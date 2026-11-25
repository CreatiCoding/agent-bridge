package main

import (
	"strings"
	"testing"
)

// AC-1849: 맥 기준 세션 목록 (REQ-F-927). A hello with caps "listed" closes this Mac's open sessions it leaves out,
// never one made or moved here a moment ago, another Mac's or another person's; a hello without it closes nothing.
// A listed session's conversation time moves the list time on only when later and not too far ahead.
func TestMacListed(t *testing.T) {
	_, _, _, _ = groupsSetup(t)
	wasP := preview
	t.Cleanup(func() { preview = wasP })
	preview = &Preview{}
	old := float64(nowMs()) - 3*24*3_600_000
	var kept, gone, fresh, moved, moving, other, ended, theirs *Sess
	withLock(func() {
		kept = newMeta("u1", "sess-0001", "h1", M{})
		gone = newMeta("u1", "sess-0002", "h1", M{})
		fresh = newMeta("u1", "sess-0003", "h1", M{})
		moved = newMeta("u1", "sess-0004", "h1", M{})
		moving = newMeta("u1", "sess-0008", "h1", M{})
		other = newMeta("u1", "sess-0005", "h2", M{})
		ended = newMeta("u1", "sess-0006", "h1", M{"closed": true, "closedAt": old})
		theirs = newMeta("u2", "sess-0007", "h1", M{})
		for _, s := range []*Sess{kept, gone, moved, moving, other, ended, theirs} {
			s.set("createdAt", old)
			s.set("lastAt", old)
		}
		moved.set("moves", []any{M{"at": float64(nowMs()) - 60_000, "from": "h2", "to": "h1"}})
		for _, s := range []*Sess{kept, gone, fresh, moved, moving, other, ended, theirs} {
			sessions.Set(s.id(), s)
		}
	})

	// Without "listed" (an older agent): nothing is closed.
	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"store"}, "name": "맥", "sessions": []any{M{"id": "sess-0001"}}})
	})
	ok(t, !truthy(gone.get("closed")), "listed 없는 hello 는 닫지 않음")

	later := old + 3_600_000
	withLock(func() {
		// resetVolatile clears moving at every hello: set again, as a move asked between the two.
		moving.set("moving", M{"to": "h2", "at": float64(nowMs())})
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"store", "listed"}, "name": "맥", "sessions": []any{M{"id": "sess-0001", "at": later}}})
	})
	ok(t, truthy(gone.get("closed")) && numOr0(gone.get("closedAt")) > old, "맥에 없는 세션은 닫힘")
	var ends []string
	for _, e := range recentEvents(gone, []string{"end"}) {
		if mstr(e, "k") == "end" {
			ends = append(ends, mstr(e, "text"))
		}
	}
	ok(t, len(ends) == 1 && strings.Contains(ends[0], "맥에 이 세션이 없어"), jsonStr(ends))
	ok(t, !truthy(kept.get("closed")), "목록에 있는 세션은 그대로")
	ok(t, !truthy(fresh.get("closed")), "막 만든 세션은 닫지 않음")
	ok(t, !truthy(moved.get("closed")), "막 옮겨 온 세션은 닫지 않음")
	ok(t, !truthy(moving.get("closed")), "다른 맥으로 옮기는 중인 세션은 닫지 않음")
	ok(t, !truthy(other.get("closed")), "다른 맥의 세션은 그대로")
	ok(t, !truthy(theirs.get("closed")), "남의 세션은 그대로")
	eq(t, numOr0(ended.get("closedAt")), old, "이미 끝난 세션은 다시 닫지 않음")
	eq(t, numOr0(kept.get("lastAt")), later, "맥의 대화 시각이 더 늦으면 받음")

	// Earlier, too far ahead, not a number: kept.
	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"listed"}, "name": "맥", "sessions": []any{M{"id": "sess-0001", "at": old}}})
	})
	eq(t, numOr0(kept.get("lastAt")), later, "이른 시각은 받지 않음")
	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"listed"}, "name": "맥", "sessions": []any{M{"id": "sess-0001", "at": float64(nowMs()) + 3_600_000}}})
	})
	eq(t, numOr0(kept.get("lastAt")), later, "너무 앞선 시각은 받지 않음")
	withLock(func() {
		helloFromAgent("u1", "h1", M{"t": "hello", "caps": []any{"listed"}, "name": "맥", "sessions": []any{M{"id": "sess-0001", "at": "어제"}}})
	})
	eq(t, numOr0(kept.get("lastAt")), later)
}

// AC-1850: the Mac's last tidy report sent again (again: true) is shown, with no notice or summary from it.
func TestTidyReportAgain(t *testing.T) {
	_, _, _, _ = groupsSetup(t)
	t.Cleanup(func() { withLock(func() { delete(noticeCache, "u1"); delete(tidyReports, "h1") }) })
	var s1 *Sess
	stopAt := float64(nowMs()) + 3_600_000
	withLock(func() {
		s1 = newMeta("u1", "tidy-a1", "h1", M{})
		sessions.Set(s1.id(), s1)
		delete(noticeCache, "u1")
		fromAgent["tidyReport"]("u1", "h1", M{"t": "tidyReport", "again": true, "report": M{"at": float64(nowMs()), "mode": "auto", "local": M{"date": "2026-11-25", "hour": 12.0}, "sessions": []any{M{"sid": "tidy-a1", "act": "notice", "stopAt": stopAt, "idleDays": 3.0}}, "done": M{"stopped": []any{M{"sid": "tidy-a1", "idleDays": 3.0}}}, "would": M{}}})
	})
	ok(t, tidyReports["h1"] != nil, "보고를 둠")
	eq(t, numOr0(s1.get("tidyStopAt")), stopAt, "내릴 시각은 받음")
	eq(t, len(noticesOf("u1", nil)), 0, "다시 받은 보고로 알림을 만들지 않음")
	ok(t, hosts.Val("h1")["tidySummary"] == nil, "요약에 다시 세지 않음")
}
