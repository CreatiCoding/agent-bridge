package main

import (
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var apiImgRe = regexp.MustCompile(`^/api/img/([0-9a-f]{40}\.(png|jpg|gif|webp))$`)
var apiSkillsRe = regexp.MustCompile(`^/api/skills(?:/([a-z0-9-]+))?$`)

func qstr(u *url.URL, k string) string { return u.Query().Get(k) }

// qnil is searchParams.get(k) as a value: nil when it is not there.
func qnil(u *url.URL, k string) any { return nilIfEmpty(u.Query(), k) }

// api: every route of a signed-in person, in the order server.mjs tried them.
func api(req *Req, res *Res, u *url.URL, uid string) {
	for _, h := range []func(*Req, *Res, *url.URL, string) bool{apiMisc, apiBridge, apiControl, apiHosts, apiAdmin, apiSessions} {
		if h(req, res, u, uid) {
			return
		}
	}
	apiEnd(req, res, u, uid)
}

func apiMisc(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	if im := apiImgRe.FindStringSubmatch(p); get && im != nil {
		typ := typeOfExt(im[2])
		// A copy an older server kept, until the operator clears it (REQ-S-075); else from the Macs (REQ-S-069).
		file := filepath.Join(imgDir(uid), im[1])
		if exists(file) {
			res.WriteHead(200, M{"Content-Type": typ, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
			res.file = &fileSend{path: file}
			res.ended = true
			return true
		}
		s := qstr(u, "s")
		first := ""
		if safeId(s) {
			if m, ok := sessions.Get(s); ok && m.uid() == uid {
				first = m.host()
			}
		}
		got := imageFromMacs(uid, im[1], first)
		if got == nil {
			any1 := false
			for _, h := range hosts.Keys() {
				if mstr(hosts.Val(h), "uid") == uid && online(h) {
					any1 = true
				}
			}
			if any1 {
				refuse(404, "그림이 없습니다")
			}
			refuse(404, "맥이 연결돼 있지 않아 그림을 가져오지 못했어요")
		}
		var t any = got.typ
		if got.typ == "" {
			t = typ
		}
		res.WriteHead(200, M{"Content-Type": t, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}).End(got.bytes)
		return true
	}
	if post && p == "/api/qr" {
		b := body(req, 4096)
		for k, v := range qrCodes {
			if jsNumber(v["exp"]) < float64(nowMs()) {
				delete(qrCodes, k)
			}
		}
		code := randHex(16)
		var sid any
		if safeId(b["sid"]) {
			if m, ok := sessions.Get(b["sid"].(string)); ok && m.uid() == uid {
				sid = b["sid"]
			}
		}
		// headless: a sign-in for a host with no screen (REQ-F-798), only for its headless browser, landing on /bridge.
		if b["headless"] == true {
			qrCodes[sha256hexs(code)] = M{"uid": uid, "exp": float64(nowMs() + QR_MS), "sid": nil, "next": "/bridge", "headless": true, "server": true}
		} else {
			qrCodes[sha256hexs(code)] = M{"uid": uid, "exp": float64(nowMs() + QR_MS), "sid": sid}
		}
		jsonRes(res, 200, M{"url": originOf(req) + "/api/auth/qr/" + code, "exp": float64(nowMs() + QR_MS)})
		return true
	}
	// 계정 삭제 (REQ-F-770): the person types their login name to say they mean it.
	if post && p == "/api/account/delete" {
		b := body(req, 4096)
		u0 := users.Val(uid)
		isApple := truthy(mget(u0, "apple"))
		login := mstr(u0, "login")
		if isApple {
			login = "삭제"
		}
		if login == "" || strings.ToLower(jsTrim(strOr(b["login"], ""))) != strings.ToLower(login) {
			if isApple {
				refuse(400, "삭제 라고 적어 주세요")
			}
			refuse(400, "로그인 이름이 맞지 않아요")
		}
		// A demo account (REQ-F-766) is not deleted: only it goes back to the seed.
		if isDemoUid(uid) {
			demoOpen(uid)
			logLine("demo: " + uid + " 계정 삭제를 눌러 처음 상태로 되돌림")
			jsonRes(res, 200, M{"ok": true, "demo": true})
			return true
		}
		deleteAccount(uid)
		jsonRes(res, 200, M{"ok": true}, M{"Set-Cookie": append([]string{cookie(req, cname(req, "cb"), "", 0)}, legacyCbClears(req)...)})
		return true
	}
	if get && p == "/api/me" {
		out := M{"user": users.Val(uid), "admin": isAdmin(uid), "version": VERSION, "origin": originOf(req), "source": SOURCE_URL, "icons": cleanIcons(prefsOf(uid)["icons"]), "voice": cleanVoice(prefsOf(uid)["voice"])}
		if u0, ok := users.Get(uid); !ok || u0 == nil {
			out["user"] = nil
		}
		if isDemoUid(uid) {
			out["demo"] = true
		} else if appBuild != nil {
			out["appBuild"] = appBuild
		}
		jsonRes(res, 200, out)
		return true
	}
	// ----- skills -----
	if sk := apiSkillsRe.FindStringSubmatch(p); get && sk != nil {
		if !(SKILLS_APP != nil || SKILLS_TOKEN != "") {
			refuse(503, "스킬 저장소가 설정되지 않았습니다 (SKILLS_GITHUB_APP_ID·SKILLS_GITHUB_APP_KEY 또는 SKILLS_GITHUB_TOKEN)")
		}
		skills := skillsFor(skillsRepoOf(uid))
		if skills == nil {
			refuse(503, "스킬 저장소가 없어요. 설정 → 더 보기 → 스킬 저장소에 내 GitHub 저장소(owner/repo)를 넣어 주세요")
		}
		var c M
		if err := try(func() { c = skills.current() }); err != nil {
			if rg, ok := err.(*jsError); ok && isRepoGone(rg) {
				refuse(404, rg.msg)
			}
			panic(err)
		}
		repo := mstr(c, "repo")
		install := originOf(req) + "/skills/install.sh?repo=" + repo + "&t=" + skillsInstallSig(repo)
		base := M{"repo": c["repo"], "market": c["market"], "sha": c["sha"], "date": c["date"], "check": c["check"], "origin": originOf(req), "install": install}
		if sk[1] == "" {
			list := []any{}
			for _, s := range asArr(c["skills"]) {
				x := shallow(asM(s))
				delete(x, "body")
				list = append(list, x)
			}
			base["skills"] = list
			jsonRes(res, 200, base)
			return true
		}
		var s any
		for _, x := range asArr(c["skills"]) {
			if mget(x, "name") == sk[1] {
				s = x
				break
			}
		}
		if s == nil {
			refuse(404, "없는 스킬입니다")
		}
		base["skill"] = s
		jsonRes(res, 200, base)
		return true
	}
	return false
}

const NOT_BRIDGE_TAB = "이 탭은 더 이상 이 호스트의 연동 탭이 아닙니다"

func apiBridge(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	switch {
	case post && p == "/api/bridge/hello":
		b := body(req, 16*1024)
		if !safeId(b["hostId"]) {
			refuse(400, "hostId 가 올바르지 않습니다")
		}
		hostID := b["hostId"].(string)
		// The demo Macs' ids (REQ-S-068): played by this server, never a Mac's.
		if isDemoHost(hostID) {
			refuse(403, "이 호스트는 다른 계정에 등록돼 있습니다")
		}
		if h, ok := hosts.Get(hostID); ok && mstr(h, "uid") != uid {
			refuse(403, "이 호스트는 다른 계정에 등록돼 있습니다")
		}
		if !hosts.Has(hostID) {
			name := "Mac"
			if truthy(b["name"]) {
				name = jsString(b["name"])
			}
			hosts.Set(hostID, M{"uid": uid, "name": jsSliceTo(name, 60), "home": "", "lastSeen": float64(nowMs())})
		}
		// The tab that says hello last is the host's bridge.
		h := hosts.Val(hostID)
		h["conn"] = randHex(12)
		touchGlobals()
		// A sign-in that has less than 7 days left is extended to 30 again.
		token := sessionToken(req)
		var extra M = M{}
		if token != "" {
			if login, ok := logins.Get(sha256hexs(token)); ok && jsNumber(login["exp"])-float64(nowMs()) < 7*86_400_000 {
				login["exp"] = float64(nowMs() + LOGIN_DAYS*86_400_000)
				extra["Set-Cookie"] = cookie(req, cname(req, "cb"), token, LOGIN_DAYS*86_400)
			}
		}
		jsonRes(res, 200, M{"ok": true, "conn": h["conn"]}, extra)
		return true
	case get && p == "/api/bridge/stream":
		hostID := qstr(u, "hostId")
		if ownHost(uid, qnil(u, "hostId"))["conn"] != qnil(u, "conn") {
			refuse(409, NOT_BRIDGE_TAB)
		}
		// The page it replaces is told so, or its EventSource would reconnect and take the host back.
		if old, ok := bridges.Get(hostID); ok {
			old.End("data: {\"t\":\"replaced\"}\n\n")
		}
		var s *Stream
		s = openStream(req, res, func() {
			if cur, ok := bridges.Get(hostID); !ok || cur != Sink(s) {
				return
			}
			bridges.Delete(hostID)
			st := live(hostID)
			st["disconnectedAt"] = float64(nowMs())
			st["stale"] = false
			st["rtt"] = nil
			hosts.Val(hostID)["lastSeen"] = float64(nowMs())
			touchGlobals()
			// What the host last said stays, but nothing is being written or asked through a dead link.
			for _, m := range sessions.Values() {
				if m.host() == hostID {
					m.set("card", nil)
					m.set("writing", "")
				}
			}
			record(uid, hostID, M{"level": "warn", "area": "link", "text": "연동 페이지와의 연결이 끊김"})
			broadcastState(uid)
		})
		bridges.Set(hostID, s)
		// Which web files this server has: a bridge tab that heard another one before reloads to run the new relay.
		s.Write("data: " + jsonStr(M{"t": "web", "hash": WEB_HASH}) + "\n\n")
		trace(hostID, "stream open via HTTP/"+req.httpVersion+" ua="+jsSliceTo(jsStringU(headerOrNil(req, "user-agent")), 120)+" enc="+jsStringU(headerOrNil(req, "accept-encoding")))
		st := live(hostID)
		st["connectedAt"] = float64(nowMs())
		st["connects"] = numOr0(st["connects"]) + 1
		st["health"] = nil
		st["healthAt"] = nil
		st["page"] = nil
		record(uid, hostID, M{"area": "link", "text": "연동 페이지 연결됨"})
		broadcastState(uid)
		return true
	case post && p == "/api/bridge/up":
		b := body(req, 32*1024*1024)
		if ownHost(uid, b["hostId"])["conn"] != b["conn"] {
			refuse(409, NOT_BRIDGE_TAB)
		}
		hostID := b["hostId"].(string)
		if TRACE {
			parts := []string{}
			for _, m := range asArr(b["msgs"]) {
				t := jsStringU(mget(m, "t"))
				if t == "page" {
					t += "(" + jsStringU(mget(m, "visible")) + ",srv" + jsStringU(mget(m, "fromServer")) + ",agent" + jsStringU(mget(m, "fromAgent")) + ")"
				}
				parts = append(parts, t)
			}
			trace(hostID, "up "+strings.Join(parts, ",")+" via "+req.httpVersion)
		}
		fromBridge(uid, hostID, asArr(b["msgs"]), originOf(req))
		jsonRes(res, 200, M{"ok": true})
		return true
	case post && p == "/api/bridge/bye":
		b := body(req, 4096)
		// The tab closes its stream in the same breath, so the stream may already be gone when this arrives.
		if ownHost(uid, b["hostId"])["conn"] == b["conn"] {
			hostID := b["hostId"].(string)
			record(uid, hostID, M{"level": "warn", "area": "link", "src": "page", "text": "연동 탭이 닫히거나 다른 페이지로 이동함"})
			if s, ok := bridges.Get(hostID); ok {
				s.End("")
			}
		}
		jsonRes(res, 200, M{"ok": true})
		return true
	case get && p == "/api/bridge/upload":
		// A video for a message (REQ-F-761), fetched by the Mac's bridge tab to hand to its agent.
		if ownHost(uid, qnil(u, "hostId"))["conn"] != qnil(u, "conn") {
			refuse(409, NOT_BRIDGE_TAB)
		}
		up := uploadOf(uid, qnil(u, "id"))
		if up == nil {
			refuse(404, "영상이 없어요")
		}
		res.WriteHead(200, M{"Content-Type": up["type"], "Content-Length": up["size"], "Cache-Control": "no-store"})
		res.file = &fileSend{path: mstr(up, "file")}
		res.ended = true
		return true
	case get && p == "/api/bridge/transcript":
		meta := ownSession(uid, qstr(u, "sid"))
		// Handed out only while a host is opening the session (a move, a switch, a reopen) (R1-L2).
		if !truthy(meta.get("moving")) {
			refuse(409, "이 세션을 여는 중이 아닙니다")
		}
		hostID := qstr(u, "hostId")
		h, ok := hosts.Get(hostID)
		if hostID == "" || !ok || mstr(h, "uid") != uid || h["conn"] != qnil(u, "conn") || mget(meta.get("moving"), "to") != hostID {
			refuse(409, NOT_BRIDGE_TAB)
		}
		cp, has := moveCopies[meta.id()]
		if !has {
			res.WriteHead(204, M{"Cache-Control": "no-store"}).End()
			return true
		}
		res.WriteHead(200, M{"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"}).EndS(cp)
		return true
	}
	return false
}

// CONTROLS_MAX: one person's open pages (REQ-S-087). One more closes the oldest, whose page opens it again if it is
// still there.
const CONTROLS_MAX = 32

func addControl(uid, key string, s *Stream) {
	if controls[uid] == nil {
		controls[uid] = newOMap[*Stream]()
	}
	c := controls[uid]
	for c.Len() >= CONTROLS_MAX {
		old := c.Keys()[0]
		if o, ok := c.Get(old); ok {
			o.End("")
		}
		c.Delete(old)
	}
	c.Set(key, s)
}

func headerOrNil(req *Req, k string) any {
	if !req.Has(k) {
		return nil
	}
	return req.H(k)
}

var hostLogsRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/logs$`)
var pushEndpointRe = regexp.MustCompile(`^https://[^\s]{10,1000}$`)

var qualityCache *struct {
	mtime time.Time
	data  any
}

func apiControl(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	if pageApi(req, res, u, uid) {
		return true
	}
	if get && p == "/api/classic/stream" {
		key := randHex(8)
		s := openStream(req, res, func() {
			if c := controls[uid]; c != nil {
				c.Delete(key)
			}
		})
		addControl(uid, key, s)
		// Only a page that says it can merge them gets deltas.
		s.wantsDelta = qstr(u, "delta") == "1"
		sendState(s, stateOf(uid))
		return true
	}
	if post && p == "/api/sessions" {
		id := startSession(uid, body(req, 256*1024), req)
		jsonRes(res, 200, M{"ok": true, "id": id})
		return true
	}
	if hl := hostLogsRe.FindStringSubmatch(p); get && hl != nil {
		h := readableHost(uid, hl[1])
		entries := readHostLog(mstr(h, "uid"), hl[1], qstr(u, "sid"), qstr(u, "level"))
		// An operator reading someone else's Mac sees no paths (R1-M5).
		if mstr(h, "uid") != uid {
			for i, e := range entries {
				x := shallow(asM(e))
				x["text"] = hidePaths(x["text"])
				entries[i] = x
			}
		}
		jsonRes(res, 200, M{"entries": entries})
		return true
	}
	if get && p == "/api/notices" {
		list := []any{}
		for _, n := range noticesOf(uid, nil) {
			x := shallow(asM(n))
			delete(x, "key")
			list = append(list, x)
		}
		jsonRes(res, 200, M{"notices": list})
		return true
	}
	if post && p == "/api/notices/dismiss" {
		id := body(req, 4096)["id"]
		dropNotices(uid, func(x M) bool { return !truthy(id) || x["id"] == id })
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	if get && p == "/api/push/key" {
		jsonRes(res, 200, M{"key": vapid["publicKey"], "apns": apns != nil})
		return true
	}
	if post && p == "/api/push/subscribe" {
		b := body(req, 8192)
		if !pushEndpointRe.MatchString(strOr(b["endpoint"], "")) || !pushService(b["endpoint"]) {
			refuse(400, "구독 정보가 올바르지 않습니다")
		}
		subs := []any{}
		for _, x := range subsOf(uid) {
			if mget(x, "endpoint") != b["endpoint"] {
				subs = append(subs, x)
			}
		}
		// Which kind of device subscribed, so the app on the same kind does not get it twice (REQ-F-775).
		dev := deviceOf(req.H("user-agent"))
		if b["off"] != true {
			s := M{"endpoint": b["endpoint"], "at": float64(nowMs())}
			if dev != "" {
				s["dev"] = dev
			}
			subs = append(subs, s)
		}
		keep := subs
		if len(keep) > 20 {
			keep = keep[len(keep)-20:]
		}
		writeJson(subsFile(uid), keep)
		jsonRes(res, 200, M{"ok": true, "count": float64(len(subs))})
		return true
	}
	// 앱 알림 (REQ-F-775): whether this phone's token is registered for this person, and whether the server can send.
	if get && p == "/api/push/apns" {
		token := strings.ToLower(qstr(u, "token"))
		on := false
		if APNS_TOKEN.MatchString(token) {
			for _, d := range devicesOf(uid) {
				if mget(d, "token") == token {
					on = true
				}
			}
		}
		jsonRes(res, 200, M{"on": on, "apns": apns != nil})
		return true
	}
	if post && p == "/api/push/apns" {
		if isDemoUid(uid) {
			refuse(403, DEMO_REFUSED)
		}
		b := body(req, 4096)
		token := strings.ToLower(strOr(b["token"], ""))
		if !APNS_TOKEN.MatchString(token) {
			refuse(400, "기기 토큰이 올바르지 않습니다")
		}
		if b["off"] != true && (!containsAny(anyList(APNS_ENVS), b["env"]) || !containsAny(anyList(APNS_DEVICES), b["device"])) {
			refuse(400, "기기 정보가 올바르지 않습니다")
		}
		// A phone is one person's: signing in as someone else there takes the token from whoever had it.
		for _, other := range users.Keys() {
			if other == uid || !exists(devicesFile(other)) {
				continue
			}
			theirs := devicesOf(other)
			has := false
			keep := []any{}
			for _, d := range theirs {
				if mget(d, "token") == token {
					has = true
				} else {
					keep = append(keep, d)
				}
			}
			if has {
				writeJson(devicesFile(other), keep)
			}
		}
		list := []any{}
		for _, d := range devicesOf(uid) {
			if mget(d, "token") != token {
				list = append(list, d)
			}
		}
		if b["off"] != true {
			list = append(list, M{"token": token, "env": b["env"], "dev": b["device"], "at": float64(nowMs())})
		}
		keep := list
		if len(keep) > 10 {
			keep = keep[len(keep)-10:]
		}
		writeJson(devicesFile(uid), keep)
		jsonRes(res, 200, M{"ok": true, "count": math.Min(float64(len(list)), 10), "apns": apns != nil})
		return true
	}
	// Tests only (dev login): raise a notice as a session would, so its push can be watched.
	if DEV_LOGIN && post && p == "/api/dev/notice" {
		b := body(req, 4096)
		sid := any("")
		if safeId(b["sid"]) {
			sid = b["sid"]
		}
		addNotice(uid, M{"sid": sid, "key": "dev|" + randHex(4), "title": strOr(b["title"], ""), "text": strOr(b["text"], ""), "tone": "info", "push": true})
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	if post && p == "/api/focus" {
		b := body(req, 1024)
		if truthy(b["visible"]) {
			lookingAt[uid] = nowMs()
		} else {
			delete(lookingAt, uid)
		}
		if viewing[uid] == nil {
			viewing[uid] = map[string]int64{}
		}
		v := viewing[uid]
		for s, at := range v {
			if nowMs()-at > 45_000 {
				delete(v, s)
			}
		}
		if truthy(b["visible"]) && safeId(b["sid"]) {
			v[b["sid"].(string)] = nowMs()
		}
		if truthy(b["was"]) && safeId(b["was"]) {
			delete(v, b["was"].(string))
		}
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	// The quality report (설정 → 더 보기 → 성능 리포트), kept in the repository (server/quality.json).
	if get && p == "/api/quality" {
		file := filepath.Join(ROOT, "server", "quality.json")
		st, err := os.Stat(file)
		if err == nil {
			if qualityCache == nil || !qualityCache.mtime.Equal(st.ModTime()) {
				b, e1 := os.ReadFile(file)
				v, e2 := parseJSON(b)
				if e1 == nil && e2 == nil {
					qualityCache = &struct {
						mtime time.Time
						data  any
					}{st.ModTime(), v}
				} else {
					err = os.ErrInvalid
				}
			}
		}
		if err != nil {
			jsonRes(res, 200, M{"pages": []any{}, "runs": []any{}})
			return true
		}
		jsonRes(res, 200, qualityCache.data)
		return true
	}
	if get && p == "/api/stats" {
		days := 7.0
		if d := jsNumber(qnil(u, "days")); d == 1 || d == 7 || d == 30 || d == 90 {
			days = d
		}
		base := computeStats(uid, days)
		// A slow answer does not hold the window up: the block is there the next time it opens.
		ch := make(chan M, 1)
		goLocked("prstats", func() {
			var r M
			_ = try(func() { r = prStatsOf(uid, days) })
			ch <- r
		})
		var pr M
		await(func() {
			select {
			case pr = <-ch:
			case <-time.After(8 * time.Second):
			}
		})
		if pr != nil {
			out := shallow(base)
			out["pr"] = pr
			jsonRes(res, 200, out)
		} else {
			jsonRes(res, 200, base)
		}
		return true
	}
	return apiPrefs(req, res, u, uid)
}

func apiPrefs(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	switch p {
	case "/api/prefs/launch":
		if get {
			jsonRes(res, 200, launchOf(uid))
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		b := body(req, 4096)
		v := cleanLaunch(b)
		// A value sent that is not one the list offers is refused, not quietly dropped.
		for _, kl := range [][2]string{{"model", "모델"}, {"effort", "effort"}, {"mode", "권한 모드"}} {
			if jsTrim(strOr(b[kl[0]], "")) != "" && !truthy(v[kl[0]]) {
				refuse(400, kl[1]+" 값이 올바르지 않아요")
			}
		}
		if jsTrim(strOr(b["folderBase"], "")) != "" && cleanFolderBase(b["folderBase"]) == "" {
			refuse(400, "기본 폴더는 ~ 나 / 로 시작하고 .. 이 없어야 해요")
		}
		prefsOf(uid)["launch"] = v
		savePrefs(uid)
		out := M{"ok": true, "note": "저장했어요. 다음에 띄우는 새 세션과 복제부터 적용돼요."}
		for k, x := range v {
			out[k] = x
		}
		jsonRes(res, 200, out)
		return true
	case "/api/prefs/skills":
		// 스킬 저장소 (REQ-F-792): only a repo the person owns on GitHub.
		if post {
			b := body(req, 4096)
			rs, isS := b["repo"].(string)
			if !isS {
				refuse(400, "repo 가 필요해요")
			}
			repo := jsTrim(rs)
			gh := githubLoginOf(uid)
			if gh == nil {
				refuse(400, "GitHub 로 로그인한 계정만 스킬 저장소를 정할 수 있어요")
			}
			ghs := jsString(gh)
			if repo != "" && !SKILLS_REPO_RE.MatchString(repo) {
				refuse(400, "owner/repo 형식으로 적어 주세요")
			}
			if repo != "" && strings.ToLower(strings.Split(repo, "/")[0]) != strings.ToLower(ghs) {
				refuse(400, "내 GitHub 계정("+ghs+")의 저장소만 넣을 수 있어요")
			}
			if repo != "" {
				prefsOf(uid)["skillsRepo"] = repo
			} else {
				delete(prefsOf(uid), "skillsRepo")
			}
			savePrefs(uid)
		} else if !get {
			refuse(405, "지원하지 않는 요청입니다")
		}
		jsonRes(res, 200, skillsView(uid))
		return true
	case "/api/prefs/voice":
		if get {
			jsonRes(res, 200, cleanVoice(prefsOf(uid)["voice"]))
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		b := body(req, 8*1024)
		if b["model"] != nil && !containsAny(anyList(VOICE_MODELS), b["model"]) {
			refuse(400, "모델 값이 올바르지 않아요")
		}
		if b["language"] != nil && !containsAny(anyList(VOICE_LANGS), b["language"]) {
			refuse(400, "언어 값이 올바르지 않아요")
		}
		v := cleanVoice(b)
		prefsOf(uid)["voice"] = v
		savePrefs(uid)
		out := M{"ok": true}
		for k, x := range v {
			out[k] = x
		}
		jsonRes(res, 200, out)
		return true
	case "/api/prefs/voice/hosts":
		own := func(id string) bool { return mstr(hosts.Val(id), "uid") == uid && hosts.Has(id) }
		list := func() M {
			out := M{}
			for id, v := range asM(prefsOf(uid)["voiceHosts"]) {
				if !own(id) {
					continue
				}
				c := cleanVoiceHost(v)
				if truthy(c["model"]) {
					out[id] = c
				}
			}
			return out
		}
		if get {
			jsonRes(res, 200, M{"hosts": list()})
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		b := body(req, 4*1024)
		if !safeId(b["host"]) || !own(b["host"].(string)) {
			refuse(404, "그 맥이 없어요")
		}
		if truthy(b["model"]) && !containsAny(anyList(VOICE_MODELS), b["model"]) {
			refuse(400, "모델 값이 올바르지 않아요")
		}
		v := cleanVoiceHost(b)
		all := shallow(asM(prefsOf(uid)["voiceHosts"]))
		if truthy(v["model"]) {
			all[b["host"].(string)] = v
		} else {
			delete(all, b["host"].(string))
		}
		prefsOf(uid)["voiceHosts"] = all
		savePrefs(uid)
		jsonRes(res, 200, M{"ok": true, "hosts": list()})
		return true
	case "/api/prefs/icons":
		if get {
			jsonRes(res, 200, cleanIcons(prefsOf(uid)["icons"]))
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		b := body(req, 1024)
		if !contains(ICON_SIZES, jsNumber(b["size"])) || !contains(ICON_FILLS, jsNumber(b["fill"])) {
			refuse(400, "아이콘 값이 올바르지 않아요")
		}
		v := cleanIcons(b)
		prefsOf(uid)["icons"] = v
		savePrefs(uid)
		jsonRes(res, 200, M{"ok": true, "size": v["size"], "fill": v["fill"]})
		return true
	case "/api/prefs/splits":
		// 분할 조합 (REQ-F-790): named sets of 2~3 sessions to open side by side again.
		if get {
			jsonRes(res, 200, M{"splits": splitsOf(uid)})
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		b := body(req, 4*1024)
		list := splitsOf(uid)
		find := func() int {
			for i, x := range list {
				if mget(x, "id") == b["id"] {
					return i
				}
			}
			return -1
		}
		switch b["op"] {
		case "remove":
			keep := []any{}
			for _, x := range list {
				if mget(x, "id") != b["id"] {
					keep = append(keep, x)
				}
			}
			list = keep
		case "move":
			at := find()
			by := 0
			if b["by"] == -1.0 {
				by = -1
			} else if b["by"] == 1.0 {
				by = 1
			}
			if at < 0 {
				refuse(404, "그 조합이 없어요")
			}
			if by == 0 {
				refuse(400, "알 수 없는 요청이에요")
			}
			to := at + by
			if to >= 0 && to < len(list) {
				list = append([]any{}, list...)
				list[at], list[to] = list[to], list[at]
			}
		case "save":
			seen := map[string]bool{}
			ids := []any{}
			for _, x := range asArr(b["ids"]) {
				if safeId(x) && !seen[x.(string)] {
					seen[x.(string)] = true
					ids = append(ids, x)
				}
			}
			name := jsSliceTo(jsTrim(strOr(b["name"], "")), 40)
			if name == "" {
				refuse(400, "이름을 적어 주세요")
			}
			if len(ids) < 2 || len(ids) > 3 {
				refuse(400, "조합은 세션 2~3개예요")
			}
			at := find()
			if at < 0 && len(list) >= SPLITS_MAX {
				refuse(400, "조합은 "+itoa(SPLITS_MAX)+"개까지 저장해요")
			}
			var id any
			if at < 0 {
				id = uuidv4()
			} else {
				id = mget(list[at], "id")
			}
			item := M{"id": id, "name": name, "ids": ids}
			if at < 0 {
				list = append(list, item)
			} else {
				list = append([]any{}, list...)
				list[at] = item
			}
		default:
			refuse(400, "알 수 없는 요청이에요")
		}
		prefsOf(uid)["splits"] = list
		savePrefs(uid)
		jsonRes(res, 200, M{"ok": true, "splits": list})
		return true
	case "/api/prefs/prompt":
		if get {
			jsonRes(res, 200, M{"text": prefsOf(uid)["defaultPrompt"]})
			return true
		}
		if !post {
			refuse(405, "지원하지 않는 요청입니다")
		}
		text := jsSliceTo(jsTrim(strOr(body(req, 64*1024)["text"], "")), 8000)
		said := setDefaultPrompt(uid, text)
		w := "비웠어요"
		if text != "" {
			w = "저장했어요"
		}
		jsonRes(res, 200, M{"ok": true, "note": w + ". " + said})
		return true
	}
	return false
}
