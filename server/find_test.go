package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// findSink: a Mac that answers each convfind with what answer returns.
type findSink struct {
	host   string
	sent   []M
	answer func(cmd M) M
}

func (f *findSink) Write(chunk string) bool {
	var cmd M
	_ = json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(chunk, "data: "), "\n\n")), &cmd)
	f.sent = append(f.sent, cmd)
	if r := f.answer(cmd); r != nil {
		r["reqId"] = cmd["reqId"]
		go withLock(func() { reply(r, f.host) })
	}
	return true
}
func (f *findSink) End(string)   {}
func (f *findSink) Pending() int { return 0 }

func withFindMacs(t *testing.T, a1, a2 func(cmd M) M) (*findSink, *findSink) {
	t.Helper()
	s1 := &findSink{host: "h1", answer: a1}
	s2 := &findSink{host: "h2", answer: a2}
	wasH, wasS, wasB := hosts, sessions, bridges
	keepA := attempts
	t.Cleanup(func() { withLock(func() { hosts, sessions, bridges, attempts = wasH, wasS, wasB, keepA }) })
	withLock(func() {
		attempts = map[string][]int64{}
		hosts, sessions, bridges = newOMap[M](), newOMap[*Sess](), newOMap[Sink]()
		hosts.Set("h1", M{"uid": "u1", "name": "맥1"})
		hosts.Set("h2", M{"uid": "u1", "name": "맥2"})
		hosts.Set("h3", M{"uid": "u1", "name": "맥3"}) // not connected
		hosts.Set("hx", M{"uid": "u2", "name": "남의 맥"})
		sessions.Set("s-open", &Sess{m: M{"id": "s-open", "uid": "u1", "hostId": "h1"}})
		sessions.Set("s-closed", &Sess{m: M{"id": "s-closed", "uid": "u1", "hostId": "h1", "closed": true, "conv": "c-old", "lastAt": 5.0}})
		sessions.Set("s-closed2", &Sess{m: M{"id": "s-closed2", "uid": "u1", "hostId": "h1", "closed": true, "lastAt": 9.0}})
		sessions.Set("s-locked", &Sess{m: M{"id": "s-locked", "uid": "u1", "hostId": "h1", "lock": M{"hash": "x"}}})
		sessions.Set("s-other", &Sess{m: M{"id": "s-other", "uid": "u2", "hostId": "h1"}})
		sessions.Set("s-h2", &Sess{m: M{"id": "s-h2", "uid": "u1", "hostId": "h2"}})
		bridges.Set("h1", s1)
		bridges.Set("h2", s2)
		bridges.Set("hx", &findSink{host: "hx", answer: func(M) M { return nil }})
	})
	return s1, s2
}

func findPost(t *testing.T, body string) (int, M) {
	t.Helper()
	code, out := extCall(t, "POST", "/api/find", body, map[string]string{"Origin": "http://localhost"}, "u1")
	var m M
	_ = json.Unmarshal([]byte(out), &m)
	return code, m
}

func findHostOf(m M, id string) M {
	for _, h := range asArr(m["hosts"]) {
		if mstr(asM(h), "id") == id {
			return asM(h)
		}
	}
	return nil
}

// AC-1721: every Mac of the person is asked; another person's and locked sessions are left out; a Mac that is not
// connected is said so; the closed ones known here and the locked ones go with the search.
func TestFindAsksEveryMacAndHidesWhatIsNotYours(t *testing.T) {
	s1, s2 := withFindMacs(t, func(cmd M) M {
		return M{"t": "convfind", "ok": true, "op": cmd["op"], "searched": 4.0, "total": 4.0, "partial": false, "hits": []any{
			M{"sid": "s-open", "at": 10.0, "n": 2.0, "snips": []any{"…https://example.slack.com/archives/C1/p1…", strings.Repeat("가", 900)}},
			M{"sid": "s-locked", "n": 1.0, "snips": []any{"잠긴 세션의 글"}},
			M{"sid": "s-other", "n": 1.0, "snips": []any{"남의 세션의 글"}},
			M{"sid": "s-h2", "n": 1.0, "snips": []any{"다른 맥의 세션을 이 맥이 말함"}},
			M{"sid": "s-closed", "n": 1.0},
			M{"sid": "nope", "n": 1.0},
		}}
	}, func(cmd M) M {
		return M{"t": "convfind", "ok": false, "error": "찾지 못했어요"}
	})
	code, m := findPost(t, `{"mode":"text","q":"example.slack.com"}`)
	ok(t, code == 200, "status", itoa(code))
	ok(t, len(asArr(m["hosts"])) == 3, "only the person's three Macs")
	h1 := findHostOf(m, "h1")
	ok(t, h1["state"] == "ok", "h1 ok")
	hits := asArr(h1["hits"])
	ids := []string{}
	for _, x := range hits {
		ids = append(ids, mstr(asM(x), "sid"))
	}
	ok(t, strings.Join(ids, ",") == "s-open,s-closed", "visible hits only: "+strings.Join(ids, ","))
	ok(t, asM(hits[1])["closed"] == true, "closed marked")
	snips := asArr(asM(hits[0])["snips"])
	ok(t, len(snips) == 2 && jsLen(jsString(snips[1])) == FIND_SNIP_MAX, "snips cut")
	ok(t, findHostOf(m, "h2")["state"] == "error" && findHostOf(m, "h2")["error"] == "찾지 못했어요", "the Mac's own error")
	ok(t, findHostOf(m, "h3")["state"] == "offline", "not connected")
	// What h1 was told: the search, its closed sessions newest first, its locked one to skip.
	ok(t, len(s1.sent) == 1 && len(s2.sent) == 1, "one command each")
	c := s1.sent[0]
	ok(t, c["t"] == "convfind" && c["op"] == "text" && c["q"] == "example.slack.com", "command")
	closed := asArr(c["closed"])
	ok(t, len(closed) == 2 && mstr(asM(closed[0]), "sid") == "s-closed2" && mstr(asM(closed[1]), "conv") == "c-old", "closed list")
	skip := asArr(c["skip"])
	ok(t, len(skip) == 1 && skip[0] == "s-locked", "locked skipped")
}

// AC-1722: a sealing Mac's findings pass on whole and unread; its sealed q goes to it alone; a broken one is refused.
func TestFindSealedPassesThrough(t *testing.T) {
	piece := "⟦bt1:0011aabb:" + strings.Repeat("A", 60) + "⟧"
	s1, s2 := withFindMacs(t, func(cmd M) M {
		return M{"t": "convfind", "ok": true, "hits": []any{M{"sid": "s-open", "at": 3.0, "sealed": piece}, M{"sid": "s-closed", "sealed": "평문인 척"}}}
	}, func(cmd M) M { return M{"t": "convfind", "ok": true, "hits": []any{}} })
	code, m := findPost(t, `{"mode":"text","qh":{"h1":"`+piece+`","h2":"평문"}}`)
	ok(t, code == 200, "status")
	h1 := findHostOf(m, "h1")
	hits := asArr(h1["hits"])
	ok(t, len(hits) == 1 && asM(hits[0])["sealed"] == piece && asM(hits[0])["n"] == nil, "sealed passed on, a fake one dropped")
	ok(t, s1.sent[0]["q"] == piece, "the sealed q to h1")
	ok(t, len(s2.sent) == 0 && findHostOf(m, "h2")["error"] == FIND_PIECE_ERR, "a qh that is not a piece is not sent")
	ok(t, findHostOf(m, "h3")["state"] == "skipped", "no words for h3 (no plain q)")
}

// AC-1723: the request's limits: mode, length, rate, one AI search at a time.
func TestFindLimits(t *testing.T) {
	withFindMacs(t, func(cmd M) M {
		return M{"t": "convfind", "ok": true, "picks": []any{M{"sid": "s-open", "why": "링크가 나옴"}}}
	}, func(cmd M) M { return M{"t": "convfind", "ok": true, "picks": []any{}} })
	c, _ := findPost(t, `{"mode":"grep","q":"abc"}`)
	ok(t, c == 400, "mode")
	c, _ = findPost(t, `{"mode":"text","q":"a"}`)
	ok(t, c == 400, "too short")
	c, _ = findPost(t, `{"mode":"text","q":"`+strings.Repeat("a", 501)+`"}`)
	ok(t, c == 400, "too long")
	c, _ = findPost(t, `{"mode":"text"}`)
	ok(t, c == 400, "nothing to find")
	code, m := findPost(t, `{"mode":"ai","q":"슬랙 스레드"}`)
	ok(t, code == 200 && mstr(asM(asArr(findHostOf(m, "h1")["hits"])[0]), "why") == "링크가 나옴", "picks come as hits")
	withLock(func() { findAiBusy["u1"] = true })
	c, _ = findPost(t, `{"mode":"ai","q":"슬랙 스레드"}`)
	ok(t, c == 409, "one AI search at a time")
	withLock(func() { delete(findAiBusy, "u1") })
	for i := 0; i < FIND_AI_PER_MIN; i++ {
		findPost(t, `{"mode":"ai","q":"슬랙 스레드"}`)
	}
	c, _ = findPost(t, `{"mode":"ai","q":"슬랙 스레드"}`)
	ok(t, c == 429, "rate")
}

// AC-1724: how a Mac that did not answer is told from one that answered with an error.
func TestFindHostStates(t *testing.T) {
	withFindMacs(t, func(M) M { return nil }, func(M) M { return nil })
	var r M
	withLock(func() {
		r = findHostResult("u1", "h1", M{"id": "h1"}, M{"ok": false, "error": "에이전트가 명령을 받았지만 제때 답하지 않았습니다"})
	})
	ok(t, r["state"] == "noanswer", "no answer")
	withLock(func() {
		r = findHostResult("u1", "h1", M{"id": "h1"}, M{"ok": false, "code": "trust-refused", "error": "🔒"})
	})
	ok(t, r["state"] == "refused", "refused")
	withLock(func() {
		r = findHostResult("u1", "h1", M{"id": "h1"}, M{"ok": false, "error": "⟦bt1:0011aabb:" + strings.Repeat("A", FIND_SEALED_MAX) + "⟧"})
	})
	ok(t, r["state"] == "error" && r["error"] == "🔒", "a sealed error too long is not cut")
}

// AC-1728: plain words and sealed pieces never go in one request; only the Macs named in hosts are asked; the page's
// number for the search (fn) goes to the Mac with it (REQ-S-102).
func TestFindPlainAndSealedApart(t *testing.T) {
	piece := "⟦bt1:0011aabb:" + strings.Repeat("A", 60) + "⟧"
	s1, s2 := withFindMacs(t, func(cmd M) M { return M{"t": "convfind", "ok": true, "hits": []any{}} }, func(cmd M) M {
		return M{"t": "convfind", "ok": true, "hits": []any{M{"sid": "s-h2", "n": 1.0}}}
	})
	c, _ := findPost(t, `{"mode":"text","q":"비밀 글","qh":{"h1":"`+piece+`"}}`)
	ok(t, c == 400, "mixed refused", itoa(c))
	ok(t, len(s1.sent) == 0 && len(s2.sent) == 0, "nothing sent for a mixed request")
	// The plain search for the Mac the page is not paired with: h1 is not asked, not even listed.
	code, m := findPost(t, `{"mode":"text","q":"비밀 글","hosts":["h2"]}`)
	ok(t, code == 200 && len(asArr(m["hosts"])) == 1 && findHostOf(m, "h2")["state"] == "ok", "only h2")
	ok(t, len(s1.sent) == 0 && len(s2.sent) == 1 && s2.sent[0]["q"] == "비밀 글", "the plain words to h2 alone")
	// The sealed search for the paired Mac, with its number.
	code, m = findPost(t, `{"mode":"text","qh":{"h1":"`+piece+`"},"hosts":["h1"],"fn":"n-123"}`)
	ok(t, code == 200 && len(asArr(m["hosts"])) == 1 && findHostOf(m, "h1") != nil, "only h1")
	ok(t, len(s1.sent) == 1 && s1.sent[0]["q"] == piece && s1.sent[0]["fn"] == "n-123", "the piece and fn to h1")
	ok(t, len(s2.sent) == 1, "h2 not asked again")
}
