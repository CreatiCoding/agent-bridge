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

// agreeAll: gh1 and gh2 agree to every loaded extension.
func agreeAll(t *testing.T) {
	for _, uid := range []string{"gh1", "gh2"} {
		c := M{}
		for _, d := range EXTS {
			c[d.ID] = d.Hash
		}
		writeJson(consentPath(uid), c)
	}
}

// AC-1493: the person's values, the server's (admins write), secrets that never come back; versions and sizes.
func TestExtStorage(t *testing.T) {
	_ = withExt(t, true)
	code, _ := extCall(t, "GET", "/api/ext/wiki/storage/user/a", "", extH, "gh1")
	eq(t, code, 403) // not agreed
	agreeAll(t)
	call := func(m, p, b, uid string) (int, string) { return extCall(t, m, "/api/ext/wiki"+p, b, extH, uid) }
	code, body := call("GET", "/storage/user/a", "", "gh1")
	eq(t, code, 200)
	jeq(t, oget(js(body), "item"), `null`)
	code, body = call("PUT", "/storage/user/a", `{"value":{"n":1}}`, "gh1")
	eq(t, code, 200)
	jeq(t, oget(js(body), "version"), `1`)
	code, _ = call("PUT", "/storage/user/a", `{"value":2,"ifVersion":5}`, "gh1")
	eq(t, code, 409)
	code, body = call("PUT", "/storage/user/a", `{"value":2,"ifVersion":1}`, "gh1")
	eq(t, code, 200)
	jeq(t, oget(js(body), "version"), `2`)
	_, body = call("GET", "/storage/user/a", "", "gh1")
	jeq(t, oget(js(body), "item"), `{"value":2,"version":2}`)
	_, body = call("GET", "/storage/user/a", "", "gh2")
	jeq(t, oget(js(body), "item"), `null`) // another person's own space
	_, _ = call("PUT", "/storage/user/ab.c", `{"value":true}`, "gh1")
	_, body = call("GET", "/storage/user?prefix=a", "", "gh1")
	jeq(t, oget(js(body), "keys"), `["a","ab.c"]`)
	for _, k := range []string{"..", "a%20b", strings.Repeat("k", 65)} {
		code, _ = call("PUT", "/storage/user/"+k, `{"value":1}`, "gh1")
		ok(t, code == 400 || code == 404, k)
	}
	code, _ = call("PUT", "/storage/user/big", `{"value":"`+strings.Repeat("x", 70_000)+`"}`, "gh1")
	eq(t, code, 413)
	code, _ = extCall(t, "PUT", "/api/ext/wiki/storage/user/a", `{"value":1}`, map[string]string{"X-Bridge-Ext": "1", "Content-Type": "text/plain"}, "gh1")
	eq(t, code, 415)
	code, _ = call("DELETE", "/storage/user/a", "", "gh1")
	eq(t, code, 200)
	_, body = call("GET", "/storage/user/a", "", "gh1")
	jeq(t, oget(js(body), "item"), `null`)
	// The server's: everyone reads, admins write.
	code, _ = call("PUT", "/storage/server/motd", `{"value":"hi"}`, "gh2")
	eq(t, code, 403)
	code, _ = call("PUT", "/storage/server/motd", `{"value":"hi"}`, "gh1")
	eq(t, code, 200)
	_, body = call("GET", "/storage/server/motd", "", "gh2")
	jeq(t, oget(js(body), "item"), `{"value":"hi","version":1}`)
	ok(t, exists(filepath.Join(DATA, "ext-data", "wiki", "data.json")))
	// Secrets: written, listed by name, never read back.
	code, _ = call("PUT", "/secrets/wikiToken", `{"value":"tok-123"}`, "gh1")
	eq(t, code, 200)
	code, body = call("GET", "/secrets", "", "gh1")
	eq(t, code, 200)
	ok(t, strings.Contains(body, `"keys":["wikiToken"]`) && !strings.Contains(body, "tok-123"), body)
	code, _ = call("GET", "/secrets/wikiToken", "", "gh1")
	eq(t, code, 405)
	st, _ := os.Stat(extStoreFile("secrets", "gh1", "wiki"))
	eq(t, st.Mode().Perm(), os.FileMode(0o600))
	ok(t, strings.HasPrefix(extStoreFile("secrets", "gh1", "wiki"), userDir("gh1")), "with the account")
}

// extUpstream: a server that records what it got and answers as told.
type extUpstream struct {
	mu   sync.Mutex
	got  []*http.Request
	body []string
	srv  *httptest.Server
	ans  func(w http.ResponseWriter, r *http.Request)
}

func newUpstream(t *testing.T) *extUpstream {
	u := &extUpstream{}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.got = append(u.got, r)
		u.body = append(u.body, string(b))
		u.mu.Unlock()
		if u.ans != nil {
			u.ans(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "a=b")
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(`{"ok":1}`))
	}))
	t.Cleanup(u.srv.Close)
	return u
}

// AC-1493: a route: signed, the person's secret put in, only some browser headers, paths that cannot climb out,
// answers that cannot run here.
func TestExtRoute(t *testing.T) {
	up := newUpstream(t)
	_ = withConfigServer(t)
	keep := EXTS
	t.Cleanup(func() { EXTS = keep })
	y := strings.Replace(extYaml, "https://wiki.example/api", up.srv.URL+"/base", 1)
	dir := extDir(t, filepath.Join(t.TempDir(), "wiki"), y, map[string]string{"index.js": "x"})
	withCfg(t, "")
	EXTS = loadExtensions([]extEntry{{Path: dir, Env: []string{"WIKI_SIGNING", "TEAM"}}}, extEnv)
	eq(t, EXTS[0].Err, "")
	agreeAll(t)
	call := func(m, p, b string, h map[string]string) (int, string, *Res) {
		r := httptest.NewRequest(m, "/api/ext/wiki/call"+p, strings.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Bridge-Ext", "1")
		for k, v := range h {
			r.Header.Set(k, v)
		}
		req := newReq(r)
		res := newRes(req)
		code := 0
		func() {
			defer func() {
				if x := recover(); x != nil {
					code = x.(*Refuse).Status
				}
			}()
			withLock(func() { api(req, res, r.URL, "gh1") })
		}()
		if code != 0 {
			return code, "", res
		}
		return res.status, string(res.body), res
	}
	code, body, res := call("GET", "/wiki/pages/1?q=a%20b", "", map[string]string{"Accept": "application/json", "Cookie": "cb=secret", "Referer": "x"})
	eq(t, code, 200)
	eq(t, body, `{"ok":1}`)
	eq(t, res.header.Get("Content-Security-Policy"), "sandbox")
	eq(t, res.header.Get("X-Content-Type-Options"), "nosniff")
	eq(t, res.header.Get("Set-Cookie"), "")
	eq(t, res.header.Get("ETag"), `"v1"`)
	g := up.got[0]
	eq(t, g.URL.Path, "/base/pages/1")
	eq(t, g.URL.RawQuery, "q=a%20b")
	eq(t, g.Header.Get("Accept"), "application/json")
	eq(t, g.Header.Get("Cookie"), "")
	eq(t, g.Header.Get("Referer"), "")
	eq(t, g.Header.Get("X-Team"), "core")
	eq(t, g.Header.Get("Authorization"), "") // no secret yet: the header is left out
	eq(t, g.Header.Get("X-Bridge-User"), "gh1")
	eq(t, g.Header.Get("X-Bridge-Login"), "boss")
	// The signature: v1, ts, nonce, method, path?query, user, login, sha256(body).
	sum := sha256.Sum256(nil)
	canon := strings.Join([]string{"v1", g.Header.Get("X-Bridge-Timestamp"), g.Header.Get("X-Bridge-Nonce"), "GET", "/base/pages/1?q=a%20b", "gh1", "boss", hex.EncodeToString(sum[:])}, "\n")
	m := hmac.New(sha256.New, []byte("0123456789abcdef-signing"))
	m.Write([]byte(canon))
	eq(t, g.Header.Get("X-Bridge-Signature"), "v1="+hex.EncodeToString(m.Sum(nil)))
	_, _ = extCall(t, "PUT", "/api/ext/wiki/secrets/wikiToken", `{"value":"tok-123"}`, extH, "gh1")
	code, _, _ = call("POST", "/wiki/save", `{"a":1}`, nil)
	eq(t, code, 200)
	eq(t, up.got[1].Header.Get("Authorization"), "Bearer tok-123")
	eq(t, up.body[1], `{"a":1}`)
	for _, p := range []string{"/wiki/../x", "/wiki/a%2f..%2fb", "/wiki/%2e%2e/x", "/wiki/a%5cb"} {
		code, _, _ = call("GET", p, "", nil)
		eq(t, code, 400, p)
	}
	code, _, _ = call("GET", "/other/x", "", nil)
	eq(t, code, 404)
	code, _, _ = call("DELETE", "/wiki/x", "", nil)
	eq(t, code, 405)
	up.ans = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<script>alert(1)</script>"))
	}
	code, _, _ = call("GET", "/wiki/x", "", nil)
	eq(t, code, 502)
	up.ans = func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://evil.example/", 302) }
	code, body, _ = call("GET", "/wiki/x", "", nil)
	eq(t, code, 502)
	eq(t, body, "")
	up.ans = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.WriteHeader(404)
	}
	code, _, _ = call("GET", "/wiki/x", "", nil)
	eq(t, code, 404)
}

// AC-1493: an event reaches the pages of the people who agreed, once claimable per extension; claims cross a
// handover; extension hooks are sent only for the people who agreed; a deleted account is forgotten.
func TestExtEventsClaims(t *testing.T) {
	hook := newUpstream(t)
	_ = withConfigServer(t)
	keep := EXTS
	t.Cleanup(func() {
		EXTS = keep
		extSent = map[string]map[string]int64{}
		extClaims = map[string]map[string]int64{}
	})
	y := strings.Replace(extYaml, "https://notify.example/done", hook.srv.URL+"/done", 1)
	dir := extDir(t, filepath.Join(t.TempDir(), "wiki"), y, map[string]string{"index.js": "x"})
	withCfg(t, "")
	EXTS = loadExtensions([]extEntry{{Path: dir, Env: []string{"WIKI_SIGNING", "TEAM"}}}, extEnv)
	ok(t, raised("session.done"), "an extension hook raises the event")
	// gh2 has not agreed: nothing for them.
	withLock(func() { emitEvent("session.done", "gh2", orderedObj{{"session", orderedObj{{"id", "s1"}}}}) })
	eq(t, len(extSent["gh2"]), 0)
	agreeAll(t)
	withLock(func() { emitEvent("session.done", "gh1", orderedObj{{"session", orderedObj{{"id", "s1"}}}}) })
	eq(t, len(extSent["gh1"]), 1)
	var id string
	for k := range extSent["gh1"] {
		id = k
	}
	for i := 0; i < 50 && func() bool { hook.mu.Lock(); defer hook.mu.Unlock(); return len(hook.got) == 0 }(); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	hook.mu.Lock()
	eq(t, len(hook.got), 1)
	ok(t, strings.Contains(hook.body[0], `"extension":"wiki"`) && strings.Contains(hook.body[0], `"hook":"session.done.after"`), hook.body[0])
	hook.mu.Unlock()
	// A page action is not an ext-event (the page has its own bus).
	withLock(func() { emitEvent("message.send", "gh1", orderedObj{{"text", "hi"}}) })
	eq(t, len(extSent["gh1"]), 1)
	code, _ := extCall(t, "POST", "/api/ext/wiki/events/"+id+"/claim", "{}", extH, "gh1")
	eq(t, code, 200)
	code, _ = extCall(t, "POST", "/api/ext/wiki/events/"+id+"/claim", "{}", extH, "gh1")
	eq(t, code, 409)
	code, _ = extCall(t, "POST", "/api/ext/wiki/events/0123456789abcdef/claim", "{}", extH, "gh1")
	eq(t, code, 404)
	code, _ = extCall(t, "POST", "/api/ext/wiki/events/"+id+"/claim", "{}", extH, "gh2")
	eq(t, code, 404) // not sent to them
	// Across a handover: the new instance knows it was taken.
	carry := js(jsonStr(M{"ext": extCarry()})).(M)
	extSent, extClaims = map[string]map[string]int64{}, map[string]map[string]int64{}
	extCarried(carry["ext"].(M))
	code, _ = extCall(t, "POST", "/api/ext/wiki/events/"+id+"/claim", "{}", extH, "gh1")
	eq(t, code, 409)
	extForget("gh1")
	_, has := extSent["gh1"]
	ok(t, !has)
	// Old entries go after ten minutes; at most a thousand.
	m := map[string]int64{"old": nowMs() - EXT_CLAIM_MS - 1}
	for i := 0; i < EXT_CLAIM_MAX+5; i++ {
		m[itoa(i)] = nowMs() + int64(i)
	}
	keepRecent(m, nowMs())
	_, hasOld := m["old"]
	ok(t, !hasOld && len(m) == EXT_CLAIM_MAX-1, itoa(len(m)))
}

// AC-1493: data of an extension taken out of bridge.yaml can be cleaned up by an admin.
func TestExtLeftovers(t *testing.T) {
	_ = withExt(t, true)
	_ = os.MkdirAll(filepath.Join(DATA, "ext-data", "gone"), 0o700)
	_ = os.MkdirAll(filepath.Join(userDir("gh2"), "ext", "gone"), 0o700)
	_ = os.MkdirAll(filepath.Join(userDir("gh2"), "ext", "wiki"), 0o700)
	code, body := callAPI(t, "GET", "/api/admin/ext-leftovers", "")
	eq(t, code, 200)
	jeq(t, oget(js(body), "ids"), `["gone"]`)
	code, _ = callAPI(t, "POST", "/api/admin/ext-leftovers", `{"id":"wiki"}`)
	eq(t, code, 404) // still listed
	code, _ = extCall(t, "POST", "/api/admin/ext-leftovers", `{"id":"gone"}`, nil, "gh2")
	eq(t, code, 403)
	code, _ = callAPI(t, "POST", "/api/admin/ext-leftovers", `{"id":"gone"}`)
	eq(t, code, 200)
	ok(t, !exists(filepath.Join(DATA, "ext-data", "gone")) && !exists(filepath.Join(userDir("gh2"), "ext", "gone")) && exists(filepath.Join(userDir("gh2"), "ext", "wiki")))
}
