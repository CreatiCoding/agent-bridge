package main

import (
	"strings"
	"testing"
)

// 세션 그룹 넘겨주기 (REQ-F-905): the person u1 with Macs h1, h2 (both carry groups), h3 (an agent that does not), and
// another person's Mac hx.
func groupsSetup(t *testing.T) (h1, h2, h3, hx *recSink) {
	t.Helper()
	keepD := DATA
	wasH, wasS, wasB, wasU := hosts, sessions, bridges, users
	h1, h2, h3, hx = &recSink{}, &recSink{}, &recSink{}, &recSink{}
	t.Cleanup(func() {
		withLock(func() {
			hosts, sessions, bridges, users = wasH, wasS, wasB, wasU
			DATA = keepD
			delete(prefsCache, "u1")
			delete(prefsCache, "u2")
			for _, id := range []string{"h1", "h2", "h3", "hx"} {
				delete(liveStatus, id)
			}
		})
	})
	withLock(func() {
		DATA = t.TempDir()
		delete(prefsCache, "u1")
		delete(prefsCache, "u2")
		hosts, sessions, bridges = newOMap[M](), newOMap[*Sess](), newOMap[Sink]()
		if users == nil {
			users = newOMap[M]()
		}
		for id, s := range map[string]*recSink{"h1": h1, "h2": h2, "h3": h3, "hx": hx} {
			uid := "u1"
			if id == "hx" {
				uid = "u2"
			}
			hosts.Set(id, M{"uid": uid, "name": id})
			bridges.Set(id, s)
			if id != "h3" {
				live(id)["caps"] = []any{"store", "groups"}
			} else {
				live(id)["caps"] = []any{"store"}
			}
		}
	})
	return
}

func groupsSent(r *recSink) []M {
	out := []M{}
	for _, c := range r.sent {
		if strings.Contains(c, `"t":"groups"`) {
			v := js(strings.TrimSuffix(strings.TrimPrefix(c, "data: "), "\n\n"))
			out = append(out, asM(v))
		}
	}
	return out
}

// AC-1758: a new server's empty list has the time 0 (it never wins); a change of the groups is stamped now and goes
// to the person's Macs that carry groups, not to an agent that does not, nor to another person's Mac. Other prefs
// changing does not send them.
func TestGroupsSyncStampAndPush(t *testing.T) {
	h1, h2, h3, hx := groupsSetup(t)
	withLock(func() {
		c := groupsCmd("u1")
		eq(t, c["at"], 0.0, "빈 목록의 시각은 0")
		prefsOf("u1")["defaultPrompt"] = "x"
		savePrefs("u1")
	})
	eq(t, len(groupsSent(h1)), 0, "그룹이 아닌 설정은 보내지 않음")
	withLock(func() {
		groupOp("u1", M{"op": "create", "name": "일"})
		savePrefs("u1")
	})
	got := groupsSent(h1)
	eq(t, len(got), 1, "바뀌면 보냄")
	ok(t, numOr0(got[0]["at"]) > 0, "바뀐 시각")
	eq(t, len(asArr(got[0]["groups"])), 1)
	ok(t, got[0]["defaultPrompt"] == nil && got[0]["groupsSync"] == nil, "그룹·loose·collapsed 만")
	eq(t, len(groupsSent(h2)), 1, "다른 맥에도")
	eq(t, len(groupsSent(h3)), 0, "그룹을 들지 않는 에이전트에는 안 보냄")
	eq(t, len(groupsSent(hx)), 0, "남의 맥에는 안 보냄")
	// Saved again unchanged: not sent again.
	withLock(func() { savePrefs("u1") })
	eq(t, len(groupsSent(h1)), 1, "같으면 다시 보내지 않음")
}

// AC-1759: a Mac's groups newer than the server's are taken whole (session ids it does not know kept, what the screen
// could not make dropped) and go on to the other Macs; older ones are answered with the server's; a time far ahead of
// the clock, or from an agent that does not carry groups, is not taken.
func TestGroupsFromAgent(t *testing.T) {
	h1, h2, _, _ := groupsSetup(t)
	var at float64
	withLock(func() {
		groupOp("u1", M{"op": "create", "name": "사이트"})
		savePrefs("u1")
		at = groupsAt(prefsOf("u1"))
	})
	h1.sent, h2.sent = nil, nil
	newer := at + 1000
	in := M{"t": "groups", "at": newer, "groups": []any{
		M{"id": "aaaa1111", "name": " 로컬 ", "items": []any{"sess-unknown-1", "sess-unknown-1", "bad id!"}},
		M{"id": "bbbb2222", "name": "안", "items": []any{}, "parent": "aaaa1111"},
		M{"id": "cccc3333", "name": "더 안", "items": []any{}, "parent": "bbbb2222"},
		M{"id": "dddd4444", "name": "넷째 단계", "items": []any{}, "parent": "cccc3333"},
		M{"id": "eeee5555", "name": "", "items": []any{}},
		M{"id": "ffff6666", "name": "없는 부모", "items": []any{}, "parent": "zzzz0000"},
		M{"id": "bad id", "name": "틀린 id"},
	}, "loose": []any{"sess-other-mac-1", "sess-unknown-1"}, "collapsed": []any{"loose", "aaaa1111", "nope0000"}}
	withLock(func() { fromAgent["groups"]("u1", "h1", in) })
	pf := prefsOf("u1")
	eq(t, groupsAt(pf), newer, "맥의 시각을 이어받음")
	gs := groupsList(pf)
	eq(t, len(gs), 5, "이름 없는 것·틀린 id 는 버림")
	eq(t, gs[0]["name"], "로컬")
	jeq(t, gs[0]["items"], `["sess-unknown-1"]`, "모르는 세션 id 는 그대로, 겹침·틀린 것은 버림")
	eq(t, gs[2]["parent"], "bbbb2222", "3단계까지는 그대로")
	ok(t, gs[3]["parent"] == nil, "4단계는 부모를 뗌")
	ok(t, gs[4]["parent"] == nil, "없는 부모는 뗌")
	jeq(t, pf["loose"], `["sess-other-mac-1"]`, "다른 맥의 세션은 남기고, 그룹에 있는 것은 겹치지 않게")
	jeq(t, pf["collapsed"], `["loose","aaaa1111"]`)
	eq(t, len(groupsSent(h1)), 0, "보낸 맥에는 되돌려 보내지 않음")
	eq(t, len(groupsSent(h2)), 1, "다른 맥에는 넘김")
	ok(t, !groupsStamp("u1", pf), "받은 그대로 저장한 뒤로는 바뀐 것이 없음")

	// Older than the server's: not taken, the server's go back.
	withLock(func() {
		fromAgent["groups"]("u1", "h1", M{"at": newer - 1, "groups": []any{}, "loose": []any{}, "collapsed": []any{}})
	})
	eq(t, len(groupsList(prefsOf("u1"))), 5, "오래된 것은 받지 않음")
	back := groupsSent(h1)
	eq(t, len(back), 1, "서버 것을 돌려줌")
	eq(t, numOr0(back[0]["at"]), newer)

	// Far ahead of the clock, or from an agent that does not carry groups: nothing.
	withLock(func() {
		fromAgent["groups"]("u1", "h1", M{"at": float64(nowMs() + GROUPS_SYNC_SKEW + 60_000), "groups": []any{}})
		fromAgent["groups"]("u1", "h3", M{"at": newer + 5, "groups": []any{}})
	})
	eq(t, len(groupsList(prefsOf("u1"))), 5, "앞선 시각·그룹을 들지 않는 맥은 무시")

	// Taken from a Mac whose clock runs ahead: a change here right after is still the later one.
	ahead := float64(nowMs() + 120_000)
	withLock(func() {
		fromAgent["groups"]("u1", "h1", M{"at": ahead, "groups": []any{}, "loose": []any{}, "collapsed": []any{}})
		groupOp("u1", M{"op": "create", "name": "방금"})
		savePrefs("u1")
	})
	ok(t, groupsAt(prefsOf("u1")) > ahead, "맥이 준 시각보다 늦게 찍힘")
}

// AC-1760: a Mac that carries groups is handed the server's at hello; one that does not, is not.
func TestGroupsAtHello(t *testing.T) {
	h1, _, h3, _ := groupsSetup(t)
	wasP := preview
	t.Cleanup(func() { preview = wasP })
	preview = &Preview{}
	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"store", "groups"}, "name": "맥", "sessions": []any{}})
		helloFromAgent("u1", "h3", M{"t": "hello", "caps": []any{"store"}, "name": "맥3", "sessions": []any{}})
	})
	eq(t, len(groupsSent(h1)), 1, "hello 에 그룹을 줌")
	eq(t, len(groupsSent(h3)), 0, "들지 않는 맥에는 안 줌")
}
