package main

import (
	"strings"
	"testing"
)

// 휴면은 claude 를 내린다 (REQ-F-501, 1.396). The way through the Mac (tidyStop, open) is in test/unit/rest.test.mjs.

func TestRestRefusals(t *testing.T) {
	meta := hookSession(t, "")
	// A session handed work closes itself once it answers (AC-1546).
	withLock(func() { meta.set("delegatedBy", "p1") })
	code, body := pageCall(t, "POST", "/api/sessions/s1/settings", `{"resting":true}`)
	eq(t, code, 409)
	ok(t, strings.Contains(body, "맡겨진 일을 하는 세션이라"), body)
	withLock(func() {
		ok(t, !truthy(meta.get("resting")), "거절이면 표시도 그대로")
		meta.del("delegatedBy")
		meta.set("autoPush", false)
		meta.set("moving", M{"to": "h1", "at": float64(nowMs())})
	})
	code, body = pageCall(t, "POST", "/api/sessions/s1/settings", `{"resting":true,"autoPush":true}`)
	eq(t, code, 409)
	ok(t, strings.Contains(body, "옮기는 중이라"), body)
	withLock(func() {
		ok(t, !truthy(meta.get("resting")) && meta.get("autoPush") == false, "거절이면 다른 설정도 바꾸지 않음")
		meta.set("moving", nil)
	})
	eq(t, restRefusal("작업 중"), "작업 중이라 지금은 휴면할 수 없어요. 턴이 끝난 뒤에 해 주세요")
	eq(t, restRefusal("잠긴 세션"), "지금은 휴면할 수 없어요: 잠긴 세션")
}

func TestRestAlreadyDownOnlyMarks(t *testing.T) {
	meta := hookSession(t, "")
	// claude already stopped (the tidy, a crash): nothing to ask the Mac (AC-1549). Its stream would never answer here.
	withLock(func() {
		meta.set("state", M{"alive": false, "phase": "ended"})
		meta.set("tidyStopAt", float64(nowMs()))
	})
	code, _ := pageCall(t, "POST", "/api/sessions/s1/settings", `{"resting":true}`)
	eq(t, code, 200)
	withLock(func() {
		ok(t, truthy(meta.get("resting")), "휴면 표시")
		ok(t, meta.get("tidyStopAt") == nil, "예고는 지움")
		ok(t, !truthy(meta.get("closed")), "끝내지 않음")
		// Not ended: the 7-day sweep of 이어서 하기 (REQ-F-742) leaves it (AC-1548).
		meta.set("lastAt", float64(nowMs())-30*86_400_000)
		eq(t, sweepEnded(float64(nowMs())+8*86_400_000), 0)
		_, still := sessions.Get("s1")
		ok(t, still, "휴면 세션은 7일 뒤에도 목록에 남음")
	})
	// Woken while its Mac is away: only the mark goes, the next message opens it.
	withLock(func() { bridges.Delete("h1") })
	code, _ = pageCall(t, "POST", "/api/sessions/s1/settings", `{"resting":false}`)
	eq(t, code, 200)
	withLock(func() { ok(t, !truthy(meta.get("resting")), "휴면 풀림") })
}

func TestRestHostAway(t *testing.T) {
	meta := hookSession(t, "")
	withLock(func() { bridges.Delete("h1") })
	code, body := pageCall(t, "POST", "/api/sessions/s1/settings", `{"resting":true}`)
	eq(t, code, 409)
	ok(t, strings.Contains(body, "맥이 연결돼 있지 않아"), body)
	withLock(func() {
		ok(t, !truthy(meta.get("resting")), "claude 가 살아 있는데 맥이 없으면 표시도 그대로")
	})
}
