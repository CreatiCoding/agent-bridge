package main

import (
	"strings"
	"testing"
)

// AC-1844: 사이트로 돌아가기 (REQ-F-925). Only a local server answers it, and it asks only the person's own linked Macs;
// /api/me says localFull only there.
func TestLocalBack(t *testing.T) {
	h1, h2, _, _ := groupsSetup(t)
	keep := LOCAL
	t.Cleanup(func() { LOCAL = keep })
	withLock(func() {
		hosts.Set("h1", M{"uid": "gh1", "name": "h1"})
		hosts.Set("h2", M{"uid": "someone", "name": "h2"})
	})
	LOCAL = false
	code, _ := callAPI(t, "POST", "/api/local/back", "{}")
	eq(t, code, 404, "사이트에서는 없음")
	_, hasLF := featuresOf()["localFull"]
	ok(t, !hasLF, "사이트의 features 에는 localFull 없음")
	eq(t, len(h1.sent), 0)

	LOCAL = true
	eq(t, featuresOf()["localFull"], true)
	code, body := callAPI(t, "POST", "/api/local/back", "{}")
	eq(t, code, 200, body)
	got := strings.Join(h1.sent, "")
	ok(t, strings.Contains(got, `"t":"localoff"`), "그 사람의 맥에 localoff: "+got)
	eq(t, len(h2.sent), 0, "남의 맥에는 안 감")

	withLock(func() { bridges.Delete("h1") })
	code, _ = callAPI(t, "POST", "/api/local/back", "{}")
	eq(t, code, 409, "연결된 맥이 없으면 409")
}
