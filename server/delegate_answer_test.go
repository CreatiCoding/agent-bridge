// A done session whose events this server lost on a restart still reads as done with its answer (1.406).
package main

import "testing"

func TestDelegateStateAsksMacAfterRestart(t *testing.T) {
	keepS, keepData, keepAsk, keepAsked := sessions, DATA, askAnswerEvents, answerAsked
	defer func() { sessions, DATA, askAnswerEvents, answerAsked = keepS, keepData, keepAsk, keepAsked }()
	DATA, sessions, answerAsked = t.TempDir(), newOMap[*Sess](), map[string]askedAnswer{}
	asked := 0
	askAnswerEvents = func(meta *Sess) []any {
		asked++
		return []any{M{"seq": 3.0, "k": "text", "text": "앞 턴"}, M{"seq": 9.0, "k": "text", "text": "판정: 고침 2건"}}
	}
	withLock(func() {
		meta := newSess(M{"id": "s1", "uid": "gh1", "host": "h1", "service": true})
		sessions.Set("s1", meta)

		meta.state()["phase"] = "working"
		st := delegateState(meta, 0)
		eq(t, st["state"], any("working"), "a turn in progress")
		eq(t, asked, 0, "not asked while the turn runs")

		meta.state()["phase"] = "idle"
		st = delegateState(meta, 0)
		eq(t, st["state"], any("done"), "idle with the answer only on the Mac")
		eq(t, st["answer"], any("판정: 고침 2건"))
		eq(t, asked, 1)

		st = delegateState(meta, 5)
		eq(t, st["answer"], any("판정: 고침 2건"), "only answers after since")
		st = delegateState(meta, 9)
		eq(t, st["state"], any("working"), "nothing after since: not done")
		eq(t, asked, 1, "asked once per DELEGATE_ASK_MS")

		answerAsked["s1"] = askedAnswer{float64(nowMs()) - DELEGATE_ASK_MS, nil}
		delegateState(meta, 0)
		eq(t, asked, 2, "asked again once the wait is over")

		meta.set("closed", true)
		st = delegateState(meta, 0)
		eq(t, st["state"], any("closed"))
		eq(t, st["answer"], any("판정: 고침 2건"), "a closed session keeps its answer")
	})
}
