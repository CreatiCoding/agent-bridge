package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pageCall: one signed-in page request, as route runs it (by: page), with its status (a refusal's when refused).
func pageCall(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	req := newReq(r)
	res := newRes(req)
	code, msg := 0, ""
	func() {
		defer func() {
			if x := recover(); x != nil {
				rf, isRefuse := x.(*Refuse)
				if !isRefuse {
					panic(x)
				}
				code, msg = rf.Status, rf.Msg
			}
		}()
		withLock(func() { withBy("page", func() { api(req, res, r.URL, "gh1") }) })
	}()
	if code != 0 {
		return code, msg
	}
	return res.status, string(res.body)
}

// hookSession: a server with the given bridge.yaml, the person gh1, a connected Mac h1 and an open session s1.
func hookSession(t *testing.T, yaml string) *Sess {
	t.Helper()
	withSlotServer(t, yaml)
	keepS, keepB := sessions, bridges
	t.Cleanup(func() { sessions, bridges = keepS, keepB })
	sessions = newOMap[*Sess]()
	bridges = newOMap[Sink]()
	var meta *Sess
	withLock(func() {
		users.Set("gh1", M{"login": "me"})
		hosts.Set("h1", M{"uid": "gh1", "name": "내 맥"})
		bridges.Set("h1", newStream(nil))
		meta = newMeta("gh1", "s1", "h1", M{"cwd": "/w", "title": "일"})
		meta.set("state", M{"alive": true, "phase": "idle"})
	})
	return meta
}

func hookBody(t *testing.T, h hookHit) M {
	t.Helper()
	verify(t, HOOK_SECRET, h)
	v, err := parseJSON([]byte(h.body))
	if err != nil {
		t.Fatal(err)
	}
	return v.(M)
}

func TestHooksRead(t *testing.T) {
	withCfg(t, "hooks:\n  session.create.after:\n    - type: webhook\n      url: https://policy.example/after?k=1\n      secret: "+HOOK_SECRET+"\n      timeoutMs: 500\n    - type: exec\n      run: /opt/hooks/on-create\n")
	hs := hooksOf("session.create.after")
	ok(t, len(hs) == 2 && hs[0].URL == "https://policy.example/after?k=1" && hs[0].Timeout == 500*time.Millisecond, "webhook")
	ok(t, hs[1].Type == "exec" && hs[1].Run == "/opt/hooks/on-create" && hs[1].Timeout == 3*time.Second, "exec, 기본 3초")
	bad := []struct{ src, has string }{
		{"hooks:\n  session.open.after: []\n", "모르는 훅"},
		{"hooks:\n  session.create.around: []\n", "모르는 훅"},
		{"hooks:\n  - x\n", "훅 이름: 목록"},
		{"hooks:\n  login.after:\n    - type: webhook\n      url: https://a.example\n", "secret 가 없습니다"},
		{"hooks:\n  login.after:\n    - type: webhook\n      url: https://a.example\n      secret: short\n", "16자 이상"},
		{"hooks:\n  login.after:\n    - type: webhook\n      url: ftp://a.example\n      secret: " + HOOK_SECRET + "\n", "http(s)://"},
		{"hooks:\n  login.after:\n    - type: exec\n      run: bin/hook\n", "절대 경로"},
		{"hooks:\n  login.after:\n    - type: exec\n      run: /bin/hook\n      url: https://a.example\n", "url·secret 을 쓰지 않습니다"},
		{"hooks:\n  login.after:\n    - type: exec\n      run: /bin/hook\n      timeoutMs: 20000\n", "timeoutMs"},
		{"hooks:\n  login.after:\n    - type: shell\n", "모르는 종류"},
		{"hooks:\n  login.after:\n    - type: exec\n      run: /bin/hook\n      onError: deny\n", "before 훅에만"},
		{"hooks:\n  login.before:\n    - type: exec\n      run: /bin/hook\n      onError: block\n", "allow 나 deny"},
		{"hooks:\n  session.done.before: []\n", "모르는 훅"},
	}
	for _, b := range bad {
		_, err := parseBridgeConfig("/etc/bridge/bridge.yaml", []byte(b.src), envMap(nil))
		ok(t, err != nil && strings.Contains(err.Error(), b.has), b.src+": "+errMsg(err))
	}
	six := "hooks:\n  login.after:\n" + strings.Repeat("    - type: exec\n      run: /bin/hook\n", 6)
	_, err := parseBridgeConfig("/etc/bridge/bridge.yaml", []byte(six), envMap(nil))
	ok(t, err != nil && strings.Contains(err.Error(), "5개까지"), errMsg(err))

	// A command inside DATA is refused before the handover (its execute bit goes at start), through a link too.
	data := t.TempDir()
	c, _ := parseBridgeConfig("/etc/bridge/bridge.yaml", []byte("hooks:\n  login.after:\n    - type: exec\n      run: "+data+"/hooks/x\n"), envMap(nil))
	ok(t, checkHookPaths(c, data) != nil, "DATA 안")
	link := filepath.Join(t.TempDir(), "d")
	_ = os.Symlink(data, link)
	c, _ = parseBridgeConfig("/etc/bridge/bridge.yaml", []byte("hooks:\n  login.after:\n    - type: exec\n      run: "+link+"/x\n"), envMap(nil))
	ok(t, checkHookPaths(c, data) != nil, "링크로 DATA 안")
	c, _ = parseBridgeConfig("/etc/bridge/bridge.yaml", []byte("hooks:\n  login.after:\n    - type: exec\n      run: /opt/hooks/x\n"), envMap(nil))
	ok(t, checkHookPaths(c, data) == nil, "DATA 밖")
	ok(t, checkHookPaths(c, "/opt") != nil, "DATA 가 위 폴더")
}

// The request kind (by) is set at the way in, survives await (another request runs meanwhile with none) and goes
// on into work a request starts later.
func TestHookScope(t *testing.T) {
	withLock(func() {
		eq(t, curBy(), "system", "밖에서는 system")
		withBy("page", func() {
			await(func() {
				mu.Lock()
				eq(t, curBy(), "system", "락을 놓은 사이 다른 요청은 범위가 없음")
				mu.Unlock()
			})
			eq(t, curBy(), "page", "await 뒤 돌아옴")
			ok(t, firstTime("a", "s1") && !firstTime("a", "s1") && firstTime("a", "s2"), "같은 대상은 한 번")
			done := make(chan string)
			goLocked("t", func() { done <- curBy() })
			await(func() { eq(t, <-done, "page", "goLocked 는 이어 감") })
		})
		eq(t, curBy(), "system")
	})
}

// AC-1486: after hooks hear of an action once, where it took effect, with who asked (page, system), and a failing
// hook changes nothing for the person.
func TestHooksAfter(t *testing.T) {
	hs := newHookServer(t)
	dead := newHookServer(t, 500)
	dir := t.TempDir()
	out := filepath.Join(dir, "got.json")
	script := filepath.Join(dir, "on-close")
	_ = os.WriteFile(script, []byte("#!/bin/sh\ncat > "+out+"\necho \"$BRIDGE_VERSION ${GITHUB_CLIENT_SECRET:-none}\" > "+out+".env\n"), 0o755)
	t.Setenv("GITHUB_CLIENT_SECRET", "server-secret")
	meta := hookSession(t, "hooks:\n  message.send.after:\n    - type: webhook\n      url: "+hs.srv.URL+"/send\n      secret: "+HOOK_SECRET+"\n    - type: webhook\n      url: "+dead.srv.URL+"\n      secret: "+HOOK_SECRET+"\n  session.settings.after:\n    - type: webhook\n      url: "+hs.srv.URL+"/settings\n      secret: "+HOOK_SECRET+"\n  permission.answer.after:\n    - type: webhook\n      url: "+hs.srv.URL+"/answer\n      secret: "+HOOK_SECRET+"\n  session.close.after:\n    - type: exec\n      run: "+script+"\n")

	code, msg := pageCall(t, "POST", "/api/sessions/s1/say", `{"text":"안녕"}`)
	eq(t, code, 200, "보내기 "+msg)
	got := hs.wait(t, 1)
	b := hookBody(t, got[0])
	eq(t, got[0].path, "/send")
	ok(t, b["name"] == "message.send" && b["text"] == "안녕" && b["images"] == 0.0 && b["by"] == "page", got[0].body)
	jeq(t, b["session"], `{"cwd":"/w","host":"내 맥","hostId":"h1","id":"s1","title":"일"}`)

	// A command wrapped in say raises the op it runs, once.
	code, _ = pageCall(t, "POST", "/api/sessions/s1/say", `{"text":":rename 새 이름"}`)
	eq(t, code, 200)
	got = hs.wait(t, 2)
	b = hookBody(t, got[1])
	ok(t, b["name"] == "session.settings" && b["by"] == "page", got[1].body)
	jeq(t, b["changed"], `{"title":"새 이름"}`)

	withLock(func() {
		meta.set("card", M{"id": "card-0001", "kind": "permission", "open": true, "title": "Bash", "tool": M{"name": "Bash", "input": M{"command": "ls"}}, "options": []any{M{"n": 1.0, "label": "허용", "kind": "allow-once"}, M{"n": 2.0, "label": "거부", "kind": "deny"}}})
	})
	code, _ = pageCall(t, "POST", "/api/sessions/s1/do", `{"cmd":"card","arg":"card-0001 2"}`)
	eq(t, code, 200)
	got = hs.wait(t, 3)
	b = hookBody(t, got[2])
	ok(t, b["name"] == "permission.answer" && b["by"] == "page", got[2].body)
	jeq(t, b["card"], `{"id":"card-0001","kind":"permission","title":"Bash","tool":{"name":"Bash","input":{"command":"ls"}}}`)
	jeq(t, b["option"], `{"n":2,"label":"거부","kind":"deny"}`)
	// A card the server does not know (after a reconnect) still goes to the Mac, as kind other.
	withLock(func() { meta.set("card", M{"id": "card-0001", "open": false}) })
	code, _ = pageCall(t, "POST", "/api/sessions/s1/answer", `{"card":"card-0009","n":1}`)
	eq(t, code, 200)
	got = hs.wait(t, 4)
	jeq(t, hookBody(t, got[3])["option"], `{"n":1,"label":"","kind":"other"}`)

	// The server's own close (no request): by system, to the command on stdin with only a small environment.
	withLock(func() { closeSession(meta, "") })
	var raw []byte
	for i := 0; i < 200 && len(raw) == 0; i++ {
		time.Sleep(10 * time.Millisecond)
		raw, _ = os.ReadFile(out)
	}
	v, err := parseJSON(raw)
	if err != nil {
		t.Fatalf("명령이 받은 것: %q", raw)
	}
	ok(t, mget(v, "name") == "session.close" && mget(v, "kind") == "end" && mget(v, "by") == "system", string(raw))
	envOut, _ := os.ReadFile(out + ".env")
	eq(t, string(envOut), VERSION+" none\n", "서버의 비밀 환경변수는 넘기지 않음")
	dead.wait(t, 1)
	time.Sleep(50 * time.Millisecond)
	dead.mu.Lock()
	eq(t, len(dead.got), 1, "after 는 다시 보내지 않음")
	dead.mu.Unlock()
}

// Without hooks nothing is built or sent, and the privacy page lists hook destinations with notify's.
func TestHooksRecipients(t *testing.T) {
	withCfg(t, "hooks:\n  session.create.after:\n    - type: webhook\n      url: https://policy.example/a/SECRET\n      secret: "+HOOK_SECRET+"\n    - type: exec\n      run: /opt/x\n  login.after:\n    - type: webhook\n      url: https://policy.example/b\n      secret: "+HOOK_SECRET+"\n")
	jeq(t, recipients(), `[{"origin":"https://policy.example","events":["login.after","session.create.after"]},{"origin":"(이 서버 안의 명령)","events":["session.create.after"]}]`)
	ok(t, !strings.Contains(jsonStr(recipients()), "SECRET"), "경로는 싣지 않음")
	withCfg(t, "")
	ok(t, !raised("session.create") && len(recipients()) == 0, "설정이 없으면 아무것도 없음")
}

// answerServer: a before hook that answers what fn says (a JSON text) to each event it gets, counting them.
type answerServer struct {
	srv *httptest.Server
	n   int
	mu  chan struct{}
}

func newAnswerServer(t *testing.T, fn func(ev M) string) *answerServer {
	a := &answerServer{mu: make(chan struct{}, 1)}
	a.mu <- struct{}{}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v, _ := parseJSON(b)
		<-a.mu
		a.n++
		a.mu <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fn(v.(M))))
	}))
	t.Cleanup(a.srv.Close)
	return a
}

func (a *answerServer) count() int {
	<-a.mu
	defer func() { a.mu <- struct{}{} }()
	return a.n
}

func beforeHook(name, url string, more string) string {
	return "  " + name + ".before:\n    - type: webhook\n      url: " + url + "\n      secret: " + HOOK_SECRET + "\n" + more
}

// AC-1487: before hooks may refuse (403 with the reason) or change the text, title, prompt or mode; the lock is let
// go while they answer and the session is checked again after; a failing hook counts as yes unless onError: deny;
// the server's own work and admins signing in are not asked.
func TestHooksBefore(t *testing.T) {
	after := newHookServer(t)
	send := newAnswerServer(t, func(ev M) string {
		if ev["hook"] != "message.send.before" || ev["by"] != "page" {
			return `{"allow":false,"reason":"본문이 이상함"}`
		}
		if strings.Contains(mstr(ev, "text"), "비밀") {
			return `{"allow":false,"reason":"비밀은 보내지 마세요"}`
		}
		return `{"allow":true,"patch":{"text":"` + mstr(ev, "text") + ` (확인됨)"}}`
	})
	closeNo := newAnswerServer(t, func(ev M) string { return `{"allow":false}` })
	badPatch := newAnswerServer(t, func(ev M) string { return `{"allow":true,"patch":{"title":"새","mode":"bypassPermissions"}}` })
	dead := newHookServer(t, 500, 500, 500, 500)
	// While this hook answers, another request takes the lock and removes the session.
	var meta *Sess
	gone := newAnswerServer(t, func(ev M) string {
		withLock(func() { sessions.Delete("s1") })
		return `{"allow":true}`
	})
	slow := newAnswerServer(t, func(ev M) string { time.Sleep(300 * time.Millisecond); return `{"allow":false}` })
	cfg := "features:\n  permissionModes: [default, plan]\nhooks:\n" +
		beforeHook("message.send", send.srv.URL, "") +
		"  message.send.after:\n    - type: webhook\n      url: " + after.srv.URL + "\n      secret: " + HOOK_SECRET + "\n" +
		beforeHook("session.close", closeNo.srv.URL, "") +
		beforeHook("session.settings", badPatch.srv.URL, "") +
		beforeHook("session.key", dead.srv.URL, "      onError: deny\n") +
		beforeHook("message.btw", dead.srv.URL, "") +
		beforeHook("session.setting", slow.srv.URL, "      timeoutMs: 50\n") +
		beforeHook("session.do", gone.srv.URL, "")
	meta = hookSession(t, cfg)

	code, _ := pageCall(t, "POST", "/api/sessions/s1/say", `{"text":"반가워"}`)
	eq(t, code, 200)
	got := hookBody(t, after.wait(t, 1)[0])
	eq(t, mstr(got, "text"), "반가워 (확인됨)", "고친 글이 맥에 감")
	ok(t, strings.Contains(string(bridgeOut(t, "h1")), "반가워 (확인됨)"), "맥에 간 명령")
	code, msg := pageCall(t, "POST", "/api/sessions/s1/say", `{"text":"비밀 번호는"}`)
	ok(t, code == 403 && msg == "비밀은 보내지 마세요", msg)

	code, msg = pageCall(t, "POST", "/api/sessions/s1/close", `{}`)
	ok(t, code == 403 && msg == HOOK_DENIED, msg)
	withLock(func() { ok(t, !truthy(meta.get("closed")), "막으면 닫지 않음") })
	// The server's own work is not asked.
	withLock(func() { closeSession(meta, "") })
	eq(t, closeNo.count(), 1, "system 은 묻지 않음")
	withLock(func() { meta.set("closed", false) })

	// A patch it may not give (a mode off the list) is a failing hook: onError allow goes on without it.
	code, _ = pageCall(t, "POST", "/api/sessions/s1/settings", `{"title":"옛"}`)
	eq(t, code, 200)
	withLock(func() { eq(t, meta.str("title"), "옛", "잘못된 patch 는 버림") })
	code, msg = pageCall(t, "POST", "/api/sessions/s1/key", `{"keys":["Enter"]}`)
	ok(t, code == 403 && msg == "확인 서버에 묻지 못해 막았어요", "onError deny: "+msg)
	code, _ = pageCall(t, "POST", "/api/sessions/s1/setting", `{"kind":"model","value":"opus"}`)
	eq(t, code, 200, "시간을 넘긴 훅은 실패, 기본 allow")

	code, msg = pageCall(t, "POST", "/api/sessions/s1/sendnow", `{}`)
	ok(t, code == 409 && strings.Contains(msg, "세션이 바뀌었어요"), "락을 놓은 사이 지워짐: "+msg)
}

// A card answer is refused when the server knows another card is open; a card it does not know goes on.
func TestAnswerOtherCard(t *testing.T) {
	meta := hookSession(t, "")
	withLock(func() { meta.set("card", M{"id": "card-0002", "open": true, "kind": "permission"}) })
	code, msg := pageCall(t, "POST", "/api/sessions/s1/answer", `{"card":"card-0001","n":1}`)
	ok(t, code == 409 && msg == OTHER_CARD, msg)
	code, _ = pageCall(t, "POST", "/api/sessions/s1/answer", `{"card":"card-0002","n":1}`)
	eq(t, code, 200)
	withLock(func() { meta.set("card", M{"id": "card-0002", "open": false}) })
	code, _ = pageCall(t, "POST", "/api/sessions/s1/answer", `{"card":"card-0001","n":1}`)
	eq(t, code, 200, "닫힌 카드뿐이면 지금처럼 넘김")
}

// login.before: a stranger may be refused; an admin is never asked.
func TestLoginBefore(t *testing.T) {
	no := newAnswerServer(t, func(ev M) string { return `{"allow":false,"reason":"점검 중"}` })
	withSlotServer(t, "hooks:\n"+beforeHook("login", no.srv.URL, ""))
	keepA := ADMINS
	t.Cleanup(func() { ADMINS = keepA })
	ADMINS = []string{"boss"}
	withLock(func() {
		users.Set("u1", M{"login": "me"})
		users.Set("u2", M{"login": "boss"})
	})
	try1 := func(uid string) (code int, msg string) {
		r := httptest.NewRequest("GET", "/api/auth/dev", nil)
		req := newReq(r)
		res := newRes(req)
		withLock(func() {
			defer func() {
				if rf, isRefuse := recover().(*Refuse); isRefuse {
					code, msg = rf.Status, rf.Msg
				}
			}()
			signIn(req, res, uid, "/", nil)
			code = res.status
		})
		return
	}
	code, msg := try1("u1")
	ok(t, code == 403 && msg == "점검 중", msg)
	code, _ = try1("u2")
	ok(t, code != 403, "관리자는 묻지 않음")
	eq(t, no.count(), 1)
}

// bridgeOut: what the server sent down to a Mac's link so far.
func bridgeOut(t *testing.T, hostID string) []byte {
	t.Helper()
	var out []byte
	withLock(func() {
		b, _ := bridges.Get(hostID)
		if s, ok := b.(*Stream); ok {
			s.smu.Lock()
			out = []byte(strings.Join(s.queue, ""))
			s.smu.Unlock()
		}
	})
	return out
}
