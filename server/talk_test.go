package main

import (
	"encoding/json"
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
