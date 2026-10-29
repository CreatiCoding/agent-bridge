package main

import (
	"math"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
)

var (
	hostDirsRe     = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/dirs$`)
	hostRecentRe   = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/recent$`)
	hostAdoptRe    = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/adopt$`)
	hostAccountsRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/accounts$`)
	hostHealRe     = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/heal$`)
	hostSudoRe     = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/sudo$`)
	hostDiskRe     = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/disk$`)
	hostDiskHelpRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/disk-help$`)
	hostBgRe       = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/background$`)
	hostAwakeRe    = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/awake$`)
	hostCompactRe  = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/compact$`)
	hostDelegateRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/delegate$`)
	hostCheckRe    = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/check$`)
	hostStatusRe   = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/status$`)
	httpsRe        = regexp.MustCompile(`^https://`)
)

var ACCOUNT_OPS = []string{"list", "add", "rename", "login", "code", "cancel", "logout", "sync", "remove"}

const NOT_CONNECTED = "호스트가 연결돼 있지 않습니다"

func okOr(r M, ok, bad string) string {
	if truthy(r["ok"]) {
		return ok
	}
	return bad
}

func apiHosts(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	if m := hostDirsRe.FindStringSubmatch(p); get && m != nil {
		ownHost(uid, m[1])
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		path := qstr(u, "path")
		if path == "" {
			path = "~"
		}
		r := ask(m[1], M{"t": "dirs", "path": jsSliceTo(path, 1000)}, 15_000)
		if !truthy(r["ok"]) {
			refuse(404, orStr(r["error"], "폴더를 읽지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "path": r["path"], "parent": r["parent"], "dirs": r["dirs"]})
		return true
	}
	if m := hostRecentRe.FindStringSubmatch(p); get && m != nil {
		ownHost(uid, m[1])
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		exclude := []any{}
		for _, s := range sessions.Values() {
			if s.uid() == uid {
				exclude = append(exclude, s.get("conv"))
			}
		}
		include := []any{}
		for _, x := range strings.Split(qstr(u, "include"), ",") {
			if safeId(x) && len(include) < 200 {
				include = append(include, x)
			}
		}
		r := ask(m[1], M{"t": "recent", "exclude": exclude, "include": include}, 30_000)
		if !truthy(r["ok"]) {
			refuse(502, orStr(r["error"], "대화 목록을 읽지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "home": r["home"], "conversations": r["conversations"]})
		return true
	}
	if m := hostAdoptRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 16*1024)
		ownHost(uid, m[1])
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		if !safeId(b["conv"]) {
			refuse(400, "대화 id 가 올바르지 않습니다")
		}
		for _, s := range sessions.Values() {
			if s.uid() == uid && s.get("conv") == b["conv"] && !truthy(s.get("closed")) {
				refuse(409, "이미 bridge 세션으로 열려 있는 대화입니다")
			}
		}
		sid := uuidv4()
		cwd := ""
		if truthy(b["cwd"]) {
			cwd = jsString(b["cwd"])
		}
		title := ""
		if truthy(b["title"]) {
			title = jsString(b["title"])
		}
		meta := newMeta(uid, sid, m[1], M{"conv": b["conv"], "cwd": jsSliceTo(cwd, 1000), "title": jsSliceTo(wsRun.ReplaceAllString(title, " "), 80)})
		st := noState()
		st["alive"] = true
		st["phase"] = "starting"
		meta.set("state", st)
		broadcastState(uid)
		r := ask(m[1], M{"t": "adopt", "sid": sid, "conv": b["conv"], "cwd": meta.get("cwd"), "sysPrompt": sysPromptOf(uid), "autoPush": true}, 90_000)
		if !truthy(r["ok"]) {
			sessions.Delete(sid)
			dirty.Delete(sid)
			_ = os.RemoveAll(sessionDir(meta))
			broadcastState(uid)
			record(uid, m[1], M{"level": "error", "area": "adopt", "sid": sid, "text": "대화를 가져오지 못함: " + jsStringU(r["error"])})
			refuse(502, orStr(r["error"], "대화를 가져오지 못했습니다"))
		}
		meta.set("cwd", r["cwd"])
		if safeAccount(r["account"]) {
			meta.set("account", r["account"])
		} else {
			meta.set("account", "")
		}
		touch(meta)
		record(uid, m[1], M{"area": "adopt", "sid": sid, "text": "맥의 대화 " + jsSliceTo(b["conv"].(string), 8) + " 를 bridge 세션으로 가져옴"})
		toHost(m[1], M{"t": "report", "sid": sid})
		jsonRes(res, 200, M{"ok": true, "id": sid})
		return true
	}
	// The Claude accounts on one of the person's Macs (설정 → Claude 계정). Its owner only.
	if m := hostAccountsRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 4096)
		h := ownHost(uid, m[1])
		if !containsAny(anyList(ACCOUNT_OPS), b["op"]) {
			refuse(400, "모르는 계정 동작이에요")
		}
		op := b["op"].(string)
		if op != "list" && op != "add" && !safeAccount(b["id"]) {
			refuse(400, "계정 id 가 올바르지 않아요")
		}
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		id := b["id"]
		if id == nil {
			id = ""
		}
		name := ""
		if b["name"] != nil {
			name = jsString(b["name"])
		}
		cmd := M{"t": "account", "op": op, "id": id, "name": jsSliceTo(name, 100)}
		if op == "code" {
			code := ""
			if b["code"] != nil {
				code = jsString(b["code"])
			}
			cmd["code"] = jsSliceTo(code, 600)
		}
		r := ask(m[1], cmd, 90_000)
		if list, ok := r["accounts"].([]any); ok {
			h["accounts"] = cleanAccounts(list)
			touchGlobals()
			broadcastState(uid)
		}
		if op != "list" {
			text := "Claude 계정 " + ACCOUNT_OP_NAMES[op]
			if truthy(b["id"]) {
				text += " (" + jsString(b["id"]) + ")"
			}
			if !truthy(r["ok"]) {
				e := ""
				if r["error"] != nil {
					e = jsString(r["error"])
				}
				text += " 실패: " + e
			}
			record(uid, m[1], M{"level": okOr(r, "info", "warn"), "area": "account", "text": text})
		}
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "계정 동작을 하지 못했어요"))
		}
		out := M{"ok": true, "accounts": h["accounts"]}
		if h["accounts"] == nil {
			out["accounts"] = []any{}
		}
		if s, ok := r["url"].(string); ok && httpsRe.MatchString(s) {
			out["url"] = s
		}
		if safeAccount(r["id"]) {
			out["id"] = r["id"]
		}
		jsonRes(res, 200, out)
		return true
	}
	if m := hostHealRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 1024)
		h := readableHost(uid, m[1])
		if !containsAny([]any{"background-restart", "awake-apply", "check", "restart", "rekey"}, b["action"]) {
			refuse(400, "모르는 복구 동작이에요")
		}
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		r := ask(m[1], M{"t": "heal", "action": b["action"]}, 30_000)
		said := jsStringU(r["error"])
		if truthy(r["ok"]) {
			said = jsStringU(r["note"])
		}
		record(mstr(h, "uid"), m[1], M{"level": okOr(r, "info", "warn"), "area": "heal", "text": "지금 복구(" + jsString(b["action"]) + "): " + said + byOperator(uid, h)})
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "복구하지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "note": r["note"]})
		return true
	}
	// 디스크 관리 (REQ-F-801). Its owner only: an operator never clears or moves someone else's files.
	if m := hostDiskRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 262_144)
		h := diskHost(uid, m[1])
		op := jsString(b["op"])
		timeouts := map[string]int64{"info": 240_000, "scan": 240_000, "clean": 600_000, "trash": 180_000, "worktrees": 300_000, "prune": 600_000}
		wait, known := timeouts[op]
		if !known {
			refuse(400, "모르는 동작이에요")
		}
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		cmd := M{"t": "disk", "op": op}
		if s, ok := b["id"].(string); ok && len(s) <= 64 {
			cmd["id"] = s
		}
		if s, ok := b["path"].(string); ok && len(s) <= 4096 {
			cmd["path"] = s
		}
		if arr, ok := b["paths"].([]any); ok {
			list := []any{}
			for _, x := range arr {
				if s, ok := x.(string); ok && len(s) <= 4096 && len(list) < 200 {
					list = append(list, s)
				}
			}
			cmd["paths"] = list
		}
		r := ask(m[1], cmd, wait)
		if op == "clean" || op == "trash" || op == "prune" {
			text := "디스크: 휴지통으로 옮김"
			if op == "clean" {
				text = "디스크: " + jsString(cmd["id"]) + " 비움"
			} else if op == "prune" {
				text = "디스크: 머지된 worktree 정리"
			}
			if !truthy(r["ok"]) {
				text += " 실패: " + jsStringU(r["error"])
			}
			record(mstr(h, "uid"), m[1], M{"level": okOr(r, "info", "warn"), "area": "disk", "text": text + byOperator(uid, h)})
		}
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "디스크 정보를 받지 못했어요"))
		}
		out := shallow(r)
		delete(out, "reqId")
		delete(out, "t")
		jsonRes(res, 200, out)
		return true
	}
	// 디스크 정리 도움 (REQ-F-804): an operator asks, the owner grants for DISK_HELP_MS or turns it down, and either
	// the owner or the operator who asked takes it back.
	if m := hostDiskHelpRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 1024)
		h := readableHost(uid, m[1])
		owner := mstr(h, "uid")
		help, _ := h["diskHelp"].(M)
		login := jsString(users.Val(uid)["login"])
		switch jsString(b["op"]) {
		case "ask":
			if owner == uid || !isAdmin(uid) {
				refuse(403, "운영자만 다른 사람의 기기에 요청할 수 있어요")
			}
			h["diskHelp"] = M{"by": uid, "login": login, "askedAt": float64(nowMs()), "until": 0.0}
			record(owner, m[1], M{"area": "disk", "text": "운영자 " + login + " 이 디스크 정리를 도울 권한을 요청함"})
		case "grant":
			if owner != uid {
				refuse(404, "호스트가 없습니다")
			}
			if help == nil {
				refuse(409, "받은 요청이 없어요")
			}
			// The grant names the operator the owner was shown: another operator's request in between is not granted (REQ-F-804).
			if l, ok := b["login"].(string); !ok || strings.ToLower(l) != strings.ToLower(mstr(help, "login")) {
				refuse(409, "요청한 운영자가 바뀌었어요. 화면을 새로고침해 다시 확인해 주세요")
			}
			g := shallow(help)
			g["until"] = float64(nowMs() + DISK_HELP_MS)
			h["diskHelp"] = g
			record(owner, m[1], M{"area": "disk", "text": "운영자 " + jsString(help["login"]) + " 에게 디스크 정리 권한을 24시간 줌"})
		case "end":
			if owner != uid && (help == nil || mstr(help, "by") != uid) {
				refuse(404, "호스트가 없습니다")
			}
			delete(h, "diskHelp")
			who := "주인이"
			if owner != uid {
				who = "운영자 " + login + " 이"
			}
			record(owner, m[1], M{"area": "disk", "text": who + " 디스크 정리 도움 권한을 거둠"})
		default:
			refuse(400, "모르는 동작이에요")
		}
		touchGlobals()
		broadcastState(owner)
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	// 관리자 권한 (REQ-F-764). Its owner only.
	if m := hostSudoRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 4096)
		hostID := m[1]
		ownHost(uid, hostID)
		st := sudoOf(hostID)
		if b["cancel"] == true {
			for _, areq := range append([]string{}, st.asks.Keys()...) {
				sudoAnswer(hostID, areq, false, "비밀번호를 묻는 창을 닫았어요")
			}
			broadcastState(uid)
			jsonRes(res, 200, M{"ok": true})
			return true
		}
		if !online(hostID) {
			refuse(409, NOT_CONNECTED)
		}
		if b["off"] == true {
			ask(hostID, M{"t": "sudooff"}, 15_000)
			st.until = 0
			record(uid, hostID, M{"area": "sudo", "text": "관리자 권한을 닫음"})
			broadcastState(uid)
			jsonRes(res, 200, M{"ok": true})
			return true
		}
		password, _ := b["password"].(string)
		if password == "" || jsLen(password) > 1024 {
			refuse(400, "비밀번호를 넣어 주세요")
		}
		r := ask(hostID, M{"t": "sudopass", "password": password}, 30_000)
		if !truthy(r["ok"]) {
			refuse(403, orStr(r["error"], "관리자 권한을 열지 못했어요"))
		}
		st.until = jsNumber(r["until"])
		if st.until == 0 || math.IsNaN(st.until) {
			st.until = float64(nowMs() + 300_000)
		}
		for _, areq := range append([]string{}, st.asks.Keys()...) {
			sudoAnswer(hostID, areq, true, "")
		}
		record(uid, hostID, M{"area": "sudo", "text": "관리자 권한을 5분 열었음"})
		broadcastState(uid)
		jsonRes(res, 200, M{"ok": true, "until": st.until})
		return true
	}
	if m := hostBgRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 1024)
		h := readableHost(uid, m[1])
		if !online(m[1]) {
			refuse(409, "호스트가 연결돼 있지 않습니다. 그 맥의 브라우저에서 이 사이트를 한 번 연 뒤 켜 주세요")
		}
		cmd := M{"t": "background", "on": b["on"] == true}
		if b["on"] == true {
			for k, v := range qrCodes {
				if jsNumber(v["exp"]) < float64(nowMs()) {
					delete(qrCodes, k)
				}
			}
			code := randHex(16)
			qrCodes[sha256hexs(code)] = M{"uid": h["uid"], "exp": float64(nowMs() + QR_MS), "sid": nil, "next": "/bridge", "headless": true}
			cmd["login"] = originOf(req) + "/api/auth/qr/" + code
		}
		r := ask(m[1], cmd, 15_000)
		onoff := "끔"
		if b["on"] == true {
			onoff = "켬"
		}
		tail := ""
		if !truthy(r["ok"]) {
			tail = " · " + strOr(r["error"], "")
			if r["error"] != nil {
				tail = " · " + jsString(r["error"])
			}
		}
		record(mstr(h, "uid"), m[1], M{"level": okOr(r, "info", "warn"), "area": "background", "text": "헤드리스 연동 모드 " + onoff + tail + byOperator(uid, h)})
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "헤드리스 연동 모드를 바꾸지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "on": truthy(r["on"]), "running": truthy(r["running"])})
		return true
	}
	if m := hostAwakeRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 1024)
		h := readableHost(uid, m[1])
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		cmd := M{"t": "awake"}
		if v, ok := b["idle"].(bool); ok {
			cmd["idle"] = v
		}
		if v, ok := b["lid"].(bool); ok {
			cmd["lid"] = v
		}
		r := ask(m[1], cmd, 15_000)
		on := func(k string) string {
			if truthy(r[k]) {
				return "켬"
			}
			return "끔"
		}
		tail := ""
		if !truthy(r["ok"]) {
			tail = " · "
			if r["error"] != nil {
				tail += jsString(r["error"])
			}
		}
		record(mstr(h, "uid"), m[1], M{"level": okOr(r, "info", "warn"), "area": "awake", "text": "잠자기 막기 " + on("idle") + " · 덮개 닫아도 켜 두기 " + on("lid") + tail + byOperator(uid, h)})
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "잠자기 설정을 바꾸지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "idle": truthy(r["idle"]), "lid": truthy(r["lid"]), "lidReady": truthy(r["lidReady"])})
		return true
	}
	if m := hostCompactRe.FindStringSubmatch(p); post && m != nil {
		b := body(req, 1024)
		h := readableHost(uid, m[1])
		var w any
		bad := false
		if v, has := b["window"]; has && v == nil {
			w = nil
		} else if f, ok := b["window"].(float64); ok && isInteger(f) && f >= 100_000 && f <= 1_000_000 {
			w = f
		} else {
			bad = true
		}
		if bad {
			refuse(400, "압축 시점은 100,000~1,000,000 토큰이거나 null 이에요")
		}
		if !online(m[1]) {
			refuse(409, NOT_CONNECTED)
		}
		r := ask(m[1], M{"t": "compact", "window": w}, 15_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "압축 시점을 바꾸지 못했습니다"))
		}
		said := "Claude Code 설정"
		if truthy(r["window"]) {
			said = numStr(jsRound(jsNumber(r["window"])/1000)) + "k 토큰"
		}
		record(mstr(h, "uid"), m[1], M{"level": "info", "area": "compact", "text": "자동 압축 시점 " + said + byOperator(uid, h)})
		jsonRes(res, 200, M{"ok": true, "window": r["window"]})
		return true
	}
	if m := hostDelegateRe.FindStringSubmatch(p); post && m != nil {
		needFeature("sessionMove")
		ownHost(uid, m[1])
		b := body(req, 1024)
		on, ok := b["on"].(bool)
		if !ok {
			refuse(400, "on 값이 필요해요")
		}
		off := delegateOff(uid)
		if on {
			delete(off, m[1])
		} else {
			off[m[1]] = true
		}
		// Kept in the order the hosts are known (a Set keeps insertion order; close enough for a set of ids).
		keep := []any{}
		for _, id := range delegateOffOrder(uid, off) {
			if hosts.Has(id) {
				keep = append(keep, id)
			}
		}
		prefsOf(uid)["delegateOff"] = keep
		savePrefs(uid)
		jsonRes(res, 200, M{"ok": true, "on": on})
		return true
	}
	if m := hostCheckRe.FindStringSubmatch(p); post && m != nil {
		readableHost(uid, m[1])
		if !toHost(m[1], M{"t": "check"}) {
			refuse(409, NOT_CONNECTED)
		}
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	if m := hostStatusRe.FindStringSubmatch(p); get && m != nil {
		readableHost(uid, m[1])
		jsonRes(res, 200, hostDetail(m[1], uid))
		return true
	}
	return false
}

// delegateOffOrder: the ids turned off, those already saved first (in their saved order), then the new one.
func delegateOffOrder(uid string, off map[string]bool) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, x := range asArr(prefsOf(uid)["delegateOff"]) {
		if s, ok := x.(string); ok && off[s] && !seen[s] {
			out = append(out, s)
			seen[s] = true
		}
	}
	rest := []string{}
	for s := range off {
		if !seen[s] {
			rest = append(rest, s)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

func jsRound(f float64) float64 { return math.Floor(f + 0.5) }

var loginNameRe = regexp.MustCompile(`^[a-z0-9-]{1,39}$`)
var reportDataRe = regexp.MustCompile(`^data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$`)

func endAllOf(id string) {
	for k, v := range logins.Keys() {
		_ = k
		if mstr(logins.Val(v), "uid") == id {
			logins.Delete(v)
		}
	}
	if c := controls[id]; c != nil {
		for _, s := range c.Values() {
			s.End("")
		}
	}
	for _, hid := range hosts.Keys() {
		if mstr(hosts.Val(hid), "uid") == id {
			if b, ok := bridges.Get(hid); ok {
				b.End("")
			}
		}
	}
}

func apiAdmin(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	if p == "/api/admin/access" {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		if post {
			b := body(req, 16*1024)
			l := ""
			if truthy(b["login"]) {
				l = strings.ToLower(jsString(b["login"]))
			}
			if !loginNameRe.MatchString(l) && !isAppleLogin(l) {
				refuse(400, "GitHub 계정 이름이 올바르지 않습니다")
			}
			if b["status"] != "release" && (contains(ADMINS, l) || contains(ALLOWED, l)) {
				refuse(409, "서버 설정으로 허용된 계정입니다. 설정(환경 변수)에서 바꿔야 합니다")
			}
			switch {
			case b["status"] == "remove":
				access.Delete(l)
			case b["status"] == "release":
				holder, _ := pins[l].(string)
				delete(pins, l)
				if a, ok := access.Get(l); ok {
					delete(a, "heldBy")
				}
				if hu, ok := users.Get(holder); holder != "" && ok && strings.ToLower(mstr(hu, "login")) == l {
					hu["login"] = mstr(hu, "login") + "#released"
					endAllOf(holder)
				}
			case containsAny([]any{"allowed", "denied", "pending"}, b["status"]):
				a, ok := access.Get(l)
				if !ok {
					a = M{"login": jsString(b["login"]), "firstAt": float64(nowMs()), "attempts": 0.0}
					access.Set(l, a)
				}
				a["status"] = b["status"]
				a["decidedBy"] = users.Val(uid)["login"]
				a["decidedAt"] = float64(nowMs())
			default:
				refuse(400, "없는 상태입니다")
			}
			touchGlobals()
			logLine("access: " + mstr(users.Val(uid), "login") + " set " + l + " -> " + jsStringU(b["status"]))
			if !isAllowed(l) {
				for _, id := range users.Keys() {
					if strings.ToLower(mstr(users.Val(id), "login")) != l {
						continue
					}
					endAllOf(id)
				}
			}
		}
		known := newOMap[M]()
		for _, id := range users.Keys() {
			if isDemoUid(id) {
				continue
			}
			uu := users.Val(id)
			known.Set(strings.ToLower(mstr(uu, "login")), uu)
		}
		names := newOMap[bool]()
		for _, x := range ADMINS {
			names.Set(x, true)
		}
		for _, x := range ALLOWED {
			if x != "*" {
				names.Set(x, true)
			}
		}
		for _, x := range access.Keys() {
			names.Set(x, true)
		}
		for _, x := range known.Keys() {
			if !strings.HasSuffix(x, "#released") {
				names.Set(x, true)
			}
		}
		entries := []any{}
		for _, l := range names.Keys() {
			a, hasA := access.Get(l)
			uu, hasU := known.Get(l)
			acc := accessOf(l)
			pick := func(k string, def any) any {
				if hasU && uu[k] != nil {
					return uu[k]
				}
				if hasA && a[k] != nil {
					return a[k]
				}
				return def
			}
			af := func(k string, def any) any {
				if hasA && a[k] != nil {
					return a[k]
				}
				return def
			}
			status := any("pending")
			if acc["allowed"] == true {
				status = "allowed"
			} else if hasA && a["status"] != nil {
				status = a["status"]
			}
			nh := 0
			for _, h := range hosts.Values() {
				if hu, ok := users.Get(mstr(h, "uid")); ok && strings.ToLower(mstr(hu, "login")) == l {
					nh++
				}
			}
			held := hasA && truthy(a["heldBy"]) && pins[l] == a["heldBy"]
			var heldBy, heldAttempt any
			if held {
				heldBy = a["heldBy"]
				heldAttempt = af("heldAttempt", nil)
			}
			entries = append(entries, orderedObj{
				{"login", pick("login", l)}, {"name", pick("name", "")}, {"avatar", pick("avatar", "")},
				{"allowed", acc["allowed"]}, {"by", acc["by"]}, {"status", status}, {"admin", contains(ADMINS, l)},
				{"signedUp", hasU}, {"firstAt", af("firstAt", nil)}, {"lastAt", af("lastAt", nil)}, {"attempts", af("attempts", 0.0)},
				{"decidedBy", af("decidedBy", nil)}, {"decidedAt", af("decidedAt", nil)}, {"hosts", nh}, {"heldBy", heldBy}, {"heldAttempt", heldAttempt},
			})
		}
		jsonRes(res, 200, orderedObj{{"open", contains(ALLOWED, "*")}, {"entries", entries}})
		return true
	}
	if p == "/api/admin/models" {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		if post {
			b := body(req, 4096)
			if v, ok := b["auto"].(bool); ok {
				models["auto"] = v
				writeJson(MODELS_FILE, models)
			}
			if b["refresh"] == true {
				refreshModels("운영자")
			}
		}
		jsonRes(res, 200, modelsView())
		return true
	}
	if get && p == "/api/admin/overview" {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		pendingN := 0
		for _, a := range access.Values() {
			if a["status"] == "pending" && !isAllowed(mstr(a, "login")) {
				pendingN++
			}
		}
		nControls := 0
		for _, c := range controls {
			nControls += c.Len()
		}
		list := []any{}
		for _, id := range users.Keys() {
			if isDemoUid(id) {
				continue
			}
			uu := users.Val(id)
			hl := []any{}
			for _, hid := range hosts.Keys() {
				h := hosts.Val(hid)
				if mstr(h, "uid") != id {
					continue
				}
				row := hostSummary(hid, h, id != uid)
				info := asM(h["info"])
				row["agent"] = mgetOr(info, "version", nil)
				row["build"] = mgetOr(info, "build", nil)
				n := 0
				for _, s := range sessions.Values() {
					if s.host() == hid && !truthy(s.get("closed")) {
						n++
					}
				}
				row["sessions"] = n
				hl = append(hl, row)
			}
			list = append(list, orderedObj{{"login", uu["login"]}, {"allowed", isAllowed(mstr(uu, "login"))}, {"hosts", hl}})
		}
		server := orderedObj{{"version", VERSION}, {"agentBuild", AGENT_BUILD}, {"github", GITHUB_CLIENT_ID != ""}, {"originSet", ORIGIN != ""}, {"root", os.Getuid() == 0}, {"agentSigned", AGENT_SIGNED}, {"agentSeqBack", AGENT_SEQ_BACK}, {"uptime", nowMs() - processStart}, {"rss", rssBytes()}, {"bridges", len(realBridges())}, {"controls", nControls}, {"sessions", sessions.Len()}}
		jsonRes(res, 200, orderedObj{{"pending", pendingN}, {"server", server}, {"users", list}})
		return true
	}
	// ---------- 제보 (REQ-F-735 ~ REQ-F-737) ----------
	if post && p == "/api/reports/upload" {
		if limited(req, 20, "report-upload") {
			refuse(429, "너무 자주 올렸어요. 잠시 뒤에 다시 해 주세요")
		}
		out := M{"ok": true}
		for k, v := range saveUpload(uid, req, u) {
			out[k] = v
		}
		jsonRes(res, 200, out)
		return true
	}
	if post && p == "/api/reports" {
		if limited(req, 10, "report") {
			refuse(429, "너무 자주 제보했어요. 잠시 뒤에 다시 해 주세요")
		}
		b := body(req, 4*1024*1024)
		text := ""
		if b["text"] != nil {
			text = jsString(b["text"])
		}
		text = jsSliceTo(jsTrim(text), 20_000)
		pics := asArr(b["images"])
		if len(pics) > REPORT_IMAGES {
			pics = pics[:REPORT_IMAGES]
		}
		images := []any{}
		for _, x := range pics {
			d := ""
			if v := mget(x, "data"); v != nil {
				d = jsString(v)
			}
			m := reportDataRe.FindStringSubmatch(d)
			var id any
			if m != nil {
				id = saveReportImage(m[1], m[2])
			}
			if !truthy(id) {
				refuse(400, "지원하지 않는 그림 형식이에요")
			}
			images = append(images, id)
		}
		vids := asArr(b["videos"])
		if len(vids) > REPORT_VIDEOS {
			refuse(400, "영상은 "+itoa(REPORT_VIDEOS)+"개까지 붙일 수 있어요")
		}
		ups := []M{}
		for _, v := range vids {
			id := ""
			if x := mget(v, "id"); x != nil {
				id = jsString(x)
			}
			up := uploadOf(uid, id)
			if up == nil {
				refuse(400, "올린 영상을 찾지 못했어요. 다시 골라 주세요")
			}
			ups = append(ups, up)
		}
		if text == "" && len(images) == 0 && len(ups) == 0 {
			refuse(400, "보낼 내용이 없어요")
		}
		vlist := []any{}
		for _, up := range ups {
			vlist = append(vlist, orderedObj{{"id", up["id"]}, {"name", up["name"]}, {"type", up["type"]}, {"size", up["size"]}})
		}
		login := any("?")
		if uu, ok := users.Get(uid); ok && uu["login"] != nil {
			login = uu["login"]
		}
		id := uuidv4()
		report := orderedObj{{"id", id}, {"at", float64(nowMs())}, {"uid", uid}, {"login", login}, {"text", text}, {"images", images}, {"videos", vlist}, {"status", "new"}, {"debug", reportDebug(uid, b)}}
		mkdirAll(dirOf(reportVideoFile("x")), 0o700)
		for _, up := range ups {
			_ = os.Rename(mstr(up, "file"), reportVideoFile(mstr(up, "id")))
			_ = os.Remove(mstr(up, "file") + ".json")
		}
		writeJson(reportFile(id), report)
		logLine("report " + id + " from " + jsString(login))
		if truthy(reportAuto["on"]) {
			r := readJSON(reportFile(id), nil)
			if rm, ok := r.(M); ok {
				goLocked("autofix", func() { autoFix(rm) })
			}
		}
		jsonRes(res, 200, M{"ok": true, "id": id})
		return true
	}
	// 기존 데이터 정리 (REQ-S-075).
	if p == "/api/admin/purge" {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		enabled := PURGE
		if post {
			if !enabled {
				refuse(409, "정리는 꺼져 있어요. 서버 환경 변수 BRIDGE_PURGE=1(또는 bridge.yaml 의 retention.allowPurge: true)로 다시 시작한 뒤에 할 수 있어요")
			}
			b := body(req, 4096)
			kinds := []string{}
			for _, k := range asArr(b["kinds"]) {
				if s, ok := k.(string); ok {
					if _, has := PURGE_KINDS[s]; has {
						kinds = append(kinds, s)
					}
				}
			}
			if len(kinds) == 0 {
				refuse(400, "지울 종류를 골라 주세요")
			}
			who := uid
			if uu, ok := users.Get(uid); ok && uu["login"] != nil {
				who = jsString(uu["login"])
			}
			logLine("purge by " + who + ": " + strings.Join(kinds, ", "))
			done := purge(kinds)
			jsonRes(res, 200, orderedObj{{"ok", true}, {"done", done}, {"targets", purgeTargets()}})
			return true
		}
		if !get {
			refuse(405, "지원하지 않는 요청이에요")
		}
		kinds := orderedObj{}
		for _, k := range PURGE_KIND_ORDER {
			kinds = append(kinds, kv{k, PURGE_KINDS[k]})
		}
		jsonRes(res, 200, orderedObj{{"enabled", enabled}, {"since", RETENTION["since"]}, {"conversationReady", CONVERSATION_PURGE_READY}, {"kinds", kinds}, {"targets", purgeTargets()}})
		return true
	}
	if p == "/api/admin/reports/auto" {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		if post {
			b := body(req, 4096)
			if s, ok := b["cwd"].(string); ok && jsTrim(s) != "" {
				reportAuto["cwd"] = jsSliceTo(jsTrim(s), 1000)
			}
			if v, has := b["hostId"]; has && (v == nil || v == "") {
				reportAuto["hostId"] = nil
			} else if s, ok := b["hostId"].(string); ok {
				want := uid
				if truthy(reportAuto["on"]) && b["on"] != false {
					want = jsString(reportAuto["uid"])
				}
				if h, ok := hosts.Get(s); !ok || mstr(h, "uid") != want {
					refuse(400, "자동 대응을 켠 운영자의 맥이 아니에요")
				}
				reportAuto["hostId"] = s
			}
			turnedOn := b["on"] == true && !truthy(reportAuto["on"])
			if on, ok := b["on"].(bool); ok && on != truthy(reportAuto["on"]) {
				if on {
					login := any("?")
					if uu, ok := users.Get(uid); ok && uu["login"] != nil {
						login = uu["login"]
					}
					reportAuto["on"] = true
					reportAuto["uid"] = uid
					reportAuto["by"] = login
					reportAuto["since"] = float64(nowMs())
				} else {
					reportAuto["on"] = false
				}
			}
			if turnedOn && truthy(reportAuto["hostId"]) {
				if h, ok := hosts.Get(jsString(reportAuto["hostId"])); !ok || mstr(h, "uid") != uid {
					reportAuto["hostId"] = nil
				}
			}
			writeJson(REPORT_AUTO_FILE, reportAuto)
			if turnedOn {
				list := []M{}
				for _, r := range readReports() {
					if r["status"] == "new" {
						list = append(list, r)
					}
				}
				sort.SliceStable(list, func(i, j int) bool { return jsNumber(list[i]["at"]) < jsNumber(list[j]["at"]) })
				for _, r := range list {
					delete(r, "auto")
					rr := r
					goLocked("autofix", func() { autoFix(rr) })
				}
			}
			sweepReports()
		} else if !get {
			refuse(405, "지원하지 않는 요청이에요")
		}
		jsonRes(res, 200, reportAutoView())
		return true
	}
	if apiReports(req, res, u, uid) {
		return true
	}
	return false
}

func mgetOr(m M, k string, def any) any {
	if v, ok := m[k]; ok && v != nil {
		return v
	}
	return def
}

func dirOf(p string) string {
	i := strings.LastIndex(p, "/")
	if i < 0 {
		return "."
	}
	return p[:i]
}

var myReportsRe = regexp.MustCompile(`^/api/reports(?:/([a-zA-Z0-9-]+)(?:/(?:img/([0-9a-f]{40}\.(?:png|jpg|gif|webp))|video/([0-9a-f]{40}\.(?:mp4|mov|webm|m4v))))?)?$`)
var adminReportsRe = regexp.MustCompile(`^/api/admin/reports(?:/([a-zA-Z0-9-]+)(?:/(fix|img|video)(?:/([0-9a-f]{40}\.(?:png|jpg|gif|webp|mp4|mov|webm|m4v)))?)?)?$`)

func sendReportImage(res *Res, r M, id string) {
	file := reportImgFile(r, id)
	if !exists(file) {
		refuse(404, "그림이 없습니다")
	}
	res.WriteHead(200, M{"Content-Type": typeOfExt(strings.Split(id, ".")[1]), "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
	res.file = &fileSend{path: file}
	res.ended = true
}

func findVideo(r M, id string) M {
	for _, v := range asArr(r["videos"]) {
		if mget(v, "id") == id {
			return asM(v)
		}
	}
	return nil
}

func apiReports(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	if mr := myReportsRe.FindStringSubmatch(p); mr != nil {
		if mr[1] == "" {
			if !get {
				refuse(405, "지원하지 않는 요청이에요")
			}
			list := []M{}
			if exists(REPORTS) {
				ents, _ := os.ReadDir(REPORTS)
				for _, e := range ents {
					if !strings.HasSuffix(e.Name(), ".json") {
						continue
					}
					if r, ok := readJSON(REPORTS+"/"+e.Name(), nil).(M); ok && r["uid"] == uid {
						list = append(list, r)
					}
				}
			}
			sort.SliceStable(list, func(i, j int) bool { return jsNumber(list[i]["at"]) > jsNumber(list[j]["at"]) })
			out := []any{}
			for _, r := range list {
				vs := []any{}
				for _, v := range asArr(r["videos"]) {
					vs = append(vs, orderedObj{{"id", mget(v, "id")}, {"name", mget(v, "name")}})
				}
				out = append(out, orderedObj{{"id", r["id"]}, {"at", r["at"]}, {"text", r["text"]}, {"images", r["images"]}, {"videos", vs}, {"status", r["status"]}})
			}
			jsonRes(res, 200, M{"reports": out})
			return true
		}
		var r M
		if safeId(mr[1]) {
			r, _ = readJSON(reportFile(mr[1]), nil).(M)
		}
		if r == nil || (r["uid"] != uid && !(req.Method == "DELETE" && isAdmin(uid))) {
			refuse(404, "제보가 없습니다")
		}
		if get && mr[3] != "" {
			if v := findVideo(r, mr[3]); v != nil {
				sendVideo(req, res, reportVideoFile(mstr(v, "id")), mstr(v, "type"))
				return true
			}
		}
		if get && mr[2] != "" && containsAny(asArr(r["images"]), mr[2]) {
			sendReportImage(res, r, mr[2])
			return true
		}
		if req.Method == "DELETE" && mr[2] == "" && mr[3] == "" {
			dropReport(r)
			who := "?"
			if uu, ok := users.Get(uid); ok && uu["login"] != nil {
				who = jsString(uu["login"])
			}
			logLine("report " + jsString(r["id"]) + " removed by " + who)
			jsonRes(res, 200, M{"ok": true})
			return true
		}
		refuse(405, "지원하지 않는 요청이에요")
	}
	if rp := adminReportsRe.FindStringSubmatch(p); rp != nil {
		if !isAdmin(uid) {
			refuse(403, "운영자만 볼 수 있습니다")
		}
		if rp[1] == "" {
			if !get {
				refuse(405, "읽기만 됩니다")
			}
			sweepReports()
			list := readReports()
			sort.SliceStable(list, func(i, j int) bool { return jsNumber(list[i]["at"]) > jsNumber(list[j]["at"]) })
			out := []any{}
			for _, r := range list {
				dbg := asM(r["debug"])
				out = append(out, orderedObj{{"id", r["id"]}, {"at", r["at"]}, {"login", r["login"]}, {"text", jsSliceTo(mstr(r, "text"), 200)}, {"images", len(asArr(r["images"]))}, {"videos", len(asArr(r["videos"]))}, {"status", r["status"]}, {"fix", mgetOr(r, "fix", nil)}, {"auto", mgetOr(r, "auto", nil)}, {"where", mgetOr(asM(dbg["client"]), "path", nil)}, {"host", mgetOr(asM(dbg["session"]), "host", nil)}})
			}
			jsonRes(res, 200, orderedObj{{"reports", out}, {"auto", reportAutoView()}})
			return true
		}
		var r M
		if safeId(rp[1]) {
			r, _ = readJSON(reportFile(rp[1]), nil).(M)
		}
		if r == nil {
			refuse(404, "제보가 없습니다")
		}
		if get && rp[2] == "" {
			x := shallow(r)
			if f, ok := r["fix"].(M); ok && f != nil {
				fx := shallow(f)
				s, has := sessions.Get(mstr(f, "sid"))
				fx["open"] = has && !truthy(s.get("closed"))
				x["fix"] = fx
			} else {
				x["fix"] = nil
			}
			jsonRes(res, 200, M{"report": x})
			return true
		}
		if get && rp[2] == "img" && rp[3] != "" && containsAny(asArr(r["images"]), rp[3]) {
			sendReportImage(res, r, rp[3])
			return true
		}
		if get && rp[2] == "video" && rp[3] != "" {
			if v := findVideo(r, rp[3]); v != nil {
				sendVideo(req, res, reportVideoFile(mstr(v, "id")), mstr(v, "type"))
				return true
			}
		}
		if post && rp[2] == "fix" {
			b := body(req, 8192)
			sid := fixReport(r, uid, b["hostId"], b["cwd"], false, req)
			jsonRes(res, 200, M{"ok": true, "id": sid})
			return true
		}
		refuse(405, "지원하지 않는 요청이에요")
	}
	return false
}
