package main

import "testing"

// REQ-F-891 (AC-1697): a switch goes only while the session is up and quiet (not working, asking, starting, with
// messages held), not locked and not driven from Slack.
func TestSwitchReady(t *testing.T) {
	mk := func(m M) *Sess {
		base := M{"id": "s1", "uid": "u1", "hostId": "h1", "state": M{"alive": true, "phase": "idle"}}
		for k, v := range m {
			base[k] = v
		}
		return &Sess{m: base}
	}
	eq(t, refused(func() { switchReady(mk(M{})) }), 0, "쉬는 중")
	eq(t, refused(func() { switchReady(mk(M{"state": M{"alive": true, "phase": "busy"}})) }), 409, "작업 중")
	eq(t, refused(func() { switchReady(mk(M{"state": M{"alive": true, "phase": "starting"}})) }), 409, "뜨는 중")
	eq(t, refused(func() { switchReady(mk(M{"state": M{"alive": true, "phase": "waiting"}})) }), 409, "답 기다림")
	eq(t, refused(func() { switchReady(mk(M{"state": M{"alive": true, "phase": "idle", "held": []any{M{"id": "x"}}}})) }), 409, "보낼 글")
	eq(t, refused(func() { switchReady(mk(M{"state": M{"alive": false, "phase": "ended"}})) }), 409, "내려간 세션")
	eq(t, refused(func() { switchReady(mk(M{"lock": M{"h": "x"}})) }), 409, "잠긴 세션")
	eq(t, refused(func() { switchReady(mk(M{"seat": M{"where": "slack"}})) }), 409, "Slack 에서 작업 중")
}

// REQ-F-891 (AC-1698): the Mac's `conv` after a switch keeps the session's name, hides the lines of a resumed
// conversation that were shown before, and records the runner it runs now (none for Claude Code).
func TestSwitchConv(t *testing.T) {
	was := sessions
	defer func() { sessions = was }()
	sessions = newOMap[*Sess]()
	conv1 := "11111111-1111-4111-8111-111111111111"
	conv2 := "22222222-2222-4222-8222-222222222222"
	meta := &Sess{m: M{"id": "s1", "uid": "u1", "hostId": "h1", "title": "작업 이름", "conv": "s1", "lines": 40.0, "state": M{"alive": true}}}
	sessions.Set("s1", meta)
	fromAgent["conv"]("u1", "h1", M{"sid": "s1", "conv": conv1, "replay": false, "silent": 12.0, "keepTitle": true, "runner": "codex"})
	eq(t, meta.str("runner"), "codex", "Codex 로")
	eq(t, meta.str("conv"), conv1, "대화 id")
	eq(t, numOr0(meta.get("lines")), 0.0, "줄 수는 처음부터")
	eq(t, numOr0(meta.get("silentUntil")), 12.0, "예전 줄은 다시 그리지 않음")
	eq(t, meta.str("titleConv"), "s1", "이름은 그대로")
	fromAgent["conv"]("u1", "h1", M{"sid": "s1", "conv": conv2, "replay": false, "keepTitle": true, "runner": "claude"})
	eq(t, meta.str("runner"), "", "Claude Code 는 기록하지 않음")
	eq(t, numOr0(meta.get("silentUntil")), 0.0, "새 대화")
	eq(t, meta.str("titleConv"), "s1", "이름은 계속 그대로")
	// Another Mac cannot say it.
	fromAgent["conv"]("u1", "h2", M{"sid": "s1", "conv": conv1, "runner": "codex"})
	eq(t, meta.str("runner"), "", "다른 맥의 말은 무시")
	// A /clear (no keepTitle) may still be named anew.
	fromAgent["conv"]("u1", "h1", M{"sid": "s1", "conv": conv1, "replay": false})
	eq(t, meta.str("titleConv"), "", "/clear 는 새 이름을 받을 수 있음")
}

// REQ-F-891: the runner a switch asks for is checked before the Mac is told.
func TestSwitchOpRunner(t *testing.T) {
	meta := &Sess{m: M{"id": "s1", "uid": "u1", "hostId": "h1", "state": M{"alive": true, "phase": "idle"}}}
	eq(t, refused(func() { switchOp(nil, "u1", meta, M{"runner": "gemini"}) }), 400, "모르는 실행기")
	eq(t, refused(func() { switchOp(nil, "u1", meta, M{"runner": "claude"}) }), 409, "이미 Claude Code")
	meta.set("runner", "codex")
	eq(t, refused(func() { switchOp(nil, "u1", meta, M{"runner": "codex"}) }), 409, "이미 Codex")
}
