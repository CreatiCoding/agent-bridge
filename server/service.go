package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

// Service API (REQ-F-799): lets a trusted server (autofix) start unattended sessions for one person
// with a static bearer token instead of the browser sign-in. It can do only two things:
// start a session and read the state of the sessions it started itself.
//
//	POST /api/service/sessions      {host, cwd?, prompt, title?}  -> {ok, id}
//	GET  /api/service/sessions/:id  -> {id, host, state, phase, waitingOn?, answer}
var (
	SERVICE_TOKEN string // BRIDGE_SERVICE_TOKEN
	SERVICE_UID   string // BRIDGE_SERVICE_UID: whose Macs and sessions the token acts as (e.g. gh12345)
)

var serviceSessionRe = re(`^/api/service/sessions/([a-zA-Z0-9-]+)$`)

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

func serviceAPI(req *Req, res *Res, p string) {
	if !serviceAuthOk(req) {
		refuse(401, "서비스 토큰이 맞지 않아요")
	}
	uid := SERVICE_UID
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
	if m := serviceSessionRe.FindStringSubmatch(p); m != nil && req.Method == "GET" {
		c, ok := sessions.Get(m[1])
		if !ok || c.uid() != uid || !truthy(c.get("service")) {
			refuse(404, "세션이 없습니다")
		}
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
	refuse(404, "없는 경로예요")
}
