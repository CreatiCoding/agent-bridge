package main

import "testing"

func refused(f func()) (code int) {
	defer func() {
		if r, ok := recover().(*Refuse); ok {
			code = r.Status
		}
	}()
	f()
	return 0
}

// REQ-F-857 (AC-1607): a hand-over starts only from the person's own Claude Code session, on the same Mac, into a
// Codex session, and not from a locked session.
func TestHandoffSource(t *testing.T) {
	was := sessions
	defer func() { sessions = was }()
	sessions = newOMap[*Sess]()
	sessions.Set("sC", &Sess{m: M{"id": "sC", "uid": "u1", "hostId": "h1", "cwd": "/w/app"}})
	sessions.Set("sX", &Sess{m: M{"id": "sX", "uid": "u1", "hostId": "h1", "runner": "codex"}})
	sessions.Set("sL", &Sess{m: M{"id": "sL", "uid": "u1", "hostId": "h1", "lock": M{"h": "x"}}})
	sessions.Set("sO", &Sess{m: M{"id": "sO", "uid": "u2", "hostId": "h1"}})
	var got *Sess
	eq(t, refused(func() { got = handoffSource("u1", "h1", "codex", M{"handoffFrom": "sC", "cwd": "/w/app"}) }), 0, "Claude → Codex")
	ok(t, got != nil && got.id() == "sC", "원본 세션")
	eq(t, refused(func() { got = handoffSource("u1", "h1", "codex", M{}) }), 0, "이어서 작업이 아님")
	ok(t, got == nil, "없으면 nil")
	eq(t, refused(func() { handoffSource("u1", "h2", "codex", M{"handoffFrom": "sC", "cwd": "/w/app"}) }), 409, "다른 맥")
	eq(t, refused(func() { handoffSource("u1", "h1", "", M{"handoffFrom": "sC", "cwd": "/w/app"}) }), 400, "Claude 로 이어서")
	eq(t, refused(func() { handoffSource("u1", "h1", "codex", M{"handoffFrom": "sX"}) }), 409, "Codex 세션에서")
	eq(t, refused(func() { handoffSource("u1", "h1", "codex", M{"handoffFrom": "sL"}) }), 409, "잠긴 세션")
	eq(t, refused(func() { handoffSource("u1", "h1", "codex", M{"handoffFrom": "sO"}) }), 404, "남의 세션")
}

// REQ-F-857 (AC-1608): the same key starts one session: a press while it is being made is refused, one after it
// gets that session, a failed start frees the key, and another person's same key is theirs.
func TestHandoffClaim(t *testing.T) {
	was := sessions
	defer func() { sessions = was }()
	sessions = newOMap[*Sess]()
	handoffKeys = map[string]handoffEntry{}
	eq(t, handoffClaim("u1", ""), "", "키 없음")
	eq(t, handoffClaim("u1", "k1"), "", "처음")
	eq(t, refused(func() { handoffClaim("u1", "k1") }), 409, "만드는 중에 또")
	eq(t, handoffClaim("u2", "k1"), "", "다른 사람의 같은 키")
	sessions.Set("new1", &Sess{m: M{"id": "new1", "uid": "u1"}})
	handoffSettle("u1", "k1", "new1")
	eq(t, handoffClaim("u1", "k1"), "new1", "만든 뒤에 또")
	handoffSettle("u2", "k1", "")
	eq(t, handoffClaim("u2", "k1"), "", "실패하면 다시 시작")
	// The session it made is gone: the key starts a new one.
	sessions.Delete("new1")
	eq(t, handoffClaim("u1", "k1"), "", "만든 세션이 없어짐")
	eq(t, refused(func() { handoffClaim("u1", string(make([]byte, 81))) }), 400, "긴 키")
}

// REQ-F-857 (AC-1610): a hand-over starts only while the Claude Code session is safe to give (not working, asking,
// starting, with messages waiting or being moved) and only into its own folder; a state that changes after the first
// check is caught by the check right before the Mac starts Codex.
func TestHandoffReady(t *testing.T) {
	was := sessions
	defer func() { sessions = was }()
	sessions = newOMap[*Sess]()
	src := &Sess{m: M{"id": "sC", "uid": "u1", "hostId": "h1", "cwd": "/w/app"}}
	sessions.Set("sC", src)
	at := func(phase string, alive bool) {
		st := noState()
		st["alive"], st["phase"] = alive, phase
		src.set("state", st)
	}
	start := func(cwd any) int {
		return refused(func() { handoffSource("u1", "h1", "codex", M{"handoffFrom": "sC", "cwd": cwd}) })
	}
	at("idle", true)
	eq(t, start("/w/app"), 0, "쉬는 중·같은 폴더")
	eq(t, start("/w/app/"), 0, "끝의 / 는 같은 폴더")
	eq(t, start("/w/other"), 409, "다른 폴더")
	eq(t, start("/w/app/sub"), 409, "하위 폴더")
	eq(t, start(nil), 409, "폴더를 안 보냄(~)")
	for _, p := range []string{"busy", "waiting", "starting"} {
		at(p, true)
		eq(t, start("/w/app"), 409, p)
	}
	at("ended", false)
	eq(t, start("/w/app"), 0, "끝난 세션")
	at("idle", true)
	src.state()["held"] = []any{M{"text": "다음 글"}}
	eq(t, start("/w/app"), 409, "보낼 글이 남음")
	at("idle", true)
	src.set("moving", M{"to": "h2"})
	eq(t, start("/w/app"), 409, "옮기는 중")
	src.set("moving", nil)
	src.set("cwd", "")
	eq(t, start("/w/app"), 409, "원래 세션 폴더를 모름")
	src.set("cwd", "/w/app")

	// The race: the start was checked while Claude was idle, then a turn began (or the session moved to another
	// folder) before the Mac was told to start Codex. The second check refuses it.
	at("idle", true)
	eq(t, start("/w/app"), 0, "처음 확인")
	at("busy", true)
	eq(t, refused(func() { handoffReady(src, "/w/app") }), 409, "확인 뒤 작업 시작")
	at("idle", true)
	src.set("cwd", "/w/moved")
	eq(t, refused(func() { handoffReady(src, "/w/app") }), 409, "확인 뒤 폴더가 바뀜")
}
