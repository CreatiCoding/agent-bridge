package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var ghClient = &http.Client{Timeout: 30 * time.Second}

// fetchJSON: a request whose answer is JSON, with the lock let go meanwhile.
func fetchJSON(method, u string, headers map[string]string, body []byte) (any, error) {
	var out any
	var err error
	await(func() {
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, e := http.NewRequest(method, u, rd)
		if e != nil {
			err = e
			return
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		r, e := ghClient.Do(req)
		if e != nil {
			err = e
			return
		}
		defer r.Body.Close()
		b, e := io.ReadAll(r.Body)
		if e != nil {
			err = e
			return
		}
		out, err = parseJSON(b)
	})
	return out, err
}

// appleAuth — Apple로 로그인 (REQ-F-772), from the iOS app (web/apple-login.js).
func appleAuth(req *Req, res *Res, u *url.URL) {
	if req.Method != "POST" {
		res.WriteHead(405).End()
		return
	}
	if !sameSite(req) {
		res.WriteHead(403).End()
		return
	}
	if u.Path == "/api/auth/apple/nonce" {
		raw := base64.RawURLEncoding.EncodeToString(randBytes(24))
		jsonRes(res, 200, M{"nonce": sha256hex(raw)}, M{"Set-Cookie": cookie(req, cname(req, "cb_apple"), raw, 600)})
		return
	}
	clear := cookie(req, cname(req, "cb_apple"), "", 0)
	html := func(status int, title, text string) {
		res.WriteHead(status, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clear}).EndS(page(title, text))
	}
	f, _ := url.ParseQuery(string(rawBody(req, 16*1024)))
	raw := cookies(req)[cname(req, "cb_apple")]
	now := nowMs()
	for k, exp := range appleUsed {
		if exp < now {
			delete(appleUsed, k)
		}
	}
	var claims M
	err := try(func() {
		if raw == "" || appleUsed[sha256hex(raw)] != 0 {
			panic(&AppleTokenError{"로그인 요청이 만료됐습니다"})
		}
		claims = verifyIdentityToken(qget(f, "token"), APPLE_CLIENT_ID, sha256hex(raw), appleKeyOf)
	})
	if err != nil {
		var ate *AppleTokenError
		isTok := errors.As(err, &ate)
		if !isTok {
			logLine("apple sign-in: keys: " + err.Error())
		}
		logLine("apple sign-in refused: " + err.Error())
		if isTok {
			html(401, "Apple 로그인에 실패했습니다", escHtml(err.Error())+". 앱에서 다시 시도해 주세요.")
		} else {
			html(502, "Apple 로그인에 실패했습니다", "Apple 의 서명 키를 받아 오지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
		}
		return
	}
	appleUsed[sha256hex(raw)] = now + 600_000
	uid, login := appleIds(mstr(claims, "sub"))
	// The name comes once, at the first sign-in; the e-mail (often Apple's relay address) comes every time.
	given := jsSliceTo(jsTrim(qget(f, "name")), 80)
	name := given
	if name == "" {
		name = mstr(users.Val(uid), "name")
	}
	if name == "" {
		name = mstr(access.Val(login), "name")
	}
	if name == "" {
		name = mstr(claims, "email")
	}
	if name == "" {
		name = "Apple 사용자"
	}
	if !isAllowed(login) {
		a := requestAccess(login, name, "")
		if a["status"] == "denied" {
			html(403, "허용되지 않은 계정입니다", "Apple 계정 <b>"+escHtml(name)+"</b> 은 이 서버를 쓸 수 없습니다.")
		} else {
			res.WriteHead(403, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clear}).EndS(pendingPage(name, demoOn, true))
		}
		return
	}
	users.Set(uid, M{"login": login, "name": name, "avatar": "", "apple": true})
	// Kept so that deleting the account can revoke it (REQ-F-770); the code is good for five minutes, so only now.
	if code := qget(f, "code"); apple != nil && code != "" {
		var refresh string
		e := try(func() { refresh = apple.refreshToken(code) })
		if e != nil {
			logLine("apple sign-in: " + login + ": token: " + e.Error())
		} else if refresh != "" {
			writeJson(filepath.Join(userDir(uid), "apple.json"), M{"refresh": refresh})
		} else {
			logLine("apple sign-in: " + login + ": no refresh token")
		}
	}
	logLine("apple sign-in: " + login)
	signIn(req, res, uid, "/", []string{clear})
}

// qget is Object.fromEntries(new URLSearchParams(…))[k]: the last value given.
func qget(q url.Values, k string) string {
	v := q[k]
	if len(v) == 0 {
		return ""
	}
	return v[len(v)-1]
}

var qrPathRe = regexp.MustCompile(`^/api/auth/qr/([a-f0-9]{32})$`)
var htmlTagChars = regexp.MustCompile(`[<>&]`)
var devLoginRe = regexp.MustCompile(`[^a-zA-Z0-9-]`)

// encodeURIComponent, as JavaScript writes it.
func encodeURIComponent(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	for _, c := range []string{"!", "'", "(", ")", "*"} {
		e = strings.ReplaceAll(e, url.QueryEscape(c), c)
	}
	return e
}

func auth(req *Req, res *Res, u *url.URL) {
	if limited(req, 0, "") {
		res.WriteHead(429).EndS("too many requests")
		return
	}
	q := u.Query()
	switch {
	case u.Path == "/api/auth/github":
		if GITHUB_CLIENT_ID == "" {
			res.WriteHead(503, M{"Content-Type": "text/html; charset=utf-8"}).EndS(page("GitHub 로그인이 설정되지 않았습니다", "서버에 GITHUB_CLIENT_ID 와 GITHUB_CLIENT_SECRET 을 넣어 주세요."))
			return
		}
		state := randHex(16)
		v := url.Values{}
		to := "https://github.com/login/oauth/authorize?" + "client_id=" + url.QueryEscape(GITHUB_CLIENT_ID) + "&redirect_uri=" + url.QueryEscape(originOf(req)+"/api/auth/github/callback") + "&state=" + state + "&allow_signup=false"
		_ = v
		res.WriteHead(302, M{"Location": to, "Set-Cookie": cookie(req, cname(req, "cb_state"), state+"."+encodeURIComponent(safeNext(nilIfEmpty(q, "next"))), 600)}).End()
		return
	case u.Path == "/api/auth/github/callback":
		parts := strings.Split(cookies(req)[cname(req, "cb_state")], ".")
		state := parts[0]
		next := ""
		if len(parts) > 1 {
			next = parts[1]
		}
		html := func(status int, title, text string) {
			res.WriteHead(status, M{"Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(req, cname(req, "cb_state"), "", 0)}).EndS(page(title, text))
		}
		if state == "" || nilIfEmpty(q, "state") != any(state) {
			html(400, "로그인을 다시 시도해 주세요", "로그인 요청이 만료됐거나 맞지 않습니다.")
			return
		}
		tok, err := fetchJSON("POST", "https://github.com/login/oauth/access_token", map[string]string{"Accept": "application/json", "Content-Type": "application/json"}, jsonBytes(M{"client_id": GITHUB_CLIENT_ID, "client_secret": GITHUB_CLIENT_SECRET, "code": nilIfEmpty(q, "code"), "redirect_uri": originOf(req) + "/api/auth/github/callback"}))
		if err != nil {
			panic(err)
		}
		at := mget(tok, "access_token")
		if !truthy(at) {
			html(502, "GitHub 로그인에 실패했습니다", "GitHub 가 토큰을 주지 않았습니다. 다시 시도해 주세요.")
			return
		}
		ghv, err := fetchJSON("GET", "https://api.github.com/user", map[string]string{"Authorization": "Bearer " + jsString(at), "User-Agent": "claude-bridge", "Accept": "application/vnd.github+json"}, nil)
		if err != nil {
			panic(err)
		}
		gh := asM(ghv)
		if !truthy(gh["login"]) || !truthy(gh["id"]) {
			html(502, "GitHub 로그인에 실패했습니다", "GitHub 계정 정보를 읽지 못했습니다.")
			return
		}
		login := jsString(gh["login"])
		ghID := "gh" + jsString(gh["id"])
		// The name another GitHub account signed in with first stays that account's (R1-L1).
		if holder := heldBy(pins, ghID, login); holder != "" {
			logLine("login refused: " + login + " is held by " + holder + ", not " + ghID)
			k := strings.ToLower(login)
			a, ok := access.Get(k)
			if !ok {
				a = M{"login": login, "status": "pending", "firstAt": float64(nowMs()), "attempts": 0.0}
				access.Set(k, a)
			}
			nm := gh["name"]
			if !truthy(nm) {
				nm = login
			}
			av := gh["avatar_url"]
			if !truthy(av) {
				av = ""
			}
			a["heldBy"] = holder
			a["heldAttempt"] = M{"id": ghID, "name": nm, "avatar": av, "at": float64(nowMs())}
			touchGlobals()
			html(403, "다른 계정이 쓰던 이름입니다", "GitHub 계정 <b>"+htmlTagChars.ReplaceAllString(login, "")+"</b> 은 이 서버에서 다른 GitHub 계정이 먼저 쓰던 이름이라 로그인할 수 없습니다. 운영자에게 알려 주세요.")
			return
		}
		if !isAllowed(login) {
			a := requestAccess(login, orStr(gh["name"]), orStr(gh["avatar_url"]))
			who := "GitHub 계정 <b>" + htmlTagChars.ReplaceAllString(login, "") + "</b>"
			if a["status"] == "denied" {
				html(403, "허용되지 않은 계정입니다", who+" 은 이 서버를 쓸 수 없습니다.")
			} else {
				res.WriteHead(403, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": cookie(req, cname(req, "cb_state"), "", 0)}).EndS(pendingPage(login, demoOn, false))
			}
			return
		}
		claimLogin(pins, ghID, login)
		name := orStr(gh["name"])
		if name == "" {
			name = login
		}
		users.Set(ghID, M{"login": login, "name": name, "avatar": orStr(gh["avatar_url"])})
		if next == "" {
			next = "/"
		}
		dec, err := url.PathUnescape(next)
		if err != nil {
			throw("URI malformed")
		}
		signIn(req, res, ghID, safeNext(dec), nil)
		return
	case u.Path == "/api/auth/apple/nonce" || u.Path == "/api/auth/apple":
		appleAuth(req, res, u)
		return
	}
	if qr := qrPathRe.FindStringSubmatch(u.Path); qr != nil {
		key := sha256hexs(qr[1])
		entry := qrCodes[key]
		// Opening the address only asks (R1-L14); saying yes is a form post from this page.
		current := whoami(req)
		eu := mstr(entry, "uid")
		if entry != nil && jsNumber(entry["exp"]) >= float64(nowMs()) && users.Has(eu) && !truthy(entry["headless"]) && current != eu {
			if req.Method != "POST" {
				who := escHtml(mstr(users.Val(eu), "login"))
				var text, title, button string
				if current != "" {
					text = "지금 <b>" + escHtml(mstr(users.Val(current), "login")) + "</b> 로 로그인돼 있어요. 이 QR 코드는 <b>" + who + "</b> 의 것이에요. 바꾸면 이 브라우저는 그 계정으로 로그인돼요. 직접 만든 QR 코드가 아니면 바꾸지 마세요."
					title = "다른 계정으로 로그인할까요?"
					button = who + " 로 바꾸기"
				} else {
					text = "이 QR 코드는 <b>" + who + "</b> 의 것이에요. 로그인하면 이 브라우저에서 그 계정의 세션을 다룰 수 있어요. 직접 만든 QR 코드가 아니면 로그인하지 마세요."
					title = who + " 로 로그인할까요?"
					button = "로그인"
				}
				res.WriteHead(200, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}).EndS(page(title, text+`</p><form method="post"><button type="submit">`+button+`</button></form><p>`))
				return
			}
			if !req.Has("origin") || req.H("origin") != originOf(req) {
				res.WriteHead(403).End()
				return
			}
		}
		delete(qrCodes, key)
		if entry == nil || jsNumber(entry["exp"]) < float64(nowMs()) || !users.Has(eu) || !isAllowed(mstr(users.Val(eu), "login")) {
			res.WriteHead(410, M{"Content-Type": "text/html; charset=utf-8"}).EndS(page("QR 코드를 쓸 수 없습니다", "만료됐거나 이미 한 번 쓰인 코드입니다. 컴퓨터 화면에서 폰 아이콘을 다시 눌러 새 코드를 받아 주세요."))
			return
		}
		logLine("qr sign-in: " + mstr(users.Val(eu), "login"))
		next := "/"
		if n, ok := entry["next"].(string); ok {
			next = n
		} else if truthy(entry["sid"]) {
			next = "/s/" + jsString(entry["sid"])
		}
		signIn(req, res, eu, next, nil)
		return
	}
	if u.Path == "/api/auth/demo" {
		// 공개 데모 (REQ-F-766): one press, no id or password, into a demo of the visitor's own.
		if !demoOn {
			res.WriteHead(404).End()
			return
		}
		if req.Method != "POST" {
			res.WriteHead(405).End()
			return
		}
		origin := req.H("origin")
		if !(req.Has("origin") && origin == originOf(req)) && !((!req.Has("origin") || origin == "" || origin == "null") && req.H("sec-fetch-site") == "same-origin") {
			res.WriteHead(403).End()
			return
		}
		html := func(status int, text string) {
			res.WriteHead(status, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}).EndS(page("데모로 둘러보기", text))
		}
		if demoTooMany(clientIp(req)) {
			html(429, "데모는 한 곳에서 1시간에 "+itoa(DEMO_PER_IP_HOUR)+"번까지 열 수 있어요. 잠시 뒤에 다시 해 주세요.")
			return
		}
		uid := newDemoUid()
		if !demoOpen(uid) {
			html(503, "지금 데모를 쓰는 사람이 많아요. 잠시 뒤에 다시 해 주세요.")
			return
		}
		demoTrimLogins()
		logLine("demo: " + uid)
		signIn(req, res, uid, "/", nil)
		return
	}
	if u.Path == "/api/auth/dev" && DEV_LOGIN {
		l := q.Get("login")
		if l == "" {
			l = "dev"
		}
		login := devLoginRe.ReplaceAllString(l, "")
		if !isAllowed(login) {
			res.WriteHead(403).EndS("not allowed (" + jsStringU(requestAccess(login, "", "")["status"]) + ")")
			return
		}
		users.Set("dev-"+login, M{"login": login, "name": login, "avatar": ""})
		signIn(req, res, "dev-"+login, safeNext(nilIfEmpty(q, "next")), nil)
		return
	}
	if u.Path == "/api/auth/logout" && req.Method == "POST" {
		if req.Has("origin") && req.H("origin") != "" && req.H("origin") != originOf(req) {
			refuse(403, "다른 출처의 요청입니다")
		}
		logins.Delete(sha256hexs(sessionToken(req)))
		touchGlobals()
		jsonRes(res, 200, M{"ok": true}, M{"Set-Cookie": append([]string{cookie(req, cname(req, "cb"), "", 0)}, legacyCbClears(req)...)})
		return
	}
	res.WriteHead(404).End()
}

// openStream: an event stream. no-transform and identity keep proxies from compressing it.
func openStream(req *Req, res *Res, onClose func()) *Stream {
	res.WriteHead(200, M{"Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Content-Encoding": "identity", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
	s := newStream(onClose)
	res.stream = s
	res.ended = true
	s.Write(": ok\n\n")
	return s
}
