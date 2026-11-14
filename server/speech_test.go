package main

import (
	"encoding/json"
	"testing"
)

// AC-1799: a Linux machine's session has its recording written by another online Mac of the same person; a macOS
// session stays on its own Mac; a sealing machine, one the page says is paired with it, or no Mac to ask is refused.
func TestLinuxSessionAsksAMacToTranscribe(t *testing.T) {
	answer := func(cmd M) M {
		if cmd["t"] != "voice" {
			return nil
		}
		return M{"t": "voice", "ok": true, "raw": "네", "text": "네", "sec": 1.0}
	}
	s1, s2 := withFindMacs(t, answer, answer)
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
	withLock(func() {
		prefsCache["u1"] = M{"groups": []any{}, "loose": []any{}, "voice": M{"on": true}}
		hosts.Val("h1")["info"] = M{"os": "Linux 7.3.0"}
		hosts.Val("h2")["info"] = M{"os": "Darwin 25.0.0"}
	})
	post := func(sid, body string) (int, M) {
		code, out := extCall(t, "POST", "/api/sessions/"+sid+"/voice", body, map[string]string{"Origin": "http://localhost"}, "u1")
		var m M
		_ = json.Unmarshal([]byte(out), &m)
		return code, m
	}

	code, m := post("s-open", `{"audio":"UklGRg=="}`)
	eq(t, code, 200)
	eq(t, m["text"], "네")
	eq(t, len(s1.sent), 0)
	eq(t, len(s2.sent), 1)
	// How loud the page heard it goes along as two numbers only (AC-1807).
	code, _ = post("s-open", `{"audio":"UklGRg==","heard":{"snr":6.12345,"level":0.08,"text":"x"}}`)
	eq(t, code, 200)
	h, _ := s2.sent[len(s2.sent)-1]["heard"].(M)
	eq(t, h["snr"], 6.123)
	eq(t, h["text"], nil)
	_, _ = post("s-open", `{"audio":"UklGRg=="}`)
	eq(t, s2.sent[len(s2.sent)-1]["heard"], nil)
	s2.sent = s2.sent[:1]

	code, _ = post("s-h2", `{"audio":"UklGRg=="}`)
	eq(t, code, 200)
	eq(t, len(s2.sent), 2)

	// Each refusal is a 409 (extCall keeps no body for one) and asks no Mac.
	code, _ = post("s-open", `{"audio":"UklGRg==","away":false}`) // paired with this device
	eq(t, code, 409)
	withLock(func() { hosts.Val("h1")["trust"] = M{"seal": true} })
	code, _ = post("s-open", `{"audio":"UklGRg=="}`) // sealing
	eq(t, code, 409)
	withLock(func() {
		delete(hosts.Val("h1"), "trust")
		hosts.Val("h2")["info"] = M{"os": "Linux 7.3.0"}
	})
	code, _ = post("s-open", `{"audio":"UklGRg=="}`) // no Mac
	eq(t, code, 409)
	eq(t, len(s1.sent)+len(s2.sent), 2)
}
