// 로컬 전체 화면 (local --full): the signed Mac builds (REQ-F-901, REQ-S-103) and the Mac's own server (REQ-F-900,
// REQ-S-104).
package main

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lfTestKey: a key of the test's own, trusted in place of the update keys while the test runs.
func lfTestKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	keep := lfKeys
	lfKeys = func() []string { return []string{base64.StdEncoding.EncodeToString(der)} }
	t.Cleanup(func() { lfKeys = keep })
	return priv
}

// lfDoc: the document scripts/sign-agent.mjs writes (agent/localfull.mjs lfDocOf), signed with key.
func lfDoc(key ed25519.PrivateKey, arch string, b []byte, seq int) (string, string) {
	h := sha256.Sum256(b)
	d, _ := json.Marshal(map[string]any{"name": "localfull-" + arch, "version": hex.EncodeToString(h[:])[:12], "seq": seq, "api": 1, "integrity": "sha256:" + base64.StdEncoding.EncodeToString(h[:]), "size": len(b)})
	return string(d), base64.StdEncoding.EncodeToString(ed25519.Sign(key, append([]byte(lfSigPrefix), d...)))
}

func TestLocalFullCheck(t *testing.T) {
	key := lfTestKey(t)
	b := []byte("a mac build")
	doc, sig := lfDoc(key, "darwin-arm64", b, 7)
	d, err := lfCheck("darwin-arm64", doc, sig, b)
	ok(t, err == nil && d.Seq == 7, "서명과 해시가 맞으면 받음")
	_, err = lfCheck("darwin-arm64", doc, sig, []byte("a mac build!"))
	ok(t, err != nil && strings.Contains(err.Error(), "해시"), "다른 바이트는 거절")
	_, err = lfCheck("darwin-amd64", doc, sig, b)
	ok(t, err != nil, "다른 아키텍처의 문서는 거절")
	// A signature without the prefix (the local screen's or an agent update's) does not read as one of these.
	bare := base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(doc)))
	_, err = lfCheck("darwin-arm64", doc, bare, b)
	ok(t, err != nil && strings.Contains(err.Error(), "서명"), "영역 구분 없는 서명은 거절")
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	doc2, sig2 := lfDoc(other, "darwin-arm64", b, 8)
	_, err = lfCheck("darwin-arm64", doc2, sig2, b)
	ok(t, err != nil, "다른 키의 서명은 거절")
}

// AC-1747: the image is made only when every Mac build is the signed one; the server hands out only those.
func TestLocalFullVerifyAndServe(t *testing.T) {
	key := lfTestKey(t)
	dir := t.TempDir()
	docs := map[string]any{"src": "x"}
	for _, a := range LF_ARCHES {
		b := []byte("build of " + a)
		_ = os.WriteFile(filepath.Join(dir, a), b, 0o600)
		doc, sig := lfDoc(key, a, b, 3)
		docs[a] = map[string]string{"doc": doc, "sig": sig}
	}
	jb, _ := json.Marshal(docs)
	docsFile := filepath.Join(dir, "localfull.json")
	_ = os.WriteFile(docsFile, jb, 0o600)
	eq(t, localFullVerify([]string{dir, docsFile}), 0, "서명과 같은 빌드")
	_ = os.WriteFile(filepath.Join(dir, "darwin-amd64"), []byte("different"), 0o600)
	eq(t, localFullVerify([]string{dir, docsFile}), 1, "서명과 다른 빌드가 하나라도 있으면 실패")

	keep := LOCALFULL
	defer func() { LOCALFULL = keep }()
	LOCALFULL = loadLocalFull(dir, docsFile)
	ok(t, LOCALFULL["darwin-arm64"].OK && !LOCALFULL["darwin-amd64"].OK, "맞는 것만 OK")
	r := httptest.NewRequest("GET", "/localfull/darwin-arm64.json", nil)
	res := newRes(newReq(r))
	ok(t, serveLocalFull(res, "/localfull/darwin-arm64.json") && res.status == 200 && strings.Contains(string(res.body), `"sig"`), "문서와 서명을 줌")
	res = newRes(newReq(httptest.NewRequest("GET", "/localfull/darwin-amd64", nil)))
	ok(t, serveLocalFull(res, "/localfull/darwin-amd64") && res.status == 404, "서명과 다른 빌드는 주지 않음")
	ok(t, !serveLocalFull(newRes(newReq(httptest.NewRequest("GET", "/localfull/linux", nil))), "/localfull/linux"), "모르는 이름")
}

// AC-1747: the image runs `localfull-verify` before anything sets ROOT, from another folder: the keys are read from
// the checkout of the documents (<root>/agent/keys.mjs), not left empty (an empty list refuses every build).
func TestLocalFullVerifyReadsKeysOfItsCheckout(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "agent"), 0o700)
	_ = os.MkdirAll(filepath.Join(root, "server"), 0o700)
	_ = os.WriteFile(filepath.Join(root, "agent", "keys.mjs"), []byte("export const UPDATE_KEYS = ['"+base64.StdEncoding.EncodeToString(der)+"']\n"), 0o600)
	builds := t.TempDir()
	docs := map[string]any{"src": "x"}
	for _, a := range LF_ARCHES {
		b := []byte("build of " + a)
		_ = os.WriteFile(filepath.Join(builds, a), b, 0o600)
		doc, sig := lfDoc(key, a, b, 3)
		docs[a] = map[string]string{"doc": doc, "sig": sig}
	}
	jb, _ := json.Marshal(docs)
	docsFile := filepath.Join(root, "server", "localfull.json")
	_ = os.WriteFile(docsFile, jb, 0o600)
	keepRoot, keepKeys := ROOT, lfKeys
	defer func() { ROOT, lfKeys = keepRoot, keepKeys }()
	ROOT, lfKeys = "", updateKeys
	t.Chdir(t.TempDir())
	eq(t, localFullVerify([]string{builds, docsFile}), 0, "문서가 있는 checkout 의 키로 확인")
}

// withLocalServer: a fresh store, run as a Mac's local server on port 4399 with the given agent secret.
func withLocalServer(t *testing.T) (secret string, tickets string) {
	t.Helper()
	withSlotServer(t, "")
	keepLocal, keepSecret, keepTickets, keepPort, keepOrigin, keepUsers, keepAllowed, keepSec := LOCAL, LOCAL_SECRET, LOCAL_TICKETS, PORT, ORIGIN, users, ALLOWED, SECURITY
	t.Cleanup(func() {
		LOCAL, LOCAL_SECRET, LOCAL_TICKETS, PORT, ORIGIN, users, ALLOWED, SECURITY = keepLocal, keepSecret, keepTickets, keepPort, keepOrigin, keepUsers, keepAllowed, keepSec
		localFails = nil
	})
	secret = strings.Repeat("s", 43)
	tickets = filepath.Join(t.TempDir(), "tickets.json")
	LOCAL, LOCAL_SECRET, LOCAL_TICKETS, PORT, ORIGIN, ALLOWED = true, secret, tickets, 4399, "http://127.0.0.1:4399", []string{LOCAL_LOGIN}
	users = newOMap[M]()
	initSecurity()
	withLock(localOwner)
	return
}

// lfTicket: what `agent.mjs local --full open` writes: the SHA-256 of the ticket and when it runs out.
func lfTicket(t *testing.T, file string, exp int64) string {
	t.Helper()
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	tk := base64.RawURLEncoding.EncodeToString(raw)
	h := sha256.Sum256([]byte(tk))
	b, _ := json.Marshal([]any{map[string]any{"h": hex.EncodeToString(h[:]), "exp": exp}})
	_ = os.WriteFile(file, b, 0o600)
	return tk
}

// localDo: one request through the gate and route, as the server's handler does.
func localDo(t *testing.T, method, target, host string, h map[string]string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.Host = host
	for k, v := range h {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	if !localGate(w, r) {
		return w
	}
	req := newReq(r)
	res := newRes(req)
	withLock(func() { route(req, res) })
	res.flush(w, r)
	return w
}

// AC-1748: only this address, an Origin of this address, and a one-time ticket make the owner; the cookie is this
// port's own, HttpOnly and SameSite=Strict.
func TestLocalServerEntry(t *testing.T) {
	_, tickets := withLocalServer(t)
	host := "127.0.0.1:4399"
	jh := map[string]string{"Content-Type": "application/json", "X-Local-UI": "1"}
	ok(t, localDo(t, "GET", "/", "evil.example:4399", nil, "").Code == 403, "다른 Host(리바인딩) 403")
	ok(t, localDo(t, "GET", "/", "127.0.0.1:4300", nil, "").Code == 403, "다른 포트 Host 403")
	for _, o := range []string{"https://bridge.example", "http://127.0.0.1:3000", "null"} {
		ok(t, localDo(t, "POST", "/api/local/login", host, map[string]string{"Content-Type": "application/json", "X-Local-UI": "1", "Origin": o}, `{"ticket":"x"}`).Code == 403, "다른 Origin 403: "+o)
	}
	w := localDo(t, "GET", "/", host, nil, "")
	ok(t, w.Code == 200 && strings.Contains(w.Body.String(), "local --full open"), "로그인 전에는 들어가는 안내")
	ok(t, strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self'") && strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self'"), "로컬 화면의 CSP")
	ok(t, localDo(t, "GET", "/api/sessions", host, nil, "").Code == 401, "토큰 없이 API 401")

	tk := lfTicket(t, tickets, nowMs()+60_000)
	ok(t, localDo(t, "POST", "/api/local/login", host, map[string]string{"Content-Type": "application/json"}, `{"ticket":"`+tk+`"}`).Code == 403, "X-Local-UI 없이 403")
	w = localDo(t, "POST", "/api/local/login", host, jh, `{"ticket":"`+tk+`"}`)
	ok(t, w.Code == 200, "일회용 링크로 로그인", w.Body.String())
	c := w.Header().Get("Set-Cookie")
	ok(t, strings.HasPrefix(c, "__Host-cb-l4399=") && strings.Contains(c, "HttpOnly") && strings.Contains(c, "SameSite=Strict"), "이 포트만의 쿠키: "+c)
	ok(t, localDo(t, "POST", "/api/local/login", host, jh, `{"ticket":"`+tk+`"}`).Code == 403, "같은 링크는 한 번만")
	cookie := strings.SplitN(c, ";", 2)[0]
	var lj struct{ Key string }
	_ = json.Unmarshal(w.Body.Bytes(), &lj)
	ok(t, secretRe.MatchString(lj.Key) && !strings.Contains(c, lj.Key), "머리글 키는 본문으로만", w.Body.String())
	// AC-1757: the cookie alone is not the owner (a program on another port of 127.0.0.1 is sent it too).
	ok(t, localDo(t, "GET", "/api/me", host, map[string]string{"Cookie": cookie}, "").Code == 401, "쿠키만으로는 401")
	ok(t, localDo(t, "GET", "/api/me", host, map[string]string{"Cookie": cookie, "X-Local-Key": strings.Repeat("B", 43)}, "").Code == 401, "틀린 키 401")
	ok(t, localDo(t, "GET", "/api/me", host, map[string]string{"X-Local-Key": lj.Key}, "").Code == 401, "키만으로는 401")
	ok(t, localDo(t, "GET", "/", host, map[string]string{"Cookie": cookie}, "").Body.String() == LOCAL_ENTER, "쿠키만으로는 들어가는 안내")
	me := localDo(t, "GET", "/api/me", host, map[string]string{"Cookie": cookie, "X-Local-Key": lj.Key}, "")
	ok(t, me.Code == 200 && strings.Contains(me.Body.String(), `"local"`), "쿠키와 키로 주인", me.Body.String())
	// The cookie of the same name made by a server on another port of 127.0.0.1 is not this one's.
	ok(t, localDo(t, "GET", "/api/me", host, map[string]string{"Cookie": "__Host-cb=" + strings.SplitN(cookie, "=", 2)[1], "X-Local-Key": lj.Key}, "").Code == 401, "다른 이름의 쿠키는 아님")
	ok(t, localDo(t, "POST", "/api/auth/logout", host, map[string]string{"Cookie": cookie}, "").Code == 401, "쿠키만으로는 로그아웃도 못 함")
	ok(t, localDo(t, "GET", "/api/me", host, map[string]string{"Cookie": cookie, "X-Local-Key": lj.Key}, "").Code == 200, "로그인은 그대로")
	sw := localDo(t, "GET", "/sw.js", host, nil, "")
	ok(t, sw.Code == 200 && strings.Contains(sw.Body.String(), "X-Local-Key") && !strings.Contains(sw.Body.String(), "push"), "로컬 서버의 sw.js 는 키를 붙이는 것")
	ok(t, strings.Contains(sw.Body.String(), "e.request.mode === 'navigate' && e.request.method !== 'GET'"), "GET 아닌 페이지 이동에는 키를 붙이지 않음")

	old := lfTicket(t, tickets, nowMs()-1)
	ok(t, localDo(t, "POST", "/api/local/login", host, jh, `{"ticket":"`+old+`"}`).Code == 403, "시간이 지난 링크 403")
	for i := 0; i < 12; i++ {
		localDo(t, "POST", "/api/local/login", host, jh, `{"ticket":"`+strings.Repeat("A", 43)+`"}`)
	}
	ok(t, localDo(t, "POST", "/api/local/login", host, jh, `{"ticket":"`+strings.Repeat("A", 43)+`"}`).Code == 429, "1분에 10번 넘게 틀리면 429")
}

// AC-1749: the bridge routes take the agent's secret only; the secret opens nothing else; what a local server never
// serves is not there.
func TestLocalServerAgentLink(t *testing.T) {
	secret, tickets := withLocalServer(t)
	host := "127.0.0.1:4399"
	hello := `{"hostId":"0123456789abcdef","name":"mac"}`
	j := map[string]string{"Content-Type": "application/json"}
	ok(t, localDo(t, "POST", "/api/bridge/hello", host, j, hello).Code == 401, "비밀 없이 401")
	ok(t, localDo(t, "POST", "/api/bridge/hello", host, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + strings.Repeat("x", 43)}, hello).Code == 401, "틀린 비밀 401")
	// The owner's sign-in cookie does not make a page the agent.
	tk := lfTicket(t, tickets, nowMs()+60_000)
	w := localDo(t, "POST", "/api/local/login", host, map[string]string{"Content-Type": "application/json", "X-Local-UI": "1"}, `{"ticket":"`+tk+`"}`)
	cookie := strings.SplitN(w.Header().Get("Set-Cookie"), ";", 2)[0]
	ok(t, localDo(t, "POST", "/api/bridge/hello", host, map[string]string{"Content-Type": "application/json", "Cookie": cookie}, hello).Code == 401, "주인 쿠키로는 연동 경로 401")
	w = localDo(t, "POST", "/api/bridge/hello", host, map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + secret}, hello)
	ok(t, w.Code == 200 && strings.Contains(w.Body.String(), `"conn"`), "에이전트 비밀로 연동", w.Body.String())
	ok(t, localDo(t, "GET", "/api/sessions", host, map[string]string{"Authorization": "Bearer " + secret}, "").Code == 401, "비밀로는 다른 API 가 열리지 않음")
	// AC-1756: the agent's challenge, answered with the secret's HMAC (agent/localfull.mjs lfHelloMac) without it.
	n := strings.Repeat("n", 43)
	hw := localDo(t, "GET", "/api/local/hello?n="+n, host, nil, "")
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(LF_HELLO + n))
	ok(t, hw.Code == 200 && strings.Contains(hw.Body.String(), base64.RawURLEncoding.EncodeToString(m.Sum(nil))) && !strings.Contains(hw.Body.String(), secret), "문답: 비밀의 HMAC", hw.Body.String())
	ok(t, localDo(t, "GET", "/api/local/hello?n=short", host, nil, "").Code == 400, "문답: 짧은 n 400")
	for _, p := range []string{"/api/auth/github", "/api/auth/dev", "/install.sh", "/agent.mjs", "/agent/keys.mjs", "/localfull/darwin-arm64", "/api/service/hosts"} {
		ok(t, localDo(t, "GET", p, host, nil, "").Code == 404, "로컬 서버에는 없음: "+p)
	}
}

func TestLocalArgs(t *testing.T) {
	port, data, tickets, root, hours, err := localArgs([]string{"--port", "4327", "--data", "/d", "--tickets", "/t", "--hours", "500"})
	ok(t, err == nil && port == 4327 && data == "/d" && tickets == "/t" && root == "" && hours == 12, "인자")
	_, _, _, _, _, err = localArgs([]string{"--port", "80", "--data", "/d", "--tickets", "/t"})
	ok(t, err != nil, "낮은 포트는 거절")
	_, _, _, _, _, err = localArgs([]string{"--port", "4327", "--data", "/d"})
	ok(t, err != nil, "입장권 파일이 없으면 거절")
}
