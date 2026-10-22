package main

import (
	"math"
	"regexp"
	"strings"
	"time"
)

// ---------- 다른 맥에 맡기기 (REQ-F-760) ----------

const (
	DELEGATE_MAX        = 3
	DELEGATE_GROUP      = "Bridge 맡긴 세션"
	DELEGATE_WAIT_MAX   = 1_800_000
	DELEGATE_SETTLE_MS  = 5000
	DELEGATE_REPORT_MAX = 6000
)

// delegateOff: Macs the person turned off for work from other Macs (설정 → 맥).
func delegateOff(uid string) map[string]bool {
	out := map[string]bool{}
	for _, x := range asArr(prefsOf(uid)["delegateOff"]) {
		if s, ok := x.(string); ok {
			out[s] = true
		}
	}
	return out
}

// delegatesOf: the open sessions a session handed work to.
func delegatesOf(meta *Sess) []*Sess {
	out := []*Sess{}
	for _, id := range asArr(meta.get("delegates")) {
		c, ok := sessions.Get(jsString(id))
		if ok && !truthy(c.get("closed")) && c.get("delegatedBy") == meta.id() {
			out = append(out, c)
		}
	}
	return out
}

// delegateState: where a session handed work to stands, from the events after `since`.
func delegateState(meta *Sess, since float64) M {
	answer := ""
	for _, e := range readEvents(meta, true) {
		if mnum(e, "seq") > since && mstr(e, "k") == "text" && truthy(mget(e, "text")) {
			answer = jsString(mget(e, "text"))
		}
	}
	phase := meta.state()["phase"]
	if phase == nil {
		phase = "ended"
	}
	state := "working"
	if truthy(meta.get("closed")) {
		state = "closed"
	} else if phase == "waiting" {
		state = "waiting"
	} else if (phase == "idle" || phase == "ended") && answer != "" {
		state = "done"
	}
	out := M{"state": state, "phase": phase}
	if state == "waiting" && truthy(mget(meta.get("card"), "title")) {
		out["waitingOn"] = jsSliceTo(jsString(mget(meta.get("card"), "title")), 200)
	}
	if jsLen(answer) > 20_000 {
		answer = jsSliceTo(answer, 20_000) + "\n…(잘림)"
	}
	out["answer"] = answer
	return out
}

// awaited: sid → tool calls waiting on that session right now.
var awaited = map[string]int{}

func waitTurn(meta *Sess, since float64, ms float64) M {
	end := float64(nowMs()) + ms
	doneSince := 0.0
	awaited[meta.id()]++
	defer func() {
		n := awaited[meta.id()] - 1
		if awaited[meta.id()] == 0 {
			n = 0
		}
		if n > 0 {
			awaited[meta.id()] = n
		} else {
			delete(awaited, meta.id())
		}
	}()
	for {
		st := delegateState(meta, since)
		now := float64(nowMs())
		if st["state"] == "done" {
			if doneSince == 0 {
				doneSince = now
			}
		} else {
			doneSince = 0
		}
		if (doneSince != 0 && now-doneSince >= DELEGATE_SETTLE_MS) || st["state"] == "closed" || now >= end {
			// The call hands this answer over itself: the follow-up message below does not send it again.
			if st["state"] == "done" {
				meta.set("reportedSeq", numOr0(meta.get("seq")))
			}
			return st
		}
		sleep(time.Second)
	}
}

var followTimers = map[string]*Timer{}
var arrowPrefixRe = re(`^↪\s*`)

// followDelegate: a session that was handed work and finished a turn tells the session that handed it over (1.236).
func followDelegate(c *Sess) {
	clearTimeout(followTimers[c.id()])
	followTimers[c.id()] = setTimeout(DELEGATE_SETTLE_MS*time.Millisecond, func() {
		delete(followTimers, c.id())
		parent, ok := sessions.Get(strOr(c.get("delegatedBy"), ""))
		if truthy(c.get("closed")) || !ok || truthy(parent.get("closed")) || parent.uid() != c.uid() || awaited[c.id()] > 0 {
			return
		}
		st := delegateState(c, numOr0(c.get("reportedSeq")))
		if st["state"] != "done" {
			return
		}
		c.set("reportedSeq", numOr0(c.get("seq")))
		touch(c)
		host := "다른 맥"
		if h, ok := hosts.Get(c.host()); ok && h["name"] != nil {
			host = jsString(h["name"])
		}
		answer := mstr(st, "answer")
		if jsLen(answer) > DELEGATE_REPORT_MAX {
			answer = jsSliceTo(answer, DELEGATE_REPORT_MAX) + "\n…(잘림, 전체는 delegate_status)"
		}
		title := jsSliceTo(arrowPrefixRe.ReplaceAllString(strOr(c.get("title"), ""), ""), 60)
		if !truthy(c.get("title")) {
			title = ""
		}
		text := "↪ " + host + " 에 맡긴 세션의 턴이 끝났어요 (id " + c.id() + ", \"" + title + "\")\n\n" + answer
		if !truthy(parent.state()["alive"]) || !online(parent.host()) {
			logEvents(parent, []any{M{"k": "notice", "tone": "info", "text": "↪ " + host + " 에 맡긴 세션이 끝났어요. 이 세션이 멈춰 있어 전하지 못했어요"}})
			return
		}
		goLocked("delegate follow", func() {
			if err := try(func() { sessionOp(parent.uid(), parent, "send", M{"text": text, "via": "delegated"}, "", "") }); err != nil {
				logLine("delegate follow " + c.id() + ": " + err.Error())
				return
			}
			record(parent.uid(), parent.host(), M{"level": "info", "area": "delegate", "sid": parent.id(), "text": "맡긴 세션 " + jsSliceTo(c.id(), 8) + " 의 답을 전함"})
		})
	})
}

// runDelegate: one request of a session's bridge MCP server, through its Mac's agent (agent/mcp.mjs).
func runDelegate(uid, hostID string, msg M) any {
	parent, ok := sessions.Get(strOr(msg["sid"], ""))
	if !ok || parent.uid() != uid || parent.host() != hostID || truthy(parent.get("closed")) {
		throw("이 세션을 서버가 모릅니다")
	}
	a, _ := msg["args"].(M)
	if a == nil {
		a = M{}
	}
	ts := numOr0(a["timeout_s"])
	if ts == 0 {
		ts = 600
	}
	ms := math.Min(DELEGATE_WAIT_MAX, math.Max(10, ts)*1000)
	brief := func(c *Sess, st M) M {
		out := M{"id": c.id(), "host": ""}
		if h, ok := hosts.Get(c.host()); ok && h["name"] != nil {
			out["host"] = h["name"]
		}
		for k, v := range st {
			out[k] = v
		}
		return out
	}
	child := func() *Sess {
		c, ok := sessions.Get(strOr(a["id"], ""))
		if !ok || c.uid() != uid || c.get("delegatedBy") != parent.id() {
			throw("이 세션이 맡긴 세션이 아니에요")
		}
		return c
	}
	own := []string{}
	for _, id := range hosts.Keys() {
		if mstr(hosts.Val(id), "uid") == uid {
			own = append(own, id)
		}
	}
	switch msg["op"] {
	case "hosts":
		out := []any{}
		off := delegateOff(uid)
		for _, id := range own {
			out = append(out, M{"name": hosts.Val(id)["name"], "online": online(id), "takesWork": !off[id], "thisMac": id == hostID})
		}
		return out
	case "delegate":
		// One level only: a session that was handed work does not hand it on.
		if truthy(parent.get("delegatedBy")) {
			throw("맡겨진 세션은 다른 맥에 다시 맡길 수 없어요")
		}
		name := strings.ToLower(jsTrim(strOr(a["host"], "")))
		target := ""
		for _, id := range own {
			if id == a["host"] || strings.ToLower(jsStringU(hosts.Val(id)["name"])) == name {
				target = id
				break
			}
		}
		if target == "" {
			throw("그런 맥이 없어요: " + jsStringU(a["host"]) + ". hosts 로 이름을 확인하세요")
		}
		h := hosts.Val(target)
		hn := jsStringU(h["name"])
		if delegateOff(uid)[target] {
			throw(hn + " 은 다른 맥의 일을 받지 않게 꺼져 있어요(맥 화면에서 켤 수 있어요)")
		}
		if !online(target) {
			throw(hn + " 이 연결돼 있지 않아요")
		}
		task := jsTrim(strOr(a["task"], ""))
		if task == "" {
			throw("task 가 비어 있어요")
		}
		if len(delegatesOf(parent)) >= DELEGATE_MAX {
			throw("이미 " + itoa(DELEGATE_MAX) + "개를 맡겨 두었어요. 끝난 것은 delegate_stop 으로 닫으세요")
		}
		// It follows this session's permission policy; no folder named: a new one under the person's default folder.
		L := launchOf(uid)
		given := jsTrim(strOr(a["cwd"], ""))
		cwd := given
		if cwd == "" {
			var group any
			for _, g := range groupsList(prefsOf(uid)) {
				if containsAny(asArr(g["items"]), parent.id()) {
					group = g["name"]
					break
				}
			}
			cwd = defaultFolder(L["folderBase"], L["folderNoGroup"], group)
		}
		mode := "default"
		if truthy(parent.get("autoAllow")) {
			mode = "autoAllow"
		}
		sid := startSession(uid, M{"hostId": target, "cwd": cwd, "create": given == "", "prompt": task, "title": "↪ " + jsSliceTo(collapse(task), 70), "mode": mode, "via": "delegate", "group": namedGroup(uid, DELEGATE_GROUP)}, &Req{internal: true, Header: map[string][]string{}})
		c, _ := sessions.Get(sid)
		from := ""
		if hh, ok := hosts.Get(hostID); ok && hh["name"] != nil {
			from = jsString(hh["name"])
		}
		c.set("delegatedBy", parent.id())
		ds := []any{}
		for _, id := range asArr(parent.get("delegates")) {
			if sessions.Has(jsString(id)) {
				ds = append(ds, id)
			}
		}
		parent.set("delegates", append(ds, sid))
		pt := parent.str("title")
		if !truthy(parent.get("title")) {
			pt = jsSliceTo(parent.id(), 8)
		}
		logEvents(c, []any{M{"k": "notice", "tone": "info", "text": "↪ " + from + " 의 세션 \"" + pt + "\" 이 맡긴 일이에요. 허용 정책은 그 세션을 따라가요."}})
		logEvents(parent, []any{M{"k": "notice", "tone": "info", "text": "↪ " + hn + " 에 일을 맡겼어요: " + jsSliceTo(collapse(task), 120)}})
		addNotice(uid, M{"sid": sid, "key": "delegate-" + sid, "title": "다른 맥에 일을 맡겼어요", "text": from + " → " + hn + ": " + jsSliceTo(collapse(task), 100), "tone": "info", "push": true})
		record(uid, target, M{"level": "info", "area": "delegate", "sid": sid, "text": from + " 의 세션이 일을 맡김"})
		touch(c)
		touch(parent)
		if a["wait"] == false {
			return brief(c, delegateState(c, 0))
		}
		return brief(c, waitTurn(c, 0, ms))
	case "delegate_status":
		c := child()
		if truthy(a["wait"]) {
			return brief(c, waitTurn(c, 0, ms))
		}
		return brief(c, delegateState(c, 0))
	case "delegate_send":
		c := child()
		if truthy(c.get("closed")) {
			throw("닫힌 세션이에요")
		}
		text := jsTrim(strOr(a["text"], ""))
		if text == "" {
			throw("text 가 비어 있어요")
		}
		since := numOr0(c.get("seq"))
		sessionOp(uid, c, "send", M{"text": text, "via": "delegate"}, "", "")
		if a["wait"] == false {
			return brief(c, delegateState(c, since))
		}
		return brief(c, waitTurn(c, since, ms))
	case "delegate_stop":
		c := child()
		if !truthy(c.get("closed")) {
			closeSession(c, "맡긴 세션이 닫음")
		}
		broadcastState(uid)
		return brief(c, M{"state": "closed"})
	}
	throw("모르는 요청: " + jsStringU(msg["op"]))
	return nil
}

// ---------- 관리자 권한 (REQ-F-764) ----------

type sudoState struct {
	until float64
	asks  *OMap[M]
}

var sudoHosts = map[string]*sudoState{}

func sudoOf(hostID string) *sudoState {
	if s, ok := sudoHosts[hostID]; ok {
		return s
	}
	s := &sudoState{asks: newOMap[M]()}
	sudoHosts[hostID] = s
	return s
}

const SUDO_SLACK = "Slack 에서 작업 중인 세션은 관리자 권한을 쓸 수 없어요. 브릿지로 옮긴 뒤 다시 해 주세요"

func sudoView(hostID string) any {
	st, ok := sudoHosts[hostID]
	if !ok {
		return nil
	}
	until := 0.0
	if st.until > float64(nowMs()) {
		until = st.until
	}
	asks := []any{}
	for _, id := range st.asks.Keys() {
		a := shallow(st.asks.Val(id))
		out := M{"id": id}
		for k, v := range a {
			out[k] = v
		}
		asks = append(asks, out)
	}
	return M{"until": until, "asks": asks}
}

// sudoAnswer answers one agent's waiting sudo request and takes it off the page.
func sudoAnswer(hostID, areq string, ok bool, e string) {
	st := sudoOf(hostID)
	st.asks.Delete(areq)
	cmd := M{"t": "sudoans", "areq": areq, "ok": ok}
	if e != "" {
		cmd["error"] = e
	}
	toHost(hostID, cmd)
	if uid := mstr(hosts.Val(hostID), "uid"); uid != "" {
		dropNotices(uid, func(n M) bool { return n["key"] == "sudo-"+areq })
	}
}

func init() {
	// A session wants root: refused when it is worked on in Slack; let through, or asked of the person.
	fromAgent["sudoask"] = func(uid, hostID string, msg M) {
		areq, ok := msg["areq"].(string)
		if !ok || areq == "" {
			return
		}
		meta, _ := sessions.Get(strOr(msg["sid"], ""))
		if !owns(meta, uid, hostID) || truthy(meta.get("closed")) {
			sudoAnswer(hostID, areq, false, "이 세션을 서버가 모릅니다")
			return
		}
		if seatOf(meta) == "slack" {
			logEvents(meta, []any{M{"k": "notice", "tone": "warn", "text": "🔐 " + SUDO_SLACK}})
			sudoAnswer(hostID, areq, false, SUDO_SLACK)
			return
		}
		if !truthy(msg["need"]) {
			sudoAnswer(hostID, areq, true, "")
			return
		}
		what := jsSliceTo(strOr(msg["what"], ""), 300)
		sudoOf(hostID).asks.Set(areq, M{"sid": meta.id(), "title": strOr(meta.get("title"), ""), "what": what, "at": float64(nowMs())})
		hn := ""
		if h, ok := hosts.Get(hostID); ok && h["name"] != nil {
			hn = jsString(h["name"])
		}
		addNotice(uid, M{"sid": meta.id(), "key": "sudo-" + areq, "title": "관리자 비밀번호가 필요해요", "text": hn + " · " + what, "tone": "warn", "push": true})
		broadcastState(uid)
	}
	// The agent stopped waiting (2 minutes passed).
	fromAgent["sudogone"] = func(uid, hostID string, msg M) {
		areq := jsStringU(msg["areq"])
		if !sudoOf(hostID).asks.Delete(areq) {
			return
		}
		dropNotices(uid, func(n M) bool { return n["key"] == "sudo-"+areq })
		broadcastState(uid)
	}
	// Until when root is open on that Mac, and which requests it still waits on.
	fromAgent["sudostate"] = func(uid, hostID string, msg M) {
		st := sudoOf(hostID)
		st.until = numOr0(msg["until"])
		waiting := map[string]bool{}
		for _, x := range asArr(msg["waiting"]) {
			waiting[jsString(x)] = true
		}
		for _, areq := range st.asks.Keys() {
			if !waiting[areq] {
				st.asks.Delete(areq)
			}
		}
		broadcastState(uid)
	}
	// macOS shows one of its own alerts (a privacy prompt) while sessions work.
	fromAgent["sysdialog"] = func(uid, hostID string, msg M) {
		key := "sysdialog-" + hostID
		if !truthy(msg["on"]) {
			dropNotices(uid, func(n M) bool { return n["key"] == key })
			return
		}
		var sid any
		for _, x := range asArr(msg["sids"]) {
			id := jsString(x)
			m, _ := sessions.Get(id)
			if owns(m, uid, hostID) {
				sid = id
				break
			}
		}
		hn := ""
		if h, ok := hosts.Get(hostID); ok && h["name"] != nil {
			hn = jsString(h["name"])
		}
		addNotice(uid, M{"sid": sid, "key": key, "title": "맥에 시스템 허락 창이 떠 있어요", "text": hn + " · 맥에서 직접 눌러 주세요. 그동안 일하던 세션이 멈춰 있을 수 있어요", "tone": "warn", "push": "always"})
	}
}

var _ = regexp.MustCompile
