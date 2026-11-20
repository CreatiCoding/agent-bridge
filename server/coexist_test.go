package main

import (
	"strings"
	"testing"
)

func sentOf(r *recSink, t string) []M {
	out := []M{}
	for _, c := range r.sent {
		if strings.Contains(c, `"t":"`+t+`"`) {
			out = append(out, asM(js(strings.TrimSuffix(strings.TrimPrefix(c, "data: "), "\n\n"))))
		}
	}
	return out
}

// AC-1842: 함께 연동 (REQ-F-924). A session started through the other server is taken as this Mac's at once
// (sessadd), with a welcome for it alone and its marks; another person's or another Mac's is not; and closed for good
// there, it is closed here.
func TestSessAddAndEnded(t *testing.T) {
	h1, _, _, _ := groupsSetup(t)
	wasP := preview
	t.Cleanup(func() { preview = wasP })
	preview = &Preview{}
	var other, theirs *Sess
	withLock(func() {
		live("h1")["caps"] = []any{"store", "groups", "marks"}
		other = newMeta("u1", "sess-0009", "h2", M{})
		theirs = newMeta("u2", "sess-000x", "hx", M{})
		sessions.Set(other.id(), other)
		sessions.Set(theirs.id(), theirs)
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"store", "groups", "marks"}, "name": "맥", "sessions": []any{}})
	})
	h1.sent = nil
	list := []any{
		M{"id": "sess-0001", "cwd": "/w/a", "conv": "sess-0001", "alive": true, "account": "", "seq": 0.0},
		M{"id": "sess-0009", "cwd": "/w/b", "conv": "sess-0009", "alive": true},
		M{"id": "sess-000x", "cwd": "/w/c", "conv": "sess-000x", "alive": true},
		M{"id": "../bad", "cwd": "/w/d"},
	}
	withLock(func() { fromAgent["sessadd"]("u1", "h1", M{"t": "sessadd", "sessions": list}) })
	w := sentOf(h1, "welcome")
	eq(t, len(w), 1, "sessadd 에 welcome 하나")
	ok(t, w[0]["partial"] == true, "그 세션들만의 welcome: "+jsonStr(w[0]))
	known := asM(w[0]["sessions"])
	eq(t, len(known), 2, jsonStr(known))
	ok(t, mget(known["sess-0001"], "mine") == true, "처음 보는 세션은 이 맥의 것으로 받음")
	ok(t, mget(known["sess-0009"], "mine") == false, "다른 맥의 세션은 자기 것이 아니라고 답함")
	_, hasTheirs := known["sess-000x"]
	ok(t, !hasTheirs, "남의 세션은 답하지 않음")
	s1, got := sessions.Get("sess-0001")
	ok(t, got && s1.host() == "h1" && s1.uid() == "u1", "목록에 들어옴")
	ok(t, other.host() == "h2", "다른 맥의 것은 그대로")
	m := sentOf(h1, "marks")
	eq(t, len(m), 1, "들고 다니는 맥에는 그 세션의 즐겨찾기·제목도")
	eq(t, len(asArr(m[0]["list"])), 1)
	eq(t, mstr(asM(asArr(m[0]["list"])[0]), "sid"), "sess-0001")

	// Over the limit: only SESSADD_MAX are looked at.
	h1.sent = nil
	many := []any{}
	for i := 0; i < SESSADD_MAX+20; i++ {
		many = append(many, M{"id": "sess-1" + strings.Repeat("0", 3-len(itoa(i))) + itoa(i), "cwd": "/w"})
	}
	withLock(func() { fromAgent["sessadd"]("u1", "h1", M{"t": "sessadd", "sessions": many}) })
	eq(t, len(asM(sentOf(h1, "welcome")[0]["sessions"])), SESSADD_MAX)

	// Closed on the Mac for good: closed here once, with its end; a plain `closed` (it stopped) leaves it open.
	withLock(func() { fromAgent["closed"]("u1", "h1", M{"t": "closed", "sid": "sess-0001"}) })
	ok(t, !truthy(s1.get("closed")), "멈춤만으로는 닫지 않음")
	withLock(func() { fromAgent["closed"]("u1", "h1", M{"t": "closed", "sid": "sess-0001", "ended": true}) })
	ok(t, truthy(s1.get("closed")) && s1.get("closedAt") != nil, "다른 화면에서 종료되면 여기도 닫힘")
	withLock(func() { fromAgent["closed"]("u1", "h1", M{"t": "closed", "sid": "sess-0009", "ended": true}) })
	ok(t, !truthy(other.get("closed")), "다른 맥의 세션은 닫지 않음")
	withLock(func() { fromAgent["closed"]("u2", "hx", M{"t": "closed", "sid": "sess-0001", "ended": true}) })
}
