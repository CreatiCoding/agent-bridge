// Turns Claude Code transcript lines (JSONL) into the events the control page draws (server/events.mjs).
package main

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

const (
	MAX_TEXT = 40_000
	MAX_TOOL = 6_000
)

func shortenHome(p, home string) string {
	if home != "" && (p == home || strings.HasPrefix(p, home+"/")) {
		return "~" + p[len(home):]
	}
	return p
}

func resultText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	list, ok := content.([]any)
	if !ok {
		return ""
	}
	parts := []string{}
	for _, c := range list {
		t := ""
		if mget(c, "type") == "text" && truthy(mget(c, "text")) {
			t = jsString(mget(c, "text"))
		} else if mget(c, "type") == "image" {
			t = "[그림]"
		}
		if t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "\n")
}

var (
	ENVELOPE_RE       = re(`(?i)^\s*<(channel|task-notification|system-reminder|agent-message|local-command-[a-z-]+|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)\b`)
	localOpenRe       = regexp.MustCompile(`<(?:local-command|bash)-(stdout|stderr)>`)
	ATTACHED_RE       = regexp.MustCompile(`\n?\[(?:Image|File) attached: [^\]]*?([0-9a-f]{40}\.[a-z0-9]{1,5})\]`)
	VIDEO_RE          = regexp.MustCompile(`\[Video attached: [^\]\n]*?/(?:[0-9a-f]{8}-)?([^/\]\n]+)\](?: \([^)\n]*\))?`)
	FILE_RE           = regexp.MustCompile(`\[Attached file: [^\]\n]*?/(?:[0-9a-f]{8}-)?([^/\]\n]+)\]`)
	ROUTINE_RE        = regexp.MustCompile(`(?i)^(Agent .* finished|Background command .* completed \(exit code 0\))$`)
	DENIED_RE         = re(`(?i)denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*)?(\[[^\]]+\])?`)
	FAKE_NOTIFICATION = re(`\s*<task-notification>[\s\S]*?</task-notification>`)
	SOURCES_HEAD_RE   = re(`(?i)^(#{1,6}\s*)?(\*\*)?(sources|references|출처|참고(\s*자료)?)(\*\*)?\s*:?\s*(\*\*)?$`)
	SOURCE_ITEM_RE    = re(`^\s*([-*+]|\d+\.)\s+.*https?://`)
	TODOS_RE          = re("\\n?```todos\\n([\\s\\S]*?)\\n```[ \\t]*")
	TODO_LINE_RE      = re(`^\s*(?:[-*]\s*)?\[([ xX>])\]\s+(.+?)\s*$`)
	threeNL           = regexp.MustCompile(`\n{3,}`)
	HEREDOC_RE        = re(`<<-?\s*['"]?\w+['"]?\s*$`)
	PREAMBLE_RE       = re(`^(#|import\s|from\s+\S+\s+import\s|require\(|use\s|set\s+-|'''|""")`)
	cdPrefixRe        = re(`^cd\s+\S+\s*(&&|;)\s*`)
	cdOnlyRe          = re(`^cd\s+\S+$`)
	quoteRe           = regexp.MustCompile(`["']`)
	endsQuoteRe       = regexp.MustCompile(`["']$`)
	openQuoteTail     = regexp.MustCompile(`["'][^"']*$`)
	dashFlagTail      = re(`\s-(c|e)?$`)
	wordOnlyRe        = regexp.MustCompile(`^\w+$`)
	dotTail           = regexp.MustCompile(` · $`)
	caveatRe          = regexp.MustCompile(`^Caveat: `)
	interruptedRe     = regexp.MustCompile(`^\[Request interrupted by user(?: for tool use)?\]$`)
	imageNumRe        = regexp.MustCompile(`\[Image #\d+\]`)
	agentMsgEdges     = re(`(?i)^\s*<agent-message\b[^>]*>\s*|\s*</agent-message>\s*$`)
	handBackRe        = re(`(?i)^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*\n`)
	harnessRe         = re(`(?im)^[ \t]*\[harness:[^\]]*\][ \t]*\n?`)
	leadSpaces        = regexp.MustCompile(`^ *`)
	cmdNameRe         = re(`<command-name>([\s\S]*?)</command-name>`)
	cmdArgsRe         = re(`<command-args>([\s\S]*?)</command-args>`)
	bashInputRe       = re(`<bash-input>([\s\S]*?)</bash-input>`)
	summaryRe         = re(`<summary>([\s\S]*?)</summary>`)
	statusTagRe       = re(`<status>([\s\S]*?)</status>`)
	mcpPrefix         = regexp.MustCompile(`^mcp__`)
	trailWS           = re(`\s+$`)
)

// localOutputs is text.matchAll(LOCAL_OUTPUT_RE): each [stream, body] of a stdout/stderr envelope.
func localOutputs(text string) [][2]string {
	out := [][2]string{}
	at := 0
	for at < len(text) {
		loc := localOpenRe.FindStringSubmatchIndex(text[at:])
		if loc == nil {
			break
		}
		stream := text[at+loc[2] : at+loc[3]]
		bodyStart := at + loc[1]
		end := -1
		closeEnd := -1
		for _, pre := range []string{"local-command", "bash"} {
			tag := "</" + pre + "-" + stream + ">"
			if i := strings.Index(text[bodyStart:], tag); i >= 0 && (end < 0 || bodyStart+i < end) {
				end = bodyStart + i
				closeEnd = end + len(tag)
			}
		}
		if end < 0 {
			// No close for this opener: the regex moves on one character.
			at += loc[0] + 1
			continue
		}
		out = append(out, [2]string{stream, text[bodyStart:end]})
		at = closeEnd
	}
	return out
}

func sourcesOnly(tail string) bool {
	lines := []string{}
	for _, l := range strings.Split(tail, "\n") {
		if l = jsTrim(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) <= 1 || !SOURCES_HEAD_RE.MatchString(lines[0]) {
		return false
	}
	for _, l := range lines[1:] {
		if !SOURCE_ITEM_RE.MatchString(l) {
			return false
		}
	}
	return true
}

// lastChoices is [...text.matchAll(CHOICES_RE)].pop() for /\n?```choices\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g:
// the start and end of the whole match and its body, or ok=false.
func lastChoices(text string) (start, end int, body string, ok bool) {
	const open = "```choices\n"
	at := 0
	for {
		i := strings.Index(text[at:], open)
		if i < 0 {
			return
		}
		s := at + i
		bodyStart := s + len(open)
		mStart := s
		if s > at && text[s-1] == '\n' {
			mStart = s - 1
		}
		found := false
		search := bodyStart
		for {
			j := strings.Index(text[search:], "\n```")
			if j < 0 {
				break
			}
			k := search + j + 4
			e := k
			for e < len(text) && (text[e] == ' ' || text[e] == '\t') {
				e++
			}
			if e == len(text) || text[e] == '\n' {
				start, end, body, ok = mStart, e, text[bodyStart:search+j], true
				found = true
				at = e
				break
			}
			search = search + j + 1
		}
		if !found {
			at = s + 1
		}
		if at >= len(text) {
			return
		}
	}
}

func extractChoices(text string) (string, []any) {
	start, end, body, ok := lastChoices(text)
	if !ok {
		return text, nil
	}
	tail := text[end:]
	if jsTrim(tail) != "" && !sourcesOnly(tail) {
		return text, nil
	}
	choices := []any{}
	for _, l := range strings.Split(body, "\n") {
		if l = jsTrim(l); l != "" && len(choices) < 6 {
			choices = append(choices, l)
		}
	}
	if len(choices) == 0 {
		return text, nil
	}
	b := trailWS.ReplaceAllString(text[:start], "")
	if jsTrim(tail) != "" {
		return b + "\n\n" + jsTrim(tail), choices
	}
	return b, choices
}

func extractTodos(text string) (string, []any) {
	var items []any
	rest := TODOS_RE.ReplaceAllStringFunc(text, func(m string) string {
		sub := TODOS_RE.FindStringSubmatch(m)
		found := []any{}
		for _, l := range strings.Split(sub[1], "\n") {
			if x := TODO_LINE_RE.FindStringSubmatch(l); x != nil && len(found) < 100 {
				st := map[string]string{" ": "pending", "x": "completed", "X": "completed", ">": "in_progress"}[x[1]]
				found = append(found, orderedObj{{"text", x[2]}, {"active", ""}, {"status", st}})
			}
		}
		items = found
		return "\n"
	})
	if items != nil {
		return jsTrim(threeNL.ReplaceAllString(rest, "\n\n")), items
	}
	return text, nil
}

func bashSummary(command any) string {
	s := ""
	if command != nil {
		s = jsString(command)
	}
	lines := []string{}
	for _, l := range strings.Split(s, "\n") {
		if l = jsTrim(l); l != "" {
			lines = append(lines, l)
		}
	}
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		for {
			m := cdPrefixRe.FindString(l)
			if m == "" {
				break
			}
			l = l[len(m):]
		}
		if l == "" || cdOnlyRe.MatchString(l) {
			continue
		}
		quotes := len(quoteRe.FindAllString(l, -1))
		opener := HEREDOC_RE.MatchString(l) || (endsQuoteRe.MatchString(l) && quotes%2 == 1)
		if !opener {
			return l
		}
		interp := HEREDOC_RE.ReplaceAllString(l, "")
		interp = openQuoteTail.ReplaceAllString(interp, "")
		interp = dashFlagTail.ReplaceAllString(jsTrim(interp), "")
		rest := []string{}
		for _, x := range lines[i+1:] {
			if !wordOnlyRe.MatchString(x) || jsLen(x) > 12 {
				rest = append(rest, x)
			}
		}
		pick := ""
		found := false
		for _, x := range rest {
			if !PREAMBLE_RE.MatchString(x) {
				pick, found = x, true
				break
			}
		}
		if !found && len(rest) > 0 {
			pick = rest[0]
		}
		return dotTail.ReplaceAllString(interp+" · "+pick, "")
	}
	if len(lines) > 0 {
		return lines[0]
	}
	return ""
}

type toolCtx struct {
	cwd, home string
}

// toolSummary: the one line that says what a tool call is doing, and the longer text behind it.
// keys is the input object's key order (Object.values goes by it).
func toolSummary(name string, input any, keys []string, ctx toolCtx) orderedObj {
	i, _ := input.(M)
	if i == nil {
		i = M{}
	}
	str := func(v any) string {
		if v == nil {
			return ""
		}
		return jsString(v)
	}
	rel := func(p any) string {
		s := str(p)
		if ctx.cwd != "" && strings.HasPrefix(s, ctx.cwd+"/") {
			return s[len(ctx.cwd)+1:]
		}
		return shortenHome(s, ctx.home)
	}
	label, detail := "", ""
	switch name {
	case "Bash":
		label = bashSummary(i["command"])
		detail = str(i["command"])
	case "Edit", "Write", "Read", "NotebookEdit", "MultiEdit":
		if i["file_path"] != nil {
			label = rel(i["file_path"])
		} else {
			label = rel(i["notebook_path"])
		}
	case "Grep", "Glob":
		label = str(i["pattern"])
	case "Task", "Agent":
		parts := []string{}
		for _, x := range []any{i["subagent_type"], i["description"]} {
			if t := jsTrim(str(x)); t != "" {
				parts = append(parts, t)
			}
		}
		label = strings.Join(parts, " · ")
		if i["prompt"] != nil {
			detail = str(i["prompt"])
		} else {
			detail = str(i["description"])
		}
	case "TodoWrite":
		todos := asArr(i["todos"])
		done := 0
		var now M
		for _, t := range todos {
			if mget(t, "status") == "completed" {
				done++
			}
			if now == nil && mget(t, "status") == "in_progress" {
				now = asM(t)
			}
		}
		if now != nil {
			w := now["activeForm"]
			if w == nil {
				w = now["content"]
			}
			label = jsStringU(w) + " (" + itoa(done) + "/" + itoa(len(todos)) + ")"
		} else {
			label = itoa(done) + "/" + itoa(len(todos)) + " 완료"
		}
	case "Skill":
		label = str(i["skill"])
	case "WebFetch":
		label = str(i["url"])
	case "WebSearch":
		label = str(i["query"])
		detail = label
	default:
		if keys == nil {
			keys = sortedKeys(i)
		}
		for _, k := range keys {
			if s, ok := i[k].(string); ok {
				label = s
				break
			}
		}
		label = strings.Split(label, "\n")[0]
	}
	detail = jsTrim(detail)
	out := orderedObj{{"label", truncate(strings.ReplaceAll(label, "`", "'"), 110)}}
	if strings.Contains(detail, "\n") || jsLen(detail) > 80 {
		out = append(out, kv{"detail", truncate(detail, 1500)})
	}
	return out
}

type evOpts struct {
	cwd, home string
	silent    *OMap[bool]
	image     func(t, d any) any
}

// rawContent: each content block's input as written, for its key order and its text with one-space indents.
type rawBlock struct {
	Input json.RawMessage `json:"input"`
}

type rawLine struct {
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

func indent1(raw json.RawMessage, v any) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "{}"
	}
	var b bytes.Buffer
	if json.Indent(&b, raw, "", " ") != nil {
		return jsonIndent(v, 1)
	}
	// Go's indenter leaves a space-only empty object/array as written; JSON.stringify writes {} and [].
	return b.String()
}

func lineToEvents(line string, ctx evOpts) []any {
	v, err := parseJSON([]byte(line))
	if err != nil {
		return []any{}
	}
	o, ok := v.(M)
	if !ok {
		if v == nil {
			// JSON.parse('null').isSidechain throws: caught by no one in Node, an empty list here.
			return []any{}
		}
		return []any{}
	}
	if truthy(o["isSidechain"]) {
		return []any{}
	}
	if s, ok := o["aiTitle"].(string); ok && o["type"] == "ai-title" {
		return []any{M{"k": "title", "title": jsSliceTo(s, 80)}}
	}
	msg, _ := o["message"].(M)
	if truthy(o["isMeta"]) || truthy(o["isCompactSummary"]) || !truthy(o["message"]) {
		return []any{}
	}
	var at any
	if truthy(o["timestamp"]) {
		d := parseDate(jsString(o["timestamp"]))
		if !math.IsNaN(d) {
			at = d
		}
	}
	out := []any{}
	push := func(e M) {
		e["at"] = at
		out = append(out, e)
	}
	content := msg["content"]
	pictures := func(blocks any) []any {
		list, ok := blocks.([]any)
		res := []any{}
		if !ok || ctx.image == nil {
			return res
		}
		for _, c := range list {
			src := asM(mget(c, "source"))
			if mget(c, "type") == "image" && src["type"] == "base64" {
				if d, ok := src["data"].(string); ok {
					mt := any("image/png")
					if src["media_type"] != nil {
						mt = jsString(src["media_type"])
					}
					if id := ctx.image(mt, d); truthy(id) {
						res = append(res, id)
					}
				}
			}
		}
		return res
	}
	userText := func(text string, images []any) {
		if local := localOutputs(text); len(local) > 0 {
			for _, m := range local {
				if jsTrim(m[1]) != "" {
					push(M{"k": "local", "text": truncate(jsTrim(ansiRe.ReplaceAllString(m[1], "")), 3500), "error": m[0] == "stderr"})
				}
			}
			return
		}
		env := ENVELOPE_RE.FindStringSubmatch(text)
		if env == nil {
			if caveatRe.MatchString(text) {
				return
			}
			if interruptedRe.MatchString(jsTrim(text)) {
				return
			}
			attached := []any{}
			for _, m := range ATTACHED_RE.FindAllStringSubmatch(text, -1) {
				attached = append(attached, m[1])
			}
			said := ATTACHED_RE.ReplaceAllString(text, "")
			said = imageNumRe.ReplaceAllString(said, "")
			said = VIDEO_RE.ReplaceAllStringFunc(said, func(m string) string { return "🎬 " + VIDEO_RE.FindStringSubmatch(m)[1] })
			said = FILE_RE.ReplaceAllStringFunc(said, func(m string) string { return "📎 " + FILE_RE.FindStringSubmatch(m)[1] })
			said = jsTrim(said)
			all := append(attached, images...)
			if said != "" || len(all) > 0 {
				e := M{"k": "user", "text": truncate(said, MAX_TEXT)}
				if len(all) > 0 {
					e["images"] = all
				}
				push(e)
			}
			return
		}
		kind := strings.ToLower(env[1])
		if kind == "agent-message" {
			body := agentMsgEdges.ReplaceAllString(text, "")
			body = handBackRe.ReplaceAllString(body, "")
			body = harnessRe.ReplaceAllString(body, "")
			lines := strings.Split(body, "\n")
			ind := -1
			for _, l := range lines {
				if jsTrim(l) != "" {
					n := len(leadSpaces.FindString(l))
					if ind < 0 || n < ind {
						ind = n
					}
				}
			}
			if ind < 0 {
				ind = 0
			}
			for i, l := range lines {
				lines[i] = jsSliceFrom(l, ind)
			}
			report := jsTrim(strings.Join(lines, "\n"))
			if report != "" {
				if jsLen(report) > 6000 {
					report = jsSliceTo(report, 6000) + "\n\n_… 이하 생략. 전체는 터미널 기록에 있습니다._"
				}
				push(M{"k": "line", "text": "🤖 *서브에이전트 보고*\n" + report})
			}
			return
		}
		switch kind {
		case "command-name", "command-message":
			cmd, args := "", ""
			if m := cmdNameRe.FindStringSubmatch(text); m != nil {
				cmd = jsTrim(m[1])
			}
			if m := cmdArgsRe.FindStringSubmatch(text); m != nil {
				args = jsTrim(m[1])
			}
			if cmd != "" {
				t := cmd
				if !strings.HasPrefix(cmd, "/") {
					t = "/" + cmd
				}
				if args != "" {
					t += " " + args
				}
				push(M{"k": "user", "text": t, "command": true})
			}
		case "bash-input":
			if m := bashInputRe.FindStringSubmatch(text); m != nil && jsTrim(m[1]) != "" {
				push(M{"k": "user", "text": "!" + jsTrim(m[1]), "command": true})
			}
		case "task-notification":
			summary, status := "", ""
			if m := summaryRe.FindStringSubmatch(text); m != nil {
				summary = jsTrim(m[1])
			}
			if m := statusTagRe.FindStringSubmatch(text); m != nil {
				status = jsTrim(m[1])
			}
			failed := status != "" && status != "completed"
			if summary != "" && !(ROUTINE_RE.MatchString(summary) && !failed) {
				if failed {
					push(M{"k": "notice", "text": summary + " (" + status + ")", "tone": "warn"})
				} else {
					push(M{"k": "notice", "text": summary, "tone": "info"})
				}
			}
		}
	}
	if o["type"] == "user" {
		if s, ok := content.(string); ok {
			userText(s, nil)
		} else if list, ok := content.([]any); ok {
			pasted := pictures(list)
			used := false
			for _, c := range list {
				cm := asM(c)
				if t, ok := cm["text"].(string); ok && cm["type"] == "text" {
					if used {
						userText(t, nil)
					} else {
						userText(t, pasted)
					}
					used = true
				} else if cm["type"] == "tool_result" {
					id := jsStringU(cm["tool_use_id"])
					if ctx.silent != nil && ctx.silent.Delete(id) {
						continue
					}
					text := resultText(cm["content"])
					images := pictures(cm["content"])
					e := M{"k": "tool_end", "tool": id, "error": cm["is_error"] == true, "text": truncate(text, MAX_TOOL)}
					if len(images) > 0 {
						e["images"] = images
					}
					push(e)
					if cm["is_error"] == true {
						if d := DENIED_RE.FindStringSubmatch(text); d != nil {
							why := d[1]
							if why == "" {
								why = "이유 없음"
							}
							push(M{"k": "line", "text": "🚫 자동 모드가 도구 호출을 거부했습니다: `" + why + "`. 누를 확인 창은 없습니다. 이 작업이 필요하면 설정에서 권한 모드를 바꾸거나(⚙️ 설정 → 권한 모드) 다른 방법으로 지시하세요."})
						}
					}
				}
			}
		}
	} else if list, ok := content.([]any); ok && o["type"] == "assistant" {
		if m, ok := msg["model"].(string); ok && m != "" && m != "<synthetic>" {
			out = append(out, M{"k": "model", "model": m})
		}
		var raws []rawBlock
		var rl rawLine
		if json.Unmarshal([]byte(line), &rl) == nil {
			_ = json.Unmarshal(rl.Message.Content, &raws)
		}
		for idx, c := range list {
			cm := asM(c)
			if t, ok := cm["text"].(string); ok && cm["type"] == "text" && jsTrim(t) != "" {
				said := FAKE_NOTIFICATION.ReplaceAllString(t, "")
				faked := said != t
				listedText, todos := extractTodos(said)
				text, choices := extractChoices(listedText)
				if jsTrim(text) != "" || choices != nil {
					e := M{"k": "text", "text": truncate(text, MAX_TEXT)}
					if choices != nil {
						e["choices"] = choices
					}
					push(e)
				}
				if todos != nil {
					push(M{"k": "todos", "items": todos})
				}
				if faked {
					push(M{"k": "notice", "text": "Claude 가 답 글에 직접 쓴 작업 알림을 숨겼어요. 실제로 끝난 작업이 아니에요.", "tone": "warn"})
				}
			} else if cm["type"] == "tool_use" {
				name := jsStringU(cm["name"])
				plan := name == "TodoWrite" || name == "mcp__bridge__todos"
				var raw json.RawMessage
				if idx < len(raws) {
					raw = raws[idx].Input
				}
				if !plan {
					var keys []string
					if len(raw) > 0 {
						keys = jsonKeyOrder(raw)
					}
					e := M{"k": "tool", "tool": jsStringU(cm["id"]), "name": mcpPrefix.ReplaceAllString(name, "")}
					for _, x := range toolSummary(name, cm["input"], keys, toolCtx{ctx.cwd, ctx.home}) {
						e[x.K] = x.V
					}
					input := cm["input"]
					if input == nil {
						input = M{}
						raw = nil
					}
					e["input"] = truncate(indent1(raw, input), MAX_TOOL)
					push(e)
				} else if ctx.silent != nil {
					ctx.silent.Set(jsStringU(cm["id"]), true)
				}
				if todos, ok := mget(cm["input"], "todos").([]any); plan && ok {
					items := []any{}
					for n, t := range todos {
						if n >= 100 {
							break
						}
						st := mget(t, "status")
						if st == nil {
							st = "pending"
						}
						items = append(items, orderedObj{{"text", strOrEmpty(mget(t, "content"))}, {"active", strOrEmpty(mget(t, "activeForm"))}, {"status", jsString(st)}})
					}
					push(M{"k": "todos", "items": items})
				}
			}
		}
	}
	// Plain JSON values from here on, as the events the rest of the server keeps.
	return asArr(jsonRound(out))
}

func strOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	return jsString(v)
}
