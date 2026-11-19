package main

import (
	"strings"
	"testing"
)

func marksSent(r *recSink) []M {
	out := []M{}
	for _, c := range r.sent {
		if strings.Contains(c, `"t":"marks"`) {
			out = append(out, asM(js(strings.TrimSuffix(strings.TrimPrefix(c, "data: "), "\n\n"))))
		}
	}
	return out
}

// AC-1835: 즐겨찾기·제목 넘겨주기 (REQ-F-923). h1, h2 carry marks (caps "marks" added here), h3 does not, hx is another
// person's.
func TestMarksSync(t *testing.T) {
	h1, _, h3, _ := groupsSetup(t)
	wasP := preview
	t.Cleanup(func() { preview = wasP })
	preview = &Preview{}
	var s1, s2, s3, sx *Sess
	withLock(func() {
		live("h1")["caps"] = []any{"store", "groups", "marks"}
		live("h2")["caps"] = []any{"store", "groups", "marks"}
		s1 = newMeta("u1", "sess-0001", "h1", M{"title": "내가 붙인 이름", "manualTitle": true, "favorite": true})
		s2 = newMeta("u1", "sess-0002", "h1", M{"title": "첫 메시지"})
		s3 = newMeta("u1", "sess-0003", "h3", M{"favorite": true})
		sx = newMeta("u2", "sess-000x", "hx", M{})
		for _, s := range []*Sess{s1, s2, s3, sx} {
			sessions.Set(s.id(), s)
		}
	})
	// Marked before there was a time: 1, so a new local server's unmarked copy (0) never wins.
	eq(t, marksAt(s1), 1.0)
	eq(t, marksAt(s2), 0.0)

	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"store", "groups", "marks"}, "name": "맥", "sessions": []any{}})
		helloFromAgent("u1", "h3", M{"t": "hello", "caps": []any{"store"}, "name": "맥3", "sessions": []any{}})
	})
	got := marksSent(h1)
	eq(t, len(got), 1, "hello 에 즐겨찾기·제목을 줌")
	list := asArr(got[0]["list"])
	eq(t, len(list), 2, jsonStr(got[0]))
	byId := map[string]M{}
	for _, x := range list {
		byId[mstr(asM(x), "sid")] = asM(x)
	}
	ok(t, byId["sess-0001"]["favorite"] == true && byId["sess-0001"]["title"] == "내가 붙인 이름" && byId["sess-0001"]["at"] == 1.0, jsonStr(byId["sess-0001"]))
	ok(t, byId["sess-0002"]["favorite"] == false && byId["sess-0002"]["title"] == "" && byId["sess-0002"]["at"] == 0.0, "만들어진 이름은 넘기지 않음: "+jsonStr(byId["sess-0002"]))
	eq(t, len(marksSent(h3)), 0, "들지 않는 맥에는 안 줌")

	// Newer from the Mac: taken. Older: this server's goes back. Another person's, too far ahead, unknown: nothing.
	now := float64(nowMs())
	h1.sent = nil
	withLock(func() {
		marksFromAgent("u1", "h1", M{"t": "marks", "list": []any{
			M{"sid": "sess-0002", "at": now, "favorite": true, "title": "  로컬에서   붙인 이름 "},
			M{"sid": "sess-0001", "at": 0.5, "favorite": false, "title": ""},
			M{"sid": "sess-000x", "at": now, "favorite": true, "title": "남의 것"},
			M{"sid": "sess-0001", "at": now + 10*60_000, "favorite": false, "title": ""},
			M{"sid": "../x", "at": now, "favorite": true},
		}})
	})
	ok(t, truthy(s2.get("favorite")) && s2.str("title") == "로컬에서 붙인 이름" && truthy(s2.get("manualTitle")) && marksAt(s2) == now, jsonStr(marksOf(s2)))
	ok(t, truthy(s1.get("favorite")) && s1.str("title") == "내가 붙인 이름", "늦지 않은 것은 받지 않음")
	ok(t, !truthy(sx.get("favorite")) && sx.str("title") != "남의 것", "남의 세션은 건드리지 않음")
	back := marksSent(h1)
	eq(t, len(back), 1)
	eq(t, len(asArr(back[0]["list"])), 1)
	eq(t, mstr(asM(asArr(back[0]["list"])[0]), "sid"), "sess-0001")

	// Cleared there: named from its first message again here.
	withLock(func() {
		marksFromAgent("u1", "h1", M{"t": "marks", "list": []any{M{"sid": "sess-0002", "at": now + 1, "favorite": false, "title": ""}}})
	})
	ok(t, !truthy(s2.get("favorite")) && !truthy(s2.get("manualTitle")) && s2.str("title") == "" && unnamed(s2), jsonStr(marksOf(s2)))

	// A change here is stamped later than any before and goes to the session's Mac when it carries marks.
	h1.sent = nil
	withLock(func() {
		marksStamp(s1)
		marksToHost(s1)
		marksStamp(s3)
		marksToHost(s3)
	})
	ok(t, marksAt(s1) > 1, "지금으로 찍힘")
	eq(t, len(marksSent(h1)), 1)
	eq(t, len(marksSent(h3)), 0)
	// An agent that does not carry marks is not listened to.
	withLock(func() {
		marksFromAgent("u1", "h3", M{"t": "marks", "list": []any{M{"sid": "sess-0003", "at": now + 99, "favorite": false, "title": "x"}}})
	})
	ok(t, truthy(s3.get("favorite")), "들지 않는 맥의 것은 받지 않음")
}
