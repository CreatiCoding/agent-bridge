// 데모 모드 (REQ-F-766, REQ-S-068): a Mac played inside the server (server/demo.mjs), and the demo accounts around
// it (server.mjs). Nothing of it is ever written to the data folder.
package main

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

var demoUidRe = regexp.MustCompile(`^demo-[0-9a-f]{12}$`)

func newDemoUid() string { return "demo-" + randHex(6) }
func isDemoUid(uid any) bool {
	s, ok := uid.(string)
	return ok && demoUidRe.MatchString(s)
}
func demoHostOf(uid string) string { return "demohost-" + jsSliceFrom(uid, 5) }
func isDemoHost(id any) bool {
	s, ok := id.(string)
	return ok && strings.HasPrefix(s, "demohost-")
}

const (
	DEMO_LOGIN_NAME = "심사용 데모"
	DEMO_HOME       = "/Users/demo"
	DEMO_MODEL      = "claude-sonnet-5-5"
	DEMO_REFUSED    = "데모에서는 쓸 수 없어요"
)

func demoPrefs(sids []string) M {
	return M{"groups": []any{M{"id": randHex(4), "name": "데모 프로젝트", "items": []any{sids[0], sids[1]}}}, "loose": []any{sids[2]}, "defaultPrompt": "", "voice": M{"on": true}}
}

func demoIso(t float64) string { return isoTime(int64(t)) }

func demoUserLine(at float64, content any) string {
	return jsonStr(orderedObj{{"type", "user"}, {"uuid", uuidv4()}, {"timestamp", demoIso(at)}, {"message", orderedObj{{"role", "user"}, {"content", content}}}})
}
func demoAsstLine(at float64, content any) string {
	return jsonStr(orderedObj{{"type", "assistant"}, {"uuid", uuidv4()}, {"timestamp", demoIso(at)}, {"message", orderedObj{{"role", "assistant"}, {"model", DEMO_MODEL}, {"content", content}}}})
}
func demoSay(at float64, text string) string {
	return demoAsstLine(at, []any{orderedObj{{"type", "text"}, {"text", text}}})
}
func demoToolUse(at float64, id, name string, input any) string {
	return demoAsstLine(at, []any{orderedObj{{"type", "tool_use"}, {"id", id}, {"name", name}, {"input", input}}})
}
func demoToolResult(at float64, id, text string) string {
	return demoUserLine(at, []any{orderedObj{{"type", "tool_result"}, {"tool_use_id", id}, {"content", text}}})
}

func permissionCard(command string) M {
	words := strings.Split(command, " ")
	if len(words) > 2 {
		words = words[:2]
	}
	return jsonRound(orderedObj{
		{"id", uuidv4()}, {"open", true}, {"at", nowMs()}, {"kind", "permission"}, {"title", "Bash command"}, {"context", command},
		{"description", "데모라 실제로 실행하지는 않아요"},
		{"options", []any{
			orderedObj{{"n", 1}, {"label", "Yes"}, {"kind", "allow-once"}},
			orderedObj{{"n", 2}, {"label", "Yes, and don't ask again for " + strings.Join(words, " ") + " commands in this project"}, {"kind", "allow-always"}},
			orderedObj{{"n", 3}, {"label", "No, and tell Claude what to do differently"}, {"kind", "deny"}},
		}},
		{"tool", orderedObj{{"name", "Bash"}, {"input", orderedObj{{"command", command}}}}},
	}).(M)
}

// jsonRound is a value as it would arrive in JSON: maps, lists, numbers as float64.
func jsonRound(v any) any {
	x, _ := parseJSON(jsonBytes(v))
	return x
}

type demoSeed struct {
	id, cwd     string
	lines       []string
	card        M
	pendingTool string
}

func seed(now float64, ids []string) []demoSeed {
	m := func(min float64) float64 { return now - min*60_000 }
	title := func(t string) string { return jsonStr(orderedObj{{"type", "ai-title"}, {"aiTitle", t}}) }
	todo := func(c, a, s string) orderedObj {
		o := orderedObj{{"content", c}}
		if a != "" {
			o = append(o, kv{"activeForm", a})
		}
		return append(o, kv{"status", s})
	}
	css := DEMO_HOME + "/projects/todo-app/src/styles.css"
	return []demoSeed{
		{id: ids[0], cwd: DEMO_HOME + "/projects/todo-app", lines: []string{
			title("할 일 앱에 다크 모드 넣기"),
			demoUserLine(m(42), "할 일 앱에 다크 모드를 넣어 줘. 시스템 설정을 따라가면 좋겠어."),
			demoSay(m(41.8), "좋아요. 먼저 스타일 파일을 볼게요."),
			demoToolUse(m(41.75), "toolu_demo_plan1", "mcp__bridge__todos", orderedObj{{"todos", []any{todo("스타일 파일 보기", "스타일 파일 보는 중", "in_progress"), todo("다크 모드 색 더하기", "", "pending"), todo("테스트 돌리기", "", "pending")}}}),
			demoToolResult(m(41.75), "toolu_demo_plan1", "할 일 3개 중 0개 완료로 패널에 보였어요."),
			demoToolUse(m(41.7), "toolu_demo_read", "Read", orderedObj{{"file_path", css}}),
			demoToolResult(m(41.6), "toolu_demo_read", ":root {\n  --bg: #ffffff;\n  --text: #1b1b1a;\n}"),
			demoToolUse(m(41), "toolu_demo_edit", "Edit", orderedObj{{"file_path", css}, {"old_string", "}"}, {"new_string", "}\n@media (prefers-color-scheme: dark) {\n  :root { --bg: #1b1b1a; --text: #e8e6df; }\n}"}}),
			demoToolResult(m(40.9), "toolu_demo_edit", "The file has been updated."),
			demoToolUse(m(40.5), "toolu_demo_test", "Bash", orderedObj{{"command", "npm test"}, {"description", "테스트 실행"}}),
			demoToolResult(m(40), "toolu_demo_test", "> todo-app@1.0.0 test\n> vitest run\n\n ✓ src/app.test.ts (6 tests)\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)"),
			demoToolUse(m(39.9), "toolu_demo_plan2", "mcp__bridge__todos", orderedObj{{"todos", []any{todo("스타일 파일 보기", "", "completed"), todo("다크 모드 색 더하기", "", "completed"), todo("테스트 돌리기", "", "completed")}}}),
			demoToolResult(m(39.9), "toolu_demo_plan2", "할 일 3개 중 3개 완료로 패널에 보였어요."),
			demoSay(m(39.8), "다크 모드를 넣었어요.\n\n- `styles.css` 에 `prefers-color-scheme: dark` 일 때의 색을 더했어요\n- 시스템 설정을 바꾸면 바로 따라가요\n- 테스트 6개가 모두 통과했어요"),
		}},
		{id: ids[1], cwd: DEMO_HOME + "/projects/todo-app", lines: []string{
			title("README 정리하고 테스트 돌리기"),
			demoUserLine(m(12), "README 의 설치 방법을 정리하고 테스트를 한 번 돌려 줘."),
			demoSay(m(11.8), "README 를 정리했어요. 이제 테스트를 돌려 볼게요."),
			demoToolUse(m(11.5), "toolu_demo_wait", "Bash", orderedObj{{"command", "npm test"}, {"description", "테스트 실행"}}),
		}, card: permissionCard("npm test"), pendingTool: "toolu_demo_wait"},
		{id: ids[2], cwd: DEMO_HOME + "/projects/notes", lines: []string{
			title("이 앱은 무엇을 하나요?"),
			demoUserLine(m(3), "이 앱은 무엇을 하나요?"),
			demoSay(m(2.9), "Agent Bridge 는 맥에서 도는 Claude Code 세션을 폰이나 다른 컴퓨터에서 이어서 다루게 해 줘요.\n\n지금은 **데모 모드**예요. 실제 맥에 연결돼 있지 않고, 정해진 답만 보여 드려요. 아래 버튼을 눌러 보거나 아무 말이나 보내 보세요.\n\n```choices\n무엇을 할 수 있어요?\n권한 요청 보여 줘\n코드 예시 보여 줘\n```"),
		}},
	}
}

var (
	demoTodoRe  = regexp.MustCompile(`할 일 패널에 정리`)
	demoPermRe  = regexp.MustCompile(`권한|permission|허용`)
	demoCodeRe  = regexp.MustCompile(`코드|code|예시`)
	demoWhatRe  = regexp.MustCompile(`무엇|뭐|what|할 수`)
	demoHelloRe = regexp.MustCompile(`안녕|hello|hi\b`)
)

type demoAnswer struct{ text, permission string }

func demoReply(text string) demoAnswer {
	t := strings.ToLower(text)
	switch {
	case demoTodoRe.MatchString(t):
		return demoAnswer{text: "지금까지 한 일과 남은 일을 정리했어요.\n\n```todos\n[x] **세션 목록** 둘러보기\n[x] 메시지 보내 보기\n[>] **할 일 패널** 써 보기\n[ ] **내 맥** 연결하기 (선택, 직접)\n```"}
	case demoPermRe.MatchString(t):
		return demoAnswer{permission: "npm run build", text: "빌드를 돌려 볼게요. 먼저 허용을 받아야 해요."}
	case demoCodeRe.MatchString(t):
		return demoAnswer{text: "예를 들면 이런 코드를 써 드려요.\n\n```ts\nexport function greet(name: string) {\n  return `안녕하세요, ${name}님`\n}\n```\n\n데모 모드라 실제 파일은 바뀌지 않아요."}
	case demoWhatRe.MatchString(t):
		return demoAnswer{text: "이런 것을 할 수 있어요.\n\n- 맥에서 도는 세션 목록을 보고 골라 열기\n- 메시지를 보내고 답을 실시간으로 받기\n- 권한 요청에 버튼으로 답하기\n- 세션을 그룹으로 묶기\n\n데모 모드예요. 실제 맥에 연결돼 있지 않아요.\n\n```choices\n권한 요청 보여 줘\n코드 예시 보여 줘\n```"}
	case demoHelloRe.MatchString(t):
		return demoAnswer{text: "안녕하세요! 데모 모드예요. 실제 맥에 연결돼 있지 않아서 정해진 답만 드려요."}
	}
	return demoAnswer{text: "데모 모드예요. 실제 맥에 연결돼 있지 않아요.\n\n보내 주신 글은 받았어요. 실제로 쓰면 이 자리에 맥의 Claude 가 일한 결과가 나와요."}
}

// splitAfterSpace is text.split(/(?<=\s)/): pieces that each end after a white space.
func splitAfterSpace(s string) []string {
	out := []string{}
	start := 0
	for i, r := range s {
		if isJSSpace(r) || unicode.IsSpace(r) {
			end := i + len(string(r))
			out = append(out, s[start:end])
			start = end
		}
	}
	if start < len(s) || len(out) == 0 {
		out = append(out, s[start:])
	}
	return out
}

type demoSess struct {
	id, cwd             string
	lines               []string
	sent                int
	phase               string
	card                M
	pendingTool         string
	mode, effort, model string
	autoAllow           bool
	turnAt              any
	timers              map[*Timer]bool
}

// DemoMac stands where a bridge tab's event stream would.
type DemoMac struct {
	build    string
	up       func(msgs []any)
	sessions *OMap[*demoSess]
}

func createDemoMac(build string, up func([]any)) *DemoMac {
	return &DemoMac{build: build, up: up, sessions: newOMap[*demoSess]()}
}

func (d *DemoMac) send(msgs ...any) {
	d.up(asArr(jsonRound(msgs)))
}

func (d *DemoMac) later(s *demoSess, ms int, f func()) {
	var t *Timer
	t = setTimeout(time.Duration(ms)*time.Millisecond, func() {
		delete(s.timers, t)
		if cur, ok := d.sessions.Get(s.id); ok && cur == s {
			f()
		}
	})
	s.timers[t] = true
}

func stopAllTimers(s *demoSess) {
	for t := range s.timers {
		clearTimeout(t)
	}
	s.timers = map[*Timer]bool{}
}

func (d *DemoMac) status(s *demoSess) {
	phase := s.phase
	var waiting, since, card any
	if s.card != nil {
		phase = "waiting"
		waiting = "권한 요청"
		since = s.card["at"]
		card = s.card["id"]
	}
	d.send(orderedObj{{"t", "status"}, {"sid", s.id}, {"alive", s.phase != "ended"}, {"phase", phase}, {"waiting", waiting}, {"waitingSince", since}, {"held", []any{}}, {"tool", nil}, {"tools", 0}, {"running", []any{}}, {"mode", s.mode}, {"effort", s.effort}, {"context", "9%"}, {"autoAllow", s.autoAllow}, {"model", s.model}, {"turnAt", s.turnAt}, {"size", 24_000}, {"card", card}})
}

func (d *DemoMac) flush(s *demoSess) {
	if len(s.lines) > s.sent {
		d.send(orderedObj{{"t", "lines"}, {"sid", s.id}, {"from", s.sent}, {"lines", append([]string{}, s.lines[s.sent:]...)}})
	}
	s.sent = len(s.lines)
}

func (d *DemoMac) add(s *demoSess, lines ...string) {
	s.lines = append(s.lines, lines...)
	d.flush(s)
}

func (d *DemoMac) hello() {
	list := []any{}
	for _, s := range d.sessions.Values() {
		list = append(list, orderedObj{{"id", s.id}, {"cwd", s.cwd}, {"conv", s.id}, {"alive", s.phase != "ended"}})
	}
	d.send(orderedObj{{"t", "hello"}, {"name", "데모 맥"}, {"kind", "macbook"}, {"home", DEMO_HOME}, {"version", "demo"}, {"build", d.build}, {"info", orderedObj{{"node", "demo"}, {"os", "macOS (데모)"}}}, {"ws", []any{}}, {"sessions", list}})
}

func (d *DemoMac) open(sid, cwd string) *demoSess {
	s := &demoSess{id: sid, cwd: cwd, phase: "idle", mode: "default", effort: "medium", model: DEMO_MODEL, timers: map[*Timer]bool{}}
	d.sessions.Set(sid, s)
	return s
}

func (d *DemoMac) reset() []string {
	d.stop()
	ids := []string{uuidv4(), uuidv4(), uuidv4()}
	for _, x := range seed(float64(nowMs()), ids) {
		s := d.open(x.id, x.cwd)
		s.lines = x.lines
		s.card = x.card
		s.pendingTool = x.pendingTool
	}
	d.hello()
	d.health()
	return ids
}

func (d *DemoMac) stop() {
	for _, s := range d.sessions.Values() {
		stopAllTimers(s)
	}
	d.sessions = newOMap[*demoSess]()
}

func (d *DemoMac) health() {
	list := []any{}
	for _, s := range d.sessions.Values() {
		list = append(list, orderedObj{{"id", s.id}, {"lines", s.sent}})
	}
	voice := orderedObj{{"whisper", true}, {"models", []any{"large-v3-turbo-q5_0"}}, {"vadModel", true}, {"vad", "idle"}, {"ffmpeg", true}}
	d.send(orderedObj{{"t", "health"}, {"checks", []any{}}, {"features", []any{}}, {"repairs", []any{}}, {"awake", orderedObj{{"idle", false}, {"lid", false}}}, {"voice", voice}, {"sessions", list}})
}

func (d *DemoMac) answer(s *demoSess, said string) {
	r := demoReply(said)
	s.phase = "busy"
	s.turnAt = float64(nowMs())
	d.status(s)
	words := splitAfterSpace(r.text)
	const steps = 6
	for i := 1; i <= steps; i++ {
		n := int(math.Ceil(float64(len(words)*i) / steps))
		d.later(s, 250*i, func() { d.send(orderedObj{{"t", "preview"}, {"sid", s.id}, {"text", strings.Join(words[:n], "")}}) })
	}
	d.later(s, 250*steps+200, func() {
		d.send(orderedObj{{"t", "preview"}, {"sid", s.id}, {"text", ""}})
		d.add(s, demoSay(float64(nowMs()), r.text))
		if r.permission != "" {
			id := "toolu_demo_" + randHex(6)
			d.add(s, demoToolUse(float64(nowMs()), id, "Bash", orderedObj{{"command", r.permission}}))
			s.pendingTool = id
			s.card = permissionCard(r.permission)
			d.status(s)
			d.send(orderedObj{{"t", "card"}, {"sid", s.id}, {"card", s.card}})
			return
		}
		s.phase = "idle"
		s.turnAt = nil
		d.status(s)
	})
}

func (d *DemoMac) decide(s *demoSess, n any) {
	card := s.card
	var opt M
	for _, o := range asArr(card["options"]) {
		if mget(o, "n") == n {
			opt = asM(o)
		}
	}
	allowed := opt != nil && opt["kind"] != "deny" && n != "esc"
	s.card = nil
	result := any("거부")
	if allowed {
		result = opt["label"]
	}
	d.send(orderedObj{{"t", "card"}, {"sid", s.id}, {"card", orderedObj{{"id", card["id"]}, {"open", false}, {"result", result}, {"at", nowMs()}}}})
	s.phase = "busy"
	d.status(s)
	d.later(s, 700, func() {
		tool := s.pendingTool
		s.pendingTool = ""
		if tool != "" {
			out := "The user doesn’t want to proceed with this tool use."
			if allowed {
				out = "> " + jsStringU(card["context"]) + "\n\n(데모 모드라 실제로 실행하지 않았어요)\n✓ 완료"
			}
			d.add(s, demoToolResult(float64(nowMs()), tool, out))
		}
		said := "알겠어요. 실행하지 않을게요."
		if allowed {
			said = "허용해 주셔서 실행했어요. 데모 모드라 실제 맥에서는 아무것도 실행되지 않았어요."
		}
		d.add(s, demoSay(float64(nowMs()), said))
		s.phase = "idle"
		s.turnAt = nil
		d.status(s)
	})
}

var demoPathPart = regexp.MustCompile(`^[\w.-]{1,40}$`)
var demoTilde = regexp.MustCompile(`^~/?`)

func (d *DemoMac) handle(cmd M) {
	sid, _ := cmd["sid"].(string)
	s, has := d.sessions.Get(sid)
	reqID := cmd["reqId"]
	switch cmd["t"] {
	case "welcome":
		ss := asM(cmd["sessions"])
		for _, id := range sortedKeys(ss) {
			k := asM(ss[id])
			x, ok := d.sessions.Get(id)
			if !ok || !truthy(k["mine"]) {
				continue
			}
			x.sent = int(math.Min(numOrNaN0(k["lines"]), float64(len(x.lines))))
			d.flush(x)
			d.status(x)
			if x.card != nil {
				d.send(orderedObj{{"t", "card"}, {"sid", id}, {"card", x.card}})
			}
		}
	case "resync":
		if !has {
			return
		}
		n := int(numOrNaN0(cmd["lines"]))
		for len(s.lines) < n {
			s.lines = append(s.lines, "{}")
		}
		s.sent = n
		d.flush(s)
	case "ping":
		d.send(orderedObj{{"t", "pong"}, {"ts", cmd["ts"]}})
		d.health()
	case "check":
		d.health()
	case "voice":
		d.send(orderedObj{{"t", "voice"}, {"reqId", reqID}, {"ok", false}, {"code", "demo"}, {"error", "데모 모드라 실제 받아쓰기는 하지 않아요. 실제로 쓰면 세션의 맥이 말을 글로 바꿔 입력창에 넣어요."}})
	case "fork":
		if !has {
			d.send(orderedObj{{"t", "error"}, {"reqId", reqID}, {"message", "세션을 찾지 못했어요"}})
			return
		}
		x := d.open(jsStringU(cmd["newSid"]), s.cwd)
		x.lines = append([]string{}, s.lines...)
		d.send(orderedObj{{"t", "forked"}, {"reqId", reqID}, {"ok", true}, {"sid", x.id}, {"cwd", x.cwd}})
		d.flush(x)
		d.status(x)
	case "report":
		if has {
			d.status(s)
		}
	case "new":
		cwd := ""
		if cmd["cwd"] != nil {
			cwd = jsString(cmd["cwd"])
		}
		parts := []string{}
		for _, x := range strings.Split(demoTilde.ReplaceAllString(cwd, ""), "/") {
			if demoPathPart.MatchString(x) {
				parts = append(parts, x)
			}
		}
		if len(parts) > 2 {
			parts = parts[len(parts)-2:]
		}
		rest := strings.Join(parts, "/")
		if rest == "" {
			rest = "demo"
		}
		x := d.open(sid, DEMO_HOME+"/projects/"+rest)
		if truthy(cmd["mode"]) {
			x.mode = jsSliceTo(jsString(cmd["mode"]), 20)
		}
		d.send(orderedObj{{"t", "opened"}, {"reqId", reqID}, {"sid", x.id}, {"ok", true}, {"cwd", x.cwd}})
		d.status(x)
		prompt := ""
		if cmd["prompt"] != nil {
			prompt = jsString(cmd["prompt"])
		}
		if jsTrim(prompt) != "" {
			d.later(x, 300, func() {
				d.add(x, demoUserLine(float64(nowMs()), jsSliceTo(prompt, 4000)))
				d.answer(x, prompt)
			})
		}
	case "open":
		if !has {
			cwd := DEMO_HOME + "/projects/demo"
			if truthy(cmd["cwd"]) {
				cwd = jsString(cmd["cwd"])
			}
			s = d.open(sid, cwd)
		}
		s.phase = "idle"
		d.send(orderedObj{{"t", "opened"}, {"reqId", reqID}, {"ok", true}, {"sid", s.id}, {"cwd", s.cwd}, {"warnings", []any{}}})
	case "flush":
		d.send(orderedObj{{"t", "flushed"}, {"reqId", reqID}, {"ok", true}})
	case "send":
		if !has {
			return
		}
		d.send(orderedObj{{"t", "delivered"}, {"sid", s.id}, {"ids", []any{cmd["id"]}}})
		text := ""
		if cmd["text"] != nil {
			text = jsString(cmd["text"])
		}
		text = jsSliceTo(text, 4000)
		d.add(s, demoUserLine(float64(nowMs()), text))
		if s.card != nil {
			return
		}
		d.answer(s, text)
	case "answer":
		if has && s.card != nil && s.card["id"] == cmd["card"] {
			if cmd["n"] == "esc" {
				d.decide(s, "esc")
			} else {
				d.decide(s, jsNumber(cmd["n"]))
			}
		}
	case "esc":
		if !has {
			return
		}
		stopAllTimers(s)
		d.send(orderedObj{{"t", "preview"}, {"sid", s.id}, {"text", ""}})
		if s.card != nil {
			d.decide(s, "esc")
		} else {
			s.phase = "idle"
			s.turnAt = nil
			d.status(s)
			d.send(orderedObj{{"t", "note"}, {"sid", s.id}, {"text", "멈췄어요"}, {"tone", "info"}})
		}
	case "close":
		if !has {
			return
		}
		stopAllTimers(s)
		s.phase = "ended"
		s.card = nil
	case "set":
		if !has {
			return
		}
		if v, ok := cmd["autoAllow"].(bool); ok {
			s.autoAllow = v
		}
		d.status(s)
	case "setting":
		if !has {
			return
		}
		v := jsStringU(cmd["value"])
		switch cmd["kind"] {
		case "mode":
			s.mode = jsSliceTo(v, 20)
		case "effort":
			s.effort = jsSliceTo(v, 10)
		case "model":
			s.model = jsSliceTo(v, 60)
		}
		d.status(s)
	case "refresh":
		if has {
			d.send(orderedObj{{"t", "note"}, {"sid", s.id}, {"text", "세션을 다시 열었어요 (데모)"}, {"tone", "info"}})
			d.status(s)
		}
	case "retract":
		if has {
			d.send(orderedObj{{"t", "note"}, {"sid", s.id}, {"text", "잘못 보낸 메시지라고 알렸어요 (데모)"}, {"tone", "info"}})
		}
	case "dropheld":
		d.send(orderedObj{{"t", "dropped"}, {"reqId", reqID}, {"ok", true}, {"ids", []any{}}})
	case "screen":
		cwd := DEMO_HOME
		if has {
			cwd = s.cwd
		}
		text := "╭──────────────────────────────╮\n│ 데모 맥 · 실제 터미널이 아니에요 │\n╰──────────────────────────────╯\n\n> " + cwd
		if truthy(reqID) {
			d.send(orderedObj{{"t", "screen"}, {"reqId", reqID}, {"ok", true}, {"text", text}})
		} else {
			d.send(orderedObj{{"t", "screen"}, {"sid", cmd["sid"]}, {"text", text}})
		}
	case "skills":
		d.send(orderedObj{{"t", "skills"}, {"reqId", reqID}, {"ok", true}, {"menu", orderedObj{{"direct", []any{}}, {"auto", []any{}}, {"other", []any{}}}}})
	case "dirs":
		d.send(orderedObj{{"t", "dirs"}, {"reqId", reqID}, {"ok", true}, {"path", DEMO_HOME + "/projects"}, {"parent", DEMO_HOME}, {"dirs", []any{"todo-app", "notes", "demo"}}})
	case "btw":
		d.send(orderedObj{{"t", "btw"}, {"reqId", reqID}, {"ok", true}, {"answer", "데모 모드예요. 곁가지 질문도 정해진 답만 드려요."}})
	default:
		if truthy(reqID) {
			d.send(orderedObj{{"t", "error"}, {"reqId", reqID}, {"message", DEMO_REFUSED}})
		}
	}
}

func (d *DemoMac) take(cmd M) {
	if _, ok := cmd["t"].(string); !ok {
		return
	}
	if truthy(cmd["reqId"]) {
		d.send(orderedObj{{"t", "got"}, {"reqId", cmd["reqId"]}})
	}
	goLocked("demo", func() {
		if err := tryLog(func() { d.handle(cmd) }); err != nil {
			logLine("demo", cmd["t"], err)
		}
	})
}

// Write, End, Pending: the Sink a bridge tab's stream would be.
func (d *DemoMac) Write(chunk string) bool {
	for _, line := range strings.Split(chunk, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		if v, err := parseJSON([]byte(line[6:])); err == nil {
			if m, ok := v.(M); ok {
				d.take(m)
			}
		}
	}
	return true
}
func (d *DemoMac) End(string)   {}
func (d *DemoMac) Pending() int { return 0 }

// ---------- the demo accounts (server.mjs) ----------

const (
	DEMO_PER_IP_HOUR   = 10
	DEMO_MAX           = 50
	DEMO_EVICT_IDLE_MS = 15 * 60_000
	DEMO_IDLE_MS       = 24 * 3_600_000
	DEMO_SWEEP_MS      = 10 * 60_000
	DEMO_LOGINS_MAX    = 1000
	DEMO_TEXT_MAX      = 2000
	DEMO_SENDS_PER_MIN = 20
	DEMO_SESSIONS_MAX  = 20
	DEMO_VOICE_BYTES   = 1_572_864
	DEMO_BODY_BYTES    = 64 * 1024
)

type demoRule struct {
	method string
	re     *regexp.Regexp
}

var DEMO_ALLOW = []demoRule{
	{"GET", regexp.MustCompile(`^/api/(me|classic/stream|options|notices|groups|stats|quality|plugins)$`)},
	{"GET", regexp.MustCompile(`^/api/prefs/(launch|voice|voice/hosts|icons|prompt|splits)$`)},
	{"POST", regexp.MustCompile(`^/api/prefs/(launch|voice|voice/hosts|icons|prompt|splits)$`)},
	{"GET", regexp.MustCompile(`^/api/img/[0-9a-f]{40}\.(png|jpg|gif|webp)$`)},
	{"POST", regexp.MustCompile(`^/api/(notices/dismiss|groups|focus|sessions|account/delete)$`)},
	{"GET", regexp.MustCompile(`^/api/sessions/S/(events|links|skills|screen)$`)},
	{"POST", regexp.MustCompile(`^/api/sessions/S/(say|send|do|answer|esc|sendnow|dropheld|retract|settings|setting|close|resume|report|refresh|btw|screen|voice|fork)$`)},
	{"DELETE", regexp.MustCompile(`^/api/sessions/S$`)},
	{"GET", regexp.MustCompile(`^/api/hosts/H/(status|dirs|logs)$`)},
	{"POST", regexp.MustCompile(`^/api/hosts/H/check$`)},
}

var (
	demoMade      = map[string][]int64{}
	demoSent      = map[string][]int64{}
	demoSidRe     = regexp.MustCompile(`^/api/sessions/([^/]+)`)
	demoHidRe     = regexp.MustCompile(`^/api/hosts/([^/]+)`)
	demoSudoText  = regexp.MustCompile(`(?i)^\s*[:/](sudo|root)\b`)
	demoSudoCmd   = regexp.MustCompile(`(?i)^(sudo|root)$`)
	demoSendShape = regexp.MustCompile(`^/api/sessions/S/(say|send|btw|voice|fork|resume)$`)
)

func within(list []int64, ms int64) []int64 {
	now := nowMs()
	out := []int64{}
	for _, t := range list {
		if now-t < ms {
			out = append(out, t)
		}
	}
	return out
}

func demoTooMany(ip string) bool {
	a := within(demoMade[ip], 3_600_000)
	if len(a) >= DEMO_PER_IP_HOUR {
		demoMade[ip] = a
		return true
	}
	demoMade[ip] = append(a, nowMs())
	return false
}

func demoRefuse(text string) {
	if text == "" {
		text = DEMO_REFUSED
	}
	refuse(403, text)
}

// demoGate lets a request of a demo account through, or refuses it with 403 (REQ-S-068).
func demoGate(req *Req, p string, uid string) {
	if m := demoSidRe.FindStringSubmatch(p); m != nil {
		if s, ok := sessions.Get(m[1]); !ok || s.uid() != uid {
			demoRefuse("")
		}
	}
	if m := demoHidRe.FindStringSubmatch(p); m != nil {
		if h, ok := hosts.Get(m[1]); !ok || mstr(h, "uid") != uid {
			demoRefuse("")
		}
	}
	shape := regexp.MustCompile(`^(/api/sessions/)[^/]+`).ReplaceAllString(p, "${1}S")
	shape = regexp.MustCompile(`^(/api/hosts/)[^/]+`).ReplaceAllString(shape, "${1}H")
	okRule := false
	for _, r := range DEMO_ALLOW {
		if r.method == req.Method && r.re.MatchString(shape) {
			okRule = true
		}
	}
	if !okRule {
		demoRefuse("")
	}
	if req.Method == "GET" {
		return
	}
	max := DEMO_BODY_BYTES
	if strings.HasSuffix(shape, "/voice") {
		max = DEMO_VOICE_BYTES
	}
	raw := rawBody(req, max)
	b := M{}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if v, err := parseJSON(raw); err == nil {
		if m, ok := v.(M); ok {
			b = m
		}
	}
	for _, k := range []string{"hostId", "host"} {
		if b[k] != nil && b[k] != "" {
			s, _ := b[k].(string)
			if h, ok := hosts.Get(s); !ok || mstr(h, "uid") != uid {
				demoRefuse("")
			}
		}
	}
	for _, k := range []string{"sid", "session"} {
		if b[k] != nil && b[k] != "" {
			s, _ := b[k].(string)
			if x, ok := sessions.Get(s); !ok || x.uid() != uid {
				demoRefuse("")
			}
		}
	}
	if len(asArr(b["images"])) > 0 || len(asArr(b["videos"])) > 0 {
		demoRefuse("데모에서는 그림이나 영상을 보낼 수 없어요")
	}
	if demoSudoText.MatchString(strField(b, "text")) || demoSudoCmd.MatchString(strField(b, "cmd")) {
		demoRefuse("")
	}
	for _, k := range []string{"text", "prompt", "title", "name"} {
		if jsLen(strField(b, k)) > DEMO_TEXT_MAX {
			refuse(413, "데모에서는 글을 2,000자까지 보낼 수 있어요")
		}
	}
	if shape == "/api/sessions" || demoSendShape.MatchString(shape) {
		a := within(demoSent[uid], 60_000)
		if len(a) >= DEMO_SENDS_PER_MIN {
			refuse(429, "데모에서는 1분에 "+itoa(DEMO_SENDS_PER_MIN)+"번까지 보낼 수 있어요. 잠시 뒤에 다시 해 주세요")
		}
		demoSent[uid] = append(a, nowMs())
	}
	if shape == "/api/sessions" || shape == "/api/sessions/S/fork" {
		n := 0
		for _, s := range sessions.Values() {
			if s.uid() == uid {
				n++
			}
		}
		if n >= DEMO_SESSIONS_MAX {
			demoRefuse("데모에서는 세션을 " + itoa(DEMO_SESSIONS_MAX) + "개까지 만들 수 있어요. 안 쓰는 세션을 지운 뒤 다시 해 주세요")
		}
	}
	// The body read here is handed on to the route as it was (req.readAll keeps it).
}

type demoAccount struct {
	mac    *DemoMac
	hostID string
	at     int64
}

var demoAccounts = newOMap[*demoAccount]()

// forgetUserCaches: what the server keeps in memory for one account.
func forgetUserCaches(uid string) {
	delete(prefsCache, uid)
	delete(noticeCache, uid)
	delete(imgInfoCache, uid)
	delete(pluginCache, uid)
	delete(prSearches, uid)
	delete(lookingAt, uid)
	delete(viewing, uid)
	for _, k := range statsCache.Keys() {
		if strings.HasPrefix(k, uid+"|") {
			statsCache.Delete(k)
		}
	}
}

func forgetSessionMemory(meta *Sess) {
	clearTimeout(reminders[meta.id()])
	delete(reminders, meta.id())
	eventCache.Delete(eventsFile(meta))
	tails.Delete(meta.id())
	sessions.Delete(meta.id())
	dirty.Delete(meta.id())
}

func demoForget(uid string) {
	if a, ok := demoAccounts.Get(uid); ok {
		a.mac.stop()
	}
	for _, meta := range sessions.Values() {
		if meta.uid() == uid {
			forgetSessionMemory(meta)
		}
	}
	_ = os.RemoveAll(userDir(uid))
	forgetUserCaches(uid)
	hostID := demoHostOf(uid)
	bridges.Delete(hostID)
	delete(liveStatus, hostID)
	hosts.Delete(hostID)
	users.Delete(uid)
	demoAccounts.Delete(uid)
}

// demoOpen: a demo account from the seed (REQ-F-766 rule 5). False when there is no room.
func demoOpen(uid string) bool {
	if demoAccounts.Has(uid) {
		demoForget(uid)
	}
	if demoAccounts.Len() >= DEMO_MAX {
		type e struct {
			uid string
			at  int64
		}
		idle := []e{}
		for _, k := range demoAccounts.Keys() {
			a := demoAccounts.Val(k)
			if nowMs()-a.at >= DEMO_EVICT_IDLE_MS {
				idle = append(idle, e{k, a.at})
			}
		}
		sort.SliceStable(idle, func(i, j int) bool { return idle[i].at < idle[j].at })
		if len(idle) == 0 {
			return false
		}
		demoForget(idle[0].uid)
	}
	hostID := demoHostOf(uid)
	users.Set(uid, M{"login": DEMO_LOGIN_NAME, "name": DEMO_LOGIN_NAME, "avatar": ""})
	hosts.Set(hostID, M{"uid": uid, "name": "데모 맥", "home": DEMO_HOME, "lastSeen": float64(nowMs()), "conn": randHex(12)})
	mac := createDemoMac(AGENT_BUILD, func(msgs []any) { fromBridge(uid, hostID, msgs, "") })
	demoAccounts.Set(uid, &demoAccount{mac: mac, hostID: hostID, at: nowMs()})
	bridges.Set(hostID, mac)
	st := live(hostID)
	st["connectedAt"] = float64(nowMs())
	st["connects"] = 1.0
	ids := mac.reset()
	prefsCache[uid] = demoPrefs(ids)
	savePrefs(uid)
	return true
}

func demoTouch(uid string) string {
	a, ok := demoAccounts.Get(uid)
	if !ok {
		if !demoOpen(uid) {
			return ""
		}
		a = demoAccounts.Val(uid)
	}
	a.at = nowMs()
	return uid
}

func startDemoSweep() {
	setInterval(DEMO_SWEEP_MS*time.Millisecond, func() {
		now := nowMs()
		for _, uid := range demoAccounts.Keys() {
			if now-demoAccounts.Val(uid).at >= DEMO_IDLE_MS {
				demoForget(uid)
			}
		}
		for k, v := range demoMade {
			if len(within(v, 3_600_000)) == 0 {
				delete(demoMade, k)
			}
		}
		for k, v := range demoSent {
			if len(within(v, 60_000)) == 0 {
				delete(demoSent, k)
			}
		}
	})
}

func demoTrimLogins() {
	type e struct {
		k   string
		exp float64
	}
	mine := []e{}
	for _, k := range logins.Keys() {
		v := logins.Val(k)
		if isDemoUid(v["uid"]) {
			mine = append(mine, e{k, jsNumber(v["exp"])})
		}
	}
	sort.SliceStable(mine, func(i, j int) bool { return mine[i].exp < mine[j].exp })
	for i := 0; i < len(mine)-DEMO_LOGINS_MAX; i++ {
		logins.Delete(mine[i].k)
	}
}

// demoCleanStart: what an earlier run left (and the single `demo` account of 1.212) goes at every start.
func demoCleanStart() {
	for _, meta := range sessions.Values() {
		if isDemoUid(meta.uid()) || meta.uid() == "demo" {
			sessions.Delete(meta.id())
		}
	}
	if ents, err := os.ReadDir(filepath.Join(DATA, "u")); err == nil {
		for _, e := range ents {
			if isDemoUid(e.Name()) || e.Name() == "demo" {
				_ = os.RemoveAll(userDir(e.Name()))
			}
		}
	}
	for _, id := range hosts.Keys() {
		if isDemoHost(id) || mstr(hosts.Val(id), "uid") == "demo" {
			hosts.Delete(id)
		}
	}
	for _, uid := range users.Keys() {
		if isDemoUid(uid) || uid == "demo" {
			users.Delete(uid)
		}
	}
	if demoOn {
		logLine("공개 데모 켜짐: 데모로 둘러보기(BRIDGE_DEMO=1)")
	}
}

// ---------- 계정 삭제 (REQ-F-770) ----------

func deleteAccount(uid string) {
	login := ""
	if u, ok := users.Get(uid); ok {
		login = mstr(u, "login")
	}
	hostIDs := []string{}
	for _, id := range hosts.Keys() {
		if mstr(hosts.Val(id), "uid") == uid {
			hostIDs = append(hostIDs, id)
		}
	}
	for _, k := range logins.Keys() {
		if mstr(logins.Val(k), "uid") == uid {
			logins.Delete(k)
		}
	}
	if c := controls[uid]; c != nil {
		for _, s := range c.Values() {
			s.End("")
		}
	}
	delete(controls, uid)
	for _, id := range hostIDs {
		if b, ok := bridges.Get(id); ok {
			b.End("")
		}
		bridges.Delete(id)
		delete(liveStatus, id)
		delete(sudoHosts, id)
		hosts.Delete(id)
	}
	for _, meta := range sessions.Values() {
		if meta.uid() != uid {
			continue
		}
		delete(forkSkip, meta.id())
		forgetSessionMemory(meta)
	}
	clearTimeout(stateTimers[uid])
	delete(stateTimers, uid)
	plug.stopUser(uid)
	revokeApple(uid)
	_ = os.RemoveAll(userDir(uid))
	forgetUserCaches(uid)
	for k, v := range qrCodes {
		if v["uid"] == uid {
			delete(qrCodes, k)
		}
	}
	for k, v := range unlocks {
		if v["uid"] == uid {
			delete(unlocks, k)
		}
	}
	if reportAuto["uid"] == uid {
		reportAuto["on"] = false
		reportAuto["uid"] = nil
		reportAuto["by"] = nil
		reportAuto["since"] = nil
		reportAuto["hostId"] = nil
		writeJson(REPORT_AUTO_FILE, reportAuto)
	}
	if login != "" {
		access.Delete(strings.ToLower(login))
	}
	users.Delete(uid)
	touchGlobals()
	flushToDisk()
	logLine("account deleted: " + uid + " (" + itoa(len(hostIDs)) + " host(s))")
}

func revokeApple(uid string) {
	if u, ok := users.Get(uid); !ok || !truthy(u["apple"]) {
		return
	}
	refresh := mget(readJSON(filepath.Join(userDir(uid), "apple.json"), nil), "refresh")
	if apple == nil || !truthy(refresh) {
		why := "APPLE_PRIVATE_KEY 없음"
		if apple != nil {
			why = "토큰 없음"
		}
		logLine("account deleted: " + uid + ": Apple 토큰 취소 건너뜀 (" + why + ")")
		return
	}
	var ok bool
	if err := try(func() { ok = apple.revoke(jsString(refresh)) }); err != nil {
		logLine("account deleted: " + uid + ": Apple 토큰 취소 실패: " + err.Error())
		return
	}
	if ok {
		logLine("account deleted: " + uid + ": Apple 토큰 취소 됨")
	} else {
		logLine("account deleted: " + uid + ": Apple 토큰 취소 실패")
	}
}
