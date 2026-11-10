package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func translatePost(t *testing.T, body string) (int, M) {
	t.Helper()
	code, out := extCall(t, "POST", "/api/translate", body, map[string]string{"Origin": "http://localhost"}, "u1")
	var m M
	_ = json.Unmarshal([]byte(out), &m)
	return code, m
}

// AC-1736: the session's Mac is asked first when it can; a sealing Mac, a Mac without the cap, an offline one and
// another person's are never asked; with none left it is 409 nohost.
func TestTranslateAsksAMacThatCan(t *testing.T) {
	answer := func(cmd M) M {
		if cmd["t"] != "translate" {
			return nil
		}
		out := []any{}
		for _, x := range asArr(cmd["texts"]) {
			out = append(out, "번역:"+x.(string))
		}
		return M{"t": "translate", "ok": true, "status": "installed", "texts": out}
	}
	s1, s2 := withFindMacs(t, answer, answer)
	keep := liveStatus
	t.Cleanup(func() { withLock(func() { liveStatus = keep }) })
	withLock(func() {
		liveStatus = map[string]M{}
		live("h1")["caps"] = []any{"store", "translate"}
		live("h2")["caps"] = []any{"translate"}
		live("h3")["caps"] = []any{"translate"} // offline
		live("hx")["caps"] = []any{"translate"} // someone else's
	})
	code, m := translatePost(t, `{"texts":["Hello there"],"host":"h2"}`)
	eq(t, code, 200)
	eq(t, m["status"], "installed")
	eq(t, m["host"], "맥2")
	eq(t, jsString(m["texts"].([]any)[0]), "번역:Hello there")
	eq(t, len(s1.sent), 0)

	// The preferred Mac seals its answers: another Mac of the person's is asked.
	withLock(func() { hosts.Val("h2")["trust"] = M{"seal": true} })
	code, m = translatePost(t, `{"texts":["Hello there"],"host":"h2"}`)
	eq(t, code, 200)
	eq(t, m["host"], "맥1")
	eq(t, len(s2.sent), 1)

	// Someone else's Mac is never taken as the preferred one.
	code, m = translatePost(t, `{"texts":["x"],"host":"hx"}`)
	eq(t, code, 200)
	eq(t, m["host"], "맥1")

	withLock(func() { live("h1")["caps"] = []any{"store"} })
	code, _ = translatePost(t, `{"texts":["x"]}`)
	eq(t, code, 409) // nohost
}

// AC-1737: limits, and a Mac's own failure and status come back as they are.
func TestTranslateLimits(t *testing.T) {
	st := "download"
	withFindMacs(t, func(cmd M) M {
		if st == "fail" {
			return M{"t": "translate", "ok": false, "code": "sealed", "error": "봉인 맥"}
		}
		return M{"t": "translate", "ok": true, "status": st}
	}, func(M) M { return nil })
	keep := liveStatus
	t.Cleanup(func() { withLock(func() { liveStatus = keep }) })
	withLock(func() {
		liveStatus = map[string]M{}
		live("h1")["caps"] = []any{"translate"}
	})
	code, m := translatePost(t, `{"texts":[]}`)
	eq(t, code, 200)
	eq(t, m["status"], "download")
	if _, ok := m["texts"]; ok {
		t.Fatalf("texts without a translation: %v", m)
	}
	many := `{"texts":[` + strings.TrimSuffix(strings.Repeat(`"a",`, TRANSLATE_LINES_MAX+1), ",") + `]}`
	code, _ = translatePost(t, many)
	eq(t, code, 400)
	code, _ = translatePost(t, `{"texts":[1]}`)
	eq(t, code, 400)
	code, _ = translatePost(t, `{"texts":["`+strings.Repeat("a", TRANSLATE_LINE_MAX+1)+`"]}`)
	eq(t, code, 400)
	st = "fail"
	code, _ = translatePost(t, `{"texts":["Hello there"]}`)
	eq(t, code, 502) // the Mac's own refusal (sealed)
}
