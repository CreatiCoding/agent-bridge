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

func clayPost(path string, body M) (*http.Response, error) {
	req, err := http.NewRequest("POST", clayBase()+path, bytes.NewReader(jsonBytes(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(env("CLAY_TTS_KEY")))
	req.Header.Set("Content-Type", "application/json")
	return clayHTTP.Do(req)
}

// clayTTS: the answer as the agent's talk reply would carry it, or nil when the voice server could not.
func clayTTS(text string, rate float64) M {
	t0 := time.Now()
	r, err := clayPost("/v1/tts", M{"text": text, "rate": rate, "format": "wav"})
	if err != nil {
		logLine("talk", "목소리 서버 안 닿음")
		return nil
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, CLAY_MAX_AUDIO+1))
	if err != nil || r.StatusCode != 200 || len(b) < 44 || len(b) > CLAY_MAX_AUDIO || string(b[:4]) != "RIFF" {
		logLine("talk", "목소리 서버 실패 "+strconv.Itoa(r.StatusCode))
		return nil
	}
	ms := time.Since(t0).Milliseconds()
	if g, err := strconv.ParseInt(r.Header.Get("X-Clay-Gen-Ms"), 10, 64); err == nil {
		ms = g
	}
	logLine("talk", "목소리 서버 "+strconv.Itoa(len([]rune(text)))+"자 "+strconv.FormatInt(ms, 10)+"ms → 소리 "+r.Header.Get("X-Clay-Audio-Sec")+"초")
	return M{"ok": true, "audio": base64.StdEncoding.EncodeToString(b), "mime": "audio/wav", "engine": "clay", "ms": float64(ms)}
}

// clayWarm: asks the voice server to load 소희 now and keep her another idle period.
func clayWarm() bool {
	r, err := clayPost("/v1/warm", M{})
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var out M
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&out)
	return r.StatusCode == 200 && truthy(out["loaded"])
}
