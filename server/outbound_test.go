package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// hookServer: a webhook that records what it got and answers with the codes given, then 200.
type hookServer struct {
	mu    sync.Mutex
	got   []hookHit
	codes []int
	srv   *httptest.Server
}

type hookHit struct {
	h    http.Header
	path string
	body string
}

func newHookServer(t *testing.T, codes ...int) *hookServer {
	s := &hookServer{codes: codes}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.got = append(s.got, hookHit{r.Header.Clone(), r.URL.RequestURI(), string(b)})
		code := 200
		if len(s.codes) > 0 {
			code, s.codes = s.codes[0], s.codes[1:]
		}
		s.mu.Unlock()
		w.WriteHeader(code)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *hookServer) wait(t *testing.T, n int) []hookHit {
	t.Helper()
	for i := 0; i < 200; i++ {
		s.mu.Lock()
		if len(s.got) >= n {
			out := append([]hookHit{}, s.got...)
			s.mu.Unlock()
			return out
		}
		s.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t.Fatalf("웹훅이 %d번 와야 함, %d번 옴", n, len(s.got))
	return nil
}

// verify checks a request the way the SPEC tells a receiver to.
func verify(t *testing.T, secret string, h hookHit) {
	t.Helper()
	sum := sha256.Sum256([]byte(h.body))
	canon := strings.Join([]string{"v1", h.h.Get("X-Bridge-Timestamp"), h.h.Get("X-Bridge-Nonce"), "POST", h.path, h.h.Get("X-Bridge-User"), h.h.Get("X-Bridge-Login"), hex.EncodeToString(sum[:])}, "\n")
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(canon))
	ok(t, h.h.Get("X-Bridge-Signature") == "v1="+hex.EncodeToString(m.Sum(nil)), "서명이 맞음")
	ok(t, len(h.h.Get("X-Bridge-Nonce")) == 32, "nonce 16바이트 hex")
}

const HOOK_SECRET = "hook-secret-0123456789"

func TestNotifyRead(t *testing.T) {
	src := "notify:\n  - type: webhook\n    url: https://hooks.example/x/${TOKEN}?a=1\n    secret: " + HOOK_SECRET + "\n    events: [decision.waiting, session.done]\n"
	c, err := parseBridgeConfig("/x/bridge.yaml", []byte(src), envMap(map[string]string{"TOKEN": "t0ken"}))
	if err != nil {
		t.Fatal(err)
	}
	ts := c.set["notify"].v.([]notifyTarget)
	ok(t, len(ts) == 1 && ts[0].URL == "https://hooks.example/x/t0ken?a=1" && strings.Join(ts[0].Events, ",") == "decision.waiting,session.done")
	bad := []struct{ src, has string }{
		{"notify:\n  - type: email\n", "모르는 수신처"},
		{"notify:\n  - type: webhook\n    url: ftp://h/x\n    secret: " + HOOK_SECRET + "\n    events: [login]\n", "http(s)://"},
		{"notify:\n  - type: webhook\n    url: https://h.example/secretpath\n    secret: short\n    events: [login]\n", "16자 이상"},
		{"notify:\n  - type: webhook\n    url: https://h.example/x\n    secret: " + HOOK_SECRET + "\n    events: [session.open]\n", "내지 않는 이벤트"},
		{"notify:\n  - type: webhook\n    url: https://h.example/x\n    secret: " + HOOK_SECRET + "\n", "events 가 없습니다"},
		{"notify:\n  - type: webhook\n    nope: 1\n", "모르는 키 notify[].nope"},
		{"notify:\n  type: webhook\n", "목록이어야"},
		{"notify:\n  - type: webhook\n    url: https://user:pw@h.example/x\n    secret: " + HOOK_SECRET + "\n    events: [login]\n", "http(s)://"},
	}
	for _, b := range bad {
		_, err := parseBridgeConfig("/x/bridge.yaml", []byte(b.src), envMap(nil))
		if err == nil || !strings.Contains(err.Error(), b.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", b.src, b.has, err)
		}
		if err != nil && (strings.Contains(err.Error(), HOOK_SECRET) || strings.Contains(err.Error(), "secretpath") || strings.Contains(err.Error(), "pw@")) {
			t.Errorf("오류 문구에 비밀값: %v", err)
		}
	}
	eq(t, rawOrigin("https://Hooks.Slack.com/services/T0/B0/xyz"), "https://hooks.slack.com")
	eq(t, rawOrigin("${NOTIFY_URL}"), "${NOTIFY_URL}")
	m := maskConfigText("notify:\n  - url: https://u:pw@hooks.example/p/q?x=1\n    secret: " + HOOK_SECRET + "\norigins:\n  primary: https://a.example\n")
	ok(t, !strings.Contains(m, "pw") && !strings.Contains(m, "/p/q") && !strings.Contains(m, HOOK_SECRET) && strings.Contains(m, "https://a.example\n"), m)
}

// AC-1484: a failed try is tried again after the waits, signed afresh each time, with the same event id.
func TestNotifyRetryAndSignature(t *testing.T) {
	keep := NOTIFY_RETRY
	t.Cleanup(func() { NOTIFY_RETRY = keep })
	NOTIFY_RETRY = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	hs := newHookServer(t, 500, 503)
	body := []byte(`{"id":"e1","name":"session.done"}`)
	go deliverEvent(notifyTarget{URL: hs.srv.URL + "/in?k=1", URLText: hs.srv.URL + "/in?k=1", Secret: HOOK_SECRET, Events: []string{"session.done"}}, body, "u1", "me")
	got := hs.wait(t, 3)
	eq(t, len(got), 3)
	for _, h := range got {
		verify(t, HOOK_SECRET, h)
		eq(t, h.body, string(body))
		eq(t, h.path, "/in?k=1")
		eq(t, h.h.Get("X-Bridge-User")+"|"+h.h.Get("X-Bridge-Login"), "u1|me")
	}
	ok(t, got[0].h.Get("X-Bridge-Nonce") != got[1].h.Get("X-Bridge-Nonce"), "다시 보낼 때마다 새 nonce")

	// Four failures: dropped after the fourth try, nothing more.
	hs2 := newHookServer(t, 500, 500, 500, 500, 500)
	deliverEvent(notifyTarget{URL: hs2.srv.URL, URLText: hs2.srv.URL, Secret: HOOK_SECRET}, body, "", "")
	eq(t, len(hs2.wait(t, 4)), 4)
	ok(t, hs2.got[0].h.Get("X-Bridge-User") == "" && hs2.got[0].path == "/", "사용자 없으면 빈 값")
}

// AC-1483: the four events are raised where the session state and its cards change, once each, to the webhooks
// that name them; nothing goes to one that does not.
func TestEventsRaised(t *testing.T) {
	hs := newHookServer(t)
	other := newHookServer(t)
	withSlotServer(t, "origins:\n  primary: https://b.example\nnotify:\n  - type: webhook\n    url: "+hs.srv.URL+"/all\n    secret: "+HOOK_SECRET+"\n    events: [login, session.done, decision.waiting, decision.answered]\n  - type: webhook\n    url: "+other.srv.URL+"\n    secret: "+HOOK_SECRET+"\n    events: [login]\n")
	keepS := sessions
	t.Cleanup(func() { sessions = keepS })
	sessions = newOMap[*Sess]()
	users.Set("u1", M{"login": "me"})
	hosts.Set("h1", M{"uid": "u1", "name": "내 맥"})
	meta := newMeta("u1", "s-events-1", "h1", M{"cwd": "/w", "title": "일"})

	card := M{"id": "card-0001", "kind": "permission", "open": true, "title": "Bash 권한 요청", "tool": M{"name": "Bash"}, "options": []any{M{"n": 1.0, "label": "허용", "kind": "allow-once"}, M{"n": 3.0, "label": "거부", "kind": "deny"}}}
	withLock(func() {
		cardFromAgent("u1", "h1", M{"sid": meta.id(), "card": card})
		cardFromAgent("u1", "h1", M{"sid": meta.id(), "card": card}) // sent again: no second event
		noteAnswer("card-0001", M{"n": 1.0, "via": "card", "by": "page"})
		cardFromAgent("u1", "h1", M{"sid": meta.id(), "card": M{"id": "card-0001", "open": false, "result": "허용"}})
		cardFromAgent("u1", "h1", M{"sid": meta.id(), "card": M{"id": "card-0002", "kind": "permission", "open": false, "auto": true, "title": "Read"}})
		meta.set("state", M{"phase": "busy"})
		statusFromAgent("u1", "h1", M{"sid": meta.id(), "phase": "idle", "alive": true})
	})
	hits := hs.wait(t, 4)
	time.Sleep(50 * time.Millisecond)
	// Each goes in its own goroutine, so in any order: sorted by name, then the answered ones by via.
	byName := map[string][]hookHit{}
	for _, h := range hits {
		verify(t, HOOK_SECRET, h)
		v, _ := parseJSON([]byte(h.body))
		byName[mstr(v.(M), "name")] = append(byName[mstr(v.(M), "name")], h)
	}
	ok(t, len(byName["decision.waiting"]) == 1 && len(byName["decision.answered"]) == 2 && len(byName["session.done"]) == 1, "넷, 다시 온 카드는 한 번")
	ans := byName["decision.answered"]
	if strings.Contains(ans[0].body, `"auto"`) {
		ans[0], ans[1] = ans[1], ans[0]
	}
	got := []hookHit{byName["decision.waiting"][0], ans[0], ans[1]}
	w, _ := parseJSON([]byte(got[0].body))
	jeq(t, mget(w, "session"), `{"cwd":"/w","host":"내 맥","hostId":"h1","id":"s-events-1","title":"일"}`, got[0].body)
	jeq(t, mget(w, "card"), `{"id":"card-0001","kind":"permission","options":[{"kind":"allow-once","label":"허용","n":1},{"kind":"deny","label":"거부","n":3}],"title":"Bash 권한 요청","tool":"Bash"}`, got[0].body)
	eq(t, mstr(w.(M), "url"), "https://b.example/s/s-events-1")
	jeq(t, mget(w, "user"), `{"login":"me","uid":"u1"}`, got[0].body)
	ok(t, len(mstr(w.(M), "id")) == 32, "이벤트 id")
	a, _ := parseJSON([]byte(got[1].body))
	ok(t, mget(a, "n") == 1.0 && mget(a, "via") == "card" && mget(a, "by") == "page", got[1].body)
	a2, _ := parseJSON([]byte(got[2].body))
	ok(t, mget(a2, "via") == "auto" && mget(a2, "n") == nil, got[2].body)
	other.mu.Lock()
	eq(t, len(other.got), 0, "login 만 받는 웹훅에는 안 감")
	other.mu.Unlock()

	// login: on a sign-in, to both.
	r := httptest.NewRequest("GET", "/api/auth/dev", nil)
	req := newReq(r)
	withLock(func() { signIn(req, newRes(req), "u1", "/", nil) })
	lg := other.wait(t, 1)
	l, _ := parseJSON([]byte(lg[0].body))
	ok(t, mget(l, "name") == "login" && mget(l, "provider") == "github" && mget(l, "url") == "https://b.example", lg[0].body)
}

// AC-1485: the shipped policy lists the destinations (origins only) and stops saying nothing leaves; /api/me has them.
func TestPrivacyRecipients(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "web", "privacy.html"))
	if err != nil {
		t.Fatal(err)
	}
	withSlotServer(t, "")
	eq(t, privacyWithRecipients(string(b)), string(b), "수신처 없으면 그대로")
	withCfg(t, "notify:\n  - type: webhook\n    url: https://hooks.slack.com/services/T0/B0/SECRETPATH\n    secret: "+HOOK_SECRET+"\n    events: [decision.waiting]\n")
	out := privacyWithRecipients(string(b))
	ok(t, strings.Contains(out, "https://hooks.slack.com — decision.waiting") && strings.Contains(out, "(https://hooks.slack.com (decision.waiting))") == false, "목록")
	ok(t, !strings.Contains(out, "SECRETPATH") && !strings.Contains(out, HOOK_SECRET), "경로·비밀값 없음")
	ok(t, !strings.Contains(out, "개인정보 처리 업무를 위탁하지 않습니다.</p>") || strings.Contains(out, "외에는 개인정보 처리 업무를 위탁하지 않습니다"), "위탁 문장 바뀜")
	ok(t, strings.Contains(out, "외에는 개인정보 처리 업무를 위탁하지 않습니다") && !strings.Contains(out, "No data is given to third parties, and no processing is outsourced."), "한국어·영어 문장 모두 바뀜")
	ok(t, strings.Contains(out, "제5조 ③") && strings.Count(out, "hooks.slack.com") == 2, "조항과 영어 요약에 한 번씩")
	ok(t, strings.Contains(out, "보낸 글·누른 키 같은 그 동작의 내용"), "보낸 글도 간다고 적음")
	code, body := callAPI(t, "GET", "/api/me", "")
	ok(t, code == 200 && strings.Contains(body, `"recipients":[{"origin":"https://hooks.slack.com","events":["decision.waiting"]}]`), body)
}
