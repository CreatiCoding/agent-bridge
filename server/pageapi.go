package main

import (
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

var pluginChoicesRe = regexp.MustCompile(`^/api/plugins/([a-z0-9-]{1,40})/choices$`)
var pluginRe = regexp.MustCompile(`^/api/plugins/([a-z0-9-]{1,40})$`)

// pageApi: the plugin, new-session option and group routes. Returns true when the request was one of them.
func pageApi(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	get := req.Method == "GET"
	post := req.Method == "POST"
	ok := func(note string, more M) {
		out := M{"ok": true, "note": note}
		for k, v := range more {
			out[k] = v
		}
		jsonRes(res, 200, out)
	}
	if get && p == "/api/plugins" {
		jsonRes(res, 200, M{"plugins": plug.list(uid)})
		return true
	}
	// R1-M2: opening the link only asks; connecting is a form post from this page.
	if (get || post) && p == "/api/plugins/slack/link" {
		needFeature("slack")
		html := func(note string) {
			res.WriteHead(200, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}).EndS(page("Slack 연결", note))
		}
		inst, _ := plug.instance(uid, "slack").(slackLinker)
		if inst == nil {
			html("Slack 플러그인이 꺼져 있어요.")
			return true
		}
		if post {
			q, _ := url.ParseQuery(string(rawBody(req, 4096)))
			html(escHtml(inst.link(q.Get("code"))))
			return true
		}
		code := u.Query().Get("code")
		who := inst.who(code)
		if who == nil {
			html("링크가 만료됐어요. Slack 채널에 글을 다시 써 주세요.")
			return true
		}
		html("Slack 사용자 <b>" + escHtml(jsString(who["name"])) + "</b> (" + escHtml(jsString(who["user"])) + ") 를 내 Agent Bridge 계정(" + escHtml(strOr(mget(users.Val(uid), "login"), "")) + ")에 연결할까요? 연결하면 이 Slack 사용자가 채널에서 내 맥에 세션을 띄우고 글을 보낼 수 있어요. 내 Slack 계정이 아니면 연결하지 마세요.</p><form method=\"post\"><input type=\"hidden\" name=\"code\" value=\"" + escHtml(code) + "\"><button type=\"submit\">연결</button></form><p>")
		return true
	}
	if pc := pluginChoicesRe.FindStringSubmatch(p); post && pc != nil {
		needPlugin(pc[1])
		b := body(req, 16*1024)
		var choices any
		key := ""
		if b["key"] != nil {
			key = jsString(b["key"])
		}
		if err := try(func() { choices = plug.choices(uid, pc[1], key, b["config"]) }); err != nil {
			jsonRes(res, 400, M{"ok": false, "note": err.Error()})
			return true
		}
		jsonRes(res, 200, M{"ok": true, "choices": choices})
		return true
	}
	if pl := pluginRe.FindStringSubmatch(p); post && pl != nil {
		needPlugin(pl[1])
		b := body(req, 16*1024)
		notes := []string{}
		if err := try(func() {
			if b["remove"] == true {
				plug.remove(uid, pl[1])
			} else {
				notes = plug.set(uid, pl[1], b["enabled"], b["config"])
			}
		}); err != nil {
			jsonRes(res, 400, M{"ok": false, "note": err.Error()})
			return true
		}
		first := "저장했어요"
		if b["remove"] == true {
			first = "플러그인을 뺐어요"
		} else if b["enabled"] == false {
			first = "껐어요"
		}
		ok(strings.Join(append([]string{first}, notes...), ". "), M{"plugins": plug.list(uid)})
		return true
	}
	if get && p == "/api/options" {
		out := shallow(CS_OPTIONS)
		out["models"] = modelList()
		modes := []any{}
		for _, m := range asArr(CS_OPTIONS["modes"]) {
			if modeOk(mstr(m, "value")) {
				modes = append(modes, m)
			}
		}
		out["modes"] = modes
		jsonRes(res, 200, out)
		return true
	}
	if get && p == "/api/groups" {
		jsonRes(res, 200, csGroups(uid))
		return true
	}
	if post && p == "/api/groups" {
		err := try(func() {
			b := body(req, 64*1024)
			sid := func(t any) any {
				s := ""
				if t != nil {
					s = jsString(t)
				}
				if m := byThread(uid, s); m != nil {
					return m.id()
				}
				return nil
			}
			op := shallow(b)
			if b["op"] == "move" {
				s := b["session"]
				if s == nil {
					s = sid(b["thread"])
				}
				op["session"] = s
				var before any
				if truthy(b["before"]) {
					before = sid(b["before"])
					if before == nil {
						before = b["before"]
					}
				}
				op["before"] = before
			}
			if b["op"] == "loose" {
				order := []any{}
				for _, t := range asArr(b["order"]) {
					if s := sid(t); truthy(s) {
						order = append(order, s)
					}
				}
				op["order"] = order
			}
			r := groupOp(uid, op)
			if held, isHeld := r["held"].([]any); isHeld {
				// Emptying a group deletes every session in it and in the groups inside it.
				pf := prefsOf(uid)
				gone := []any{}
				for _, id := range held {
					s, _ := sessions.Get(jsString(id))
					if s == nil || s.uid() != uid {
						gone = append(gone, id)
					}
				}
				for _, x := range groupsList(pf) {
					items := []any{}
					for _, i := range asArr(x["items"]) {
						if !containsAny(gone, i) {
							items = append(items, i)
						}
					}
					x["items"] = items
				}
				all := []*Sess{}
				for _, id := range held {
					if s, ok := sessions.Get(jsString(id)); ok && s.uid() == uid {
						all = append(all, s)
					}
				}
				kept := 0
				for _, m := range all {
					if truthy(m.get("lock")) || truthy(m.get("moving")) {
						kept++
						continue
					}
					sessionOp(uid, m, "", nil, "DELETE", "")
				}
				n := len(all) - kept
				if len(all) == 0 {
					r["note"] = "그룹이 이미 비어 있어요."
				} else {
					note := "세션 " + itoa(n) + "개를 지웠어요."
					if kept > 0 {
						note += " 잠겼거나 옮기는 중인 세션 " + itoa(kept) + "개는 남겼어요."
					}
					r["note"] = note
				}
			}
			savePrefs(uid)
			more := M{}
			if truthy(r["id"]) {
				more["id"] = r["id"]
			}
			ok(strOr(r["note"], ""), more)
		})
		if err != nil {
			rf, isRefuse := err.(*Refuse)
			if !isRefuse {
				panic(err)
			}
			out := M{"ok": false, "note": rf.Msg}
			for k, v := range rf.Extra {
				out[k] = v
			}
			jsonRes(res, 400, out)
		}
		return true
	}
	return false
}

var bgKindNames = map[string]string{"agent": "에이전트", "monitor": "Monitor", "bash": "백그라운드 명령"}

// refreshSession: reopen a session in place (the conversation goes on) with the default prompt as it is now.
func refreshSession(uid string, meta *Sess, hostID string, when string) {
	if when == "" {
		when = "now"
	}
	bg := asArr(meta.get("bg"))
	interrupted := []any{}
	for _, t := range bg {
		name, ok := bgKindNames[mstr(t, "kind")]
		if !ok {
			name = "undefined"
		}
		interrupted = append(interrupted, name+": "+jsString(mget(t, "label")))
	}
	toHost(hostID, M{"t": "refresh", "sid": meta.id(), "bg": float64(len(bg)), "sysPrompt": sysPromptOf(uid), "interrupted": interrupted, "when": when})
	if when == "now" {
		meta.set("bg", []any{})
	}
}

// setDefaultPrompt: a changed default prompt is taken by every session that is up, at once.
func setDefaultPrompt(uid string, text string) string {
	want := jsTrim(text)
	if want == "" {
		want = BUILTIN_DEFAULT_PROMPT
	}
	changed := sysPromptOf(uid) != want
	prefsOf(uid)["defaultPrompt"] = text
	savePrefs(uid)
	if !changed {
		return "바뀐 내용이 없어 세션은 그대로예요."
	}
	done, working, kept := 0, 0, 0
	for _, meta := range sessions.Values() {
		st := meta.state()
		if meta.uid() != uid || truthy(meta.get("closed")) || !truthy(st["alive"]) {
			continue
		}
		if truthy(meta.get("lock")) || truthy(meta.get("moving")) || truthy(st["handedOffTo"]) || !online(meta.host()) {
			kept++
			continue
		}
		if st["phase"] == "busy" || st["phase"] == "waiting" {
			working++
		}
		record(uid, meta.host(), M{"area": "prompt", "sid": meta.id(), "text": "기본 프롬프트가 바뀌어 다시 엶 (" + jsString(st["phase"]) + ")"})
		refreshSession(uid, meta, meta.host(), "")
		done++
	}
	if done == 0 {
		if kept > 0 {
			return "잠겼거나 연결이 끊긴 세션 " + itoa(kept) + "개는 다음에 다시 열 때 적용돼요."
		}
		return "새로 띄우는 세션부터 적용돼요."
	}
	out := "세션 " + itoa(done) + "개를 새로고침해 바로 적용했어요"
	if working > 0 {
		out += " · 일하던 " + itoa(working) + "개는 다시 뜬 뒤 하던 작업을 이어가요"
	}
	if kept > 0 {
		out += " · 잠겼거나 연결이 끊긴 " + itoa(kept) + "개는 다음에 다시 열 때 적용돼요"
	}
	return out + "."
}

// maskHealth: an agent's health as an operator may see it on someone else's Mac (R8-L3, R10-L1).
func maskHealth(h M) M {
	hide := func(o any, keys ...string) M {
		out := shallow(asM(o))
		for _, k := range keys {
			if truthy(mget(o, k)) {
				out[k] = hidePaths(mget(o, k))
			}
		}
		return out
	}
	out := shallow(h)
	mapList := func(k string, keys ...string) []any {
		l := []any{}
		for _, x := range asArr(h[k]) {
			l = append(l, hide(x, keys...))
		}
		return l
	}
	out["checks"] = mapList("checks", "detail", "fix")
	out["features"] = mapList("features", "detail", "fix")
	out["repairs"] = mapList("repairs", "text")
	if truthy(h["background"]) {
		out["background"] = hide(h["background"], "error")
	}
	return out
}

var accountIDRe = regexp.MustCompile(`^a[0-9a-f]{8}$`)

// safeAccount: ” is a Mac's main account, an added one is `a` and 8 hex letters.
func safeAccount(id any) bool {
	s, ok := id.(string)
	return ok && (s == "" || accountIDRe.MatchString(s))
}

func cleanAccounts(list any) []any {
	text := func(v any, n int) any {
		if s, ok := v.(string); ok {
			return jsSliceTo(s, n)
		}
		return nil
	}
	out := []any{}
	for _, a := range asArr(list) {
		if !truthy(a) || !safeAccount(mget(a, "id")) {
			continue
		}
		if len(out) >= 11 {
			break
		}
		id := mstr(a, "id")
		name := text(mget(a, "name"), 40)
		if !truthy(name) {
			if id != "" {
				name = "계정"
			} else {
				name = "기본 계정"
			}
		}
		var li any
		if b, ok := mget(a, "loggedIn").(bool); ok {
			li = b
		}
		n := jsNumber(mget(a, "sessions"))
		if n != n {
			n = 0
		}
		out = append(out, M{"id": id, "name": name, "main": id == "", "loggedIn": li, "email": text(mget(a, "email"), 200), "plan": text(mget(a, "plan"), 40), "method": text(mget(a, "method"), 40), "sessions": n, "signingIn": mget(a, "signingIn") == true})
	}
	return out
}

var ACCOUNT_OP_NAMES = map[string]string{"list": "목록", "add": "추가", "rename": "이름 바꾸기", "login": "로그인 시작", "code": "로그인 코드 입력", "cancel": "로그인 취소", "logout": "로그아웃", "sync": "공유 설정 다시 맞추기", "remove": "빼기"}

// accountsBrief: a host's accounts without the e-mail addresses.
func accountsBrief(h M) []any {
	out := []any{}
	for _, a := range asArr(h["accounts"]) {
		m := shallow(asM(a))
		delete(m, "email")
		out = append(out, m)
	}
	return out
}

var voiceNameRe = regexp.MustCompile(`^[\w.-]{1,64}$`)

func cleanVoiceStatus(v any) any {
	m, ok := v.(M)
	if !ok || m == nil {
		return nil
	}
	names := func(a any) []any {
		out := []any{}
		for _, x := range asArr(a) {
			if s, ok := x.(string); ok && voiceNameRe.MatchString(s) {
				out = append(out, s)
			}
		}
		if len(out) > 20 {
			out = out[:20]
		}
		return out
	}
	var vad any
	if s, ok := m["vad"].(string); ok && contains([]string{"on", "off", "idle"}, s) {
		vad = s
	}
	return M{"whisper": m["whisper"] == true, "models": names(m["models"]), "vadModel": m["vadModel"] == true, "vad": vad, "ffmpeg": m["ffmpeg"] == true}
}

// cleanSys: what an agent says about its CPU, memory and disk (REQ-F-800), numbers only.
func cleanSys(v any) any {
	m, ok := v.(M)
	if !ok || m == nil {
		return nil
	}
	num := func(v any) any {
		if f, ok := v.(float64); ok && !math.IsInf(f, 0) && f == f && f >= 0 {
			return f
		}
		return nil
	}
	var disk any
	if d, ok := m["disk"].(M); ok && d != nil {
		disk = M{"total": num(d["total"]), "used": num(d["used"]), "avail": num(d["avail"]), "pct": num(d["pct"])}
	}
	return M{"cpu": num(m["cpu"]), "cores": num(m["cores"]), "memUsed": num(m["memUsed"]), "memTotal": num(m["memTotal"]), "disk": disk, "battery": cleanBattery(m["battery"], num)}
}

// BATTERY_KEEP_MS: how often an unchanged battery is written to the host record again (REQ-F-807).
const BATTERY_KEEP_MS = 600_000

// keepBattery keeps the last battery a host reported, and when, on its record (saved with the hosts), so the
// operator page still shows it after the host goes away or the server restarts (REQ-F-807). Written when it
// changes, else at most every BATTERY_KEEP_MS.
func keepBattery(h M, health M, now int64) {
	b, ok := mget(cleanSys(health["sys"]), "battery").(M)
	if !ok || h == nil {
		return
	}
	if prev, ok := h["battery"].(M); ok {
		same := shallow(prev)
		delete(same, "at")
		if jsonStr(same) == jsonStr(b) && float64(now)-numOr0(prev["at"]) < BATTERY_KEEP_MS {
			return
		}
	}
	kept := shallow(b)
	kept["at"] = float64(now)
	h["battery"] = kept
	touchGlobals()
}

// keepBackground keeps the last background.on a host reported, and when, on its record (REQ-F-811). health lives
// only in memory and is emptied when the host connects again, so a server that turns on auth.headerOnly still knows
// which hosts had the headless link on. Written when it changes, else at most every BATTERY_KEEP_MS.
func keepBackground(h M, health M, now int64) {
	b, ok := health["background"].(M)
	if !ok || h == nil {
		return
	}
	on, _ := b["on"].(bool)
	if prev, ok := h["lastBackground"].(M); ok && prev["on"] == on && float64(now)-numOr0(prev["at"]) < BATTERY_KEEP_MS {
		return
	}
	h["lastBackground"] = M{"on": on, "at": float64(now)}
	touchGlobals()
}

// batteryStates are the words an agent may use for a battery (REQ-F-806).
var batteryStates = map[string]bool{"charging": true, "discharging": true, "full": true, "idle": true}

// cleanBattery keeps a battery report to its known fields (REQ-F-806): two flags, a state word and numbers.
func cleanBattery(v any, num func(any) any) any {
	b, ok := v.(M)
	if !ok || b == nil {
		return nil
	}
	present, _ := b["present"].(bool)
	ac, _ := b["ac"].(bool)
	if !present {
		return M{"present": false, "ac": ac}
	}
	var state any
	if s, ok := b["state"].(string); ok && batteryStates[s] {
		state = s
	}
	pct := num(b["pct"])
	if f, ok := pct.(float64); ok && f > 100 {
		pct = nil
	}
	return M{"present": true, "ac": ac, "pct": pct, "state": state, "remain": num(b["remain"]), "cycles": num(b["cycles"]), "health": num(b["health"])}
}

func cleanKeyState(k any) any {
	m, ok := k.(M)
	if !ok || m == nil {
		return nil
	}
	num := func(v any) any {
		if f, ok := v.(float64); ok && !math.IsInf(f, 0) && f == f {
			return f
		}
		return nil
	}
	app := func(v any) any {
		if s, ok := v.(string); ok && voiceNameRe.MatchString(s) {
			return s
		}
		return nil
	}
	event := func(e any) any {
		em, ok := e.(M)
		if !ok || em == nil || !truthy(num(em["at"])) {
			return nil
		}
		out := M{"at": em["at"], "app": app(em["app"])}
		if b, ok := em["ok"].(bool); ok {
			out["ok"] = b
		}
		return out
	}
	retired := num(m["retired"])
	if retired == nil {
		retired = 0.0
	}
	var linked any
	if s, ok := m["linked"].(string); ok && (s == "current" || s == "old") {
		linked = s
	}
	// The key changes (REQ-S-084): times and two short words only, at most five.
	orNil := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	changes := []any{}
	if arr, ok := m["log"].([]any); ok {
		for _, e := range arr {
			em, ok := e.(M)
			if !ok || em == nil || !truthy(num(em["at"])) || len(changes) >= 5 {
				continue
			}
			why, _ := em["why"].(string)
			if !contains([]string{"auto", "site", "gen"}, why) {
				why = ""
			}
			result, _ := em["result"].(string)
			if !contains([]string{"took", "waiting", "missed"}, result) {
				result = ""
			}
			changes = append(changes, M{"at": em["at"], "why": orNil(why), "took": num(em["took"]), "result": orNil(result)})
		}
	}
	return M{"gen": num(m["gen"]), "latest": num(m["latest"]), "at": num(m["at"]), "oldUntil": num(m["oldUntil"]), "next": num(m["next"]), "retired": retired, "linked": linked, "stale": event(m["stale"]), "reopen": event(m["reopen"]), "log": changes}
}

// hostSummary: a Mac at a glance. `masked`: for an operator on someone else's Mac, the error texts lose their paths.
func hostSummary(id string, h M, masked bool) M {
	st := live(id)
	health := asM(st["health"])
	failing := []any{}
	for _, c := range asArr(health["checks"]) {
		if mget(c, "level") == "fail" {
			failing = append(failing, c)
		}
	}
	var problem any
	if len(failing) > 0 {
		problem = jsString(mget(failing[0], "title")) + ": " + jsString(mget(failing[0], "detail"))
	}
	lastError := st["lastError"]
	if truthy(lastError) && masked {
		le := shallow(asM(lastError))
		le["text"] = hidePaths(le["text"])
		lastError = le
	}
	background := health["background"]
	if masked && truthy(mget(background, "error")) {
		b := shallow(asM(background))
		b["error"] = hidePaths(b["error"])
		background = b
	}
	kind := h["kind"]
	if kind == nil {
		kind = "other"
	}
	info := h["info"]
	var voice, sudo any
	if !masked {
		voice = cleanVoiceStatus(health["voice"])
		sudo = sudoView(id)
	}
	behind := truthy(info) && mget(info, "build") != AGENT_BUILD
	if masked && problem != nil {
		problem = hidePaths(problem)
	}
	accts := accountsBrief(h)
	if masked {
		for i, a := range accts {
			m := shallow(asM(a))
			delete(m, "name")
			accts[i] = m
		}
	}
	return M{"id": id, "name": h["name"], "kind": kind, "info": info, "awake": health["awake"], "voice": voice, "takesWork": !delegateOff(mstr(h, "uid"))[id], "sudo": sudo, "background": background,
		// Behind, and this server will hand it the new one: not when it sends none (R9-I1).
		"outdated": behind && AGENT_SIGNED,
		// Behind, but this server sends no update (R10-I2).
		"updateBlocked": behind && !AGENT_SIGNED, "key": cleanKeyState(health["keyState"]), "sys": cleanSys(health["sys"]), "battery": h["battery"], "diskHelp": diskHelpView(h["diskHelp"]), "problems": float64(len(failing)), "problem": problem, "online": shownOnline(id), "stale": shownOnline(id) && truthy(st["stale"]), "lastSeen": h["lastSeen"], "healthAt": st["healthAt"], "rtt": st["rtt"], "errors": st["errors"], "lastError": lastError, "accounts": accts}
}

// hostDetail: a Mac's state for its owner, or for an operator looking at someone else's Mac (R1-M5).
func hostDetail(hostID, viewer string) M {
	h := hosts.Val(hostID)
	other := viewer != mstr(h, "uid")
	st := live(hostID)
	health := asM(st["health"])
	agentSessions := map[string]M{}
	for _, s := range asArr(health["sessions"]) {
		agentSessions[jsString(mget(s, "id"))] = asM(s)
	}
	host := hostSummary(hostID, h, other)
	user := mget(users.Val(mstr(h, "uid")), "login")
	if user == nil {
		user = h["uid"]
	}
	host["user"] = user
	if other {
		host["home"] = ""
	} else {
		host["home"] = h["home"]
	}
	host["latest"] = AGENT_BUILD
	if !other {
		a := h["accounts"]
		if a == nil {
			a = []any{}
		}
		host["accounts"] = a
	}
	var hv any
	if truthy(st["health"]) {
		var hh M
		if other {
			hh = maskHealth(health)
		} else {
			hh = shallow(health)
		}
		delete(hh, "sessions")
		hh["at"] = st["healthAt"]
		hv = hh
	} else {
		hv = st["health"]
	}
	var pg any = st["page"]
	if truthy(st["page"]) {
		pm := shallow(asM(st["page"]))
		pm["at"] = st["pageAt"]
		pg = pm
	}
	list := []any{}
	for _, m := range sessions.Values() {
		if m.host() != hostID || truthy(m.get("closed")) {
			continue
		}
		a, has := agentSessions[m.id()]
		var shown M
		if other {
			cp := &Sess{m: shallow(m.m)}
			if !truthy(cp.m["lock"]) {
				cp.m["lock"] = true
			}
			cp.m["manualTitle"] = false
			shown = shielded(cp)
		} else {
			shown = shielded(m)
		}
		var title any = ""
		if !other {
			title = shown["title"]
		}
		or := func(k string) any {
			if has && a[k] != nil {
				return a[k]
			}
			return nil
		}
		var behind any
		if has {
			behind = math.Max(0, jsNumber(a["lines"])-jsNumber(m.get("lines")))
		}
		var pe any
		if other {
			if has && truthy(a["pushError"]) {
				pe = "(가림)"
			}
		} else {
			pe = or("pushError")
		}
		list = append(list, M{"id": m.id(), "title": title, "cwd": shown["cwd"], "state": shown["state"], "locked": truthy(m.get("lock")), "hooks": or("hooks"), "serverLines": m.get("lines"), "agentLines": or("lines"), "behind": behind, "syncedAt": m.get("syncedAt"), "transcriptBytes": or("transcriptBytes"), "tmux": or("tmux"), "mux": or("mux"), "folderAt": or("folderAt"), "pushError": pe, "knownToAgent": has})
	}
	return M{
		"host":     host,
		"link":     M{"connectedAt": st["connectedAt"], "disconnectedAt": st["disconnectedAt"], "connects": st["connects"], "rtt": st["rtt"], "rttAt": st["rttAt"]},
		"health":   hv,
		"page":     pg,
		"sessions": list,
	}
}

// startHeartbeat: ping every connected host through its bridge page, and notice the ones whose agent has gone quiet.
func startHeartbeat() {
	setInterval(HEARTBEAT_MS*time.Millisecond, func() {
		for _, hostID := range bridges.Keys() {
			st := live(hostID)
			toHost(hostID, M{"t": "ping", "ts": float64(nowMs())})
			quiet := float64(nowMs()) - math.Max(numOr0(st["healthAt"]), numOr0(st["connectedAt"]))
			if !truthy(st["stale"]) && quiet > STALE_MS {
				st["stale"] = true
				uid := mstr(hosts.Val(hostID), "uid")
				record(uid, hostID, M{"level": "warn", "area": "heartbeat", "text": "연동 페이지는 붙어 있는데 에이전트가 " + numStr(math.Round(quiet/1000)) + "초째 상태를 보내지 않음 (탭이 멈췄거나 에이전트가 죽었을 수 있음)"})
				broadcastState(uid)
			}
		}
	})
}

var stateDrop = []string{"uid", "silentUntil", "stats", "prLinks", "agentLog", "_legacy"}

func stateOf(uid string) M {
	hs := []any{}
	for _, id := range hosts.Keys() {
		h := hosts.Val(id)
		if mstr(h, "uid") == uid {
			hs = append(hs, hostSummary(id, h, false))
		}
	}
	pf := prefsOf(uid)
	col := pf["collapsed"]
	if col == nil {
		col = []any{}
	}
	notices := []any{}
	for _, n := range noticesOf(uid, nil) {
		m := shallow(asM(n))
		delete(m, "key")
		notices = append(notices, m)
	}
	places := []any{}
	if inst := plug.instance(uid, "slack"); inst != nil {
		if _, ok := inst.(seatMover); ok && mget(inst.status(), "state") == "on" {
			places = append(places, "slack")
		}
	}
	list := []*Sess{}
	for _, m := range sessions.Values() {
		if m.uid() == uid {
			list = append(list, m)
		}
	}
	rows := make([]M, len(list))
	for i, meta := range list {
		m := shielded(meta)
		for _, k := range stateDrop {
			delete(m, k)
		}
		rows[i] = m
	}
	sort.SliceStable(rows, func(i, j int) bool { return jsNumber(rows[i]["createdAt"]) < jsNumber(rows[j]["createdAt"]) })
	return M{
		"t":        "state",
		"hosts":    hs,
		"groups":   M{"groups": pf["groups"], "loose": pf["loose"], "collapsed": col},
		"splits":   splitsOf(uid),
		"notices":  notices,
		"places":   places,
		"ui":       uiBuild(),
		"sessions": anyList(rows),
	}
}

// sendState: the first state to a page is whole; after that only what changed.
var STATE_PARTS = []string{"hosts", "groups", "splits", "notices", "places", "ui"}

type stateSnap struct {
	order []string
	rows  map[string]string
	parts map[string]string
}

func sendState(res *Stream, st M) {
	snap := &stateSnap{rows: map[string]string{}, parts: map[string]string{}}
	for _, r := range asArr(st["sessions"]) {
		id := jsString(mget(r, "id"))
		if _, ok := snap.rows[id]; !ok {
			snap.order = append(snap.order, id)
		}
		snap.rows[id] = jsonStr(r)
	}
	for _, k := range STATE_PARTS {
		snap.parts[k] = jsonStr(st[k])
	}
	last := res.lastState
	res.lastState = snap
	if last == nil || !res.wantsDelta {
		sse(res, st)
		return
	}
	d := M{"t": "state_delta"}
	for _, k := range STATE_PARTS {
		if snap.parts[k] != last.parts[k] {
			d[k] = st[k]
		}
	}
	changed := []any{}
	for _, r := range asArr(st["sessions"]) {
		id := jsString(mget(r, "id"))
		if lr, ok := last.rows[id]; !ok || lr != snap.rows[id] {
			changed = append(changed, r)
		}
	}
	if len(changed) > 0 {
		d["changed"] = changed
	}
	same := len(snap.order) == len(last.order)
	if same {
		for i := range snap.order {
			if snap.order[i] != last.order[i] {
				same = false
				break
			}
		}
	}
	if !same {
		d["order"] = anyList(snap.order)
	}
	if len(d) > 1 {
		sse(res, d)
	}
}

var stateTimers = map[string]*Timer{}

func broadcastState(uid string) {
	if _, ok := stateTimers[uid]; ok {
		return
	}
	stateTimers[uid] = setTimeout(150*time.Millisecond, func() {
		delete(stateTimers, uid)
		toControls(uid, stateOf(uid))
	})
}
