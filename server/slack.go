// The Slack plugin (server/plugins/slack.mjs): one person's sessions, in one Slack channel kept for them, through that
// person's own Slack app. A session is worked on in one place at a time: the bridge or Slack. While it is in Slack it
// is a thread; while it is in the bridge, the thread only says where it went.
//
// Nothing here knows the server. It is given a host (plugins.go) and talks to Slack over HTTP and one Socket Mode
// WebSocket, so there is no public URL to set up.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func slackAPI() string {
	u := os.Getenv("SLACK_API_URL")
	if u == "" {
		u = "https://slack.com/api"
	}
	return strings.TrimRight(u, "/")
}

// A message's markdown_text takes at most 12,000 characters; a piece stays well under it.
const MD_MAX = 10000

func slackEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// A run of 전부 허용 lines (one message) holds at most this many, in at most this many characters.
const (
	AUTO_RUN_MAX  = 30
	AUTO_LIST_MAX = 2800
	AUTO_LINE_MAX = 200
)

func autoEditMs() time.Duration {
	n := jsNumber(os.Getenv("SLACK_AUTO_EDIT_MS"))
	if os.Getenv("SLACK_AUTO_EDIT_MS") == "" || n != n || n == 0 {
		n = 3000
	}
	return time.Duration(n * float64(time.Millisecond))
}

// autoItem: one allowed tool, or a row of the same tool on files or the same thing done again.
type autoItem struct {
	name  string
	desc  bool
	n     int
	whats []string
}

func lineOf(it autoItem) string {
	s := "• *" + slackEsc(it.name) + "*"
	if it.n > len(it.whats) && it.n > 1 {
		s += " ×" + itoa(it.n)
	}
	if len(it.whats) > 0 {
		s += " " + slackEsc(strings.Join(it.whats, ", "))
	}
	return s
}

func listOf(items []autoItem) string {
	lines := make([]string, len(items))
	for i, it := range items {
		lines[i] = lineOf(it)
	}
	return strings.Join(lines, "\n")
}

// withTool: the run's items with one more tool, onto the last line when it is the same tool on another file, or the
// same thing again.
func withTool(items []autoItem, name, what string, desc bool) []autoItem {
	out := append([]autoItem{}, items...)
	if len(items) > 0 {
		last := items[len(items)-1]
		if last.name == name {
			first := ""
			if len(last.whats) > 0 {
				first = last.whats[0]
			}
			if last.desc == desc && len(last.whats) <= 1 && first == what {
				last.n++
				out[len(out)-1] = last
				return out
			}
			if !desc && !last.desc && last.n == len(last.whats) && what != "" && !contains(last.whats, what) {
				grown := autoItem{name: last.name, desc: last.desc, n: last.n + 1, whats: append(append([]string{}, last.whats...), what)}
				if jsLen(lineOf(grown)) <= AUTO_LINE_MAX {
					out[len(out)-1] = grown
					return out
				}
			}
		}
	}
	whats := []string{}
	if what != "" {
		whats = []string{what}
	}
	return append(out, autoItem{name: name, desc: desc, n: 1, whats: whats})
}

// Methods that only read take form fields, not a JSON body.
var slackForm = map[string]bool{"chat.getPermalink": true, "users.conversations": true, "conversations.info": true, "users.info": true}

// Where Slack keeps the files people attach. The bot token goes to no other host (R1-L15).
const FILES_HOST = "files.slack.com"

func onFilesHost(u any) bool {
	s, ok := u.(string)
	if !ok {
		return false
	}
	x, err := url.Parse(s)
	return err == nil && x.Scheme == "https" && x.Hostname() == FILES_HOST && x.Host != ""
}

var slackClient = &http.Client{Timeout: 300 * time.Second}

// slackCall: one Web API call, waiting out a rate limit up to three times. Throws `${method}: ${error}`.
func slackCall(method string, args orderedObj, token string) M {
	for attempt := 0; ; attempt++ {
		form := slackForm[method]
		var body []byte
		ct := "application/json; charset=utf-8"
		if form {
			parts := []string{}
			for _, e := range args {
				if e.V == nil || e.V == "" {
					continue
				}
				parts = append(parts, url.QueryEscape(e.K)+"="+url.QueryEscape(jsString(e.V)))
			}
			body = []byte(strings.Join(parts, "&"))
			ct = "application/x-www-form-urlencoded"
		} else {
			if args == nil {
				args = orderedObj{}
			}
			body = jsonBytes(args)
		}
		var status int
		var retry string
		var raw []byte
		var ferr error
		await(func() {
			rq, err := http.NewRequest("POST", slackAPI()+"/"+method, bytes.NewReader(body))
			if err != nil {
				ferr = err
				return
			}
			rq.Header.Set("Authorization", "Bearer "+token)
			rq.Header.Set("Content-Type", ct)
			r, err := slackClient.Do(rq)
			if err != nil {
				ferr = err
				return
			}
			defer r.Body.Close()
			status = r.StatusCode
			retry = r.Header.Get("Retry-After")
			raw, _ = io.ReadAll(r.Body)
		})
		if ferr != nil {
			throw("fetch failed")
		}
		if status == 429 && attempt < 3 {
			wait := jsNumber(retry)
			if retry == "" || wait != wait || wait == 0 {
				wait = 1
			}
			sleep(time.Duration(wait * float64(time.Second)))
			continue
		}
		v, err := parseJSON(raw)
		j, _ := v.(M)
		if err != nil || j == nil {
			j = M{"ok": false, "error": "http_" + itoa(status)}
		}
		if !truthy(j["ok"]) {
			throw(method + ": " + jsStringU(j["error"]))
		}
		return j
	}
}

func slackButton(text, actionID string, value any, more ...kv) orderedObj {
	o := orderedObj{{"type", "button"}, {"text", orderedObj{{"type", "plain_text"}, {"text", text}, {"emoji", true}}}, {"action_id", actionID}, {"value", value}}
	return append(o, more...)
}

// The app a person makes once: api.slack.com/apps → Create New App → From a manifest.
var SLACK_MANIFEST = orderedObj{
	{"display_information", orderedObj{{"name", "claude-bridge"}}},
	{"features", orderedObj{{"bot_user", orderedObj{{"display_name", "claude-bridge"}, {"always_online", true}}}}},
	{"oauth_config", orderedObj{{"scopes", orderedObj{{"bot", []any{"chat:write", "channels:history", "groups:history", "channels:read", "groups:read", "files:read", "reactions:write"}}}}}},
	{"settings", orderedObj{
		{"event_subscriptions", orderedObj{{"bot_events", []any{"message.channels", "message.groups"}}}},
		{"interactivity", orderedObj{{"is_enabled", true}}},
		{"socket_mode_enabled", true},
	}},
}

// Slack's new-app window with the manifest already in it.
var SLACK_MANIFEST_URL = "https://api.slack.com/apps?new_app=1&manifest_json=" + encodeURIComponent(jsonStr(SLACK_MANIFEST))

var (
	mdFence     = regexp.MustCompile("(?s)```.*?```")
	mdFenceLang = regexp.MustCompile("^```[a-zA-Z0-9_-]+\n")
	mdCode      = regexp.MustCompile("`[^`\n]*`")
	mdHead      = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`)
	mdBold      = regexp.MustCompile(`\*\*([^*\n]+?)\*\*`)
	mdLink      = regexp.MustCompile(`!?\[([^\]\n]+)\]\((https?://[^)\s]+)\)`)
	mdBullet    = regexp.MustCompile(`(?m)^(\s*)[-*]\s+`)
	mdSlot      = regexp.MustCompile("\x00(\\d+)\x00")
)

// toMrkdwn: Markdown as a session writes it → Slack's mrkdwn. Code is left alone; a zero-width space goes around
// bold so Slack sees it next to Korean.
func toMrkdwn(text string) string {
	var out strings.Builder
	at := 0
	plain := func(part string) string {
		codes := []string{}
		part = mdCode.ReplaceAllStringFunc(part, func(c string) string {
			codes = append(codes, c)
			return "\x00" + itoa(len(codes)-1) + "\x00"
		})
		part = slackEsc(part)
		part = mdHead.ReplaceAllString(part, "​*${1}*​")
		part = mdBold.ReplaceAllString(part, "​*${1}*​")
		part = mdLink.ReplaceAllString(part, "<${2}|${1}>")
		part = mdBullet.ReplaceAllString(part, "${1}• ")
		return mdSlot.ReplaceAllStringFunc(part, func(m string) string {
			k, _ := strconv.Atoi(m[1 : len(m)-1])
			if k < len(codes) {
				return codes[k]
			}
			return "undefined"
		})
	}
	for _, loc := range mdFence.FindAllStringIndex(text, -1) {
		out.WriteString(plain(text[at:loc[0]]))
		out.WriteString(mdFenceLang.ReplaceAllString(text[loc[0]:loc[1]], "```\n"))
		at = loc[1]
	}
	out.WriteString(plain(text[at:]))
	return out.String()
}

// pieces: Slack takes about 4000 characters in a message; longer text goes in pieces, cut at a line where it can.
func pieces(text string, max int) []string {
	out := []string{}
	rest := text
	for jsLen(rest) > max {
		cut := jsLastIndexOf(rest, "\n", max)
		at := max
		if float64(cut) > float64(max)/2 {
			at = cut
		}
		out = append(out, jsSliceTo(rest, at))
		rest = strings.TrimPrefix(jsSliceFrom(rest, at), "\n")
	}
	if jsTrim(rest) != "" {
		out = append(out, rest)
	}
	return out
}

func slackPlugin() *pluginDef {
	return &pluginDef{
		id:    "slack",
		name:  "Slack",
		about: "세션을 Slack 전용 채널에서 이어서 할 수 있어요. 한 세션은 한 번에 한 곳(브릿지 또는 Slack)에서만 작업해요. 세션 메뉴의 \"Slack 으로 옮기기\"로 보내고, Slack 스레드의 \"브릿지로 옮기기\"로 가져와요. 채널에 새 글을 쓰면 Slack 에서 작업하는 새 세션이 떠요. 내 Slack 앱과 내 채널을 써요.",
		fields: []pluginField{
			{key: "botToken", label: "Bot 토큰", placeholder: "xoxb-…", secret: true, required: true, prefix: "xoxb-"},
			{key: "appToken", label: "App 토큰 (Socket Mode)", placeholder: "xapp-…", secret: true, required: true, prefix: "xapp-"},
			{key: "channel", label: "전용 채널", placeholder: "C0123ABCD", required: true, pick: "채널 고르기"},
			// places: JSON {main: hostId, dirs: {hostId: folder}}, set with buttons.
			{key: "places", label: "기기별로 새 세션을 띄울 곳", kind: "places", max: 4000},
			{key: "cwd", label: "기기별 폴더가 없을 때 쓸 폴더 (비우면 홈)", placeholder: "~/projects"},
		},
		help: []any{
			orderedObj{
				{"title", "1. Slack 앱 만들기 (1분)"},
				{"text", "아래 링크를 열면 매니페스트가 채워진 새 앱 창이 떠요. 워크스페이스를 고르고 Next → Create 를 누릅니다. 권한과 Socket Mode 설정이 매니페스트에 다 들어 있어서 따로 켤 것은 없습니다. 창이 비어 있으면 From a manifest 를 고르고 JSON 탭에 복사한 매니페스트를 붙여 넣습니다."},
				{"link", orderedObj{{"label", "매니페스트 채운 새 앱 창 열기"}, {"url", SLACK_MANIFEST_URL}}},
				{"copy", orderedObj{{"label", "앱 매니페스트 복사"}, {"text", jsonIndent(SLACK_MANIFEST, 2)}}},
			},
			orderedObj{
				{"title", "2. 워크스페이스에 설치하고 Bot 토큰 받기"},
				{"text", "왼쪽 메뉴의 Install App → Install to Workspace → 허용. 설치가 끝나면 보이는 Bot User OAuth Token (xoxb- 로 시작) 을 복사해 위의 \"Bot 토큰\" 칸에 넣습니다. 나중에 다시 보려면 OAuth & Permissions 에 있습니다."},
			},
			orderedObj{
				{"title", "3. App 토큰 만들기"},
				{"text", "왼쪽 메뉴의 Basic Information → 아래로 내려 App-Level Tokens → Generate Token and Scopes. 이름은 아무거나(예: socket), Add Scope 에서 connections:write 를 고르고 Generate. 나온 토큰 (xapp- 로 시작) 을 \"App 토큰\" 칸에 넣습니다."},
			},
			orderedObj{
				{"title", "4. 전용 채널 만들고 봇 부르기"},
				{"text", "Slack 에서 Agent Bridge 만 쓰는 채널을 하나 만듭니다(혼자 쓰는 비공개 채널을 권합니다). 다른 봇이나 대화가 있는 채널은 피하세요: 채널 맨 위에 쓴 글은 모두 새 세션이 됩니다. 채널에 아래 명령을 보내 봇을 부릅니다."},
				{"copy", orderedObj{{"label", "초대 명령 복사"}, {"text", "/invite @claude-bridge"}}},
			},
			orderedObj{
				{"title", "5. 전용 채널 고르고 켜기"},
				{"text", "\"전용 채널\" 칸 옆의 \"채널 고르기\" 를 누르면 봇이 들어간 채널이 나옵니다. 4단계의 채널을 고르고 \"저장하고 켜기\" 를 누릅니다. 봇이 들어간 채널이 하나뿐이면 비워 두고 눌러도 그 채널로 정해집니다. 목록이 안 나오면 채널 이름을 눌러 채널 정보 맨 아래의 채널 ID (C 로 시작) 를 복사해 직접 넣어도 됩니다. 상태가 \"켜짐\" 이 되면 연결된 것입니다."},
			},
			orderedObj{
				{"title", "6. 내 Slack 계정 연결하기"},
				{"text", "채널에 아무 글이나 한 번 씁니다. 봇이 나에게만 보이는 연결 링크를 줍니다. 이 사이트에 로그인한 브라우저에서 그 링크를 열면 끝입니다. 링크를 열지 않은 Slack 계정은 채널에 있어도 세션을 조작할 수 없습니다."},
			},
			orderedObj{
				{"title", "7. 브릿지와 Slack 오가기"},
				{"text", "한 세션은 한 번에 한 곳에서만 작업합니다. 브릿지의 세션 메뉴에서 \"Slack 으로 옮기기\" 를 누르면 전용 채널에 그 세션의 스레드가 생기고(있으면 그 스레드를 이어 씁니다), 브릿지 화면은 읽기 전용이 됩니다. 스레드의 \"브릿지로 옮기기\" 를 누르면 브릿지에서 이어서 쓰고, 스레드에는 브릿지로 가는 링크가 남습니다. 어느 쪽에서 나눈 대화든 브릿지의 세션 화면에 모두 남습니다."},
			},
			orderedObj{
				{"title", "안 될 때"},
				{"text", "\"토큰을 받지 않았어요\": 두 토큰이 서로 바뀌지 않았는지(xoxb- 는 Bot, xapp- 는 App) 확인합니다. \"채널 고르기\" 가 권한이 없다고 하면: 예전 매니페스트로 만든 앱입니다. OAuth & Permissions 에서 channels:read, groups:read 를 더하고 앱을 다시 설치합니다. 켜짐인데 반응이 없으면: 봇이 그 채널에 들어와 있는지 확인합니다. 새 세션이 안 뜨면: 맥의 에이전트가 연결돼 있어야 합니다."},
			},
		},
		prompt: orderedObj{
			{"label", "AI 에게 Slack 쪽 준비 맡기기"},
			{"about", "브라우저를 조작할 수 있는 AI(Claude in Chrome 등)에게 주면 앱 만들기, 설치 준비, 전용 채널 만들기와 봇 초대까지 해요. 토큰 두 개를 복사해 넣는 것만 직접 하면 돼요. Slack 에 로그인된 브라우저여야 해요."},
			{"text", `Agent Bridge 를 Slack 에 연결하려고 해. Slack 쪽 준비를 내 브라우저로 대신 해 줘. 단계마다 끝나면 한 줄로 알려 줘.

지킬 것
- 토큰은 다루지 마. 화면에 xoxb-, xapp- 로 시작하는 값이 보여도 읽거나 옮겨 적거나 어디에 넣지 마. 토큰은 내가 직접 복사해.
- 권한 허용(Allow) 화면, 워크스페이스 고르기처럼 내가 정할 것이 나오면 멈추고 나에게 물어.
- 다른 앱의 설정을 바꾸거나, 앱·채널을 지우거나, 다른 사람을 초대하지 마. 메시지는 3단계의 초대 명령만 보내.

1. 앱 만들기: 아래 링크를 연다. 매니페스트가 채워진 새 앱 창이 뜬다. 워크스페이스를 고르고(여러 개면 나에게 묻는다) Next → Create 를 누른다.
   ` + SLACK_MANIFEST_URL + `
   창이 비어 있으면 "From a manifest" 를 고르고 JSON 탭의 내용을 지운 뒤 아래 매니페스트를 붙여 넣는다.
` + jsonStr(SLACK_MANIFEST) + `

2. 설치와 App 토큰 만들기: 왼쪽 메뉴 Install App → Install to Workspace 를 누르고, 허용 화면에서 멈춰 내가 누르게 한다. 그다음 Basic Information → App-Level Tokens → Generate Token and Scopes 에서 이름 socket, 범위 connections:write 로 Generate 한다. 만든 토큰 창은 닫지 말고 그대로 둔다.

3. 전용 채널: Agent Bridge 만 쓰는 비공개 채널을 만든다. 이름은 agent-bridge 를 제안하고 나에게 확인받는다(이미 있으면 다른 이름을 묻는다). 다른 대화가 있는 채널은 쓰지 않는다. 그 채널에 "/invite @claude-bridge" 를 보내 봇을 부른다.

4. 끝나면 앱 이름, 워크스페이스, 채널 이름을 알려 주고 내가 할 일을 이대로 적어 줘:
   - Bot 토큰(xoxb-): 앱 설정 → OAuth & Permissions → Bot User OAuth Token 복사
   - App 토큰(xapp-): 앱 설정 → Basic Information → App-Level Tokens → socket 복사
   - {origin}/guide 의 Slack 단계에서 "토큰 넣기" 를 눌러 두 토큰을 붙여 넣고, "채널 고르기" 로 3단계의 채널을 고른 뒤 "저장하고 켜기"
   - 채널에 아무 글이나 한 번 써서 봇이 주는 연결 링크를 열기`},
		},
		choices: slackChoices,
		start:   startSlack,
	}
}

var (
	reMissingScope = regexp.MustCompile(`missing_scope`)
	reBadToken     = regexp.MustCompile(`invalid_auth|not_authed|token_revoked|account_inactive`)
	reFatal        = regexp.MustCompile(`invalid_auth|not_authed|account_inactive|token_revoked|not_allowed_token_type|missing_scope`)
)

// localeLess approximates String.prototype.localeCompare for channel labels: case-insensitive first, lower case
// before upper case on a tie.
func localeLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}
	return a > b
}

// slackChoices: the channels the bot is in, for "채널 고르기".
func slackChoices(config M, key string) []any {
	if key != "channel" {
		return []any{}
	}
	token, _ := config["botToken"].(string)
	if token == "" {
		throw("Bot 토큰을 먼저 넣어 주세요")
	}
	type ch struct {
		value, label, hint string
	}
	out := []ch{}
	cursor := ""
	if err := try(func() {
		for page := 0; page < 10; page++ {
			r := slackCall("users.conversations", orderedObj{{"types", "public_channel,private_channel"}, {"exclude_archived", true}, {"limit", 200.0}, {"cursor", cursor}}, token)
			for _, c := range asArr(r["channels"]) {
				kind := "공개"
				if truthy(mget(c, "is_private")) {
					kind = "비공개"
				}
				id := jsStringU(mget(c, "id"))
				out = append(out, ch{id, "#" + jsStringU(mget(c, "name")), kind + " · " + id})
			}
			cursor, _ = mget(r["response_metadata"], "next_cursor").(string)
			if cursor == "" {
				break
			}
		}
	}); err != nil {
		if reMissingScope.MatchString(err.Error()) {
			throw("Slack 앱에 channels:read, groups:read 권한이 없어요. OAuth & Permissions 에서 두 권한을 더하고 앱을 다시 설치하거나, 채널 ID 를 직접 넣어 주세요")
		}
		if reBadToken.MatchString(err.Error()) {
			throw("Slack 이 Bot 토큰을 받지 않았어요 (" + err.Error() + ")")
		}
		panic(err)
	}
	if len(out) == 0 {
		throw("봇이 들어간 채널이 없어요. 전용 채널에서 /invite @claude-bridge 를 보낸 뒤 다시 눌러 주세요")
	}
	sort.SliceStable(out, func(i, j int) bool { return localeLess(out[i].label, out[j].label) })
	res := []any{}
	for _, c := range out {
		res = append(res, orderedObj{{"value", c.value}, {"label", c.label}, {"hint", c.hint}})
	}
	return res
}

type autoRun struct {
	ts     any
	items  []autoItem
	total  int
	counts *OMap[int]
	sent   int
	timer  *Timer
}

type slackInst struct {
	config      M
	host        *plugHost
	st          M
	pending     map[string]string
	statusV     M
	stopped     bool
	ws          *wsClient
	botUser     string
	channelName string
	queue       []func()
	queueBusy   bool
	mdRefused   int64
	runs        *OMap[*autoRun]
	msgOrder    []string
}

func cfgStr(c M, k string) string {
	s, _ := c[k].(string)
	return s
}

func startSlack(config M, host *plugHost) PluginInst {
	s := &slackInst{config: config, host: host, st: host.state, pending: map[string]string{}, runs: newOMap[*autoRun]()}
	for _, k := range []string{"threads", "msgs", "seatMsg"} {
		if _, ok := s.st[k].(M); !ok || s.st[k] == nil {
			if s.st[k] == nil {
				s.st[k] = M{}
			}
		}
	}
	if s.st["users"] == nil {
		s.st["users"] = []any{}
	}
	// What order the cards came in is not in the saved object any more; the ids sort the way they were made.
	s.msgOrder = sortedKeys(asM(s.st["msgs"]))
	s.statusV = M{"state": "connecting", "note": "Slack 에 연결하는 중"}
	go locked("slack connect", s.connect)
	return s
}

func (s *slackInst) threads() M { return asM(s.st["threads"]) }
func (s *slackInst) msgs() M    { return asM(s.st["msgs"]) }
func (s *slackInst) seatMsg() M { return asM(s.st["seatMsg"]) }
func (s *slackInst) users() []any {
	u, _ := s.st["users"].([]any)
	return u
}
func (s *slackInst) channel() any { return s.config["channel"] }

func (s *slackInst) where() string {
	if s.channelName != "" {
		return "#" + s.channelName
	}
	return jsStringU(s.channel())
}

func (s *slackInst) bySlack() M {
	out := M{}
	for _, k := range sortedKeys(s.threads()) {
		out[jsString(s.threads()[k])] = k
	}
	return out
}

func (s *slackInst) here(thread string) bool {
	seat := s.host.Seat(thread)
	return seat != nil && seat["where"] == "slack"
}

func (s *slackInst) slack(method string, args orderedObj) M {
	return slackCall(method, args, cfgStr(s.config, "botToken"))
}

// queued: one thing at a time, in order: a card must not be posted before the text that led to it. Called with the
// lock held; the job runs with it too. The channel says how it ended.
func (s *slackInst) queued(fn func()) chan error {
	done := make(chan error, 1)
	s.queue = append(s.queue, func() {
		err := try(fn)
		if err != nil {
			s.host.log("slack: " + err.Error())
		}
		done <- err
	})
	if !s.queueBusy {
		s.queueBusy = true
		go func() {
			mu.Lock()
			defer mu.Unlock()
			for len(s.queue) > 0 {
				f := s.queue[0]
				s.queue = s.queue[1:]
				f()
			}
			s.queueBusy = false
		}()
	}
	return done
}

func (s *slackInst) inOrder(fn func()) chan error { return s.queued(fn) }

func waitDone(done chan error) error {
	var err error
	await(func() { err = <-done })
	return err
}

// post: Slack takes at most 50 blocks in a message and refuses the whole message past that.
func (s *slackInst) post(threadTs any, text any, blocks []any) M {
	args := orderedObj{{"channel", s.channel()}}
	if threadTs != nil {
		args = append(args, kv{"thread_ts", threadTs})
	}
	args = append(args, kv{"text", truncate(jsStringU(text), 3900)})
	if blocks != nil {
		if len(blocks) > 50 {
			blocks = blocks[:50]
		}
		args = append(args, kv{"blocks", blocks})
	}
	args = append(args, kv{"unfurl_links", false})
	return s.slack("chat.postMessage", args)
}

// postMd: what a session says goes as markdown_text; if Slack will not take that, as mrkdwn for 10 minutes.
func (s *slackInst) postMd(threadTs any, md string) M {
	if nowMs()-s.mdRefused > 600_000 {
		var r M
		err := try(func() {
			args := orderedObj{{"channel", s.channel()}}
			if threadTs != nil {
				args = append(args, kv{"thread_ts", threadTs})
			}
			r = s.slack("chat.postMessage", append(args, kv{"markdown_text", md}, kv{"unfurl_links", false}))
		})
		if err == nil {
			return r
		}
		s.mdRefused = nowMs()
		s.host.log("slack: markdown_text 를 받지 않아 mrkdwn 으로 보냄 (" + err.Error() + ")")
	}
	var r M
	for _, p := range pieces(toMrkdwn(md), 3500) {
		r = s.post(threadTs, p, nil)
	}
	return r
}

func (s *slackInst) whisper(user any, threadTs any, text string, blocks []any) {
	args := orderedObj{{"channel", s.channel()}, {"user", user}}
	if threadTs != nil {
		args = append(args, kv{"thread_ts", threadTs})
	}
	args = append(args, kv{"text", text})
	if blocks != nil {
		args = append(args, kv{"blocks", blocks})
	}
	_ = try(func() { s.slack("chat.postEphemeral", args) })
}

func (s *slackInst) permalink(ts any) any {
	var out any
	_ = try(func() {
		r := s.slack("chat.getPermalink", orderedObj{{"channel", s.channel()}, {"message_ts", ts}})
		out = r["permalink"]
	})
	return out
}

func slackSection(text string) orderedObj {
	return orderedObj{{"type", "section"}, {"text", orderedObj{{"type", "mrkdwn"}, {"text", truncate(text, 2900)}}}}
}

func (s *slackInst) toWeb(thread string) orderedObj {
	more := []kv{{"style", "primary"}}
	if seat := s.host.Seat(thread); seat != nil && truthy(seat["link"]) {
		more = append(more, kv{"url", seat["link"]})
	}
	return slackButton("브릿지로 옮기기", "seat_web", thread, more...)
}

func (s *slackInst) toSlack(thread string) orderedObj {
	return slackButton("Slack 으로 가져오기", "seat_slack", thread)
}

// seatMessage: the message that says where a session is, with the button that moves it; the one before loses its
// button.
func (s *slackInst) seatMessage(thread string, root any, text string, btn orderedObj) any {
	if old := asM(s.seatMsg()[thread]); old != nil && s.seatMsg()[thread] != nil {
		ot := jsStringU(old["text"])
		_ = try(func() {
			s.slack("chat.update", orderedObj{{"channel", s.channel()}, {"ts", old["ts"]}, {"text", truncate(ot, 3900)}, {"blocks", []any{slackSection(ot)}}})
		})
	}
	r := s.post(root, text, []any{slackSection(text), orderedObj{{"type", "actions"}, {"block_id", "bridge_seat"}, {"elements", []any{btn}}}})
	s.seatMsg()[thread] = M{"ts": r["ts"], "text": text}
	s.host.save()
	return r["ts"]
}

// threadOf: the Slack thread of a session; made with a head when the session has none yet.
func (s *slackInst) threadOf(thread string) any {
	if t := s.threads()[thread]; truthy(t) {
		return t
	}
	f := s.host.Find(thread)
	title := "새 세션"
	for _, k := range []string{"title", "name", "preview"} {
		if truthy(f[k]) {
			title = jsString(f[k])
			break
		}
	}
	bits := []string{}
	for _, v := range []any{mget(f["bridge"], "host"), f["cwd"]} {
		if truthy(v) {
			bits = append(bits, jsString(v))
		}
	}
	r := s.post(nil, "*"+truncate(title, 80)+"*\n"+strings.Join(bits, " · "), nil)
	s.threads()[thread] = r["ts"]
	s.host.save()
	return r["ts"]
}

func runText(run *autoRun) string { return "⚡ 자동 허용 " + itoa(run.total) + "개" }

func runBlocks(run *autoRun) []any {
	parts := []string{}
	for _, n := range run.counts.Keys() {
		c := run.counts.Val(n)
		if c > 1 {
			parts = append(parts, n+" "+itoa(c))
		} else {
			parts = append(parts, n)
		}
	}
	return []any{slackSection(truncate(runText(run)+" · "+strings.Join(parts, " · "), 300)), slackSection(listOf(run.items))}
}

func (s *slackInst) edit(run *autoRun) {
	if s.stopped || run.sent == run.total {
		return
	}
	run.sent = run.total
	s.slack("chat.update", orderedObj{{"channel", s.channel()}, {"ts", run.ts}, {"text", runText(run)}, {"blocks", runBlocks(run)}})
}

// endRun (in the queue): the run is over; what it took since its last edit is written before anything else goes out.
func (s *slackInst) endRun(thread string) {
	run, ok := s.runs.Get(thread)
	if !ok {
		return
	}
	s.runs.Delete(thread)
	clearTimeout(run.timer)
	s.edit(run)
}

// allowed (in the queue): one more allowed tool, onto the open run or a new one.
func (s *slackInst) allowed(thread string, ev M) {
	auto := asM(ev["auto"])
	name := "터미널 확인 창"
	if auto != nil && auto["name"] != nil {
		name = jsString(auto["name"])
	}
	what := ""
	if auto != nil && auto["what"] != nil {
		what = jsString(auto["what"])
	}
	desc := auto != nil && truthy(auto["desc"])
	run, has := s.runs.Get(thread)
	var items []autoItem
	if has {
		items = withTool(run.items, name, what, desc)
		if len(items) > AUTO_RUN_MAX || jsLen(listOf(items)) > AUTO_LIST_MAX {
			s.endRun(thread)
			has = false
		}
	}
	if has {
		run.items = items
		run.total++
		run.counts.Set(name, run.counts.Val(name)+1)
		// Edits are spaced out: chat.update is limited per app, and every session in Slack shares it.
		if run.timer == nil {
			r := run
			run.timer = setTimeout(autoEditMs(), func() {
				r.timer = nil
				s.inOrder(func() { s.edit(r) })
			})
		}
		return
	}
	counts := newOMap[int]()
	counts.Set(name, 1)
	run = &autoRun{items: withTool(nil, name, what, desc), total: 1, counts: counts, sent: 1}
	r := s.post(s.threadOf(thread), runText(run), runBlocks(run))
	run.ts = r["ts"]
	s.runs.Set(thread, run)
}

func blocksOf(v any) []any {
	b := asArr(v)
	if b == nil {
		b = []any{}
	}
	if len(b) > 50 {
		b = b[:50]
	}
	return b
}

// onEvent: what a session did, in the Slack shape (cs.go). Only a session in Slack is posted.
func (s *slackInst) onEvent(thread string, evAny any) {
	ev := asM(evAny)
	if s.stopped || ev == nil {
		return
	}
	typ := ev["type"]
	text := truthy(ev["text"])
	eph := truthy(ev["ephemeral"])
	// A card already in the thread is kept true wherever it was answered.
	if typ == "msg_update" {
		s.inOrder(func() {
			if ts := s.msgs()[jsString(ev["ts"])]; truthy(ts) {
				s.slack("chat.update", orderedObj{{"channel", s.channel()}, {"ts", ts}, {"text", truncate(jsStringU(ev["text"]), 3900)}, {"blocks", blocksOf(ev["blocks"])}})
			}
		})
		return
	}
	if !s.here(thread) {
		return
	}
	if typ == "msg" && truthy(ev["auto"]) && !eph {
		s.inOrder(func() { s.allowed(thread, ev) })
		return
	}
	userOut := typ == "user" && ev["via"] != "slack" && text
	if userOut || (typ == "text" && text) || (typ == "msg" && !eph) || (typ == "notice" && text) || typ == "end" {
		s.inOrder(func() { s.endRun(thread) })
	}
	switch {
	case userOut:
		s.inOrder(func() {
			t := jsString(ev["text"])
			s.post(s.threadOf(thread), "💬 "+t, []any{orderedObj{{"type", "context"}, {"elements", []any{orderedObj{{"type", "mrkdwn"}, {"text", "💬 Slack 밖에서 보냄: " + truncate(toMrkdwn(t), 2800)}}}}}})
		})
	case typ == "text" && text:
		s.inOrder(func() {
			ts := s.threadOf(thread)
			for _, p := range pieces(jsString(ev["text"]), MD_MAX) {
				s.postMd(ts, p)
			}
		})
	case typ == "msg" && !eph:
		s.inOrder(func() {
			r := s.post(s.threadOf(thread), ev["text"], asArr(ev["blocks"]))
			k := jsStringU(ev["ts"])
			if _, had := s.msgs()[k]; !had {
				s.msgOrder = append(s.msgOrder, k)
			}
			s.msgs()[k] = r["ts"]
			// Kept for the cards still open and a while after; not for ever.
			if n := len(s.msgOrder) - 300; n > 0 {
				for _, old := range s.msgOrder[:n] {
					delete(s.msgs(), old)
				}
				s.msgOrder = append([]string{}, s.msgOrder[n:]...)
			}
			s.host.save()
		})
	case typ == "notice" && text:
		s.inOrder(func() {
			t := jsString(ev["text"])
			s.post(s.threadOf(thread), t, []any{orderedObj{{"type", "context"}, {"elements", []any{orderedObj{{"type", "mrkdwn"}, {"text", truncate(toMrkdwn(t), 2900)}}}}}})
		})
	case typ == "end":
		s.inOrder(func() {
			if root := s.threads()[thread]; truthy(root) {
				why := "종료"
				if ev["why"] != nil {
					why = jsString(ev["why"])
				}
				s.post(root, "세션이 끝났어요 ("+why+")", nil)
			}
		})
	}
}

// moveIn: from the bridge into Slack; the session's thread (made now if it has none) says where the earlier talk is.
func (s *slackInst) moveIn(thread string) M {
	var out M
	done := s.queued(func() {
		_ = try(func() { s.endRun(thread) })
		sm := s.host.Summary(thread)
		if sm == nil {
			sm = M{}
		}
		lines := []string{"🔀 *Slack 으로 옮겼어요.* 이제 이 스레드에 답하면 세션에 전달돼요."}
		if truthy(sm["link"]) {
			lines = append(lines, "이전 대화: <"+jsString(sm["link"])+"|브릿지에서 보기>")
		}
		if truthy(sm["last"]) {
			lines = append(lines, "마지막 답:\n>"+strings.ReplaceAll(truncate(toMrkdwn(jsString(sm["last"])), 700), "\n", "\n>"))
		}
		root := s.threads()[thread]
		var ts any
		if truthy(root) {
			ts = s.seatMessage(thread, root, strings.Join(lines, "\n"), s.toWeb(thread))
		} else {
			// A new thread: its first message is the head and carries the button.
			title := "세션"
			if truthy(sm["title"]) {
				title = jsString(sm["title"])
			}
			head := "*" + truncate(title, 80) + "*"
			if truthy(sm["host"]) || truthy(sm["cwd"]) {
				bits := []string{}
				for _, v := range []any{sm["host"], sm["cwd"]} {
					if truthy(v) {
						bits = append(bits, jsString(v))
					}
				}
				head += "\n" + strings.Join(bits, " · ")
			}
			ts = s.seatMessage(thread, nil, head+"\n"+strings.Join(lines, "\n"), s.toWeb(thread))
			root = ts
			s.threads()[thread] = root
			s.host.save()
		}
		u := s.permalink(ts)
		if u == nil {
			u = s.permalink(root)
		}
		out = M{"url": u}
	})
	if err := waitDone(done); err != nil {
		panic(err)
	}
	return out
}

// moveOut: from Slack to the bridge; the thread keeps a way to the session's page and a way back.
func (s *slackInst) moveOut(thread string) {
	var link any
	if seat := s.host.Seat(thread); seat != nil {
		link = seat["link"]
	}
	s.inOrder(func() {
		_ = try(func() { s.endRun(thread) })
		root := s.threads()[thread]
		if !truthy(root) {
			return
		}
		to := "브릿지에서 여세요"
		if truthy(link) {
			to = "<" + jsString(link) + "|브릿지에서 열기>"
		}
		s.seatMessage(thread, root, "🌐 *브릿지로 옮겼어요.* 이어서 하려면 "+to+". 이 스레드에 쓰는 글은 이제 세션에 가지 않아요.", s.toSlack(thread))
	})
}

// askToLink: someone the plugin has not seen gets a link, and whoever is signed in to the bridge decides.
func (s *slackInst) askToLink(user string, threadTs any) {
	code := s.host.Code()
	s.pending[code] = user
	setTimeout(10*time.Minute, func() { delete(s.pending, code) })
	args := orderedObj{{"channel", s.channel()}, {"user", user}}
	if threadTs != nil {
		args = append(args, kv{"thread_ts", threadTs})
	}
	s.slack("chat.postEphemeral", append(args, kv{"text", "이 Slack 계정으로 세션을 조작하려면 Agent Bridge 에 로그인한 브라우저에서 이 링크를 여세요 (10분): " + s.host.Origin() + "/api/plugins/slack/link?code=" + code}))
}

var slackImageType = regexp.MustCompile(`^image/(png|jpeg|gif|webp)$`)

func (s *slackInst) pictures(files any) []any {
	out := []any{}
	n := 0
	for _, f := range asArr(files) {
		mt, _ := mget(f, "mimetype").(string)
		if !slackImageType.MatchString(mt) || !onFilesHost(mget(f, "url_private")) {
			continue
		}
		if n++; n > 8 {
			break
		}
		var data []byte
		okRes := false
		var ferr error
		u := jsString(mget(f, "url_private"))
		token := cfgStr(s.config, "botToken")
		await(func() {
			rq, err := http.NewRequest("GET", u, nil)
			if err != nil {
				ferr = err
				return
			}
			rq.Header.Set("Authorization", "Bearer "+token)
			r, err := slackClient.Do(rq)
			if err != nil {
				ferr = err
				return
			}
			defer r.Body.Close()
			okRes = r.StatusCode >= 200 && r.StatusCode < 300
			data, _ = io.ReadAll(r.Body)
		})
		if ferr != nil {
			throw("fetch failed")
		}
		if okRes {
			out = append(out, M{"name": mget(f, "name"), "data": "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(data)})
		}
	}
	return out
}

var slackMention = regexp.MustCompile(`<@[A-Z0-9]+>\s*`)

func (s *slackInst) isUser(u any) bool { return containsAny(s.users(), u) }

func (s *slackInst) onMessage(m M) {
	if m["channel"] != s.channel() || truthy(m["bot_id"]) || !truthy(m["user"]) || m["user"] == s.botUser {
		return
	}
	if truthy(m["subtype"]) && m["subtype"] != "file_share" {
		return
	}
	user := jsString(m["user"])
	if !s.isUser(user) {
		s.askToLink(user, m["thread_ts"])
		return
	}
	text := ""
	if m["text"] != nil {
		text = jsString(m["text"])
	}
	text = slackMention.ReplaceAllString(text, "")
	text = jsTrim(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(text, "&lt;", "<"), "&gt;", ">"), "&amp;", "&"))
	at := m["thread_ts"]
	if at == nil {
		at = m["ts"]
	}
	say := func(t string) { _ = try(func() { s.post(at, t, nil) }) }
	if err := try(func() {
		if m["thread_ts"] != nil {
			thread, _ := s.bySlack()[jsString(m["thread_ts"])].(string)
			if thread == "" {
				say("이 스레드에 이어진 세션이 없어요. 채널에 새 글을 쓰면 새 세션이 떠요.")
				return
			}
			if seat := s.host.Seat(thread); seat != nil && seat["where"] != "slack" {
				t := "이 세션은 지금 브릿지에서 작업 중이라 이 글은 전달하지 않았어요. <" + jsStringU(seat["link"]) + "|브릿지에서 열기>"
				s.whisper(user, m["thread_ts"], t, []any{slackSection(t), orderedObj{{"type", "actions"}, {"elements", []any{s.toSlack(thread)}}}})
				return
			}
			if text == "브릿지로 옮기기" {
				s.host.MoveTo(thread, "web")
				return
			}
			images := s.pictures(m["files"])
			if text == "" && len(images) == 0 {
				return
			}
			s.host.Send(thread, text, images)
		} else {
			images := s.pictures(m["files"])
			if text == "" && len(images) == 0 {
				return
			}
			// In the queue: what the new session says while it starts waits until its thread is known.
			waitDone(s.inOrder(func() {
				if err := try(func() {
					started := s.host.Start(text, cfgStr(s.config, "cwd"), cfgStr(s.config, "places"))
					thread := jsString(started["thread"])
					s.threads()[thread] = m["ts"]
					s.host.save()
					s.seatMessage(thread, m["ts"], "세션을 띄웠어요. 이 스레드에 답하면 세션에 전달돼요. 웹에서 이어서 하려면 *브릿지로 옮기기* 를 누르세요.", s.toWeb(thread))
					s.host.SeatUrl(thread, s.permalink(m["ts"]))
				}); err != nil {
					say("⚠️ " + err.Error())
				}
			}))
		}
	}); err != nil {
		say("⚠️ " + err.Error())
	}
}

func (s *slackInst) onAction(p M) {
	if mget(p["channel"], "id") != s.channel() {
		return
	}
	threadTs := mget(p["message"], "thread_ts")
	if threadTs == nil {
		threadTs = mget(p["container"], "thread_ts")
	}
	uid := mget(p["user"], "id")
	if !s.isUser(uid) {
		s.askToLink(jsStringU(uid), threadTs)
		return
	}
	for _, a := range asArr(p["actions"]) {
		if err := try(func() {
			id := mget(a, "action_id")
			if id == "seat_web" || id == "seat_slack" {
				to := "slack"
				if id == "seat_web" {
					to = "web"
				}
				s.host.MoveTo(jsStringU(mget(a, "value")), to)
			} else {
				v := mget(a, "value")
				if v == nil {
					v = mget(mget(a, "selected_option"), "value")
				}
				if v == nil {
					v = ""
				}
				s.host.Command(jsString(v))
			}
		}); err != nil {
			s.whisper(uid, threadTs, "⚠️ "+err.Error(), nil)
		}
	}
}

// connect: Socket Mode. Slack hands out a WebSocket address; every envelope is acknowledged, then acted on.
func (s *slackInst) connect() {
	wait := time.Second
	for !s.stopped {
		err := try(func() {
			s.botUser = jsString(s.slack("auth.test", nil)["user_id"])
			if s.channelName == "" {
				_ = try(func() {
					r := s.slack("conversations.info", orderedObj{{"channel", s.channel()}})
					if n := mget(r["channel"], "name"); n != nil {
						s.channelName = jsString(n)
					}
				})
			}
			r := slackCall("apps.connections.open", orderedObj{}, cfgStr(s.config, "appToken"))
			u := jsStringU(r["url"])
			var c *wsClient
			var derr error
			await(func() { c, derr = dialWS(u) })
			if derr != nil {
				throw("Slack 과의 연결이 끊겼어요")
			}
			if s.stopped {
				c.close()
				return
			}
			s.ws = c
			wait = time.Second
			note := "연결됨 · 채널 " + s.where()
			if len(s.users()) == 0 {
				note += " · 채널에 글을 써서 Slack 계정을 연결하세요"
			}
			s.statusV = M{"state": "on", "note": note}
			s.host.changed()
			await(func() {
				for {
					msg, err := c.read()
					if err != nil {
						return
					}
					v, perr := parseJSON(msg)
					env, _ := v.(M)
					if perr != nil || env == nil {
						continue
					}
					if id := env["envelope_id"]; id != nil {
						c.sendText(jsonBytes(orderedObj{{"envelope_id", id}}))
					}
					if env["type"] == "disconnect" {
						c.close()
						continue
					}
					pl := asM(env["payload"])
					if env["type"] == "events_api" && mget(pl["event"], "type") == "message" {
						ev := asM(pl["event"])
						goLocked("slack", func() {
							if err := try(func() { s.onMessage(ev) }); err != nil {
								s.host.log("slack: " + err.Error())
							}
						})
					} else if env["type"] == "interactive" && pl["type"] == "block_actions" {
						goLocked("slack", func() {
							if err := try(func() { s.onAction(pl) }); err != nil {
								s.host.log("slack: " + err.Error())
							}
						})
					}
				}
			})
		})
		if err != nil {
			// A wrong token does not get better by trying again every second.
			fatal := reFatal.MatchString(err.Error())
			note := "다시 연결하는 중 (" + err.Error() + ")"
			if fatal {
				note = "Slack 이 토큰을 받지 않았어요 (" + err.Error() + ")"
			}
			s.statusV = M{"state": "error", "note": note}
			s.host.changed()
			if fatal {
				return
			}
		}
		if s.stopped {
			return
		}
		sleep(wait)
		wait *= 2
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
	}
}

func (s *slackInst) status() M {
	out := shallow(s.statusV)
	out["linked"] = float64(len(s.users()))
	return out
}

// who: who a link would connect, for the page that asks before connecting (R1-M2). Nil when the code is unknown or
// expired. Looking does not use the code up.
func (s *slackInst) who(code string) M {
	user, ok := s.pending[code]
	if !ok {
		return nil
	}
	var u M
	_ = try(func() { u = asM(s.slack("users.info", orderedObj{{"user", user}})["user"]) })
	name := any(user)
	for _, v := range []any{mget(u["profile"], "display_name"), mget(u["profile"], "real_name"), u["real_name"], u["name"]} {
		if truthy(v) {
			name = v
			break
		}
	}
	return M{"user": user, "name": name}
}

// link: POST /api/plugins/slack/link {code}; the person signed in to the bridge said yes on that page.
func (s *slackInst) link(code string) string {
	user, ok := s.pending[code]
	if !ok {
		return "링크가 만료됐어요. Slack 채널에 글을 다시 써 주세요."
	}
	delete(s.pending, code)
	if !s.isUser(user) {
		s.st["users"] = append(s.users(), user)
	}
	s.host.save()
	st := shallow(s.statusV)
	st["note"] = "연결됨 · 채널 " + s.where()
	s.statusV = st
	s.host.changed()
	goLocked("slack link", func() {
		_ = try(func() {
			s.slack("chat.postEphemeral", orderedObj{{"channel", s.channel()}, {"user", user}, {"text", "연결됐어요. 이제 이 채널에 글을 쓰면 세션이 뜨고, 스레드에 답하면 그 세션에 전달돼요."}})
		})
	})
	return "Slack 계정을 연결했어요. 이 창은 닫아도 됩니다."
}

func (s *slackInst) stop() {
	s.stopped = true
	for _, run := range s.runs.Values() {
		clearTimeout(run.timer)
	}
	if s.ws != nil {
		s.ws.close()
	}
	// Off: the session menu no longer offers Slack.
	s.host.changed()
}

// ---------- a WebSocket client, enough for Socket Mode ----------

type wsClient struct {
	conn   net.Conn
	br     *bufio.Reader
	wmu    sync.Mutex
	closed bool
}

func dialWS(raw string) (*wsClient, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	host := u.Host
	var conn net.Conn
	d := &net.Dialer{Timeout: 30 * time.Second}
	switch u.Scheme {
	case "wss":
		if u.Port() == "" {
			host += ":443"
		}
		conn, err = tls.DialWithDialer(d, "tcp", host, &tls.Config{ServerName: u.Hostname()})
	case "ws":
		if u.Port() == "" {
			host += ":80"
		}
		conn, err = d.Dial("tcp", host)
	default:
		return nil, errors.New("bad scheme")
	}
	if err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(randBytes(16))
	path := u.RequestURI()
	req := "GET " + path + " HTTP/1.1\r\nHost: " + u.Host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if resp.StatusCode != 101 || resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(h[:]) {
		conn.Close()
		return nil, errors.New("handshake")
	}
	conn.SetDeadline(time.Time{})
	return &wsClient{conn: conn, br: br}, nil
}

func (c *wsClient) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed && op != 8 {
		return errors.New("closed")
	}
	head := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n < 126:
		head = append(head, 0x80|byte(n))
	case n < 65536:
		head = append(head, 0x80|126, byte(n>>8), byte(n))
	default:
		head = append(head, 0x80|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		head = append(head, b[:]...)
	}
	mask := randBytes(4)
	head = append(head, mask...)
	body := make([]byte, n)
	for i := range payload {
		body[i] = payload[i] ^ mask[i%4]
	}
	_, err := c.conn.Write(append(head, body...))
	return err
}

func (c *wsClient) sendText(b []byte) { _ = c.writeFrame(1, b) }

func (c *wsClient) close() {
	c.wmu.Lock()
	was := c.closed
	c.closed = true
	c.wmu.Unlock()
	if !was {
		_ = c.writeFrame(8, []byte{0x03, 0xe8})
		go func() {
			time.Sleep(2 * time.Second)
			c.conn.Close()
		}()
	}
}

// read: the next whole text (or binary) message; an error when the connection is over.
func (c *wsClient) read() ([]byte, error) {
	var msg []byte
	for {
		var h [2]byte
		if _, err := io.ReadFull(c.br, h[:]); err != nil {
			c.conn.Close()
			return nil, err
		}
		fin := h[0]&0x80 != 0
		op := h[0] & 0x0f
		n := uint64(h[1] & 0x7f)
		if n == 126 {
			var b [2]byte
			if _, err := io.ReadFull(c.br, b[:]); err != nil {
				c.conn.Close()
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		} else if n == 127 {
			var b [8]byte
			if _, err := io.ReadFull(c.br, b[:]); err != nil {
				c.conn.Close()
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		var mask []byte
		if h[1]&0x80 != 0 {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(c.br, mask); err != nil {
				c.conn.Close()
				return nil, err
			}
		}
		if n > 64<<20 {
			c.conn.Close()
			return nil, errors.New("too big")
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			c.conn.Close()
			return nil, err
		}
		for i := range mask {
			_ = i
		}
		if mask != nil {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch op {
		case 8:
			c.close()
			c.conn.Close()
			return nil, io.EOF
		case 9:
			_ = c.writeFrame(10, payload)
			continue
		case 10:
			continue
		}
		msg = append(msg, payload...)
		if fin {
			return msg, nil
		}
	}
}
