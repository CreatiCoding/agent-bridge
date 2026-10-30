package main

import (
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
		{"hooks:\n  login.after:\n    - type: exec\n      run: /bin/hook\n      onError: deny\n", "모르는 키"},
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
