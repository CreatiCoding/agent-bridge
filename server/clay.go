package main

import (
	"bytes"
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
