package main

// The Slack plugin against a pretend Slack: its Web API over HTTP and Socket Mode over a WebSocket
// (from slack-plugin.test.mjs).

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type slackCallRec struct {
	method string
	args   map[string]any
	token  string
}

// fakeSlack records what it is asked and lets the test push Socket Mode envelopes.
type fakeSlack struct {
	srv    *httptest.Server
	mu     sync.Mutex
	calls  []slackCallRec
	acks   []any
	socket net.Conn
	wmu    sync.Mutex
}

func newFakeSlack(t *testing.T) *fakeSlack {
	s := &fakeSlack{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			s.upgrade(w, r)
			return
		}
		// The plugin only POSTs. Anything else is not a Slack call.
		if r.Method != "POST" {
			w.WriteHeader(404)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		method := r.URL.Path[1:]
		args := map[string]any{}
		if len(raw) > 0 {
			if strings.Contains(r.Header.Get("Content-Type"), "json") {
				json.Unmarshal(raw, &args)
			} else {
				q, _ := url.ParseQuery(string(raw))
				for k := range q {
					args[k] = q.Get(k)
				}
			}
		}
		auth := r.Header.Get("Authorization")
		s.mu.Lock()
		s.calls = append(s.calls, slackCallRec{method, args, auth})
		n := len(s.calls)
		s.mu.Unlock()
		reply := func(o any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			b, _ := json.Marshal(o)
			w.Write(b)
		}
		str := func(v any) string {
			if v == nil {
				return ""
			}
			return jsString(v)
		}
		switch {
		case auth == "Bearer xoxb-bad":
			reply(map[string]any{"ok": false, "error": "invalid_auth"})
		case method == "auth.test":
			reply(map[string]any{"ok": true, "user_id": "UBOT"})
		case method == "apps.connections.open":
			reply(map[string]any{"ok": true, "url": "ws://" + r.Host + "/socket"})
		case method == "users.info":
			reply(map[string]any{"ok": true, "user": map[string]any{"id": args["user"], "name": "u1name", "profile": map[string]any{"display_name": "<b>앨리스</b>"}}})
		case method == "chat.postMessage" && strings.Contains(str(args["markdown_text"]), "NO_MD"):
			reply(map[string]any{"ok": false, "error": "invalid_arguments"})
		case method == "chat.postMessage":
			reply(map[string]any{"ok": true, "ts": "1700000000." + padStart(itoa(n), 6, "0")})
		case method == "conversations.info":
			if args["channel"] == "C1" {
				reply(map[string]any{"ok": true, "channel": map[string]any{"id": "C1", "name": "bridge"}})
			} else {
				reply(map[string]any{"ok": false, "error": "channel_not_found"})
			}
		case method == "chat.getPermalink":
			reply(map[string]any{"ok": true, "permalink": "https://team.slack.test/archives/" + str(args["channel"]) + "/p" + strings.Replace(str(args["message_ts"]), ".", "", 1)})
		case method == "users.conversations":
			switch auth {
			case "Bearer xoxb-old":
				reply(map[string]any{"ok": false, "error": "missing_scope"})
			case "Bearer xoxb-one":
				reply(map[string]any{"ok": true, "channels": []any{map[string]any{"id": "C9", "name": "only", "is_private": true}}, "response_metadata": map[string]any{"next_cursor": ""}})
			default:
				reply(map[string]any{"ok": true, "channels": []any{map[string]any{"id": "C2", "name": "zeta", "is_private": false}, map[string]any{"id": "C1", "name": "bridge", "is_private": true}}, "response_metadata": map[string]any{"next_cursor": ""}})
			}
		default:
			reply(map[string]any{"ok": true})
		}
	}))
	return s
}

func (s *fakeSlack) upgrade(w http.ResponseWriter, r *http.Request) {
	h := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return
	}
	conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(h[:]) + "\r\n\r\n"))
	s.mu.Lock()
	s.socket = conn
	s.mu.Unlock()
	go func() {
		br := brw.Reader
		for {
			var hd [2]byte
			if _, err := io.ReadFull(br, hd[:]); err != nil {
				return
			}
			n := uint64(hd[1] & 0x7f)
			if n == 126 {
				var b [2]byte
				io.ReadFull(br, b[:])
				n = uint64(binary.BigEndian.Uint16(b[:]))
			} else if n == 127 {
				var b [8]byte
				io.ReadFull(br, b[:])
				n = binary.BigEndian.Uint64(b[:])
			}
			mask := make([]byte, 4)
			io.ReadFull(br, mask)
			body := make([]byte, n)
			if _, err := io.ReadFull(br, body); err != nil {
				return
			}
			for i := range body {
				body[i] ^= mask[i%4]
			}
			if hd[0]&0x0f == 1 {
				var v any
				json.Unmarshal(body, &v)
				s.mu.Lock()
				s.acks = append(s.acks, v)
				s.mu.Unlock()
			}
		}
	}()
}

func (s *fakeSlack) push(env any) {
	body, _ := json.Marshal(env)
	head := []byte{0x81}
	switch n := len(body); {
	case n < 126:
		head = append(head, byte(n))
	case n < 65536:
		head = append(head, 126, byte(n>>8), byte(n))
	default:
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		head = append(append(head, 127), b[:]...)
	}
	s.mu.Lock()
	c := s.socket
	s.mu.Unlock()
	s.wmu.Lock()
	c.Write(append(head, body...))
	s.wmu.Unlock()
}

func (s *fakeSlack) connected() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.socket != nil }

func (s *fakeSlack) all() []slackCallRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]slackCallRec{}, s.calls...)
}

func (s *fakeSlack) of(method string) []map[string]any {
	out := []map[string]any{}
	for _, c := range s.all() {
		if c.method == method {
			out = append(out, c.args)
		}
	}
	return out
}

func (s *fakeSlack) last(method string) map[string]any {
	l := s.of(method)
	if len(l) == 0 {
		return map[string]any{}
	}
	return l[len(l)-1]
}

func (s *fakeSlack) close() {
	s.mu.Lock()
	if s.socket != nil {
		s.socket.Close()
	}
	s.mu.Unlock()
	s.srv.CloseClientConnections()
	s.srv.Close()
}

// fakeBridge: the server's side as the plugin sees it. seats: where each session is worked on (web unless said).
type fakeBridge struct {
	saved map[string]M
	did   []M
	seats map[string]string
	p     *Plugins
}

type fakeHost struct {
	b   *fakeBridge
	uid string
}

func (h *fakeHost) Origin() string  { return "https://bridge.test" }
func (h *fakeHost) Code() string    { return "code-1" }
func (h *fakeHost) Sessions() []any { return nil }
func (h *fakeHost) Find(thread string) M {
	return M{"name": "세션 " + thread, "cwd": "/work", "bridge": M{"host": "MacA"}}
}
func (h *fakeHost) Command(value string) string {
	h.b.did = append(h.b.did, M{"uid": h.uid, "command": value})
	return ""
}
func (h *fakeHost) seat(thread string) string {
	if s, ok := h.b.seats[thread]; ok {
		return s
	}
	return "web"
}
func (h *fakeHost) Seat(thread string) M {
	return M{"where": h.seat(thread), "link": "https://bridge.test/#/s/" + thread}
}
func (h *fakeHost) Summary(thread string) M {
	return M{"title": "세션 " + thread, "host": "MacA", "cwd": "~/work", "last": "**다 했어요**", "link": "https://bridge.test/#/s/" + thread}
}
func (h *fakeHost) SeatUrl(thread string, u any) {
	h.b.did = append(h.b.did, M{"uid": h.uid, "seatUrl": thread, "url": u})
}

// As the server does: the seat changes, then the plugin is told (moveIn waits for the thread).
func (h *fakeHost) MoveTo(thread string, to string) M {
	h.b.did = append(h.b.did, M{"uid": h.uid, "moveTo": thread, "to": to})
	if to == "slack" {
		h.b.p.instance(h.uid, "slack").(seatMover).moveIn(thread)
	}
	h.b.seats[thread] = to
	if to == "web" {
		h.b.p.instance(h.uid, "slack").(seatMover).moveOut(thread)
	}
	return nil
}
func (h *fakeHost) Send(thread string, text string, images []any) M {
	h.b.did = append(h.b.did, M{"uid": h.uid, "send": thread, "text": text, "images": images})
	return nil
}
func (h *fakeHost) Start(prompt string, cwd any, places string) M {
	h.b.seats["T-new"] = "slack"
	h.b.did = append(h.b.did, M{"uid": h.uid, "start": prompt, "cwd": cwd, "places": places})
	return M{"thread": "T-new"}
}

func newFakeBridge() *fakeBridge {
	b := &fakeBridge{saved: map[string]M{}, seats: map[string]string{}}
	b.p = newPlugins(pluginDeps{
		load: func(uid string) M {
			if b.saved[uid] == nil {
				b.saved[uid] = M{}
			}
			return b.saved[uid]
		},
		store:   func(string, M) {},
		changed: func(string) {},
		host:    func(uid string) PluginHost { return &fakeHost{b, uid} },
	})
	return b
}

func until(t *testing.T, what string, f func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		got := false
		withLock(func() { got = f() })
		if got {
			return
		}
	}
	t.Fatalf("기다리던 일이 일어나지 않음: %s", what)
}

func pset(p *Plugins, uid string, enabled any, config M) ([]string, error) {
	var notes []string
	var err error
	withLock(func() { err = try(func() { notes = p.set(uid, "slack", enabled, config) }) })
	return notes, err
}

func statusOf(p *Plugins, uid string) M {
	var st M
	withLock(func() { st = norm(p.list(uid)[0]).(M) })
	return st
}

func state(b *fakeBridge, uid string) M { return asM(mget(b.saved[uid]["slack"], "state")) }

func dig(v any, path ...any) any {
	for _, k := range path {
		switch x := k.(type) {
		case string:
			v = mget(v, x)
		case int:
			a := asArr(v)
			if x < 0 {
				x += len(a)
			}
			if x < 0 || x >= len(a) {
				return nil
			}
			v = a[x]
		}
	}
	return v
}

func TestMrkdwnAndPieces(t *testing.T) {
	eq(t, toMrkdwn("## 제목\n**굵게** [링크](https://a.b/c) `a**b**`\n- 하나"), "​*제목*​\n​*굵게*​ <https://a.b/c|링크> `a**b**`\n• 하나")
	eq(t, toMrkdwn("**커밋(`d99`)이 올라감.** 그 뒤 **5번**했고"), "​*커밋(`d99`)이 올라감.*​ 그 뒤 ​*5번*​했고", "코드가 든 굵게, 한글에 붙은 굵게")
	eq(t, toMrkdwn("```js\nif (a < b) **x**\n```"), "```\nif (a < b) **x**\n```")
	parts := pieces(strings.Repeat("가", 3000)+"\n"+strings.Repeat("나", 3000), 3500)
	eq(t, len(parts), 2)
	eq(t, parts[0], strings.Repeat("가", 3000))
}

func TestSlackSessionThread(t *testing.T) {
	s := newFakeSlack(t)
	defer s.close()
	t.Setenv("SLACK_API_URL", s.srv.URL)
	b := newFakeBridge()
	p := b.p
	defer withLock(p.stopAll)
	places, _ := json.Marshal(map[string]any{"main": "h2", "dirs": map[string]any{"h1": "~/a", "h2": "~/" + strings.Repeat("x", 600)}})
	PLACES := string(places)

	_, err := pset(p, "u1", true, M{"botToken": "xoxb-1"})
	ok(t, err != nil && strings.Contains(err.Error(), "App 토큰"), errMsg(err))
	if _, err := pset(p, "u1", true, M{"botToken": "xoxb-1", "appToken": "xapp-1", "channel": "C1", "cwd": "~/w", "places": PLACES}); err != nil {
		t.Fatal(err)
	}
	until(t, "켜짐", func() bool {
		return s.connected() && mget(norm(p.list("u1")[0]), "status") != nil && mget(mget(norm(p.list("u1")[0]), "status"), "state") == "on"
	})
	st := statusOf(p, "u1")
	eq(t, dig(st, "config", "botToken"), any("••••••••"), "비밀 값은 돌려주지 않음")
	for _, c := range s.all() {
		if c.method == "apps.connections.open" {
			eq(t, c.token, "Bearer xapp-1")
		}
	}
	ok(t, regexp.MustCompile(`^연결됨 · 채널 #bridge`).MatchString(jsString(dig(st, "status", "note"))), "채널은 ID 가 아니라 이름으로")

	// Someone the plugin has not met: a link, and nothing is done for them.
	s.push(M{"envelope_id": "e1", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C1", "user": "U1", "ts": "100.1", "text": "hello"}}})
	until(t, "ephemeral", func() bool { return len(s.of("chat.postEphemeral")) > 0 })
	s.mu.Lock()
	jeq(t, s.acks[0], `{"envelope_id":"e1"}`)
	s.mu.Unlock()
	ok(t, regexp.MustCompile(`https://bridge\.test/api/plugins/slack/link\?code=code-1`).MatchString(jsString(s.of("chat.postEphemeral")[0]["text"])))
	withLock(func() { eq(t, len(b.did), 0) })
	// R1-M2: looking at the link says who would be linked and links nobody; only link() does.
	withLock(func() {
		inst := p.instance("u1", "slack").(*slackInst)
		jeq(t, inst.who("code-1"), `{"user":"U1","name":"<b>앨리스</b>"}`)
		jeq(t, inst.who("code-1"), `{"user":"U1","name":"<b>앨리스</b>"}`, "보기만 해서는 쓰지 않음")
		ok(t, inst.who("nope") == nil)
		ok(t, strings.Contains(inst.link("code-1"), "연결했어요"))
		ok(t, strings.Contains(inst.link("code-1"), "만료"))
	})

	// A message at the top of the channel starts a session worked on in Slack.
	s.push(M{"envelope_id": "e2", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C1", "user": "U1", "ts": "100.2", "text": "fix &lt;it&gt;"}}})
	find := func(k string) M {
		for _, d := range b.did {
			if d[k] != nil {
				return d
			}
		}
		return nil
	}
	count := func(k string) int {
		n := 0
		for _, d := range b.did {
			if d[k] != nil {
				n++
			}
		}
		return n
	}
	until(t, "start", func() bool { return find("start") != nil })
	withLock(func() {
		jeq(t, find("start"), jsonStr(M{"uid": "u1", "start": "fix <it>", "cwd": "~/w", "places": PLACES}))
	})
	until(t, "thread T-new", func() bool { return mget(state(b, "u1")["threads"], "T-new") == "100.2" && find("seatUrl") != nil })
	started := s.last("chat.postMessage")
	eq(t, started["thread_ts"], any("100.2"))
	eq(t, dig(started, "blocks", 1, "elements", 0, "action_id"), any("seat_web"))
	eq(t, dig(started, "blocks", 1, "elements", 0, "url"), any("https://bridge.test/#/s/T-new"))
	withLock(func() {
		eq(t, find("seatUrl")["url"], any("https://team.slack.test/archives/C1/p1002"), "세션 화면이 스레드로 가는 주소를 받음")
	})
	postsBefore := len(s.of("chat.postMessage"))

	// What the session says goes to that thread; what was typed in Slack is not said back to it.
	var inst *slackInst
	withLock(func() {
		inst = p.instance("u1", "slack").(*slackInst)
		inst.onEvent("T-new", M{"type": "user", "via": "slack", "text": "fix <it>"})
		inst.onEvent("T-new", M{"type": "text", "text": "**done**"})
		inst.onEvent("T-new", M{"type": "msg", "ts": "card-1", "text": "권한 요청", "blocks": []any{M{"type": "actions", "elements": []any{M{"type": "button", "action_id": "perm_allow", "value": "1001:card card-1 1"}}}}})
	})
	until(t, "2 posts", func() bool { return len(s.of("chat.postMessage")) == postsBefore+2 })
	posts := s.of("chat.postMessage")[postsBefore:]
	eq(t, posts[0]["thread_ts"], any("100.2"))
	eq(t, posts[0]["markdown_text"], any("**done**"), "세션의 글은 Markdown 그대로")
	ok(t, posts[0]["text"] == nil)
	eq(t, dig(posts[1], "blocks", 0, "elements", 0, "value"), any("1001:card card-1 1"))

	// The button answers the card, and the card is then rewritten in place.
	s.push(M{"envelope_id": "e3", "type": "interactive", "payload": M{"type": "block_actions", "channel": M{"id": "C1"}, "user": M{"id": "U1"}, "message": M{"thread_ts": "100.2"}, "actions": []any{M{"action_id": "perm_allow", "value": "1001:card card-1 1"}}}})
	until(t, "command", func() bool { return find("command") != nil })
	withLock(func() { eq(t, b.did[len(b.did)-1]["command"], any("1001:card card-1 1")) })
	withLock(func() {
		inst.onEvent("T-new", M{"type": "msg_update", "ts": "card-1", "text": "✅ 허용", "blocks": []any{}})
	})
	until(t, "chat.update", func() bool { return len(s.of("chat.update")) > 0 })
	withLock(func() { eq(t, s.of("chat.update")[0]["ts"], mget(state(b, "u1")["msgs"], "card-1")) })

	// A reply in the thread is sent to the session; the bot's own messages and other channels are not.
	s.push(M{"envelope_id": "e4", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C1", "user": "U1", "ts": "100.3", "thread_ts": "100.2", "text": "and tests"}}})
	s.push(M{"envelope_id": "e5", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C1", "user": "UBOT", "bot_id": "B1", "ts": "100.4", "thread_ts": "100.2", "text": "mine"}}})
	s.push(M{"envelope_id": "e6", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C2", "user": "U1", "ts": "100.5", "text": "elsewhere"}}})
	until(t, "send", func() bool { return find("send") != nil })
	time.Sleep(100 * time.Millisecond)
	withLock(func() {
		eq(t, count("send")+count("start"), 2)
		jeq(t, find("send"), `{"uid":"u1","send":"T-new","text":"and tests","images":[]}`)
	})

	// Slack refusing markdown_text: the same piece goes as mrkdwn instead, bold kept at a Korean word's edge.
	withLock(func() { inst.onEvent("T-new", M{"type": "text", "text": "NO_MD **통과**했고 **`a`**"}) })
	until(t, "NO_MD", func() bool { return strings.HasPrefix(jsString(s.last("chat.postMessage")["text"]), "NO_MD") })
	eq(t, s.last("chat.postMessage")["text"], any("NO_MD ​*통과*​했고 ​*`a`*​"))

	// A session worked on in the bridge is not posted at all.
	quiet := len(s.all())
	withLock(func() {
		inst.onEvent("T-web", M{"type": "text", "text": "hi"})
		inst.onEvent("T-web", M{"type": "end", "why": "종료"})
	})
	time.Sleep(100 * time.Millisecond)
	eq(t, len(s.all()), quiet, "브릿지에서 작업 중인 세션은 Slack 에 올리지 않음")

	// Moved to Slack: a thread is made whose head says where the earlier talk is, with the button back.
	var r M
	withLock(func() {
		r = inst.moveIn("T-web")
		b.seats["T-web"] = "slack"
	})
	root := s.last("chat.postMessage")
	_, hasTs := root["thread_ts"]
	ok(t, !hasTs, "thread_ts 없음")
	rt := jsString(root["text"])
	ok(t, regexp.MustCompile(`세션 T-web`).MatchString(rt), rt)
	ok(t, regexp.MustCompile(`<https://bridge\.test/#/s/T-web\|브릿지에서 보기>`).MatchString(rt), rt)
	ok(t, regexp.MustCompile(`\*다 했어요\*`).MatchString(rt), "마지막 답을 함께 보여 줌")
	eq(t, dig(root, "blocks", 1, "elements", 0, "action_id"), any("seat_web"))
	var webRoot string
	withLock(func() { webRoot = jsString(mget(state(b, "u1")["threads"], "T-web")) })
	eq(t, r["url"], any("https://team.slack.test/archives/C1/p"+strings.Replace(webRoot, ".", "", 1)))
	withLock(func() { inst.onEvent("T-web", M{"type": "text", "text": "now here"}) })
	until(t, "now here", func() bool { return s.last("chat.postMessage")["text"] == "now here" }) // 거절된 뒤 10분은 mrkdwn 으로

	// The button moves it back: the head loses its button, the thread says where it went and offers the way back.
	s.push(M{"envelope_id": "e7", "type": "interactive", "payload": M{"type": "block_actions", "channel": M{"id": "C1"}, "user": M{"id": "U1"}, "message": M{"ts": webRoot}, "actions": []any{M{"action_id": "seat_web", "value": "T-web"}}}})
	until(t, "seat_slack", func() bool {
		return dig(s.last("chat.postMessage"), "blocks", 1, "elements", 0, "action_id") == "seat_slack"
	})
	withLock(func() {
		var last M
		for _, d := range b.did {
			if d["moveTo"] != nil {
				last = d
			}
		}
		jeq(t, last, `{"uid":"u1","moveTo":"T-web","to":"web"}`)
	})
	update := s.last("chat.update")
	eq(t, update["ts"], any(webRoot))
	eq(t, len(asArr(roundTrip(update["blocks"]))), 1, "앞 메시지의 버튼은 지움")
	ok(t, regexp.MustCompile(`브릿지로 옮겼어요.*<https://bridge\.test/#/s/T-web\|브릿지에서 열기>`).MatchString(jsString(s.last("chat.postMessage")["text"])))

	// A reply there now reaches nobody: the writer is told where the session is, with a way to bring it back.
	var sent int
	withLock(func() { sent = count("send") })
	s.push(M{"envelope_id": "e8", "type": "events_api", "payload": M{"event": M{"type": "message", "channel": "C1", "user": "U1", "ts": "100.9", "thread_ts": webRoot, "text": "still there?"}}})
	until(t, "브릿지에서 작업 중", func() bool {
		return strings.Contains(jsString(s.last("chat.postEphemeral")["text"]), "브릿지에서 작업 중")
	})
	withLock(func() { eq(t, count("send"), sent) })
	eq(t, dig(s.last("chat.postEphemeral"), "blocks", 1, "elements", 0, "action_id"), any("seat_slack"))

	// R1-L15: an attachment somewhere other than Slack's file host gets no bot token.
	var sends int
	withLock(func() { sends = count("send") })
	s.push(M{"envelope_id": "e9", "type": "events_api", "payload": M{"event": M{"type": "message", "subtype": "file_share", "channel": "C1", "user": "U1", "ts": "100.10", "thread_ts": "100.2", "text": "pic", "files": []any{M{"name": "a.png", "mimetype": "image/png", "url_private": s.srv.URL + "/evil-file"}}}}})
	until(t, "send pic", func() bool { return count("send") > sends })
	eq(t, len(s.of("evil-file")), 0, "Slack 파일 호스트가 아니면 받지 않음")

	// Another person's plugin is another app: a bad token is theirs alone.
	if _, err := pset(p, "u2", true, M{"botToken": "xoxb-bad", "appToken": "xapp-2", "channel": "C9"}); err != nil {
		t.Fatal(err)
	}
	until(t, "u2 error", func() bool { return mget(mget(norm(p.list("u2")[0]), "status"), "state") == "error" })
	eq(t, dig(statusOf(p, "u1"), "status", "state"), any("on"))

	// Off keeps the settings; removed forgets them.
	if _, err := pset(p, "u1", false, nil); err != nil {
		t.Fatal(err)
	}
	eq(t, statusOf(p, "u1")["enabled"], any(false))
	eq(t, dig(statusOf(p, "u1"), "config", "channel"), any("C1"))
	before := len(s.all())
	withLock(func() { inst.onEvent("T-new", M{"type": "text", "text": "after off"}) })
	time.Sleep(100 * time.Millisecond)
	eq(t, len(s.all()), before, "끈 뒤에는 Slack 에 아무것도 보내지 않음")
	withLock(func() { p.remove("u1", "slack") })
	eq(t, statusOf(p, "u1")["added"], any(false))
	eq(t, dig(statusOf(p, "u1"), "config", "channel"), any(""))
	withLock(func() { p.remove("u2", "slack") })
}

func TestSlackRunLines(t *testing.T) {
	type tl struct {
		name, what string
		desc       bool
	}
	run := func(tools []tl) string {
		var items []autoItem
		for _, x := range tools {
			items = withTool(items, x.name, x.what, x.desc)
		}
		return listOf(items)
	}
	eq(t, run([]tl{{"Write", "a.ts", false}, {"Write", "b<c>.ts", false}, {"Edit", "a.ts", false}}), "• *Write* a.ts, b&lt;c&gt;.ts\n• *Edit* a.ts")
	eq(t, run([]tl{{"Bash", "설치", true}, {"Bash", "설치", true}, {"Bash", "빌드", true}}), "• *Bash* ×2 설치\n• *Bash* 빌드", "설명이 있는 줄은 같을 때만 합침")
	eq(t, run([]tl{{"Write", "", false}, {"Write", "", false}}), "• *Write* ×2")
	eq(t, run([]tl{{"Edit", "a.ts", false}, {"Edit", "a.ts", false}, {"Edit", "b.ts", false}}), "• *Edit* ×2 a.ts\n• *Edit* b.ts")
	many := []tl{}
	for k := 0; k < 40; k++ {
		many = append(many, tl{"Write", "file-" + itoa(k) + ".tsx", false})
	}
	out := run(many)
	for _, l := range strings.Split(out, "\n") {
		ok(t, jsLen(l) <= 200, "합친 줄은 200자에서 멈춤")
	}
	eq(t, len(regexp.MustCompile(`file-\d+`).FindAllString(out, -1)), 40, "파일 이름은 빠지지 않음")
}

func TestSlackAutoRuns(t *testing.T) {
	s := newFakeSlack(t)
	defer s.close()
	t.Setenv("SLACK_API_URL", s.srv.URL)
	t.Setenv("SLACK_AUTO_EDIT_MS", "40")
	b := newFakeBridge()
	p := b.p
	defer withLock(p.stopAll)
	if _, err := pset(p, "u1", true, M{"botToken": "xoxb-1", "appToken": "xapp-1", "channel": "C1"}); err != nil {
		t.Fatal(err)
	}
	until(t, "on", func() bool { return mget(mget(norm(p.list("u1")[0]), "status"), "state") == "on" })
	var inst *slackInst
	withLock(func() {
		b.seats["T1"] = "slack"
		inst = p.instance("u1", "slack").(*slackInst)
	})
	textOf := func(a map[string]any) string {
		if a["text"] != nil {
			return jsString(a["text"])
		}
		return jsString(a["markdown_text"])
	}
	posts := func() []string {
		out := []string{}
		for _, a := range s.of("chat.postMessage") {
			out = append(out, textOf(a))
		}
		return out
	}
	updates := func() []map[string]any { return s.of("chat.update") }
	auto := func(k int, name, what string, desc bool) {
		inst.onEvent("T1", M{"type": "msg", "ts": "a" + itoa(k), "text": "⚡ 자동 허용 · " + name, "blocks": []any{M{"type": "section", "text": M{"type": "mrkdwn", "text": "```rm -rf /tmp/x```"}}}, "auto": M{"name": name, "what": what, "desc": desc}})
	}
	bash := func(k int) { auto(k, "Bash", "일 "+itoa(k), true) }

	withLock(func() {
		inst.onEvent("T1", M{"type": "text", "text": "시작"})
		for k := 0; k < 4; k++ {
			if k == 3 {
				auto(k, "Edit", "a<b>.ts", false)
			} else {
				bash(k)
			}
		}
	})
	until(t, "1 update", func() bool { return len(updates()) == 1 })
	// The head, the text, then one message for the four: the first goes out alone, the rest come in one edit.
	eq(t, len(posts()), 3)
	first := posts()[2]
	eq(t, first, "⚡ 자동 허용 1개")
	idx := -1
	for i, c := range s.all() {
		if c.method == "chat.postMessage" && c.args["text"] == first {
			idx = i
			break
		}
	}
	u := updates()[0]
	eq(t, u["ts"], any("1700000000."+padStart(itoa(idx+1), 6, "0")), "첫 메시지를 고침")
	eq(t, u["text"], any("⚡ 자동 허용 4개"))
	eq(t, dig(u, "blocks", 0, "text", "text"), any("⚡ 자동 허용 4개 · Bash 3 · Edit"))
	eq(t, dig(u, "blocks", 1, "text", "text"), any("• *Bash* 일 0\n• *Bash* 일 1\n• *Bash* 일 2\n• *Edit* a&lt;b&gt;.ts"))
	ok(t, !strings.Contains(jsonStr(s.of("chat.postMessage")[2])+jsonStr(u), "rm -rf"), "명령 원문은 올리지 않음")

	// Anything else in the thread ends the run: the next one is a new message.
	withLock(func() {
		inst.onEvent("T1", M{"type": "text", "text": "중간 답"})
		bash(10)
	})
	until(t, "5 posts", func() bool { return len(posts()) == 5 })
	ok(t, reflect.DeepEqual(posts()[3:], []string{"중간 답", "⚡ 자동 허용 1개"}), strings.Join(posts(), "|"))
	time.Sleep(120 * time.Millisecond)
	eq(t, len(updates()), 1, "하나뿐인 묶음은 고치지 않음")

	// 30 lines to a message: the 31st starts the next one, and the full one gets its last edit first.
	withLock(func() {
		inst.onEvent("T1", M{"type": "text", "text": "많이"})
		for k := 0; k < 31; k++ {
			bash(100 + k)
		}
	})
	until(t, "8 posts", func() bool { return len(posts()) == 8 })
	full := func() map[string]any {
		for _, x := range updates() {
			if x["text"] == "⚡ 자동 허용 30개" {
				return x
			}
		}
		return nil
	}
	until(t, "30 update", func() bool { return full() != nil })
	eq(t, posts()[len(posts())-1], "⚡ 자동 허용 1개")
	eq(t, len(strings.Split(jsString(dig(full(), "blocks", 1, "text", "text")), "\n")), 30)

	// Long lines: a message never passes a section's 3,000 characters, and no line is lost.
	withLock(func() {
		inst.onEvent("T1", M{"type": "text", "text": "길게"})
		for k := 0; k < 40; k++ {
			auto(200+k, "Bash", itoa(k)+" "+strings.Repeat("가", 98), true)
		}
		inst.onEvent("T1", M{"type": "text", "text": "끝"})
	})
	until(t, "끝", func() bool { p := posts(); return len(p) > 0 && p[len(p)-1] == "끝" })
	time.Sleep(120 * time.Millisecond)
	seen := map[string]bool{}
	for _, c := range s.all() {
		txt := jsString(c.args["text"])
		body := jsString(dig(c.args, "blocks", 1, "text", "text"))
		if !strings.HasPrefix(txt, "⚡") || !strings.Contains(body, strings.Repeat("가", 98)) {
			continue
		}
		for _, blk := range asArr(roundTrip(c.args["blocks"])) {
			ok(t, jsLen(jsString(dig(blk, "text", "text"))) <= 3000, "섹션은 3,000자 이하")
		}
		for _, l := range strings.Split(body, "\n") {
			if f := strings.Split(l, " "); len(f) > 2 {
				seen[f[2]] = true
			}
		}
	}
	eq(t, len(seen), 40, "빠진 줄이 없음")
	n := 0
	for _, x := range posts() {
		if strings.HasPrefix(x, "⚡") {
			n++
		}
	}
	ok(t, n >= 4, "길이가 차면 새 메시지")
}

func TestSlackChannelChoices(t *testing.T) {
	s := newFakeSlack(t)
	defer s.close()
	t.Setenv("SLACK_API_URL", s.srv.URL)
	b := newFakeBridge()
	p := b.p
	choices := func(key string, draft M) ([]any, error) {
		var out []any
		var err error
		withLock(func() { err = try(func() { out = p.choices("u1", "slack", key, draft) }) })
		return out, err
	}
	_, err := choices("channel", M{})
	ok(t, err != nil && strings.Contains(err.Error(), "Bot 토큰을 먼저"), errMsg(err))
	_, err = choices("cwd", M{"botToken": "xoxb-1"})
	ok(t, err != nil && strings.Contains(err.Error(), "고를 수 있는 값이 없어요"), errMsg(err))
	got, err := choices("channel", M{"botToken": "xoxb-1"})
	if err != nil {
		t.Fatal(err)
	}
	jeq(t, got, `[{"value":"C1","label":"#bridge","hint":"비공개 · C1"},{"value":"C2","label":"#zeta","hint":"공개 · C2"}]`)
	eq(t, s.of("users.conversations")[0]["types"], any("public_channel,private_channel"), "읽기 메서드는 form 으로 보냄")
	_, err = choices("channel", M{"botToken": "xoxb-old"})
	ok(t, err != nil && strings.Contains(err.Error(), "channels:read, groups:read"), errMsg(err))
}

func TestSlackSwappedTokens(t *testing.T) {
	s := newFakeSlack(t)
	defer s.close()
	t.Setenv("SLACK_API_URL", s.srv.URL)
	b := newFakeBridge()
	p := b.p
	defer withLock(p.stopAll)
	_, err := pset(p, "u1", true, M{"botToken": "hello", "appToken": "xapp-1", "channel": "C1"})
	ok(t, err != nil && strings.Contains(err.Error(), "Bot 토큰은 xoxb- 로 시작해요"), errMsg(err))
	notes, err := pset(p, "u1", true, M{"botToken": "xapp-1", "appToken": "xoxb-one"})
	if err != nil {
		t.Fatal(err)
	}
	withLock(func() {
		cfg := asM(mget(b.saved["u1"]["slack"], "config"))
		eq(t, cfg["botToken"], any("xoxb-one"))
		eq(t, cfg["appToken"], any("xapp-1"))
		eq(t, cfg["channel"], any("C9"), "봇이 들어간 채널이 하나면 그 채널")
	})
	ok(t, reflect.DeepEqual(notes, []string{"Bot 토큰과 App 토큰 (Socket Mode)이 바뀌어 있어서 제자리에 넣었어요", "전용 채널을 #only(으)로 정했어요"}), strings.Join(notes, "|"))
	_, err = pset(p, "u1", true, M{"botToken": "xoxb-1", "channel": ""})
	ok(t, err != nil && regexp.MustCompile(`전용 채널 을\(를\) 채워 주세요`).MatchString(err.Error()), "여럿이면 고르게 함: "+errMsg(err))
}

func TestSlackSaysWhatItNeeds(t *testing.T) {
	def := slackPlugin()
	req := []string{}
	prefixes := []string{}
	pick := ""
	for _, f := range def.fields {
		if f.required {
			req = append(req, f.key)
		}
		if f.prefix != "" {
			prefixes = append(prefixes, f.prefix)
		}
		if f.key == "channel" {
			pick = f.pick
		}
	}
	ok(t, reflect.DeepEqual(req, []string{"botToken", "appToken", "channel"}), strings.Join(req, ","))
	help := asArr(norm(def.help))
	copyText := jsString(dig(help, 0, "copy", "text"))
	manifest := js(copyText)
	ok(t, dig(manifest, "settings", "socket_mode_enabled") == true, "매니페스트를 복사할 수 있음")
	bot := strList(asArr(dig(manifest, "oauth_config", "scopes", "bot")))
	ok(t, contains(bot, "channels:read") && contains(bot, "groups:read"), "채널 목록을 읽을 권한")
	eq(t, pick, "채널 고르기")
	for _, h := range help {
		ok(t, truthy(mget(h, "title")) && jsLen(mstr(h, "text")) > 40, "단계마다 무엇을 누르는지 적혀 있음")
	}
	prompt := jsString(mget(norm(def.prompt), "text"))
	ok(t, regexp.MustCompile(`\{origin\}/guide`).MatchString(prompt))
	ok(t, strings.Contains(prompt, "socket_mode_enabled"))
	ok(t, strings.Contains(prompt, "토큰은 다루지 마"), "AI 는 토큰을 읽거나 넣지 않음")
	ok(t, !regexp.MustCompile(`토큰을 넣고|Bot 토큰, App 토큰을 넣`).MatchString(prompt))
	link, _ := url.Parse(jsString(dig(help, 0, "link", "url")))
	ok(t, reflect.DeepEqual(js(link.Query().Get("manifest_json")), manifest), "링크에 매니페스트가 채워져 있음")
	eq(t, link.Query().Get("new_app"), "1")
	ok(t, reflect.DeepEqual(prefixes, []string{"xoxb-", "xapp-"}))
}

var _ = os.Getenv
