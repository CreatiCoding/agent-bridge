package main

import (
	"os"
	"regexp"
	"testing"
)

// AC-1510: off by default; every worker gets its default model and effort, and a value that is not as expected
// falls back to the default instead of being kept.
func TestRoutingClean(t *testing.T) {
	d := cleanRouting(nil)
	ok(t, d["on"] == false, "기본은 꺼짐")
	eq(t, d["subagentModel"], "sonnet")
	w := d["workers"].(M)
	eq(t, len(w), 6)
	jeq(t, w["checker"], `{"effort":"low","model":"haiku"}`, "checker 기본")
	jeq(t, w["Explore"], `{"effort":"medium","model":"haiku"}`, "Explore 기본")
	jeq(t, w["reviewer"], `{"effort":"medium","model":"opus"}`, "reviewer 기본")
	c := cleanRouting(js(`{"on":true,"subagentModel":"x y","workers":{"checker":{"model":"sonnet","effort":"high"},"ops-runner":{"model":"a;rm -rf","effort":"huge"},"stranger":{"model":"opus"}}}`))
	ok(t, c["on"] == true, "켜짐")
	eq(t, c["subagentModel"], "sonnet", "틀린 기본 모델은 sonnet")
	cw := c["workers"].(M)
	jeq(t, cw["checker"], `{"effort":"high","model":"sonnet"}`, "고른 값")
	jeq(t, cw["ops-runner"], `{"effort":"low","model":"sonnet"}`, "틀린 값은 기본")
	ok(t, cw["stranger"] == nil, "모르는 일꾼은 버림")
	// on must be the boolean true.
	ok(t, cleanRouting(js(`{"on":"yes"}`))["on"] == false, "참·거짓만")
}

// AC-1511: off, a command that starts claude carries nothing (nil); on, the whole routing. Saved through the API.
func TestRoutingAPI(t *testing.T) {
	// The prefs are written under a folder of the test's own, never the checkout.
	keepD := DATA
	t.Cleanup(func() { DATA = keepD; delete(prefsCache, "gh1") })
	DATA = t.TempDir()
	delete(prefsCache, "gh1")
	code, body := callAPI(t, "GET", "/api/prefs/routing", "")
	eq(t, code, 200)
	ok(t, oget(js(body), "on") == false, body)
	ok(t, oget(js(body), "defaults") != nil, body)
	ok(t, routingCmd("gh1") == nil, "꺼져 있으면 nil")
	code, body = callAPI(t, "POST", "/api/prefs/routing", `{"on":true,"subagentModel":"haiku","workers":{"researcher":{"model":"opus","effort":"max"}}}`)
	eq(t, code, 200, body)
	r, isM := routingCmd("gh1").(M)
	ok(t, isM && r["on"] == true && r["subagentModel"] == "haiku", "켜면 명령에 실림")
	jeq(t, r["workers"].(M)["researcher"], `{"effort":"max","model":"opus"}`)
	code, _ = callAPI(t, "POST", "/api/prefs/routing", `{"on":false}`)
	eq(t, code, 200)
	ok(t, routingCmd("gh1") == nil, "다시 끄면 nil")
	code, _ = callAPI(t, "DELETE", "/api/prefs/routing", "")
	eq(t, code, 405)
}

// AC-1511: every command that starts claude (새 세션, 다시 열기·옮기기, 이어받기, 복제, 가벼운 복제, 새로고침) carries the
// routing next to the system prompt.
func TestRoutingInEveryLaunch(t *testing.T) {
	want := map[string]*regexp.Regexp{
		"session.go": regexp.MustCompile(`"t": "new", "sid": sid, "sysPrompt": sysPromptOf\(uid\), "routing": routingCmd\(uid\)`),
		"api2.go":    regexp.MustCompile(`"t": "adopt".*"routing": routingCmd\(uid\)`),
		"api3.go":    regexp.MustCompile(`"t": "fork".*"routing": routingCmd\(uid\)`),
		"pageapi.go": regexp.MustCompile(`"t": "refresh".*"routing": routingCmd\(uid\)`),
	}
	for f, re := range want {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		ok(t, re.Match(b), f)
	}
	b, _ := os.ReadFile("session.go")
	ok(t, regexp.MustCompile(`"t": "open", "sysPrompt": sysPromptOf\(meta.uid\(\)\), "routing": routingCmd\(meta.uid\(\)\)`).Match(b), "open")
	b, _ = os.ReadFile("api3.go")
	ok(t, regexp.MustCompile(`"t": "lightfork".*"routing": routingCmd\(uid\)`).Match(b), "lightfork")
}
