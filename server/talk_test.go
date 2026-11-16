package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func talkPost(t *testing.T, sid, body string) (int, M) {
	t.Helper()
	code, out := extCall(t, "POST", "/api/sessions/"+sid+"/talk", body, map[string]string{"Origin": "http://localhost"}, "u1")
	var m M
	_ = json.Unmarshal([]byte(out), &m)
	return code, m
}

// AC-1798: 대화 모드 asks only the session's own Mac, with the op and the text, and hands back what it said;
// a turn is only ever done or more, and the voice setting off, an unknown op or too long a text is refused.
func TestTalkAsksTheSessionsMac(t *testing.T) {
	withCfg(t, "features:\n  voice: true\n")
	s1, s2 := withFindMacs(t, func(cmd M) M {
		if cmd["t"] != "talk" {
			return nil
		}
		switch cmd["op"] {
		case "tts":
			return M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav", "engine": "say:Yuna"}
		case "turn":
			return M{"t": "talk", "ok": true, "end": "아마도"}
		}
		return M{"t": "talk", "ok": true, "line": "배포가 끝났어요."}
	}, func(M) M { return nil })
	keep, had := prefsCache["u1"]
	t.Cleanup(func() {
		withLock(func() {
			if had {
				prefsCache["u1"] = keep
			} else {
				delete(prefsCache, "u1")
			}
		})
	})
	withLock(func() { prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}} })

	code, m := talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요"}`)
	eq(t, code, 200)
	eq(t, m["audio"], "UklGRg==")
	eq(t, len(s1.sent), 1)
	eq(t, len(s2.sent), 0)
	// 읽는 속도 (AC-1807): a rate in 0.5~2 goes to the Mac, anything else is left for its default.
	_, _ = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","rate":1.25}`)
	eq(t, s1.sent[len(s1.sent)-1]["rate"], 1.25)
	_, _ = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","rate":9}`)
	eq(t, s1.sent[len(s1.sent)-1]["rate"], nil)
	code, m = talkPost(t, "s-open", `{"op":"turn","text":"그거 하니까"}`)
	eq(t, code, 200)
	eq(t, m["end"], "more")
	code, m = talkPost(t, "s-open", `{"op":"brief","text":"x"}`)
	eq(t, code, 200)
	eq(t, m["line"], "배포가 끝났어요.")

	code, _ = talkPost(t, "s-open", `{"op":"sing","text":"x"}`)
	eq(t, code, 400)
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"`+strings.Repeat("가", TALK_TTS_MAX+1)+`"}`)
	eq(t, code, 400)
	code, _ = talkPost(t, "s-other", `{"op":"tts","text":"x"}`)
	ok(t, code == 404 || code == 403, "남의 세션")
	withLock(func() { prefsCache["u1"]["voice"] = M{"on": false} })
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"x"}`)
	eq(t, code, 409)
}

// AC-1808: 소희 (REQ-F-911): a tts goes, with engine qwen, to the person's Mac that said it has her (caps talkVoice);
// when that Mac fails, the session's own machine reads; paired with this device (away false), turn and brief stay on
// the session's machine; a session whose own machine has her stays there.
func TestTalkVoiceGoesToTheMacWithSohee(t *testing.T) {
	withCfg(t, "features:\n  voice: true\n")
	h2ok := true
	s1, s2 := withFindMacs(t, func(cmd M) M {
		if cmd["t"] != "talk" {
			return nil
		}
		return M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav", "engine": "say:Yuna", "end": "done"}
	}, func(cmd M) M {
		if cmd["t"] != "talk" {
			return nil
		}
		if !h2ok {
			return M{"t": "talk", "ok": false, "code": "voice", "error": "멈췄어요"}
		}
		return M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav", "engine": "qwen:Sohee"}
	})
	keep, had := prefsCache["u1"]
	t.Cleanup(func() {
		withLock(func() {
			if had {
				prefsCache["u1"] = keep
			} else {
				delete(prefsCache, "u1")
			}
			delete(live("h1"), "caps")
			delete(live("h2"), "caps")
		})
	})
	withLock(func() {
		prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}}
		live("h2")["caps"] = []any{"talkVoice"}
	})

	code, m := talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","rate":1.25}`)
	eq(t, code, 200)
	eq(t, m["engine"], "qwen:Sohee")
	eq(t, len(s1.sent), 0)
	eq(t, len(s2.sent), 1)
	eq(t, s2.sent[0]["engine"], "qwen")
	eq(t, s2.sent[0]["rate"], 1.25)

	h2ok = false
	code, m = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요"}`)
	eq(t, code, 200)
	eq(t, m["engine"], "say:Yuna")
	eq(t, len(s2.sent), 2)
	eq(t, len(s1.sent), 1)
	eq(t, s1.sent[0]["engine"], nil)
	h2ok = true

	_, _ = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","away":false}`)
	eq(t, len(s2.sent), 2)
	eq(t, len(s1.sent), 2)
	_, _ = talkPost(t, "s-open", `{"op":"turn","text":"그거 하니까"}`)
	eq(t, len(s2.sent), 2)
	eq(t, len(s1.sent), 3)

	withLock(func() { live("h1")["caps"] = []any{"talkVoice"} })
	_, _ = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","away":false}`)
	eq(t, len(s1.sent), 4)
	eq(t, s1.sent[3]["engine"], "qwen")
}

// AC-1816: 말하기 시작하면 소희가 있는 맥만 깨우고, 없으면 아무에게도 묻지 않는다.
func TestTalkWarmWakesOnlySohee(t *testing.T) {
	withCfg(t, "features:\n  voice: true\n")
	s1, s2 := withFindMacs(t, func(cmd M) M {
		return M{"t": "talk", "ok": true}
	}, func(cmd M) M {
		return M{"t": "talk", "ok": true}
	})
	keep, had := prefsCache["u1"]
	t.Cleanup(func() {
		withLock(func() {
			if had {
				prefsCache["u1"] = keep
			} else {
				delete(prefsCache, "u1")
			}
			delete(live("h2"), "caps")
		})
	})
	withLock(func() { prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}} })

	code, m := talkPost(t, "s-open", `{"op":"warm"}`)
	eq(t, code, 200)
	eq(t, m["warm"], false)
	eq(t, len(s1.sent)+len(s2.sent), 0)

	withLock(func() { live("h2")["caps"] = []any{"talkVoice"} })
	code, m = talkPost(t, "s-open", `{"op":"warm"}`)
	eq(t, code, 200)
	eq(t, m["warm"], true)
	eq(t, len(s1.sent), 0)
	eq(t, len(s2.sent), 1)
	eq(t, s2.sent[0]["op"], "warm")
	eq(t, s2.sent[0]["engine"], "qwen")
}

// AC-1818: with CLAY_TTS_URL and CLAY_TTS_KEY the operator's voice server reads first (rate passed, key sent, the
// text not logged); when it fails the Mac with 소희 reads; a paired session never goes to it; warm wakes it first.
func TestTalkOperatorVoiceServer(t *testing.T) {
	withCfg(t, "features:\n  voice: true\n")
	var got []M
	fail := false
	lockFree := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The server waits for the voice server outside its lock (1.547): a long answer must not stop it.
		if mu.TryLock() {
			lockFree++
			mu.Unlock()
		}
		var b M
		_ = json.NewDecoder(r.Body).Decode(&b)
		b["path"], b["auth"] = r.URL.Path, r.Header.Get("Authorization")
		got = append(got, b)
		if fail {
			w.WriteHeader(503)
			return
		}
		if r.URL.Path == "/v1/warm" {
			_, _ = w.Write([]byte(`{"loaded":true,"load_ms":0}`))
			return
		}
		w.Header().Set("X-Clay-Gen-Ms", "1234")
		w.Header().Set("X-Clay-Audio-Sec", "1.5")
		_, _ = w.Write(append([]byte("RIFF"), make([]byte, 60)...))
	}))
	defer srv.Close()
	keepEnv := env
	t.Cleanup(func() { env = keepEnv })
	env = func(k string) string {
		switch k {
		case "CLAY_TTS_URL":
			return srv.URL + "/"
		case "CLAY_TTS_KEY":
			return "k-123"
		}
		return keepEnv(k)
	}
	s1, s2 := withFindMacs(t, func(cmd M) M {
		return M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav", "engine": "say:Yuna"}
	}, func(cmd M) M {
		return M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav", "engine": "qwen:Sohee"}
	})
	keep, had := prefsCache["u1"]
	t.Cleanup(func() {
		withLock(func() {
			if had {
				prefsCache["u1"] = keep
			} else {
				delete(prefsCache, "u1")
			}
			delete(live("h2"), "caps")
		})
	})
	withLock(func() {
		prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}}
		live("h2")["caps"] = []any{"talkVoice"}
	})

	code, m := talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","rate":1.25}`)
	eq(t, code, 200)
	eq(t, m["engine"], "clay")
	eq(t, m["ms"], 1234.0)
	ok(t, strings.HasPrefix(m["audio"].(string), "UklGRg"), "wav base64")
	eq(t, len(got), 1)
	eq(t, got[0]["path"], "/v1/tts")
	eq(t, got[0]["auth"], "Bearer k-123")
	eq(t, got[0]["rate"], 1.25)
	eq(t, got[0]["format"], "wav")
	eq(t, len(s1.sent)+len(s2.sent), 0)

	code, m = talkPost(t, "s-open", `{"op":"warm"}`)
	eq(t, code, 200)
	eq(t, m["warm"], true)
	eq(t, got[1]["path"], "/v1/warm")
	eq(t, len(s2.sent), 0)

	fail = true
	code, m = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요"}`)
	eq(t, code, 200)
	eq(t, m["engine"], "qwen:Sohee")
	eq(t, len(s2.sent), 1)
	fail = false

	n := len(got)
	_, _ = talkPost(t, "s-open", `{"op":"tts","text":"안녕하세요","away":false}`)
	eq(t, len(got), n, "짝지은 기계의 세션은 목소리 서버로 보내지 않음")
	eq(t, lockFree, len(got), "목소리 서버를 기다리는 동안 잠금을 놓음")
}

// AC-1821 (1.548): a talk token goes only with the command carrying the words it names (a spare signed for the second
// try on the same Mac never reaches the next sentence), a sealed text is taken at the size the words could make, and
// a sealing Mac's answer is passed on as the one piece it is, nothing plain beside it.
func TestTalkSignedAndSealed(t *testing.T) {
	withCfg(t, "features:\n  voice: true\n")
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", 60) + "⟧"
	answer := M{"t": "talk", "ok": true, "audio": "UklGRg==", "mime": "audio/wav"}
	s1, _ := withFindMacs(t, func(cmd M) M {
		if cmd["t"] != "talk" {
			return nil
		}
		return answer
	}, func(M) M { return nil })
	keep, had := prefsCache["u1"]
	t.Cleanup(func() {
		withLock(func() {
			if had {
				prefsCache["u1"] = keep
			} else {
				delete(prefsCache, "u1")
			}
			authQ = map[string][]authTok{}
		})
	})
	withLock(func() { prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}} })

	tokFor := func(n int, text string) string {
		return `{"v":1,"h":"h1","d":"dev","ts":1,"n":` + strconv.Itoa(n) + `,"t":"talk","i":{"op":"tts","textH":"` + sha256hex(text) + `"}}`
	}
	spare := tokFor(1, "첫 문장")
	next := tokFor(2, "둘째 문장")
	hdr, _ := json.Marshal([]M{{"p": spare, "s": "sig"}, {"p": next, "s": "sig"}})
	withLock(func() { queueTrustAuth("u1", base64.RawURLEncoding.EncodeToString(hdr)) })
	code, _ := talkPost(t, "s-open", `{"op":"tts","text":"둘째 문장","away":false}`)
	eq(t, code, 200)
	eq(t, mstr(asM(s1.sent[len(s1.sent)-1]["auth"]), "p"), next, "그 글의 서명만 붙음(먼저 온 다른 글의 서명이 아니라)")
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"셋째 문장","away":false}`)
	eq(t, code, 200)
	ok(t, s1.sent[len(s1.sent)-1]["auth"] == nil, "다른 글의 남은 서명은 붙지 않음")

	// A sealed text: one piece, longer than the plain limit allows, is taken; plain words beside a piece are not.
	long := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", TALK_TTS_MAX*4) + "⟧"
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"`+long+`","away":false}`)
	eq(t, code, 200)
	eq(t, mstr(s1.sent[len(s1.sent)-1], "text"), long)
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"x`+long+`","away":false}`)
	eq(t, code, 400)

	// A sealing Mac's answer: the piece alone.
	withLock(func() { answer = M{"t": "talk", "ok": true, "sealed": piece, "ms": float64(5)} })
	code, m := talkPost(t, "s-open", `{"op":"brief","text":"x","away":false}`)
	eq(t, code, 200)
	eq(t, mstr(m, "sealed"), piece)
	ok(t, m["line"] == nil && m["audio"] == nil, "평문 값은 없음")
	withLock(func() { answer = M{"t": "talk", "ok": true, "sealed": "⟦bt1:zz⟧"} })
	code, _ = talkPost(t, "s-open", `{"op":"tts","text":"x","away":false}`)
	eq(t, code, 502)
}
