package main

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---------- messages from agents (through the bridge page) ----------

func newMeta(uid, id, hostID string, fields M) *Sess {
	now := float64(nowMs())
	home := mget(hosts.Val(hostID), "home")
	if home == nil {
		home = ""
	}
	m := M{
		"id": id, "uid": uid, "hostId": hostID, "prevHostId": nil, "title": "", "cwd": "", "home": home, "lines": 0.0,
		"syncedAt": nil, "autoPush": true, "folder": nil, "closed": false, "moves": []any{}, "conv": id, "seq": 0.0,
		"lastAt": now, "last": "", "preview": "", "model": "", "autoAllow": false, "createdAt": now, "updatedAt": now,
		// Its events go to its Mac as they happen (REQ-S-069): nothing from before to move there.
		"agentLog": true,
		"state":    noState(), "moving": nil, "card": nil, "writing": "",
	}
	for k, v := range fields {
		m[k] = v
	}
	s := &Sess{m: m, openTools: newOMap[bool](), silentTools: newOMap[bool](), cardIndex: newOMap[any]()}
	sessions.Set(id, s)
	return s
}

// resetVolatile is Object.assign(meta, volatile()).
func resetVolatile(meta *Sess) {
	meta.set("state", noState())
	meta.set("moving", nil)
	meta.set("card", nil)
	meta.set("writing", "")
}

// reminders: sid -> the timer that reminds of a decision nobody has answered.
var reminders = map[string]*Timer{}

// owns: the host a session runs on, or the one it is being opened on right now: both may speak for it.
func owns(meta *Sess, uid, hostID string) bool {
	return meta != nil && meta.uid() == uid && (meta.host() == hostID || mget(meta.get("moving"), "to") == hostID)
}

// appBuild: the newest iOS build sent to TestFlight (REQ-F-781).
var APP_BUILD_FILE string
var appBuild M

func cleanAppBuild(o any) M {
	build := jsNumber(mget(o, "build"))
	at := jsNumber(mget(o, "at"))
	if isSafeInteger(build) && build > 0 && build < 1e7 && isSafeInteger(at) && at > 0 && at < float64(nowMs()+86_400_000) {
		return M{"build": build, "at": at}
	}
	return nil
}

func loadAppBuild() {
	APP_BUILD_FILE = filepath.Join(DATA, "app-build.json")
	appBuild = cleanAppBuild(readJSON(APP_BUILD_FILE, nil))
}

func sessOf(msg M) *Sess {
	s, _ := msg["sid"].(string)
	if s == "" {
		return nil
	}
	m, _ := sessions.Get(s)
	return m
}

func strN(v any, n int) any {
	if s, ok := v.(string); ok {
		return jsSliceTo(s, n)
	}
	return nil
}

var cardLabels = map[string]string{"permission": "권한 요청", "question": "질문", "plan": "플랜 승인", "dialog": "터미널 확인", "keyed": "터미널 확인", "stuck": "지시 대기"}
var remindLabels = map[string]string{"question": "질문 대기", "plan": "플랜 승인 대기", "stuck": "지시 대기"}
var mdFileRe = regexp.MustCompile(`^SESSION(-[0-9a-f]{8})?\.md$`)
var prLinkRe = regexp.MustCompile(`^https://[\w.-]+/[\w.-]+/[\w.-]+/pull/\d+$`)

var fromAgent map[string]func(uid, hostID string, msg M)

func init() {
	fromAgent = map[string]func(uid, hostID string, msg M){
		// The Mac's last TestFlight upload (REQ-F-781): kept only from an operator, and never an older build.
		"testflight": func(uid, hostID string, msg M) {
			v := cleanAppBuild(msg)
			if v == nil || !isAdmin(uid) || (appBuild != nil && (v["build"].(float64) < appBuild["build"].(float64) || (v["build"] == appBuild["build"] && v["at"] == appBuild["at"]))) {
				return
			}
			appBuild = v
			writeJson(APP_BUILD_FILE, appBuild)
			record(uid, hostID, M{"area": "update", "text": "TestFlight 최신 빌드 " + numStr(v["build"].(float64)) + " (" + isoTime(int64(v["at"].(float64))) + ")"})
		},
		// A session's bridge MCP server asks (REQ-F-760); answered with the same areq, however long it takes.
		"delegate": func(uid, hostID string, msg M) {
			areq, ok := msg["areq"].(string)
			if !ok || areq == "" {
				return
			}
			goLocked("delegate", func() {
				var result any
				err := try(func() { result = runDelegate(uid, hostID, msg) })
				if err != nil {
					toHost(hostID, M{"t": "delegated", "areq": areq, "ok": false, "error": jsSliceTo(err.Error(), 500)})
					return
				}
				toHost(hostID, M{"t": "delegated", "areq": areq, "ok": true, "result": result})
			})
		},
		// One end of a local preview's WebSocket.
		"ws": func(uid, hostID string, msg M) { preview.fromAgent(hostID, msg) },
		// The Claude accounts on the Mac changed: kept with the host.
		"accounts": func(uid, hostID string, msg M) {
			hosts.Val(hostID)["accounts"] = cleanAccounts(msg["accounts"])
			touchGlobals()
			broadcastState(uid)
		},
		"hello":  helloFromAgent,
		"lines":  linesFromAgent,
		"status": statusFromAgent,
		"delivered": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) {
				return
			}
			ids := []any{}
			for _, x := range asArr(msg["ids"]) {
				if isStr(x) && len(ids) < 50 {
					ids = append(ids, x)
				}
			}
			dropSentUploads(ids)
			marks := []any{}
			for _, id := range ids {
				marks = append(marks, M{"k": "react", "id": id, "name": "hourglass_flowing_sand", "on": false}, M{"k": "react", "id": id, "name": "eyes", "on": true})
			}
			logEvents(meta, marks)
			keep := []any{}
			for _, x := range asArr(meta.get("heldIds")) {
				if !containsAny(ids, x) {
					keep = append(keep, x)
				}
			}
			meta.set("heldIds", keep)
		},
		"card": cardFromAgent,
		"note": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) {
				return
			}
			tone := "info"
			if msg["tone"] == "warn" {
				tone = "warn"
			}
			logEvents(meta, []any{M{"k": "notice", "text": jsSliceTo(strOr(msg["text"], ""), 2000), "tone": tone}})
		},
		"toast": func(uid, hostID string, msg M) {
			text := jsSliceTo(strOr(msg["text"], ""), 300)
			if m := sessOf(msg); m != nil && truthy(m.get("lock")) {
				text = "🔒 잠긴 세션에서 알림이 있어요"
			}
			toControls(uid, M{"t": "notice", "sid": msg["sid"], "text": text})
		},
		// What Claude is writing right now, read off the terminal. Shown while it lasts, never stored.
		"preview": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) {
				return
			}
			meta.set("writing", jsSliceTo(strOr(msg["text"], ""), 40_000))
			toControls(uid, M{"t": "preview", "sid": meta.id(), "text": meta.get("writing")})
		},
		// The session went on to another conversation: its transcript copy starts over under the new id.
		"conv": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) || !safeId(msg["conv"]) {
				return
			}
			silent := 0.0
			if truthy(msg["replay"]) {
				silent = numOr0(meta.get("lines"))
			}
			meta.set("conv", msg["conv"])
			meta.set("silentUntil", silent)
			meta.set("lines", 0.0)
			_ = os.Remove(transcriptFile(meta))
			touch(meta)
		},
		// Log hand-overs the Mac has on disk now (REQ-S-069).
		"logged": func(uid, hostID string, msg M) {
			lids := []any{}
			for _, x := range asArr(msg["lids"]) {
				if isStr(x) && len(lids) < 1000 {
					lids = append(lids, x)
				}
			}
			heardKept(hostID, lids)
		},
		// A session's numbers for the statistics and the pull requests it names, worked out on the Mac (REQ-S-070).
		"stats": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) {
				return
			}
			if s := cleanStats(msg["stats"]); s != nil {
				meta.set("stats", s)
			}
			if prs, ok := msg["prs"].([]any); ok {
				out := []any{}
				for _, u := range prs {
					if s, ok := u.(string); ok && prLinkRe.MatchString(s) && len(out) < 100 {
						out = append(out, s)
					}
				}
				meta.set("prLinks", out)
			}
			dirty.Set(meta.id(), true)
		},
		"folder": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if !owns(meta, uid, hostID) {
				return
			}
			meta.set("folder", cleanFolder(msg["folder"]))
			meta.set("syncedAt", float64(nowMs()))
			touch(meta)
		},
		"screen": func(uid, hostID string, msg M) {
			toControls(uid, M{"t": "screen", "sid": msg["sid"], "text": jsSliceTo(strOr(msg["text"], ""), 200_000)})
		},
		"closed": func(uid, hostID string, msg M) {
			meta := sessOf(msg)
			if meta == nil || meta.uid() != uid || meta.host() != hostID {
				return
			}
			resetVolatile(meta)
			broadcastState(uid)
		},
		"health": func(uid, hostID string, msg M) {
			st := live(hostID)
			health := shallow(msg)
			delete(health, "t")
			if truthy(st["stale"]) {
				record(uid, hostID, M{"area": "heartbeat", "text": "에이전트가 다시 상태를 보냄"})
			}
			st["health"] = health
			st["healthAt"] = float64(nowMs())
			st["stale"] = false
			broadcastState(uid)
		},
		"page": func(uid, hostID string, msg M) {
			st := live(hostID)
			was := mget(st["page"], "visible")
			n := func(k string) float64 { return numOr0(msg[k]) }
			var opened any
			if v := n("openedAt"); v != 0 {
				opened = v
			}
			var le any
			if truthy(msg["lastError"]) {
				le = M{"ts": jsNumber(mget(msg["lastError"], "ts")), "text": jsSliceTo(jsStringU(mget(msg["lastError"], "text")), 200)}
			}
			ua := ""
			if truthy(msg["ua"]) {
				ua = jsSliceTo(jsString(msg["ua"]), 200)
			}
			pg := M{"visible": jsStringU(msg["visible"]), "queue": n("queue"), "ua": ua, "openedAt": opened, "fromServer": n("fromServer"), "toAgentOk": n("toAgentOk"), "toAgentFail": n("toAgentFail"), "fromAgent": n("fromAgent"), "upOk": n("upOk"), "upFail": n("upFail"), "agentReconnects": n("agentReconnects"), "lastError": le}
			st["page"] = pg
			st["pageAt"] = float64(nowMs())
			if truthy(was) && was != pg["visible"] {
				text := "연동 탭이 백그라운드로 감"
				if pg["visible"] == "visible" {
					text = "연동 탭이 앞으로 나옴"
				}
				record(uid, hostID, M{"area": "page", "src": "page", "text": text})
			}
		},
		"pong": func(uid, hostID string, msg M) {
			st := live(hostID)
			st["rtt"] = float64(nowMs()) - jsNumber(msg["ts"])
			st["rttAt"] = float64(nowMs())
		},
		"logs": func(uid, hostID string, msg M) {
			entries := asArr(msg["entries"])
			if len(entries) > 200 {
				entries = entries[:200]
			}
			src := "agent"
			if msg["src"] == "page" {
				src = "page"
			}
			for _, e := range entries {
				x := shallow(asM(e))
				x["src"] = src
				record(uid, hostID, x)
			}
		},
		"error": func(uid, hostID string, msg M) {
			text := "호스트 오류: " + jsSliceTo(jsStringU(msg["message"]), 300)
			if m := sessOf(msg); m != nil && truthy(m.get("lock")) {
				text = "🔒 잠긴 세션에서 호스트 오류가 났어요"
			}
			toControls(uid, M{"t": "notice", "sid": msg["sid"], "text": text})
		},
	}
}

// jsStringU is String(v) where a missing v is `undefined`.
func jsStringU(v any) string {
	if v == nil {
		return "undefined"
	}
	return jsString(v)
}

func helloFromAgent(uid, hostID string, msg M) {
	caps := []any{}
	for _, c := range asArr(msg["caps"]) {
		if isStr(c) && len(caps) < 20 {
			caps = append(caps, c)
		}
	}
	live(hostID)["caps"] = caps
	// Preview WebSockets the agent no longer has (it started again) are closed.
	ws := []string{}
	for _, x := range asArr(msg["ws"]) {
		ws = append(ws, jsString(x))
	}
	preview.hostGone(hostID, ws)
	h := hosts.Val(hostID)
	name := ""
	if truthy(msg["name"]) {
		name = jsSliceTo(jsString(msg["name"]), 60)
	}
	if name == "" {
		name = jsString(h["name"])
		if h["name"] == nil {
			name = ""
		}
	}
	kind := "other"
	if truthy(msg["kind"]) {
		kind = jsString(msg["kind"])
	}
	s := func(v any) string {
		if truthy(v) {
			return jsString(v)
		}
		return ""
	}
	info := asM(msg["info"])
	h["name"] = name
	h["kind"] = jsSliceTo(kind, 20)
	h["home"] = s(msg["home"])
	h["lastSeen"] = float64(nowMs())
	h["info"] = M{"version": s(msg["version"]), "build": s(msg["build"]), "node": s(info["node"]), "os": s(info["os"])}
	nsess := 0
	if l, ok := msg["sessions"].([]any); ok {
		nsess = len(l)
	}
	record(uid, hostID, M{"area": "link", "text": "에이전트 연결됨: " + name + " (" + jsString(h["kind"]) + "), agent " + jsStringU(msg["version"]) + ", node " + jsStringU(info["node"]) + ", " + jsStringU(info["os"]) + ", 세션 " + itoa(nsess) + "개"})
	touchGlobals()
	known := M{}
	listed := map[string]bool{}
	for _, sv := range asArr(msg["sessions"]) {
		sm := asM(sv)
		if !safeId(sm["id"]) {
			continue
		}
		id := sm["id"].(string)
		listed[id] = true
		meta, _ := sessions.Get(id)
		if meta != nil && meta.uid() != uid {
			continue
		}
		// A session the agent has but the server has never seen: take it as this host's.
		if meta == nil {
			conv := sm["id"]
			if safeId(sm["conv"]) {
				conv = sm["conv"]
			}
			cwd := ""
			if truthy(sm["cwd"]) {
				cwd = jsString(sm["cwd"])
			}
			meta = newMeta(uid, id, hostID, M{"cwd": cwd, "autoPush": sm["autoPush"] != false, "conv": conv})
		}
		mine := meta.host() == hostID && !truthy(meta.get("closed"))
		// The agent moved on to another conversation (`/clear`) while it was away from the server.
		cur := meta.get("conv")
		if cur == nil {
			cur = meta.id()
		}
		if mine && safeId(sm["conv"]) && sm["conv"] != cur {
			meta.set("conv", sm["conv"])
			meta.set("lines", 0.0)
		}
		if mine && isStr(sm["account"]) && safeAccount(sm["account"]) {
			meta.set("account", sm["account"])
		}
		known[id] = M{"lines": meta.get("lines"), "mine": mine}
		if mine {
			meta.state()["alive"] = truthy(sm["alive"])
		}
		// A server that started from an older meta.json counts on from the Mac's last number (REQ-S-069).
		if mine && isInteger(sm["seq"]) && jsNumber(sm["seq"]) > numOr0(meta.get("seq")) {
			meta.set("seq", sm["seq"])
			dirty.Set(meta.id(), true)
		}
	}
	for _, meta := range sessions.Values() {
		if meta.uid() == uid && meta.host() == hostID && !listed[meta.id()] {
			resetVolatile(meta)
		}
	}
	toHost(hostID, M{"t": "welcome", "sessions": known})
	// What it did not say it kept goes again, then the copies this server kept before (REQ-S-069).
	if storeOn(hostID) {
		if q := logOut[hostID]; q != nil {
			for _, cmd := range q.m.Values() {
				c := shallow(cmd)
				delete(c, "size")
				toHost(hostID, c)
			}
		}
		goLocked("migrate", func() { migrateHost(uid, hostID) })
		seen := map[string]bool{}
		for _, m := range sessions.Values() {
			if m.get("carryFrom") == hostID && !truthy(m.get("agentLog")) && !seen[m.host()] {
				seen[m.host()] = true
				to := m.host()
				if online(to) {
					goLocked("migrate", func() { migrateHost(uid, to) })
				}
			}
		}
	}
	// An agent that is not the one this server hands out is given the current files by its own bridge tab.
	// Not an agent the Macs would refuse (unsigned, or signed with a seq that went back): they keep theirs (R7-M1).
	build := mstr(h["info"], "build")
	if build != AGENT_BUILD && AGENT_SIGNED {
		b := build
		if b == "" {
			b = "?"
		}
		record(uid, hostID, M{"area": "update", "text": "에이전트 build " + b + " → " + AGENT_BUILD + " 로 업데이트를 보냄"})
		// The largest seq is recorded when a Mac is first sent it (R9-L2, R10-I1).
		if !seqRecorded && jsNumber(AGENT_SIG["seq"]) > SEQ_SEEN {
			writeJson(SEQ_FILE, M{"max": AGENT_SIG["seq"]})
			seqRecorded = true
		}
		or := func(k string, d any) any {
			if AGENT_SIG[k] != nil {
				return AGENT_SIG[k]
			}
			return d
		}
		toHost(hostID, M{"t": "update", "build": AGENT_BUILD, "names": anyList(AGENT_FILES), "sig": or("legacy", ""), "msig": or("msig", ""), "seq": or("seq", 0.0)})
	}
	broadcastState(uid)
}

func linesFromAgent(uid, hostID string, msg M) {
	meta := sessOf(msg)
	raw, ok := msg["lines"].([]any)
	if meta == nil || meta.uid() != uid || !ok {
		return
	}
	if !owns(meta, uid, hostID) {
		toHost(hostID, M{"t": "release", "sid": meta.id()})
		return
	}
	if from, ok := msg["from"].(float64); !ok || from != numOr0(meta.get("lines")) {
		toHost(hostID, M{"t": "resync", "sid": meta.id(), "lines": meta.get("lines")})
		return
	}
	// Read into events and let go: the transcript stays on the Mac (REQ-S-069).
	lines := []string{}
	for _, l := range raw {
		if s, ok := l.(string); ok && !strings.Contains(s, "\n") {
			lines = append(lines, s)
		}
	}
	// A conversation resumed under a new id begins with a copy of lines already shown: kept, not drawn again.
	silent := int(math.Max(0, math.Min(float64(len(lines)), numOr0(meta.get("silentUntil"))-numOr0(meta.get("lines")))))
	events := convert(meta, lines[silent:])
	meta.set("lines", numOr0(meta.get("lines"))+float64(len(lines)))
	meta.set("syncedAt", float64(nowMs()))
	if !truthy(meta.get("title")) && !truthy(meta.get("manualTitle")) {
		t := ""
		for _, e := range events {
			if mstr(e, "k") == "user" && !truthy(mget(e, "command")) {
				t = strOr(mget(e, "text"), "")
				break
			}
		}
		meta.set("title", jsSliceTo(collapse(t), 80))
	}
	touch(meta)
	logEvents(meta, events)
	closeWhenReportDone(meta)
	// The Mac reports the turn's end before the transcript line with its answer: the answer that lands after counts.
	ph := meta.state()["phase"]
	if truthy(meta.get("delegatedBy")) && (ph == "idle" || ph == "ended") {
		for _, e := range events {
			if mstr(e, "k") == "text" && truthy(mget(e, "text")) {
				followDelegate(meta)
				break
			}
		}
	}
}

func statusFromAgent(uid, hostID string, msg M) {
	meta := sessOf(msg)
	if !owns(meta, uid, hostID) {
		return
	}
	str := func(v any, n int) any { return strN(v, n) }
	orNull := func(v any) any {
		if f := numOr0(v); f != 0 {
			return f
		}
		return nil
	}
	was := meta.state()["phase"]
	phase := "idle"
	if p, ok := msg["phase"].(string); ok && contains([]string{"starting", "idle", "busy", "waiting", "ended"}, p) {
		phase = p
	}
	held := []any{}
	for _, h := range asArr(msg["held"]) {
		if len(held) >= 50 {
			break
		}
		at := numOr0(mget(h, "at"))
		if at == 0 {
			at = float64(nowMs())
		}
		held = append(held, M{"id": jsStringU(mget(h, "id")), "text": jsSliceTo(jsStringU(mget(h, "text")), 100_000), "at": at})
	}
	var tool any
	if truthy(msg["tool"]) {
		tool = M{"name": str(mget(msg["tool"], "name"), 80), "title": str(mget(msg["tool"], "title"), 200), "at": orNull(mget(msg["tool"], "at"))}
	}
	running := []any{}
	for _, t := range asArr(msg["running"]) {
		if len(running) >= 20 {
			break
		}
		running = append(running, jsSliceTo(jsStringU(t), 200))
	}
	var sessionMd any
	if f, ok := msg["sessionMd"].(float64); ok {
		sessionMd = f
	}
	var mdFile any
	if mdFileRe.MatchString(strOr(msg["mdFile"], "")) {
		mdFile = msg["mdFile"]
	}
	mdMax := numOr0(msg["mdMax"])
	if mdMax == 0 {
		mdMax = 20_000
	}
	mdMax = math.Min(100_000, math.Max(20_000, mdMax))
	plugins := []any{}
	for _, x := range asArr(msg["plugins"]) {
		if len(plugins) >= 10 {
			break
		}
		p := M{"market": jsSliceTo(jsStringU(mget(x, "market")), 60), "version": jsSliceTo(jsStringU(mget(x, "version")), 40)}
		if truthy(mget(x, "latest")) {
			p["latest"] = jsSliceTo(jsString(mget(x, "latest")), 40)
		}
		plugins = append(plugins, p)
	}
	var bridgeTools any
	if l, ok := msg["bridgeTools"].([]any); ok {
		bt := []any{}
		for _, t := range l {
			if len(bt) >= 50 {
				break
			}
			bt = append(bt, jsSliceTo(jsStringU(t), 80))
		}
		bridgeTools = bt
	}
	var usage any
	if um, ok := msg["usage"].(M); ok && um != nil {
		u := M{}
		for _, k := range []string{"context", "window", "fiveHour", "week", "cost", "fiveHourResetsAt", "weekResetsAt"} {
			if f, ok := um[k].(float64); ok {
				u[k] = f
			} else {
				u[k] = nil
			}
		}
		usage = u
	}
	var handed any
	if safeId(msg["handedOffTo"]) {
		handed = msg["handedOffTo"]
	}
	servers := []any{}
	for _, x := range asArr(msg["servers"]) {
		port := mget(x, "port")
		if !isInteger(port) || jsNumber(port) <= 0 || jsNumber(port) >= 65536 {
			continue
		}
		if len(servers) >= 20 {
			break
		}
		title := str(mget(x, "title"), 120)
		if title == nil {
			title = ""
		}
		servers = append(servers, M{"port": port, "title": title})
	}
	st := M{
		"alive": truthy(msg["alive"]), "phase": phase, "waiting": str(msg["waiting"], 40), "waitingSince": orNull(msg["waitingSince"]),
		"held": held, "tool": tool, "tools": numOr0(msg["tools"]), "running": running, "sessionMd": sessionMd, "mdFile": mdFile,
		"mdMax": mdMax, "plugins": plugins, "turnAt": orNull(msg["turnAt"]), "mode": str(msg["mode"], 40), "effort": str(msg["effort"], 20),
		"context": str(msg["context"], 20), "autoAllow": truthy(msg["autoAllow"]), "allowAll": truthy(msg["autoAllow"]) && truthy(msg["allowAll"]), "refreshAfter": truthy(msg["refreshAfter"]),
		"bridgeTools": bridgeTools, "size": orNull(msg["size"]), "quietSince": orNull(msg["quietSince"]), "usage": usage,
		"handedOffTo": handed, "cache": cacheOf(msg["cache"]), "servers": servers,
	}
	meta.set("state", st)
	if truthy(mdFile) {
		meta.set("mdFile", mdFile)
	}
	// When work starts and stops, kept in the log: the usage statistics are counted from these.
	if st["alive"] == true && phase != was && (phase == "busy" || was == "busy") {
		logEvents(meta, []any{M{"k": "status", "phase": phase}})
	}
	if phase != "busy" {
		meta.set("coding", false)
	}
	over := phase == "idle" || phase == "ended"
	// A session that was handed work ended a turn: the one that handed it over hears of it (REQ-F-760 rule 11).
	if truthy(meta.get("delegatedBy")) && was == "busy" && over {
		followDelegate(meta)
	}
	// The Mac counted the shells Claude really has: the list of background commands cannot be longer than that.
	if shells, ok := msg["shells"].(float64); ok && len(asArr(meta.get("bg"))) > 0 {
		bg := asArr(meta.get("bg"))
		before := len(bg)
		now := float64(nowMs())
		kept := []any{}
		for _, t := range bg {
			timeout := 300_000.0
			if v := mget(t, "timeout"); v != nil {
				timeout = jsNumber(v)
			}
			if mget(t, "kind") != "monitor" || now < numOr0(mget(t, "at"))+timeout {
				kept = append(kept, t)
			}
		}
		bg = kept
		sh := []any{}
		for _, t := range bg {
			if mget(t, "kind") != "agent" {
				sh = append(sh, t)
			}
		}
		settled := []any{}
		for _, t := range sh {
			if now-numOr0(mget(t, "at")) > 30_000 {
				settled = append(settled, t)
			}
		}
		if n := len(sh) - int(shells); float64(len(sh))-shells > 0 {
			sort.SliceStable(settled, func(i, j int) bool { return numOr0(mget(settled[i], "at")) < numOr0(mget(settled[j], "at")) })
			if n > len(settled) {
				n = len(settled)
			}
			gone := settled[:n]
			k2 := []any{}
			for _, t := range bg {
				drop := false
				for _, g := range gone {
					if sameObj(t, g) {
						drop = true
					}
				}
				if !drop {
					k2 = append(k2, t)
				}
			}
			bg = k2
		}
		meta.set("bg", bg)
		if len(bg) != before && online(meta.host()) {
			toHost(meta.host(), M{"t": "bg", "sid": meta.id(), "n": float64(len(bg))})
		}
	}
	// A turn that ended with tool calls still open closes them, a moment later.
	if was == "busy" && over && meta.openTools.Len() > 0 {
		setTimeout(5000*time.Millisecond, func() {
			ph := meta.state()["phase"]
			if !(ph == "idle" || ph == "ended") || meta.openTools.Len() == 0 {
				return
			}
			open := meta.openTools.Keys()
			meta.openTools.Clear()
			evs := []any{}
			for _, t := range open {
				evs = append(evs, M{"k": "tool_end", "tool": t, "error": true, "text": "(중단됨)"})
			}
			logEvents(meta, evs)
		})
	}
	// Put to rest is only a mark: the session working again takes it off.
	if truthy(meta.get("resting")) && phase == "busy" {
		meta.set("resting", false)
	}
	if m, ok := msg["model"].(string); ok && m != "" {
		meta.set("launchModel", jsSliceTo(m, 60))
	}
	if !truthy(msg["card"]) {
		meta.set("card", nil)
		meta.set("cardWant", nil)
	} else if mget(meta.get("card"), "id") != msg["card"] {
		// A dropped link empties meta.card: put the card back from the log, or the page draws it as answered.
		want := jsString(msg["card"])
		c, has := cardsOf(meta).Get(want)
		if has && !truthy(mget(c, "auto")) {
			cm := shallow(asM(c))
			cm["open"] = true
			meta.set("card", cm)
		} else if !has && storeOn(hostID) {
			meta.set("cardWant", want)
			goLocked("card", func() {
				evs := recentEvents(meta, []string{"card"})
				var found M
				for i := len(evs) - 1; i >= 0; i-- {
					if mget(mget(evs[i], "card"), "id") == want {
						found = mobj(evs[i], "card")
						break
					}
				}
				if found == nil || truthy(found["auto"]) || meta.get("cardWant") != want || mget(meta.get("card"), "id") == want {
					return
				}
				cardsOf(meta).Set(jsString(found["id"]), found)
				cm := shallow(found)
				cm["open"] = true
				meta.set("card", cm)
				broadcastState(uid)
			})
		}
	}
	// A message the Mac is holding wears an hourglass; one card for the lot.
	now := []string{}
	nowSet := map[string]bool{}
	for _, h := range held {
		id := mstr(h, "id")
		if !nowSet[id] {
			nowSet[id] = true
			now = append(now, id)
		}
	}
	before := map[string]bool{}
	for _, x := range asArr(meta.get("heldIds")) {
		before[jsString(x)] = true
	}
	marks := []any{}
	for _, id := range now {
		if !before[id] {
			marks = append(marks, M{"k": "react", "id": id, "name": "hourglass_flowing_sand", "on": true})
		}
	}
	meta.set("heldIds", anyList(now))
	hc := asM(meta.get("heldCard"))
	if float64(len(now)) != numOr0(hc["n"]) {
		first := !truthy(meta.get("heldCard"))
		id := hc["id"]
		if id == nil {
			id = uuidv4()
		}
		mk := M{"k": "held", "id": id, "n": float64(len(now))}
		if first {
			mk["first"] = true
		}
		marks = append(marks, mk)
		if len(now) > 0 {
			meta.set("heldCard", M{"id": id, "n": float64(len(now))})
		} else {
			meta.set("heldCard", nil)
		}
	}
	if len(marks) > 0 {
		logEvents(meta, marks)
	}
	broadcastState(uid)
	closeWhenReportDone(meta)
}

// permissionNotice: "🔐 권한 요청 · <session>" over "<Mac> · Bash: git push origin main", the call itself rather than
// Claude Code's "Do you want to proceed?". Pushed even while a desk's tab is in front: the session stands still
// until someone answers (REQ-F-795).
func permissionNotice(meta *Sess, hostID string, c M, key, lead string) M {
	name := ""
	if v := mget(c["tool"], "name"); truthy(v) {
		name = jsString(v)
	}
	what := strOr(c["title"], "권한 요청")
	if name != "" {
		what = name
		for _, x := range toolSummary(name, mget(c["tool"], "input"), nil, toolCtx{cwd: meta.str("cwd")}) {
			if l, _ := x.V.(string); x.K == "label" && l != "" {
				what = name + ": " + l
			}
		}
	}
	parts := []string{}
	for _, p := range []string{lead, strOr(hostName(hostID), ""), what} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	title := "세션"
	if truthy(meta.get("title")) {
		title = meta.str("title")
	}
	return M{"sid": meta.id(), "key": key, "title": "🔐 권한 요청 · " + title, "text": strings.Join(parts, " · "), "tone": "warn", "push": "always"}
}

// cardFromAgent: a decision the terminal is waiting for, as a card with buttons; or the same card, answered.
func cardFromAgent(uid, hostID string, msg M) {
	meta := sessOf(msg)
	c, _ := msg["card"].(M)
	if !owns(meta, uid, hostID) || c == nil || !safeId(c["id"]) {
		return
	}
	cid := c["id"].(string)
	label, ok := cardLabels[mstr(c, "kind")]
	if !ok {
		label = "응답 대기"
	}
	if truthy(c["open"]) || truthy(c["auto"]) {
		cardsOf(meta).Set(cid, c)
	} else if old, ok := cardsOf(meta).Get(cid); ok {
		cardsOf(meta).Set(cid, old)
	} else {
		cardsOf(meta).Set(cid, c)
	}
	title := func() string {
		if t := meta.str("title"); truthy(meta.get("title")) {
			return t
		}
		return "세션"
	}
	if truthy(c["open"]) {
		meta.set("card", c)
		at := numOr0(c["at"])
		if at == 0 {
			at = float64(nowMs())
		}
		logEvents(meta, []any{M{"k": "card", "card": c, "at": at}})
		// Someone has that conversation open: the card is in front of them, a notice on top of it is noise.
		if !isViewing(uid, meta.id()) && c["kind"] == "permission" {
			addNotice(uid, permissionNotice(meta, hostID, c, "card|"+cid, ""))
		} else if !isViewing(uid, meta.id()) {
			tn := ""
			if truthy(mget(c["tool"], "name")) {
				tn = jsString(mget(c["tool"], "name")) + ": "
			}
			addNotice(uid, M{"sid": meta.id(), "key": "card|" + cid, "title": title(), "text": label + " — " + tn + jsSliceTo(strOr(c["title"], ""), 120), "tone": "info", "push": true})
		}
		// Still unanswered after five minutes, and again after ten.
		clearTimeout(reminders[meta.id()])
		var remind func(n int)
		remind = func(n int) {
			reminders[meta.id()] = setTimeout(300_000*time.Millisecond, func() {
				if mget(meta.get("card"), "id") != cid {
					return
				}
				key := "remind|" + cid + "|" + itoa(n)
				if c["kind"] == "permission" {
					addNotice(uid, permissionNotice(meta, hostID, c, key, "⏰ "+itoa(n*5)+"분째 기다리는 중"))
				} else {
					l, ok := remindLabels[mstr(c, "kind")]
					if !ok {
						l = "터미널 확인 대기"
					}
					addNotice(uid, M{"sid": meta.id(), "key": key, "title": title(), "text": "⏰ " + itoa(n*5) + "분째 " + l + " 중입니다. 세션이 그동안 멈춰 있습니다.", "tone": "info", "push": true})
				}
				if n < 2 && c["kind"] == "permission" {
					remind(n + 1)
				}
			})
		}
		remind(1)
	} else {
		clearTimeout(reminders[meta.id()])
		dropNotices(uid, func(x M) bool {
			k := mstr(x, "key")
			return k == "card|"+cid || strings.HasPrefix(k, "remind|"+cid+"|")
		})
		if mget(meta.get("card"), "id") == cid {
			meta.set("card", nil)
		}
		// An automatic allow was never open: it is logged as one line with what was allowed.
		if truthy(c["auto"]) {
			logEvents(meta, []any{M{"k": "card", "card": c}})
		} else {
			logEvents(meta, []any{M{"k": "card_end", "id": cid, "result": jsSliceTo(strOr(c["result"], ""), 200)}})
		}
	}
}

var notBackRe = regexp.MustCompile(`돌아오지 않았습니다`)

// fromBridge: what a host's bridge tab passed up (/api/bridge/up), or the demo Mac in its place.
func fromBridge(uid, hostID string, msgs []any, origin string) {
	for _, mv := range msgs {
		msg := asM(mv)
		if msg["t"] == "got" {
			if p := pending[jsString(msg["reqId"])]; p != nil && p.hostID == hostID {
				clearTimeout(p.gotTimer)
				p.got = true
			}
			continue
		}
		if msg["t"] == "relayfail" {
			// An agent that stays away is dead or cannot start: only installing it again helps.
			gone := ""
			if notBackRe.MatchString(jsStringU(msg["error"])) {
				gone = " 그 맥의 에이전트가 꺼져 있거나 뜨지 못하고 있어요. 그 맥의 터미널에서 curl -fsSL " + origin + "/install.sh | bash 로 다시 설치해 주세요."
			}
			reply(M{"reqId": msg["reqId"], "ok": false, "error": "연동 탭이 그 맥의 에이전트(127.0.0.1)에 명령을 전달하지 못했습니다: " + jsSliceTo(jsStringU(msg["error"]), 200) + gone}, hostID)
			continue
		}
		if truthy(msg["reqId"]) && reply(msg, hostID) {
			continue
		}
		t, _ := msg["t"].(string)
		h := fromAgent[t]
		if h == nil {
			continue
		}
		if err := tryLog(func() { h(uid, hostID, msg) }); err != nil {
			// Logged and skipped: answering 500 would make the tab send the whole batch again, the good ones twice.
			logLine("error", "from agent "+jsStringU(msg["t"]), err)
			var sid any
			if safeId(msg["sid"]) {
				sid = msg["sid"]
			}
			record(uid, hostID, M{"level": "error", "area": "up", "sid": sid, "text": "서버가 에이전트 메시지(" + jsSliceTo(jsStringU(msg["t"]), 20) + ")를 처리하지 못함: " + jsSliceTo(err.Error(), 200)})
		}
	}
}

func reply(msg M, from string) bool {
	id := jsString(msg["reqId"])
	p := pending[id]
	if p == nil || (from != "" && p.hostID != from) {
		return false
	}
	clearTimeout(p.timer)
	clearTimeout(p.gotTimer)
	delete(pending, id)
	if msg["t"] == "error" {
		p.resolve(M{"ok": false, "error": jsStringU(msg["message"])})
	} else {
		p.resolve(msg)
	}
	return true
}
