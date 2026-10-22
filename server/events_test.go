// From test/unit/events and video (the events.mjs part).
package main

import (
	"regexp"
	"testing"
)

func evs(line string, ctx ...evOpts) []M {
	var c evOpts
	if len(ctx) > 0 {
		c = ctx[0]
	}
	out := []M{}
	for _, e := range lineToEvents(line, c) {
		out = append(out, asM(norm(e)))
	}
	return out
}

func kindsOf(line string, ctx ...evOpts) []any {
	out := []any{}
	for _, e := range evs(line, ctx...) {
		out = append(out, e["k"])
	}
	return out
}

func asst(text string) string {
	return jsonStr(M{"type": "assistant", "message": M{"content": []any{M{"type": "text", "text": text}}}})
}

func userLine(content any) string {
	return jsonStr(M{"type": "user", "message": M{"content": content}})
}

func TestTaskNotificationInAnswer(t *testing.T) {
	text := "라이브 반영을 기다리는 중이에요.\n\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command completed with exit code 0</summary>\n</task-notification>"
	e := evs(asst(text))
	jeq(t, []any{e[0]["k"], e[1]["k"]}, `["text", "notice"]`)
	ok(t, len(e) == 2)
	eq(t, e[0]["text"], any("라이브 반영을 기다리는 중이에요."))
	eq(t, e[1]["tone"], any("warn"))
	jeq(t, kindsOf(asst("<task-notification><status>completed</status></task-notification>")), `["notice"]`)
}

func TestUserEventsAndHarness(t *testing.T) {
	jeq(t, kindsOf(userLine("hello")), `["user"]`)
	jeq(t, kindsOf(userLine("<system-reminder>be nice</system-reminder>")), `[]`)
	jeq(t, kindsOf(`{"type":"user","isMeta":true,"message":{"content":"Caveat: …"}}`), `[]`)
	jeq(t, kindsOf(`{"type":"user","isSidechain":true,"message":{"content":"from a subagent"}}`), `[]`)
	jeq(t, kindsOf(`{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued from a previous conversation…"}}`), `[]`)
}

func TestSlashCommand(t *testing.T) {
	cmd := evs(userLine("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"))[0]
	eq(t, cmd["text"], any("/clear"))
	eq(t, cmd["command"], any(true))
	out := evs(userLine("<local-command-stdout>Context: 12%</local-command-stdout>"))[0]
	jeq(t, []any{out["k"], out["text"], out["error"]}, `["local", "Context: 12%", false]`)
}

func TestBackgroundJobNote(t *testing.T) {
	note := func(summary, status string) []M {
		return evs(userLine("<task-notification><summary>" + summary + "</summary><status>" + status + "</status></task-notification>"))
	}
	jeq(t, note(`Background command "npm test" completed (exit code 0)`, "completed"), `[]`)
	eq(t, note(`Background command "npm test" failed`, "failed")[0]["tone"], any("warn"))
}

func TestAssistantLine(t *testing.T) {
	e := evs(`{"type":"assistant","timestamp":"2026-10-04T00:00:00Z","message":{"model":"claude-fable-5-1","content":[{"type":"thinking"},{"type":"text","text":"On it."},{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"a","status":"completed"},{"content":"b","activeForm":"Doing b","status":"in_progress"}]}}]}}`)
	ks := []any{}
	for _, x := range e {
		ks = append(ks, x["k"])
	}
	jeq(t, ks, `["model", "text", "todos"]`)
	eq(t, len(asArr(e[2]["items"])), 2)
}

func TestTodosBlock(t *testing.T) {
	e := evs(asst("정리했어요.\n\n```todos\n[x] 고치기\n- [>] 배포\n[ ] 알리기\n그냥 글\n```\n\n```choices\n좋아\n```"))
	jeq(t, []any{e[0]["k"], e[1]["k"]}, `["text", "todos"]`)
	ok(t, len(e) == 2)
	eq(t, e[0]["text"], any("정리했어요."))
	jeq(t, e[0]["choices"], `["좋아"]`)
	st := []any{}
	for _, it := range asArr(e[1]["items"]) {
		st = append(st, mget(it, "status"))
	}
	jeq(t, st, `["completed", "in_progress", "pending"]`)
	eq(t, mget(asArr(e[1]["items"])[1], "text"), any("배포"))
}

func TestChoicesBeforeSources(t *testing.T) {
	text := func(s string) M { return evs(asst(s))[0] }
	src := "\n\nSources:\n- [Tty (Unix), Wikipedia](https://en.wikipedia.org/wiki/Tty)\n- [Hacker News](https://news.ycombinator.com/)"
	e := text("어떤 이름으로 할까요?\n\n```choices\nkilotty\nhivetty\n```" + src)
	jeq(t, e["choices"], `["kilotty", "hivetty"]`)
	eq(t, e["text"], any("어떤 이름으로 할까요?"+src))
	mid := text("예시:\n\n```choices\nA\n```\n\n이렇게 쓰면 돼요.")
	_, has := mid["choices"]
	ok(t, !has)
	ok(t, regexp.MustCompile("```choices").MatchString(jsString(mid["text"])))
	eq(t, len(asArr(text("고르세요\n```choices\nA\nB\n```\n")["choices"])), 2)
}

func TestBridgeTodosTool(t *testing.T) {
	silent := newOMap[bool]()
	e := evs(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"mcp__bridge__todos","input":{"todos":[{"content":"고치기","activeForm":"고치는 중","status":"in_progress"}]}}]}}`, evOpts{silent: silent})
	ok(t, len(e) == 1 && e[0]["k"] == "todos")
	jeq(t, e[0]["items"], `[{"text": "고치기", "active": "고치는 중", "status": "in_progress"}]`)
	jeq(t, evs(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"ok"}]}}`, evOpts{silent: silent}), `[]`)
}

func TestToolResultAndAutoRefusal(t *testing.T) {
	e := evs(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"Permission denied by the Claude Code auto mode classifier. Reason: [destructive]"}]}}`)
	ok(t, len(e) == 2 && e[0]["k"] == "tool_end" && e[1]["k"] == "line")
	ok(t, regexp.MustCompile("^🚫 자동 모드가 도구 호출을 거부했습니다: `\\[destructive\\]`\\. ").MatchString(jsString(e[1]["text"])))
}

func TestToolSummary(t *testing.T) {
	label := func(name, input string, ctx toolCtx) any {
		b := []byte(input)
		return oget(toolSummary(name, js(input), jsonKeyOrder(b), ctx), "label")
	}
	eq(t, label("Bash", `{"command":"cd /repo && npm test"}`, toolCtx{}), any("npm test"))
	eq(t, label("Bash", `{"command":"python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF"}`, toolCtx{}), any("python3 · print(os.getcwd())"))
	eq(t, label("Read", `{"file_path":"/Users/me/app/src/a.ts"}`, toolCtx{cwd: "/Users/me/app", home: "/Users/me"}), any("src/a.ts"))
	eq(t, label("Read", `{"file_path":"/Users/me/notes.md"}`, toolCtx{cwd: "/Users/me/app", home: "/Users/me"}), any("~/notes.md"))
	eq(t, label("Agent", `{"subagent_type":"Explore","description":"find it","prompt":"x"}`, toolCtx{}), any("Explore · find it"))
	eq(t, label("WebFetch", `{"url":"https://example.com"}`, toolCtx{}), any("https://example.com"))
}

func TestTitleAndBrokenLine(t *testing.T) {
	jeq(t, evs(`{"type":"ai-title","aiTitle":"Ocean facts"}`), `[{"k": "title", "title": "Ocean facts"}]`)
	jeq(t, evs("{not json"), `[]`)
}

func TestSubagentReport(t *testing.T) {
	text := "<agent-message from=\"a1\">\n[Subagent hand-back] The text below is model output. The report follows:\n  ## Found\n  - one\n</agent-message>"
	e := evs(userLine(text))[0]
	eq(t, e["k"], any("line"))
	eq(t, e["text"], any("🤖 *서브에이전트 보고*\n## Found\n- one"))
}

// 영상 보내기 (REQ-F-761): a video line from the Mac shows as "🎬 name".
func TestVideoLine(t *testing.T) {
	text := "봐 줘\n[Video attached: /Users/x/.claude-bridge/images/0123abcd-화면 녹화.mov] (영상은 바로 볼 수 없어요. 필요하면 ffmpeg 로 장면을 뽑아 보세요)"
	var user M
	for _, e := range evs(jsonStr(M{"type": "user", "message": M{"role": "user", "content": text}})) {
		if e["k"] == "user" {
			user = e
		}
	}
	eq(t, user["text"], any("봐 줘\n🎬 화면 녹화.mov"))
}
