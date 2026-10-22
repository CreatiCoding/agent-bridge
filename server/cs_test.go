// From test/unit/cs-cards.
package main

import (
	"strings"
	"testing"
)

func csBlocks(m M) []any { return asArr(norm(m["blocks"])) }

func csLabels(m M) []any {
	out := []any{}
	for _, b := range csBlocks(m) {
		if mget(b, "type") == "actions" {
			for _, e := range asArr(mget(b, "elements")) {
				out = append(out, mget(mget(e, "text"), "text"))
			}
			break
		}
	}
	return out
}

func TestPlanCardWording(t *testing.T) {
	card := js(`{ "id": "c1", "kind": "plan", "plan": "do it", "options": [{ "n": 1, "label": "Yes, clear context and auto-accept edits" }, { "n": 2, "label": "Yes, and manually approve edits" }, { "n": 3, "label": "No, keep planning" }] }`).(M)
	jeq(t, csLabels(cardMessage(card, 1001.0)), `["✅ 승인 · 편집 자동 승인", "✅ 승인 · 편집 수동 승인", "✏️ 아니오 · 계속 계획", "🖥 화면"]`)
	two := shallow(card)
	two["options"] = js(`[{ "n": 1, "label": "Yes, and auto-accept edits" }, { "n": 2, "label": "Yes, and switch to auto mode" }, { "n": 3, "label": "No, keep planning" }]`)
	jeq(t, csLabels(cardMessage(two, 1001.0)), `["1. Yes, and auto-accept edits", "2. Yes, and switch to auto mode", "✏️ 아니오 · 계속 계획", "🖥 화면"]`)
	for _, b := range csBlocks(cardMessage(card, 1001.0)) {
		if mget(b, "type") == "actions" {
			eq(t, mget(asArr(mget(b, "elements"))[1], "value"), any("1001:card c1 2"))
			break
		}
	}
}

func TestQuestionCard(t *testing.T) {
	card := js(`{ "id": "q1", "kind": "question", "title": "Which?", "header": "Size", "multi": true, "options": [{ "n": 1, "label": "S" }, { "n": 2, "label": "L" }] }`).(M)
	m := cardMessage(card, 7.0)
	found := false
	for _, b := range csBlocks(m) {
		s, _ := mget(mget(b, "text"), "text").(string)
		if strings.HasPrefix(s, "*[Size] Which?*") && strings.Contains(s, "복수 선택") {
			found = true
		}
	}
	ok(t, found)
	jeq(t, csLabels(m), `["1. S", "2. L", "확정 (Enter)"]`)
}

func TestFoldedMessage(t *testing.T) {
	f := func(card, result string) any { return foldedMessage(js(card).(M), result)["text"] }
	eq(t, f(`{ "kind": "permission", "tool": { "name": "Bash" } }`, "허용"), any("✅ Bash · 허용"))
	eq(t, f(`{ "kind": "permission", "tool": { "name": "Bash" } }`, "거부"), any("⛔ Bash · 거부"))
	eq(t, f(`{ "kind": "question", "title": "Which?" }`, "선택: Blue"), any("☑️ 선택: *Blue*"))
	eq(t, f(`{ "kind": "question" }`, "메시지로 답함"), any("💬 메시지로 답함"))
	eq(t, f(`{ "kind": "keyed" }`, "이미 닫힌 창"), any("⌨️ 이미 닫힌 창"))
}

func TestCardInsideSlackLimits(t *testing.T) {
	sections := func(m M) []string {
		out := []string{}
		for _, b := range csBlocks(m) {
			if mget(b, "type") == "section" {
				out = append(out, jsString(mget(mget(b, "text"), "text")))
			}
		}
		return out
	}
	long := "echo " + strings.Repeat("x", 5000)
	bash := M{"id": "c1", "kind": "permission", "tool": M{"name": "Bash", "input": M{"command": long}}, "options": []any{M{"n": 1.0, "kind": "allow-once", "label": "Yes"}}}
	edit := M{"id": "c2", "kind": "permission", "tool": M{"name": "Edit", "input": M{"file_path": "/a/b.ts", "old_string": strings.Repeat("a\n", 3000), "new_string": strings.Repeat("b\n", 3000)}}, "options": []any{}}
	for _, m := range []M{cardMessage(bash, 1.0), cardMessage(edit, 1.0), autoAllowMessage(bash), autoAllowMessage(edit)} {
		for _, s := range sections(m) {
			ok(t, jsLen(s) <= 3000, "섹션 "+itoa(jsLen(s))+"자")
			eq(t, strings.Count(s, "```")%2, 0, "코드 블록이 닫혀 있음")
		}
	}
	ok(t, strings.HasSuffix(fit("```\n"+strings.Repeat("y", 4000), 0), "…\n```"))
	eq(t, jsLen(fit(strings.Repeat("z", 4000), 0)), 2996)
	plan := cardMessage(M{"id": "p", "kind": "plan", "plan": strings.Repeat("p", 200000), "options": []any{M{"n": 1.0, "label": "Yes, auto-accept"}}}, 1.0)
	ok(t, len(csBlocks(plan)) <= 50, "블록 "+itoa(len(csBlocks(plan)))+"개")
	jeq(t, autoLine(M{"tool": M{"name": "Bash", "input": M{"command": "rm -rf ~/x", "description": "작업 폴더 정리"}}}), `{"name": "Bash", "what": "작업 폴더 정리", "desc": true}`)
	jeq(t, autoLine(M{"tool": M{"name": "Bash", "input": M{"command": "rm -rf ~/x"}}}), `{"name": "Bash", "what": "", "desc": false}`)
	jeq(t, autoLine(M{"tool": M{"name": "Edit", "input": edit["tool"].(M)["input"]}}), `{"name": "Edit", "what": "b.ts", "desc": false}`)
	jeq(t, autoLine(M{"tool": M{"name": "WebFetch", "input": M{"url": "https://docs.slack.dev/a?token=1"}}}), `{"name": "WebFetch", "what": "docs.slack.dev", "desc": false}`)
	eq(t, autoLine(M{"tool": M{"name": "mcp__dokploy__application-one", "input": M{}}})["name"], any("dokploy application-one"))
	eq(t, jsLen(jsString(autoLine(M{"tool": M{"name": "Bash", "input": M{"description": strings.Repeat("d", 500)}}})["what"])), 100)
}
