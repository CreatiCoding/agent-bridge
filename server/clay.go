package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 운영자 목소리 서버 (REQ-F-917): an operator may point the server at an HTTP voice service of their own
// (CLAY_TTS_URL, with its key in CLAY_TTS_KEY) that reads 대화 모드 answers in 소희's voice. When both are set the
// server asks it first and, if it does not answer, reads as before (the Mac with 소희, then the session's machine).
// Not for a machine that seals its conversations nor one paired with this device: what is said there stays there,
// the same rule as voiceHost. The text is never logged.

var clayHTTP = &http.Client{Timeout: TALK_WAIT_MS * time.Millisecond}

const CLAY_MAX_AUDIO = 24 << 20

func clayBase() string {
	u, k := strings.TrimRight(strings.TrimSpace(env("CLAY_TTS_URL")), "/"), strings.TrimSpace(env("CLAY_TTS_KEY"))
	if k == "" || !(strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")) {
		return ""
	}
	return u
}

// clayFor: the voice server may read this session's answers.
func clayFor(meta *Sess, away bool) bool {
	return clayBase() != "" && away && !hostSeals(liveHost(meta))
}

type clayReply struct {
	status int
	header http.Header
	body   []byte
	err    error
}

// clayPost asks the voice server outside the lock (await, 1.547): making a long answer takes as long as saying it
// (15~20 s), and the whole server waited on the lock meanwhile until it was restarted.
func clayPost(path string, body M, limit int64) clayReply {
	u, key, b := clayBase()+path, strings.TrimSpace(env("CLAY_TTS_KEY")), jsonBytes(body)
	var out clayReply
	await(func() {
		req, err := http.NewRequest("POST", u, bytes.NewReader(b))
		if err != nil {
			out.err = err
			return
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		r, err := clayHTTP.Do(req)
		if err != nil {
			out.err = err
			return
		}
		defer r.Body.Close()
		out.status, out.header = r.StatusCode, r.Header
		out.body, out.err = io.ReadAll(io.LimitReader(r.Body, limit+1))
	})
	return out
}

// clayTTS: the answer as the agent's talk reply would carry it, or nil when the voice server could not.
func clayTTS(text string, rate float64) M {
	t0 := time.Now()
	r := clayPost("/v1/tts", M{"text": text, "rate": rate, "format": "wav"}, CLAY_MAX_AUDIO)
	if r.status == 0 {
		logLine("talk", "목소리 서버 안 닿음")
		return nil
	}
	b := r.body
	if r.err != nil || r.status != 200 || len(b) < 44 || len(b) > CLAY_MAX_AUDIO || string(b[:4]) != "RIFF" {
		logLine("talk", "목소리 서버 실패 "+strconv.Itoa(r.status))
		return nil
	}
	ms := time.Since(t0).Milliseconds()
	if g, err := strconv.ParseInt(r.header.Get("X-Clay-Gen-Ms"), 10, 64); err == nil {
		ms = g
	}
	logLine("talk", "목소리 서버 "+strconv.Itoa(len([]rune(text)))+"자 "+strconv.FormatInt(ms, 10)+"ms → 소리 "+r.header.Get("X-Clay-Audio-Sec")+"초")
	return M{"ok": true, "audio": base64.StdEncoding.EncodeToString(b), "mime": "audio/wav", "engine": "clay", "ms": float64(ms)}
}

// The streaming request has no overall deadline of its own (a 600-letter answer takes ~100 s to say, and it is made
// about as fast): the voice server's own limits end it (60 s in its line, 30 s without a piece), and so does the page
// leaving.
var clayStreamHTTP = &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: TALK_WAIT_MS * time.Millisecond}}

const CLAY_STREAM_MAX = 10 * time.Minute

// clayStream (REQ-F-920): the answer as a WAV stream that grows while the voice server makes it (24 kHz 16-bit mono;
// the header's sizes are the largest, since the length is not known yet). Waits outside the lock for the voice server
// to take the request, then hands the body over to the network as it comes, without the lock (Res.pipe). False when
// it could not start: nothing was sent and the caller reads as before.
func clayStream(res *Res, text string, rate float64) bool {
	u, key, b := clayBase()+"/v1/tts", strings.TrimSpace(env("CLAY_TTS_KEY")), jsonBytes(M{"text": text, "rate": rate, "format": "wav", "stream": true})
	chars := len([]rune(text))
	ctx, cancel := context.WithTimeout(context.Background(), CLAY_STREAM_MAX)
	var r *http.Response
	var err error
	t0 := time.Now()
	await(func() {
		req, e := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(b))
		if e != nil {
			err = e
			return
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		r, err = clayStreamHTTP.Do(req)
	})
	if err != nil || r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "audio/wav") {
		status := 0
		if r != nil {
			status = r.StatusCode
			r.Body.Close()
		}
		cancel()
		logLine("talk", "목소리 서버 흘려 읽기 못 함 "+strconv.Itoa(status))
		return false
	}
	res.WriteHead(200, M{"Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Talk-Engine": "clay"})
	res.ended = true
	res.pipe = func(w http.ResponseWriter, hr *http.Request) {
		defer cancel()
		defer r.Body.Close()
		// The page left: the voice server is told at once (it stops making), not when the next write fails.
		stop := context.AfterFunc(hr.Context(), cancel)
		defer stop()
		for k, v := range res.header {
			w.Header()[k] = v
		}
		w.WriteHeader(200)
		rc := http.NewResponseController(w)
		buf := make([]byte, 32*1024)
		n, firstMs := 0, int64(-1)
		for {
			k, e := r.Body.Read(buf)
			if k > 0 {
				if firstMs < 0 {
					firstMs = time.Since(t0).Milliseconds()
				}
				if _, we := w.Write(buf[:k]); we != nil {
					break
				}
				_ = rc.Flush()
				n += k
			}
			if e != nil {
				break
			}
		}
		sec := float64(max(n-44, 0)) / 48000
		logLine("talk", "목소리 서버 흘려 읽기 "+strconv.Itoa(chars)+"자 첫 조각 "+strconv.FormatInt(firstMs, 10)+"ms 전체 "+strconv.FormatInt(time.Since(t0).Milliseconds(), 10)+"ms → 소리 "+strconv.FormatFloat(sec, 'f', 2, 64)+"초")
	}
	return true
}

// clayWarm: asks the voice server to load 소희 now and keep her another idle period.
func clayWarm() bool {
	r := clayPost("/v1/warm", M{}, 4096)
	if r.status != 200 {
		return false
	}
	var out M
	_ = json.Unmarshal(r.body, &out)
	return truthy(out["loaded"])
}
