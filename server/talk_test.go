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
