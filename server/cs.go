// A session as the Slack plugin reads it (server/cs.mjs): a session row, an event, a decision as Slack blocks.
// Pure functions.
package main

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	SECTION_MAX   = 3000
	PLAN_SECTIONS = 40
	AUTO_WHAT     = 100
)

var threeTicks = regexp.MustCompile("`{3,}")
var tripleTick = regexp.MustCompile("```")

func truncS(v any, n int) string { return truncate(jsStringU(v), n) }

func csFence(text any, lang string) string {
	return "```" + lang + "\n" + truncate(threeTicks.ReplaceAllString(jsStringU(text), "'''"), 2700) + "\n```"
}

func fit(text string, n int) string {
	if n == 0 {
		n = SECTION_MAX
	}
	if jsLen(text) <= n {
		return text
	}
	cut := jsSliceTo(text, n-5)
	if len(tripleTick.FindAllString(cut, -1))%2 == 1 {
		return cut + "…\n```"
	}
	return cut + "…"
}

func csSection(text string) M {
	return M{"type": "section", "text": M{"type": "mrkdwn", "text": fit(text, 0)}}
}
func csContext(text string) M {
	return M{"type": "context", "elements": []any{M{"type": "mrkdwn", "text": text}}}
}
func csButton(text, actionID, value, style string) M {
	b := M{"type": "button", "text": M{"type": "plain_text", "text": text, "emoji": true}, "action_id": actionID, "value": value}
	if style != "" {
		b["style"] = style
	}
	return b
}

// threadOf: a session's thread key in Slack's form (`seconds.micros`).
func threadOf(meta M) string {
	id := strings.ReplaceAll(mstr(meta, "id"), "-", "")
	n, _ := strconv.ParseInt(jsSliceTo(id, 8), 16, 64)
	tail := padStart(strconv.FormatInt(n%1_000_000, 10), 6, "0")
	return numStr(math.Floor(jsNumber(meta["createdAt"])/1000)) + "." + tail
}

var WAITING = map[string]string{"권한 요청": "권한 대기", "질문": "질문 대기", "플랜 승인": "플랜 승인 대기", "지시 대기": "지시 대기", "터미널 확인": "터미널 확인 대기"}
var TOOL_EMOJI = map[string]string{"Bash": "⚙️", "Edit": "✏️", "Write": "📝", "Read": "📖", "Grep": "🔍", "Glob": "🔍", "Agent": "🤖", "Task": "🤖", "TodoWrite": "📋", "Skill": "🧩", "WebFetch": "🌐", "WebSearch": "🌐", "NotebookEdit": "✏️"}

var ruleBad = regexp.MustCompile("[|;&`$\n]")

func rulePreview(tool M) any {
	i := asM(tool["input"])
	name := jsStringU(tool["name"])
	if tool["name"] == nil {
		name = ""
	}
	switch name {
	case "Bash":
		cmd := ""
		if i["command"] != nil {
			cmd = jsTrim(jsString(i["command"]))
		}
		if cmd == "" || ruleBad.MatchString(cmd) {
			return nil
		}
		parts := wsSplit(cmd)
		a := parts[0]
		b := ""
		if len(parts) > 1 {
			b = parts[1]
		}
		extra := ""
		if contains([]string{"git", "npm", "yarn", "pnpm", "docker", "kubectl", "gh", "make", "cargo", "go", "pip", "brew"}, a) && b != "" && !strings.HasPrefix(b, "-") {
			extra = " " + b
		}
		return "Bash(" + a + extra + ":*)"
	case "Edit", "Write", "Read":
		fp := "…"
		if i["file_path"] != nil {
			fp = jsString(i["file_path"])
		}
		return name + "(" + fp + ")"
	case "WebFetch":
		u, err := url.Parse(jsStringU(i["url"]))
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil
		}
		return "WebFetch(domain:" + u.Host + ")"
	}
	if strings.HasPrefix(name, "mcp__") {
		return name
	}
	return nil
}

func wsSplit(s string) []string {
	parts := re(`\s+`).Split(s, -1)
	if len(parts) == 0 {
		return []string{""}
	}
	return parts
}

func permissionDetail(card M) []any {
	tool := asM(card["tool"])
	i, hasInput := tool["input"].(M)
	name := tool["name"]
	if !hasInput || i == nil {
		if truthy(card["context"]) {
			return []any{csSection(csFence(truncS(card["context"], 2500), ""))}
		}
		return []any{}
	}
	if old, ok := i["old_string"].(string); ok && name == "Edit" {
		lines := []string{}
		for _, l := range strings.Split(old, "\n") {
			lines = append(lines, "- "+l)
		}
		nw := ""
		if i["new_string"] != nil {
			nw = jsString(i["new_string"])
		}
		for _, l := range strings.Split(nw, "\n") {
			lines = append(lines, "+ "+l)
		}
		ra := ""
		if truthy(i["replace_all"]) {
			ra = " _(모두 바꾸기)_"
		}
		return []any{csSection("`" + jsStringU(i["file_path"]) + "`" + ra + "\n" + csFence(strings.Join(lines, "\n"), "diff"))}
	}
	if content, ok := i["content"].(string); ok && name == "Write" {
		lines := strings.Split(content, "\n")
		more := ""
		if len(lines) > 20 {
			more = " (앞 20줄)"
		}
		head := lines
		if len(head) > 20 {
			head = head[:20]
		}
		return []any{csSection("`" + jsStringU(i["file_path"]) + "` · " + itoa(len(lines)) + "줄" + more + "\n" + csFence(strings.Join(head, "\n"), ""))}
	}
	if cmd, ok := i["command"].(string); ok && name == "Bash" {
		return []any{csSection(csFence(cmd, "bash"))}
	}
	if truthy(card["context"]) {
		return []any{csSection(csFence(truncS(card["context"], 2500), ""))}
	}
	return []any{csSection(csFence(truncate(jsonIndent(i, 1), 2500), ""))}
}

func cardOptions(card M) []any { return asArr(card["options"]) }

// cardMessage: a decision the terminal waits for, as the Slack message to post.
func cardMessage(card M, pid any) M {
	pidS := jsStringU(pid)
	val := func(n any) string { return pidS + ":card " + jsStringU(card["id"]) + " " + jsStringU(n) }
	opt := func(kind string) M {
		for _, o := range cardOptions(card) {
			if mget(o, "kind") == kind {
				return asM(o)
			}
		}
		return nil
	}
	tool := asM(card["tool"])
	switch card["kind"] {
	case "permission":
		name := any("도구")
		if tool["name"] != nil {
			name = tool["name"]
		}
		allow, always, deny := opt("allow-once"), opt("allow-always"), opt("deny")
		var rule any
		if always != nil {
			rule = rulePreview(tool)
		}
		desc := mget(tool["input"], "description")
		if desc == nil {
			desc = card["description"]
		}
		if desc == nil {
			desc = card["title"]
		}
		if desc == nil {
			desc = ""
		}
		blocks := []any{csSection("🔐 *" + jsStringU(name) + "* 권한 요청\n" + truncS(desc, 500))}
		blocks = append(blocks, permissionDetail(card)...)
		if rule != nil {
			blocks = append(blocks, csContext("항상 허용을 누르면 `"+jsString(rule)+"` 규칙이 기록됩니다 (예상)"))
		}
		els := []any{}
		if allow != nil {
			els = append(els, csButton("허용", "perm_allow", val(allow["n"]), "primary"))
		}
		if always != nil {
			els = append(els, csButton("항상 허용", "perm_always", val(always["n"]), ""))
		}
		if deny != nil {
			els = append(els, csButton("거부", "perm_deny", val(deny["n"]), "danger"))
		}
		blocks = append(blocks, M{"type": "actions", "block_id": "perm_" + pidS + "_" + jsStringU(card["id"]), "elements": els})
		return M{"text": "🔐 권한 요청 · " + jsStringU(name), "blocks": blocks}
	case "stuck":
		text := "⏸️ 작업이 중단된 채 다음 지시를 기다리고 있습니다. 이어서 하려면 *계속해* 를 누르거나 새 지시를 쓰세요."
		return M{"text": text, "blocks": []any{csSection(text), M{"type": "actions", "block_id": "stuck_" + pidS, "elements": []any{csButton("▶️ 계속해", "ctl_btn", pidS+":continue", "primary"), csButton("🖥 화면", "ctl_btn", pidS+":screen", "")}}}}
	case "keyed":
		options := cardOptions(card)
		if len(options) > 5 {
			options = options[:5]
		}
		title := ""
		if card["title"] != nil {
			title = jsString(card["title"])
		}
		blocks := []any{csSection("⌨️ *터미널이 입력을 기다립니다*\n" + truncate(title, 500))}
		if truthy(card["description"]) {
			blocks = append(blocks, csSection(csFence(truncS(card["description"], 1500), "")))
		}
		if truthy(card["footer"]) {
			blocks = append(blocks, csContext(truncS(card["footer"], 300)))
		}
		sel := 0.0
		if card["selected"] != nil {
			sel = jsNumber(card["selected"])
		}
		els := []any{}
		for k, o := range options {
			style := ""
			if float64(k) == sel {
				style = "primary"
			}
			els = append(els, csButton(truncS(mget(o, "label"), 75), "dlg_key", val(mget(o, "n")), style))
		}
		els = append(els, csButton("취소 (Esc)", "dlg_key", pidS+":card "+jsStringU(card["id"])+" esc", ""))
		blocks = append(blocks, M{"type": "actions", "block_id": "dlg_key_" + pidS, "elements": els})
		return M{"text": "⌨️ *터미널이 입력을 기다립니다*\n" + title, "blocks": blocks}
	}
	all := cardOptions(card)
	options := all
	if len(options) > 20 {
		options = options[:20]
	}
	dropped := len(all) - len(options)
	els := []any{}
	for k, o := range options {
		style := ""
		if card["kind"] == "plan" && k == 0 {
			style = "primary"
		}
		els = append(els, csButton(truncate(jsStringU(mget(o, "n"))+". "+jsStringU(mget(o, "label")), 75), "dlg_answer", val(mget(o, "n")), style))
	}
	buttons := M{"type": "actions", "block_id": "dlg_q0_" + pidS, "elements": els}
	described := []any{}
	for _, o := range options {
		if truthy(mget(o, "description")) {
			described = append(described, o)
		}
	}
	describedLine := func() string {
		parts := []string{}
		for _, o := range described {
			parts = append(parts, jsStringU(mget(o, "n"))+". "+jsStringU(mget(o, "description")))
		}
		return truncate(strings.Join(parts, " · "), 300)
	}
	if card["kind"] == "plan" {
		plan := ""
		if card["plan"] != nil {
			plan = jsString(card["plan"])
		}
		fixed := []struct {
			re    *regexp.Regexp
			label string
		}{{regexp.MustCompile(`(?i)auto-accept|auto mode`), "✅ 승인 · 편집 자동 승인"}, {regexp.MustCompile(`(?i)manually approve`), "✅ 승인 · 편집 수동 승인"}, {regexp.MustCompile(`(?i)^no\b|keep planning`), "✏️ 아니오 · 계속 계획"}}
		labels := make([]string, len(options))
		for k, o := range options {
			for _, f := range fixed {
				if f.re.MatchString(jsStringU(mget(o, "label"))) {
					labels[k] = f.label
					break
				}
			}
		}
		unique := func(l string) bool {
			n := 0
			for _, x := range labels {
				if x == l {
					n++
				}
			}
			return n == 1
		}
		pels := []any{}
		for k, o := range options {
			l := labels[k]
			text := truncate(jsStringU(mget(o, "n"))+". "+jsStringU(mget(o, "label")), 75)
			if l != "" && unique(l) {
				text = l
			}
			style := ""
			if k == 0 {
				style = "primary"
			}
			pels = append(pels, csButton(text, "dlg_answer", val(mget(o, "n")), style))
		}
		pels = append(pels, csButton("🖥 화면", "ctl_btn", pidS+":screen", ""))
		buttons["elements"] = pels
		blocks := []any{csSection("📋 *플랜 승인을 기다립니다.* 위에 스트리밍된 내용이 플랜입니다.")}
		n := int(math.Min(PLAN_SECTIONS, math.Ceil(float64(jsLen(plan))/2900)))
		for k := 0; k < n; k++ {
			blocks = append(blocks, csSection(jsSlice(plan, k*2900, (k+1)*2900)))
		}
		if jsLen(plan) > PLAN_SECTIONS*2900 {
			blocks = append(blocks, csContext("플랜이 길어 뒷부분은 생략했습니다 — 화면으로 확인하세요."))
		}
		blocks = append(blocks, buttons)
		if len(described) > 0 {
			blocks = append(blocks, csContext(describedLine()))
		}
		return M{"text": "📋 플랜 승인을 기다립니다", "blocks": blocks}
	}
	introParts := []string{}
	for _, x := range []any{card["context"], card["description"]} {
		if truthy(x) {
			introParts = append(introParts, jsString(x))
		}
	}
	intro := strings.Join(introParts, "\n")
	q := card["kind"] == "question"
	text := "❓ 터미널이 선택을 기다립니다"
	head := "❓ *터미널이 선택을 기다립니다*"
	if q {
		text = "❓ Claude가 선택을 기다립니다"
		head = "❓ *Claude가 선택을 기다립니다*"
	}
	blocks := []any{csSection(head)}
	if intro != "" {
		if truthy(card["context"]) {
			s := csFence(truncS(card["context"], 2500), "")
			if truthy(card["description"]) {
				s += "\n" + jsString(card["description"])
			}
			blocks = append(blocks, csSection(jsSliceTo(s, 2900)))
		} else {
			blocks = append(blocks, csContext(truncate(intro, 500)))
		}
	}
	header := ""
	if truthy(card["header"]) {
		header = "[" + jsString(card["header"]) + "] "
	}
	title := ""
	if card["title"] != nil {
		title = jsString(card["title"])
	}
	multi := ""
	if truthy(card["multi"]) {
		multi = " _(복수 선택: 번호를 차례로 누른 뒤 확정)_"
	}
	blocks = append(blocks, csSection("*"+header+truncate(title, 500)+"*"+multi))
	if truthy(card["multi"]) {
		b := shallow(buttons)
		b["elements"] = append(append([]any{}, els...), csButton("확정 (Enter)", "dlg_answer", pidS+":card "+jsStringU(card["id"])+" enter", "primary"))
		blocks = append(blocks, b)
	} else {
		blocks = append(blocks, buttons)
	}
	if len(described) > 0 {
		blocks = append(blocks, csContext(describedLine()))
	}
	if dropped > 0 {
		blocks = append(blocks, csContext("선택지 "+itoa(dropped)+"개는 너무 많아 생략했습니다 — 화면으로 확인하세요."))
	}
	return M{"text": text, "blocks": blocks}
}

var deniedResultRe = regexp.MustCompile(`^(거부|취소|확인 창이 이미|이미 닫힌 창|세션이 끝남)`)
var choseRe = regexp.MustCompile(`^선택: `)

func foldedMessage(card M, result any) M {
	r := "답함"
	if truthy(result) {
		r = jsString(result)
	}
	denied := deniedResultRe.MatchString(r)
	mark := "✅"
	if denied {
		mark = "⛔"
	}
	tool := asM(card["tool"])
	var text string
	switch {
	case card["kind"] == "permission" && truthy(tool["name"]):
		text = mark + " " + jsString(tool["name"]) + " · " + r
	case choseRe.MatchString(r):
		text = "☑️ 선택: *" + jsSliceFrom(r, 4) + "*"
	case r == "메시지로 답함":
		text = "💬 메시지로 답함"
	case card["kind"] == "keyed":
		text = "⌨️ " + r
	default:
		text = mark + " " + r
		if truthy(card["title"]) && card["kind"] != "stuck" {
			text += " · " + truncS(card["title"], 80)
		}
	}
	return M{"text": text, "blocks": []any{csSection(text)}}
}

func autoAllowMessage(card M) M {
	tool := asM(card["tool"])
	name := "터미널 확인 창"
	if tool["name"] != nil {
		name = jsString(tool["name"])
	}
	text := "⚡ 자동 허용 · *" + name + "*"
	if d := mget(tool["input"], "description"); truthy(d) {
		text += " · " + truncS(d, 200)
	}
	return M{"text": "⚡ 자동 허용 · " + name, "blocks": append([]any{csSection(text)}, permissionDetail(card)...)}
}

func autoLine(card M) M {
	tool := asM(card["tool"])
	raw := "터미널 확인 창"
	if tool["name"] != nil {
		raw = jsString(tool["name"])
	}
	name := raw
	if strings.HasPrefix(raw, "mcp__") {
		name = strings.Join(strings.Split(raw, "__")[1:], " ")
	}
	i := asM(tool["input"])
	one := func(s any) string { return truncate(strings.Split(jsTrim(jsStringU(s)), "\n")[0], AUTO_WHAT) }
	base := func(p any) string {
		s := jsStringU(p)
		parts := []string{}
		for _, x := range strings.Split(s, "/") {
			if x != "" {
				parts = append(parts, x)
			}
		}
		if len(parts) == 0 {
			return s
		}
		return parts[len(parts)-1]
	}
	host := ""
	if truthy(i["url"]) {
		if u, err := url.Parse(jsString(i["url"])); err == nil && u.Scheme != "" {
			host = u.Host
		}
	}
	what := ""
	switch {
	case truthy(i["description"]):
		what = one(i["description"])
	case truthy(i["file_path"]):
		what = base(i["file_path"])
	case truthy(i["notebook_path"]):
		what = base(i["notebook_path"])
	case host != "":
		what = host
	case truthy(i["pattern"]):
		what = one(i["pattern"])
	case truthy(i["query"]):
		what = one(i["query"])
	case truthy(i["skill"]):
		what = one(i["skill"])
	}
	return M{"name": name, "what": what, "desc": truthy(i["description"])}
}

type csOpts struct {
	pid   any
	cards *OMap[any]
	image func(id string) any
}

var imgExtType = map[string]string{"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}

func csImage(ctx csOpts, id any) M {
	s := jsStringU(id)
	info := M{}
	if ctx.image != nil {
		if x, ok := ctx.image(s).(M); ok {
			info = x
		}
	}
	parts := strings.Split(s, ".")
	typ := imgExtType[parts[len(parts)-1]]
	if typ == "" {
		typ = "image/png"
	}
	bytes := info["bytes"]
	if bytes == nil {
		bytes = 0.0
	}
	out := M{"id": id, "type": typ, "bytes": bytes, "src": "/api/img/" + s}
	if truthy(info["w"]) && truthy(info["h"]) {
		out["w"] = info["w"]
		out["h"] = info["h"]
	}
	if truthy(info["name"]) {
		out["name"] = info["name"]
	}
	return out
}

func csImages(ctx csOpts, list any) []any {
	out := []any{}
	for _, id := range asArr(list) {
		out = append(out, csImage(ctx, id))
	}
	return out
}

// toCsEvent: one stored event as the Slack plugin reads it, with the same seq.
func toCsEvent(e M, ctx csOpts) any {
	out := M{"seq": e["seq"], "at": e["at"]}
	set := func(kv ...any) M {
		for i := 0; i+1 < len(kv); i += 2 {
			out[kv[i].(string)] = kv[i+1]
		}
		return out
	}
	or := func(v, d any) any {
		if v == nil {
			return d
		}
		return v
	}
	seq := numStr(jsNumber(e["seq"]))
	if e["seq"] == nil {
		seq = "undefined"
	}
	switch e["k"] {
	case "user":
		set("type", "user", "ts", or(e["id"], "u"+seq), "text", or(e["text"], ""), "via", or(e["via"], "terminal"))
		if len(asArr(e["images"])) > 0 {
			out["images"] = csImages(ctx, e["images"])
		}
		return out
	case "text":
		set("type", "text", "ts", "t"+seq, "text", e["text"])
		if truthy(e["choices"]) {
			out["choices"] = e["choices"]
		}
		return out
	case "tool":
		name := jsStringU(e["name"])
		emoji := TOOL_EMOJI[name]
		if emoji == "" {
			emoji = "🔧"
		}
		title := emoji + " " + name
		if truthy(e["label"]) {
			title += " " + jsString(e["label"])
		}
		set("type", "tool", "id", e["tool"], "name", e["name"], "title", title)
		if truthy(e["detail"]) {
			out["detail"] = e["detail"]
		}
		return out
	case "tool_end":
		set("type", "tool_end", "id", e["tool"], "ok", !truthy(e["error"]), "output", or(e["text"], ""))
		if len(asArr(e["images"])) > 0 {
			out["images"] = csImages(ctx, e["images"])
		}
		return out
	case "todos":
		todos := []any{}
		for _, t := range asArr(e["items"]) {
			todos = append(todos, orderedObj{{"content", mget(t, "text")}, {"status", mget(t, "status")}, {"activeForm", mget(t, "active")}}.dropNil())
		}
		return set("type", "todos", "todos", todos)
	case "local":
		pre := ""
		if truthy(e["error"]) {
			pre = "⚠️ 명령 오류\n"
		}
		return set("type", "msg", "ts", "l"+seq, "text", pre+csFence(e["text"], ""))
	case "held":
		ts := "held-" + jsStringU(e["id"])
		if !truthy(e["n"]) {
			return set("type", "msg_delete", "ts", ts)
		}
		pid := jsStringU(ctx.pid)
		text := "🕓 메시지 " + jsStringU(e["n"]) + "개를 붙잡고 있습니다. 실행 중인 도구가 끝나면 전달합니다."
		typ := "msg_update"
		if truthy(e["first"]) {
			typ = "msg"
		}
		return set("type", typ, "ts", ts, "text", text, "blocks", []any{csSection(text + "\n_지금 보내면 실행 중인 작업을 끊고 바로 전달합니다 (터미널의 Ctrl+Enter)._"), M{"type": "actions", "block_id": "held_" + pid, "elements": []any{csButton("⚡ 지금 보내기", "ctl_btn", pid+":sendnow", "primary"), csButton("취소", "ctl_btn", pid+":dropheld", "")}}})
	case "line":
		set("type", "msg", "ts", "m"+seq, "text", e["text"])
		if truthy(e["blocks"]) {
			out["blocks"] = e["blocks"]
		}
		return out
	case "notice":
		icon := e["icon"]
		if icon == nil {
			if e["tone"] == "warn" {
				icon = "alert"
			} else {
				icon = "bell"
			}
		}
		return set("type", "notice", "text", e["text"], "icon", icon)
	case "end":
		return set("type", "end", "why", or(e["text"], "종료"))
	case "status":
		set("type", "status", "state", e["phase"])
		if truthy(e["waiting"]) {
			out["waiting"] = e["waiting"]
		}
		return out
	case "react":
		return set("type", "react", "ts", e["id"], "name", e["name"], "on", truthy(e["on"]))
	case "side":
		typ := "msg"
		if truthy(e["update"]) {
			typ = "msg_update"
		}
		tail := ""
		if truthy(e["answer"]) {
			tail = "```" + truncate(strings.ReplaceAll(jsString(e["answer"]), "```", "'''"), 3800) + "```"
		} else if e["error"] != nil {
			tail = jsString(e["error"])
		} else {
			tail = "답을 기다리는 중…"
		}
		return set("type", typ, "ts", e["id"], "text", "옆길 질문 · 대화에는 남지 않아요 — "+truncS(e["q"], 120)+"\n"+tail)
	case "card":
		card := asM(e["card"])
		if ctx.cards != nil {
			ctx.cards.Set(jsStringU(card["id"]), card)
		}
		var msg M
		if truthy(card["auto"]) {
			msg = autoAllowMessage(card)
			out["auto"] = autoLine(card)
		} else {
			msg = cardMessage(card, ctx.pid)
		}
		set("type", "msg", "ts", card["id"])
		for k, v := range msg {
			out[k] = v
		}
		return out
	case "card_end":
		var card M
		if ctx.cards != nil {
			if c, ok := ctx.cards.Get(jsStringU(e["id"])); ok {
				card, _ = c.(M)
			}
		}
		set("type", "msg_update", "ts", e["id"])
		for k, v := range foldedMessage(card, e["result"]) {
			out[k] = v
		}
		return out
	}
	return set("type", "status", "state", "idle")
}

func mbOf(bytes float64) float64 { return jsRound(bytes/1e5) / 10 }

// toCsSession: a session as one row of the Slack plugin's list, plus which Mac it is on under `bridge`.
func toCsSession(meta M, at M) M {
	st := asM(meta["state"])
	moving := truthy(meta["moving"])
	reachable := truthy(at["online"]) && truthy(st["alive"]) && !moving
	state := any("idle")
	switch {
	case moving:
		state = "starting"
	case !reachable:
		state = "ended"
	case st["phase"] != nil:
		state = st["phase"]
	}
	var card M
	if c := asM(meta["card"]); truthy(c["open"]) && c["kind"] == "permission" {
		card = c
	}
	u := asM(st["usage"])
	now := float64(nowMs())
	out := M{"pid": at["pid"], "thread": at["thread"], "cwd": meta["cwd"], "state": state}
	setIf := func(k string, v any) {
		if truthy(v) {
			out[k] = v
		}
	}
	setIf("title", meta["title"])
	if state == "waiting" {
		w, ok := WAITING[jsStringU(st["waiting"])]
		if !ok {
			w = "터미널 확인 대기"
		}
		out["waiting"] = w
		setIf("waitingSince", st["waitingSince"])
	}
	if truthy(meta["launchModel"]) {
		out["model"] = meta["launchModel"]
	} else {
		setIf("model", meta["model"])
	}
	setIf("effort", st["effort"])
	setIf("permissionMode", st["mode"])
	setIf("contextLabel", st["context"])
	if u["context"] != nil {
		out["context"] = jsStringU(u["context"]) + "%"
	} else {
		setIf("context", st["context"])
	}
	if truthy(u["window"]) {
		w := jsNumber(u["window"])
		out["contextWindow"] = M{"size": u["window"], "used": jsRound(numOr0(u["context"])/100*w/1000) * 1000}
	}
	if u["fiveHour"] != nil || u["week"] != nil {
		us := M{}
		if u["fiveHour"] != nil {
			if truthy(u["fiveHourResetsAt"]) && jsNumber(u["fiveHourResetsAt"]) < now {
				us["fiveHour"] = 0.0
			} else {
				us["fiveHour"] = u["fiveHour"]
			}
		}
		if u["week"] != nil {
			if truthy(u["weekResetsAt"]) && jsNumber(u["weekResetsAt"]) < now {
				us["sevenDay"] = 0.0
			} else {
				us["sevenDay"] = u["week"]
			}
		}
		setIfM(us, "fiveHourResetsAt", u["fiveHourResetsAt"])
		setIfM(us, "sevenDayResetsAt", u["weekResetsAt"])
		out["usage"] = us
	}
	if truthy(st["size"]) {
		out["transcriptMb"] = mbOf(jsNumber(st["size"]))
	}
	out["startedAt"] = meta["createdAt"]
	out["held"] = float64(len(asArr(st["held"])))
	out["canKeys"] = reachable
	out["autoAllow"] = truthy(st["autoAllow"]) || truthy(meta["autoAllow"])
	if out["autoAllow"] == true && (truthy(st["allowAll"]) || truthy(meta["allowAll"])) {
		out["allowAll"] = true
	}
	if truthy(st["refreshAfter"]) {
		out["refreshAfter"] = true
	}
	if truthy(meta["resting"]) {
		out["resting"] = true
	}
	running := asArr(st["running"])
	toolTitle := mget(st["tool"], "title")
	if state == "busy" && (len(running) > 0 || truthy(toolTitle)) {
		if len(running) > 0 {
			out["running"] = running
		} else {
			out["running"] = []any{toolTitle}
		}
	}
	if state == "busy" && truthy(meta["coding"]) {
		out["coding"] = true
	}
	if truthy(meta["reviewLoop"]) && state != "ended" {
		out["reviewLoop"] = true
	}
	if st["sessionMd"] != nil {
		max := st["mdMax"]
		if max == nil {
			max = 20000.0
		}
		out["sessionMd"] = M{"bytes": st["sessionMd"], "max": max}
	}
	if len(asArr(st["plugins"])) > 0 {
		out["plugins"] = st["plugins"]
	}
	if truthy(st["quietSince"]) && state == "busy" {
		out["quietMs"] = now - jsNumber(st["quietSince"])
	}
	if bg := asArr(meta["bg"]); len(bg) > 0 && state != "busy" {
		labels := []any{}
		for _, t := range bg {
			l := mget(t, "label")
			if l == nil {
				l = mget(t, "kind")
			}
			if l == nil {
				l = "작업"
			}
			labels = append(labels, l)
		}
		out["background"] = labels
	}
	if card != nil {
		p := M{"ts": card["id"]}
		for k, v := range cardMessage(card, at["pid"]) {
			p[k] = v
		}
		out["permission"] = p
	}
	if meta["seq"] != nil {
		out["lastSeq"] = meta["seq"]
	} else {
		out["lastSeq"] = 0.0
	}
	if meta["lastAt"] != nil {
		out["lastAt"] = meta["lastAt"]
	} else {
		out["lastAt"] = meta["createdAt"]
	}
	setIf("preview", meta["preview"])
	if truthy(meta["last"]) {
		out["last"] = M{"text": truncS(meta["last"], 200), "mine": truthy(meta["lastMine"])}
	}
	host := asM(at["host"])
	hostName := host["name"]
	if hostName == nil {
		hostName = ""
	}
	var movingTo any
	if v := mget(meta["moving"], "to"); v != nil {
		movingTo = v
	}
	prev := meta["prevHostId"]
	moves := asArr(meta["moves"])
	switched := false
	if len(moves) > 0 {
		switched = mget(moves[len(moves)-1], "sourceOnline") == false
	}
	bridge := M{"id": meta["id"], "hostId": meta["hostId"], "host": hostName, "online": at["online"], "alive": truthy(st["alive"]), "moving": movingTo, "prevHostId": prev, "switched": switched}
	for _, k := range []string{"syncedAt", "autoPush", "home"} {
		if v, ok := meta[k]; ok && v != nil {
			bridge[k] = v
		}
	}
	out["bridge"] = bridge
	return out
}

func setIfM(m M, k string, v any) {
	if truthy(v) {
		m[k] = v
	}
}
