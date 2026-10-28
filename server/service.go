package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

// Service API (REQ-F-799): lets a trusted server (autofix) start unattended sessions for one person
// with a static bearer token instead of the browser sign-in. It can do only three things:
// start a session, read the state of the sessions it started itself, and close those.
//
//	POST /api/service/sessions            {host, cwd?, prompt, title?}  -> {ok, id}
//	GET  /api/service/sessions/:id        -> {id, host, state, phase, waitingOn?, answer}
//	POST /api/service/sessions/:id/close  -> {ok, id, state: "closed"}
var (
	SERVICE_TOKEN string // BRIDGE_SERVICE_TOKEN
	SERVICE_UID   string // BRIDGE_SERVICE_UID: whose Macs and sessions the token acts as (e.g. gh12345)
)

var (
	serviceSessionRe = re(`^/api/service/sessions/([a-zA-Z0-9-]+)$`)
	serviceCloseRe   = re(`^/api/service/sessions/([a-zA-Z0-9-]+)/close$`)
)

// serviceAuthOk compares hashes so the check takes the same time whatever the length.
func serviceAuthOk(req *Req) bool {
	if SERVICE_TOKEN == "" || SERVICE_UID == "" {
		return false
	}
	got, ok := strings.CutPrefix(req.H("authorization"), "Bearer ")
	if !ok {
		return false
	}
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(SERVICE_TOKEN))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// serviceUidActive: the account the token acts as still exists and is still allowed, as whoami asks of a sign-in.
func serviceUidActive(uid string) bool {
	u, ok := users.Get(uid)
	return ok && !isDemoUid(uid) && isAllowed(mstr(u, "login"))
}

func serviceAPI(req *Req, res *Res, p string) {
	if !serviceAuthOk(req) {
		refuse(401, "서비스 토큰이 맞지 않아요")
	}
	uid := SERVICE_UID
	// The token acts as this person, so it stops with them: removed from the allow-list or the account gone, the
	// browser sign-in ends at once (whoami) and so does this (REQ-S-085).
	if !serviceUidActive(uid) {
		refuse(403, "서비스 토큰의 계정이 허용돼 있지 않아요")
	}
	if p == "/api/service/sessions" && req.Method == "POST" {
		if !strings.HasPrefix(ctype(req), "application/json") {
			refuse(415, "application/json 만 받습니다")
		}
		b := body(req, 256*1024)
		prompt := jsTrim(strOr(b["prompt"], ""))
		if prompt == "" {
			refuse(400, "prompt 가 비어 있어요")
		}
		name := strings.ToLower(jsTrim(strOr(b["host"], "")))
		target := ""
		for _, id := range hosts.Keys() {
			h := hosts.Val(id)
			if mstr(h, "uid") == uid && (id == b["host"] || strings.ToLower(jsStringU(h["name"])) == name) {
				target = id
				break
			}
		}
		if target == "" {
			refuse(404, "그런 맥이 없어요")
		}
		if !online(target) {
			refuse(409, "맥이 연결돼 있지 않아요")
		}
		cwd := jsTrim(strOr(b["cwd"], ""))
		if cwd == "" {
			L := launchOf(uid)
			cwd = defaultFolder(L["folderBase"], L["folderNoGroup"], nil)
		}
		title := jsTrim(strOr(b["title"], ""))
		if title == "" {
			title = "🤖 " + jsSliceTo(collapse(prompt), 70)
		}
		// No person is watching: permission prompts are answered automatically (autoAllow).
		// AskUserQuestion and calls the guard flags still wait, and show up as state "waiting".
		sid := startSession(uid, M{"hostId": target, "cwd": cwd, "create": true, "prompt": prompt, "title": title, "mode": "autoAllow", "chrome": false}, &Req{internal: true, Header: map[string][]string{}})
		c, _ := sessions.Get(sid)
		c.set("service", true)
		jsonRes(res, 200, M{"ok": true, "id": sid})
		return
	}
	// Only the sessions this API opened for that person, never the person's own.
	own := func(sid string) *Sess {
		c, ok := sessions.Get(sid)
		if !ok || c.uid() != uid || !truthy(c.get("service")) {
			refuse(404, "세션이 없습니다")
		}
		return c
	}
	if m := serviceSessionRe.FindStringSubmatch(p); m != nil && req.Method == "GET" {
		c := own(m[1])
		out := M{"id": c.id(), "host": ""}
		if h, ok := hosts.Get(c.host()); ok && h["name"] != nil {
			out["host"] = h["name"]
		}
		for k, v := range delegateState(c, 0) {
			out[k] = v
		}
		jsonRes(res, 200, out)
		return
	}
	// The caller is done with it: claude stops on the Mac and frees its memory (REQ-F-799, IF-253). Closing twice is fine.
	if m := serviceCloseRe.FindStringSubmatch(p); m != nil && req.Method == "POST" {
		c := own(m[1])
		if !truthy(c.get("closed")) {
			closeSession(c, "종료(서비스 API)")
			broadcastState(uid)
		}
		jsonRes(res, 200, M{"ok": true, "id": c.id(), "state": "closed"})
		return
	}
	refuse(404, "없는 경로예요")
}
