package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const PROXY = "auth:\n  providers:\n    - type: trusted-header\n      userHeader: X-Auth-Request-Email\n      secretHeader: X-Bridge-Proxy-Secret\n      secret: proxy-secret-0123456789\n      trustFrom: [10.0.0.0/8, 192.0.2.7]\n"

// routeAt runs one request through route() from a peer address, and gives the answer.
func routeAt(t *testing.T, method, target, peer string, h map[string]string) (int, http.Header, string) {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	r.RemoteAddr = peer
	for k, v := range h {
		r.Header.Set(k, v)
	}
	req := newReq(r)
	res := newRes(req)
	withLock(func() { route(req, res) })
	hd := http.Header{}
	for k, v := range res.header {
		hd[k] = v
	}
	return res.status, hd, string(res.body)
}

// withSlotServer: a server with a fresh store and the given bridge.yaml.
func withSlotServer(t *testing.T, yaml string) {
	t.Helper()
	_ = withConfigServer(t)
	keepL, keepAl, keepO, keepP, keepAc, keepH, keepHo := logins, ALLOWED, ORIGIN, preview, access, hosts, handover
	t.Cleanup(func() {
		logins, ALLOWED, ORIGIN, preview, access, hosts, handover = keepL, keepAl, keepO, keepP, keepAc, keepH, keepHo
	})
	logins = newOMap[M]()
	hosts = newOMap[M]()
	handover = &Handover{id: "test"}
	access = newOMap[M]()
	preview = &Preview{}
	withCfg(t, yaml)
	ORIGIN = cfgGet("origins.primary").(string)
}

func TestProvidersRead(t *testing.T) {
	withCfg(t, PROXY)
	p := headerProvider()
	ok(t, p != nil && p.UserHeader == "X-Auth-Request-Email" && len(p.TrustFrom) == 2, "제공자 하나")
	eq(t, strings.Join(p.TrustText, ","), "10.0.0.0/8,192.0.2.7")
	bad := []struct{ src, has string }{
		{"auth:\n  providers:\n    - type: oidc\n", "모르는 제공자"},
		{"auth:\n  providers:\n    - type: trusted-header\n      userHeader: X-A\n      secretHeader: X-B\n      secret: short\n      trustFrom: [10.0.0.0/8]\n", "16자 이상"},
		{"auth:\n  providers:\n    - type: trusted-header\n      userHeader: X-A\n      secretHeader: X-B\n      secret: proxy-secret-0123456789\n", "trustFrom 이 없습니다"},
		{"auth:\n  providers:\n    - type: trusted-header\n      userHeader: X-A\n      secretHeader: X-B\n      secret: proxy-secret-0123456789\n      trustFrom: [10.0.0.300/8]\n", "IP 주소나 CIDR"},
		{"auth:\n  providers:\n    - type: trusted-header\n      userHeader: Cookie\n      secretHeader: X-B\n      secret: proxy-secret-0123456789\n      trustFrom: [10.0.0.0/8]\n", "헤더 이름"},
		{"auth:\n  providers:\n    - type: trusted-header\n      userHeader: X-A\n      secretHeader: x-a\n      secret: proxy-secret-0123456789\n      trustFrom: [10.0.0.0/8]\n", "달라야"},
		{"auth:\n  providers:\n    - type: trusted-header\n      nope: 1\n", "모르는 키 auth.providers[].nope"},
		{PROXY + "    - type: trusted-header\n      userHeader: X-A\n      secretHeader: X-B\n      secret: proxy-secret-0123456789\n      trustFrom: [10.0.0.0/8]\n", "하나만"},
		{"origins:\n  primary: https://a.example\n  extra: [https://b.example]\n", "trusted-header 가 있어야"},
		{"origins:\n  extra: [https://b.example]\n" + PROXY, "origins.primary(또는 BRIDGE_ORIGIN)"},
		{"origins:\n  primary: https://a.example\n  extra: [https://A.example/]\n" + PROXY, "같은 호스트"},
		{"origins:\n  primary: https://a.example\n  extra: [https://b.example/path]\n" + PROXY, "경로 없이"},
	}
	for _, c := range bad {
		_, err := parseBridgeConfig("/x/bridge.yaml", []byte(c.src), envMap(nil))
		if err == nil || !strings.Contains(err.Error(), c.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", c.src, c.has, err)
		}
		if err != nil && strings.Contains(err.Error(), "proxy-secret") {
			t.Errorf("오류 문구에 비밀값: %v", err)
		}
	}
	// The secret may come from the environment.
	c, err := parseBridgeConfig("/x/bridge.yaml", []byte(strings.Replace(PROXY, "proxy-secret-0123456789", "${PROXY_SECRET}", 1)), envMap(map[string]string{"PROXY_SECRET": "from-env-0123456789"}))
	ok(t, err == nil && c.set["auth.providers"].v.([]authProvider)[0].Secret == "from-env-0123456789", "환경변수에서 비밀값")
}

func TestProviderOf(t *testing.T) {
	eq(t, providerOf(headerUid("me@example.com")), "trusted-header")
	ap, _ := appleIds("sub")
	eq(t, providerOf(ap), "apple")
	eq(t, providerOf("12345"), "github")
	eq(t, providerOf("dev-me"), "dev")
	ok(t, isHeaderLogin("Me.Name+x@Example.co.kr") && !isHeaderLogin("boss") && !isHeaderLogin("apple_0123456789") && !isHeaderLogin("a@b"), "이메일만")
}

// AC-1480: the proxy's header signs the person in only with the secret and from trustFrom; the header wins over a
// cookie of someone else; an address that is no e-mail is 401; a person not allowed is not signed in.
func TestHeaderSignIn(t *testing.T) {
	withSlotServer(t, PROXY+"  allow: [me@example.com]\n")
	ALLOWED = cfgGet("auth.allow").([]string)
	good := map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "Me@Example.com"}
	code, h, body := routeAt(t, "GET", "/api/me", "10.1.2.3:5555", good)
	eq(t, code, 200, body)
	ok(t, strings.Contains(body, `"login":"me@example.com"`), body)
	ok(t, strings.Contains(strings.Join(h.Values("Set-Cookie"), ";"), "cb="), "쿠키 발급")
	ok(t, users.Has(headerUid("me@example.com")), "사용자가 생김")

	// The same person with the cookie: no second cookie.
	tok := strings.TrimPrefix(strings.Split(h.Values("Set-Cookie")[0], ";")[0], "cb=")
	withCookie := map[string]string{"Cookie": "cb=" + tok}
	for k, v := range good {
		withCookie[k] = v
	}
	_, h2, _ := routeAt(t, "GET", "/api/me", "10.1.2.3:5555", withCookie)
	eq(t, len(h2.Values("Set-Cookie")), 0, "이미 있으면 다시 주지 않음")
	// The cookie alone still works (not header-only).
	code, _, _ = routeAt(t, "GET", "/api/me", "203.0.113.9:1", map[string]string{"Cookie": "cb=" + tok})
	eq(t, code, 200)

	for _, c := range []struct {
		peer string
		h    map[string]string
	}{
		{"203.0.113.9:1", good},
		{"10.1.2.3:1", map[string]string{"X-Bridge-Proxy-Secret": "wrong-secret-0123456789", "X-Auth-Request-Email": "me@example.com"}},
		{"10.1.2.3:1", map[string]string{"X-Auth-Request-Email": "me@example.com"}},
	} {
		code, _, _ := routeAt(t, "GET", "/api/me", c.peer, c.h)
		eq(t, code, 401, "믿지 않는 요청은 헤더를 보지 않음: "+c.peer)
	}
	// X-Forwarded-For does not make a peer trusted.
	xf := map[string]string{"X-Forwarded-For": "10.1.2.3"}
	for k, v := range good {
		xf[k] = v
	}
	code, _, _ = routeAt(t, "GET", "/api/me", "203.0.113.9:1", xf)
	eq(t, code, 401)

	code, _, body = routeAt(t, "GET", "/api/me", "192.0.2.7:1", map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "boss"})
	eq(t, code, 401, body)
	ok(t, strings.Contains(body, "이메일 주소가 아니에요"), body)

	// Someone else's cookie with the proxy's header: the header's person, not the cookie's.
	users.Set("gh9", M{"login": "boss"})
	ALLOWED = append(ALLOWED, "boss")
	other := newSignIn("gh9")
	both := map[string]string{"Cookie": "cb=" + other}
	for k, v := range good {
		both[k] = v
	}
	_, _, body = routeAt(t, "GET", "/api/me", "10.9.9.9:1", both)
	ok(t, strings.Contains(body, `"login":"me@example.com"`), body)

	// Not allowed: no sign-in.
	code, h, _ = routeAt(t, "GET", "/api/me", "10.1.2.3:1", map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "stranger@example.com"})
	ok(t, code == 401 && len(h.Values("Set-Cookie")) == 0, "허용 안 된 사람은 쿠키 없음")
	// Opening the site asks the operator for access, as a GitHub sign-in does.
	code, _, body = routeAt(t, "GET", "/", "10.1.2.3:1", map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "stranger@example.com"})
	ok(t, code == 403 && strings.Contains(body, "사내 로그인") && !strings.Contains(body, "/api/auth/github"), body)
	eq(t, mstr(access.Val("stranger@example.com"), "status"), "pending")
}

// AC-1481: with origins.extra the Host picks the request's origin; another Host is 421; the service API and
// /api/health are not checked; a page at the extra origin does not link Macs.
func TestOriginsExtra(t *testing.T) {
	withSlotServer(t, "origins:\n  primary: https://a.example\n  extra: [https://b.example]\n"+PROXY+"  allow: [me@example.com]\n")
	ALLOWED = cfgGet("auth.allow").([]string)
	good := map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "me@example.com"}
	hostAt := func(host string) map[string]string {
		m := map[string]string{"Host": host}
		for k, v := range good {
			m[k] = v
		}
		return m
	}
	code, h, body := routeAt(t, "GET", "/api/me", "10.0.0.1:1", hostAt("b.example"))
	eq(t, code, 200, body)
	ok(t, strings.Contains(body, `"origin":"https://b.example"`) && strings.Contains(body, `"linkHere":false`), body)
	ok(t, strings.Contains(h.Values("Set-Cookie")[0], "__Host-cb="), "그 출처의 쿠키")
	code, _, body = routeAt(t, "GET", "/api/me", "10.0.0.1:1", hostAt("a.example"))
	ok(t, code == 200 && !strings.Contains(body, "linkHere"), body)
	code, _, _ = routeAt(t, "GET", "/api/me", "10.0.0.1:1", hostAt("evil.example"))
	eq(t, code, 421)
	code, _, _ = routeAt(t, "GET", "/api/health", "10.0.0.1:1", map[string]string{"Host": "evil.example"})
	eq(t, code, 200, "health 는 검사 앞")
	code, _, _ = routeAt(t, "POST", "/api/service/sessions", "172.17.0.5:1", map[string]string{"Host": "bridge:4300"})
	ok(t, code != 421, "서비스 API 는 Host 를 보지 않음")
	hello := hostAt("b.example")
	hello["Content-Type"] = "application/json"
	code, _, body = routeAt(t, "POST", "/api/bridge/hello", "10.0.0.1:1", hello)
	ok(t, code == 403 && strings.Contains(body, "연동하지 않아요"), body)
	// The Origin check uses the request's own origin.
	po := hostAt("b.example")
	po["Origin"] = "https://a.example"
	code, _, _ = routeAt(t, "POST", "/api/prefs/voice", "10.0.0.1:1", po)
	eq(t, code, 403, "다른 출처")
}

// Without the keys nothing looks at the Host or the headers.
func TestSlotsOffByDefault(t *testing.T) {
	withSlotServer(t, "")
	code, _, _ := routeAt(t, "GET", "/api/me", "10.0.0.1:1", map[string]string{"Host": "anything.example", "X-Auth-Request-Email": "me@example.com"})
	eq(t, code, 401)
}

// During a handover the old instance signs the peer it saw; the new one trusts only that, and only when told.
func TestPeerHeaderAcrossHandover(t *testing.T) {
	mk := func(h map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		for k, v := range h {
			r.Header.Set(k, v)
		}
		return r
	}
	r := mk(map[string]string{PEER_HEADER: "10.0.0.1:1", PEER_SIG_HEADER: peerSig("s", "10.0.0.1:1"), PEER_OK_HEADER: "10.0.0.1:1"})
	acceptPeer(r, false, "s", true)
	eq(t, r.Header.Get(PEER_OK_HEADER), "", "손님이 보낸 헤더는 버림")
	r = mk(map[string]string{PEER_HEADER: "10.0.0.1:1", PEER_SIG_HEADER: peerSig("s", "10.0.0.1:1")})
	acceptPeer(r, true, "s", false)
	eq(t, r.Header.Get(PEER_OK_HEADER), "", "옛 인스턴스가 서명한다고 하지 않으면 버림")
	r = mk(map[string]string{PEER_HEADER: "10.0.0.1:1", PEER_SIG_HEADER: peerSig("x", "10.0.0.1:1")})
	acceptPeer(r, true, "s", true)
	eq(t, r.Header.Get(PEER_OK_HEADER), "", "서명이 틀리면 버림")
	r = mk(map[string]string{PEER_HEADER: "10.0.0.1:1", PEER_SIG_HEADER: peerSig("s", "10.0.0.1:1")})
	acceptPeer(r, true, "s", true)
	eq(t, r.Header.Get(PEER_OK_HEADER), "10.0.0.1:1")
	ok(t, r.Header.Get(PEER_HEADER) == "" && r.Header.Get(PEER_SIG_HEADER) == "")
	req := newReq(r)
	req.remote = "127.0.0.1:9"
	eq(t, peerIP(req).String(), "10.0.0.1")
}

// The access page takes an e-mail address when sign-in by header is on; skills need a GitHub account.
func TestHeaderLoginElsewhere(t *testing.T) {
	withSlotServer(t, PROXY)
	ok(t, githubLoginOf(headerUid("me@example.com")) == nil)
	users.Set(headerUid("me@example.com"), M{"login": "me@example.com"})
	ok(t, githubLoginOf(headerUid("me@example.com")) == nil, "헤더 사용자는 GitHub 이름이 없음")
	code, body := callAPI(t, "POST", "/api/admin/access", `{"login":"Me@Example.com","status":"allowed"}`)
	eq(t, code, 200, body)
	ok(t, isAllowed("me@example.com"))
}

// AC-1482: header-only closes every other way in; a cookie alone is not taken; the headless link and QR sign-in
// are off (turning the headless link off stays open); the check lists the hosts to turn off first.
func TestHeaderOnly(t *testing.T) {
	_, err := parseBridgeConfig("/x/bridge.yaml", []byte("auth:\n  headerOnly: true\n"), envMap(nil))
	ok(t, err != nil && strings.Contains(err.Error(), "trusted-header 가 있어야"), "제공자 없이 headerOnly")

	withSlotServer(t, PROXY+"  headerOnly: true\n  allow: [me@example.com]\n")
	ALLOWED = cfgGet("auth.allow").([]string)
	good := map[string]string{"X-Bridge-Proxy-Secret": "proxy-secret-0123456789", "X-Auth-Request-Email": "me@example.com"}
	code, h, body := routeAt(t, "GET", "/api/me", "10.0.0.1:1", good)
	eq(t, code, 200, body)
	ok(t, strings.Contains(body, `"background":false`), body)
	tok := strings.TrimPrefix(strings.Split(h.Values("Set-Cookie")[0], ";")[0], "cb=")

	code, _, body = routeAt(t, "GET", "/api/me", "203.0.113.1:1", map[string]string{"Cookie": "cb=" + tok})
	ok(t, code == 401 && strings.Contains(body, `"headerOnly":true`), "쿠키만으로는 안 됨: "+body)
	for _, p := range []string{"/api/auth/github", "/api/auth/demo", "/api/auth/dev", "/api/auth/qr/0123456789abcdef0123456789abcdef", "/api/auth/apple/nonce"} {
		code, _, _ = routeAt(t, "GET", p, "10.0.0.1:1", good)
		eq(t, code, 404, p)
	}
	code, _, _ = routeAt(t, "POST", "/api/auth/logout", "10.0.0.1:1", good)
	ok(t, code != 404, "로그아웃은 열림")
	code, _, body = routeAt(t, "GET", "/", "203.0.113.1:1", nil)
	ok(t, code == 401 && strings.Contains(body, "프록시를 거쳐") && !strings.Contains(body, "/api/auth/github"), body)
	code, _, body = routeAt(t, "GET", "/settings", "203.0.113.1:1", nil)
	ok(t, code == 401 && strings.Contains(body, "프록시를 거쳐"), "로그인 리다이렉트 대신 안내")

	hosts.Set("h1", M{"uid": "gh1", "name": "mac"})
	code, body = callAPI(t, "POST", "/api/qr", `{"headless":true}`)
	eq(t, code, 403, body)
	code, _ = callAPI(t, "POST", "/api/hosts/h1/background", `{"on":true}`)
	eq(t, code, 409)
	code, _ = callAPI(t, "POST", "/api/hosts/h1/heal", `{"action":"background-restart"}`)
	eq(t, code, 409)
	code, _ = callAPI(t, "POST", "/api/hosts/h1/background", `{"on":false}`)
	eq(t, code, 409, "끄기는 막지 않음(연결이 없어 409, 문구는 끄라는 안내)")
}

func TestHeaderOnlyHosts(t *testing.T) {
	rows := headerOnlyHosts([]M{
		{"name": "on", "lastBackground": M{"on": true, "at": 5.0}},
		{"name": "off", "lastBackground": M{"on": false, "at": 5.0}},
		{"name": "never", "lastSeen": 3.0},
		{"name": "box", "kind": "server", "lastBackground": M{"on": false, "at": 5.0}},
	})
	names := []string{}
	for _, r := range rows {
		names = append(names, jsString(r.(orderedObj)[0].V)+":"+jsString(r.(orderedObj)[2].V))
	}
	eq(t, strings.Join(names, ","), "on:on,never:unknown,box:server")

	withSlotServer(t, PROXY)
	hosts.Set("h1", M{"uid": "gh1", "name": "mac", "lastBackground": M{"on": true, "at": 1.0}})
	chk := checkText("/x/bridge.yaml", []byte(PROXY+"  headerOnly: true\n"), envMap(nil), nil)
	ok(t, chk["ok"] == true && len(asArr(chk["headerOnlyHosts"])) == 1, string(jsonBytes(chk)))
	chk = checkText("/x/bridge.yaml", []byte(PROXY), envMap(nil), nil)
	ok(t, chk["headerOnlyHosts"] == nil, "켜지 않는 파일은 목록 없음")
}
