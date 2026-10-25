package main

// The key-state fields the server passes on (from stale-key.test.mjs, AC-1333) and whether a session has the bridge
// todos tool (from todos-tool.test.mjs, AC-1354).

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"testing"
	"time"
)

func TestCleanKeyState(t *testing.T) {
	now := float64(time.Now().UnixMilli())
	out := cleanKeyState(M{"gen": 2.0, "latest": 2.0, "at": now, "oldUntil": nil, "next": now, "retired": 1.0, "linked": "current", "stale": M{"at": now, "app": "com.google.Chrome", "key": "K"}, "reopen": M{"at": now, "app": "com.google.Chrome", "ok": true}, "key": "SECRET", "print": "abc"})
	want := M{"gen": 2.0, "latest": 2.0, "at": now, "oldUntil": nil, "next": now, "retired": 1.0, "linked": "current", "stale": M{"at": now, "app": "com.google.Chrome"}, "reopen": M{"at": now, "app": "com.google.Chrome", "ok": true}}
	if !reflect.DeepEqual(roundTrip(out), roundTrip(want)) {
		t.Fatal(jsonStr(out))
	}
	if cleanKeyState(nil) != nil {
		t.Fatal("nil")
	}
	if mget(cleanKeyState(M{"linked": "x", "stale": M{"at": "no"}, "reopen": M{"at": now, "app": "<script>"}}), "linked") != nil {
		t.Fatal("linked")
	}
	if mget(cleanKeyState(M{"stale": M{"at": "no"}}), "stale") != nil {
		t.Fatal("stale")
	}
	if r := mget(cleanKeyState(M{"reopen": M{"at": now, "app": "<script>"}}), "reopen"); r == nil || mget(r, "app") != nil {
		t.Fatal("reopen.app")
	}
	src, _ := os.ReadFile("pageapi.go")
	if !regexp.MustCompile(`"key": cleanKeyState\(health\["keyState"\]\)`).Match(src) {
		t.Fatal("hostSummary 가 cleanKeyState 를 거치지 않음")
	}
}

func TestTrackTodosTool(t *testing.T) {
	seen := func(lines ...any) bool {
		meta := &Sess{m: M{}}
		for _, l := range lines {
			s, ok := l.(string)
			if !ok {
				b, _ := json.Marshal(l)
				s = string(b)
			}
			trackTodosTool(meta, s)
		}
		return truthy(meta.get("sawTodosTool"))
	}
	// The request "지금까지 한 일로 정리" names the tool: that is not the tool.
	if seen(map[string]any{"type": "user", "message": map[string]any{"content": "`mcp__bridge__todos` 도구가 있으면 그 도구로 보내고"}}) {
		t.Fatal(1)
	}
	if seen(map[string]any{"type": "attachment", "attachment": map[string]any{"type": "deferred_tools_delta", "addedNames": []any{"mcp__bridge__hosts", "mcp__bridge__delegate"}}}) {
		t.Fatal(2)
	}
	if seen("not json mcp__bridge__todos") {
		t.Fatal(3)
	}
	if !seen(map[string]any{"type": "attachment", "attachment": map[string]any{"type": "deferred_tools_delta", "addedNames": []any{"mcp__bridge__hosts", "mcp__bridge__todos"}}}) {
		t.Fatal(4)
	}
	if !seen(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "mcp__bridge__todos", "input": map[string]any{"todos": []any{}}}}}}) {
		t.Fatal(5)
	}
	ev, _ := os.ReadFile("eventlog.go")
	if !regexp.MustCompile(`func trackBackground\(meta \*Sess, line string\) \{\n\ttrackTodosTool\(meta, line\)`).Match(ev) {
		t.Fatal("trackBackground 가 trackTodosTool 부터 부르지 않음")
	}
	am, _ := os.ReadFile("agentmsg.go")
	if !regexp.MustCompile(`msg\["bridgeTools"\]\.\(\[\]any\)`).Match(am) {
		t.Fatal("bridgeTools 를 배열일 때만 받지 않음")
	}
}
