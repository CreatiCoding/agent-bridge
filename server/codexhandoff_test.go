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
	sessions.Set("sC", &Sess{m: M{"id": "sC", "uid": "u1", "hostId": "h1"}})
	sessions.Set("sX", &Sess{m: M{"id": "sX", "uid": "u1", "hostId": "h1", "runner": "codex"}})
	sessions.Set("sL", &Sess{m: M{"id": "sL", "uid": "u1", "hostId": "h1", "lock": M{"h": "x"}}})
	sessions.Set("sO", &Sess{m: M{"id": "sO", "uid": "u2", "hostId": "h1"}})
	var got *Sess
	eq(t, refused(func() { got = handoffSource("u1", "h1", "codex", M{"handoffFrom": "sC"}) }), 0, "Claude → Codex")
	ok(t, got != nil && got.id() == "sC", "원본 세션")
	eq(t, refused(func() { got = handoffSource("u1", "h1", "codex", M{}) }), 0, "이어서 작업이 아님")
	ok(t, got == nil, "없으면 nil")
	eq(t, refused(func() { handoffSource("u1", "h2", "codex", M{"handoffFrom": "sC"}) }), 409, "다른 맥")
	eq(t, refused(func() { handoffSource("u1", "h1", "", M{"handoffFrom": "sC"}) }), 400, "Claude 로 이어서")
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
