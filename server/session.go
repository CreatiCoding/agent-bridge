package main

import (
	"bytes"
	"os"
	"regexp"
	"strings"
	"time"
)

var trailingWSRe = re(`\s+$`)

// sudoCommand — `:sudo <command>` (REQ-F-764): runs as root on the session's Mac; what it printed goes into the conversation.
func sudoCommand(uid string, meta *Sess, command string, opts csOptsCmd) string {
	if opts.via == "slack" || seatOf(meta) == "slack" {
		refuse(403, SUDO_SLACK)
	}
	if command == "" {
		refuse(400, "실행할 명령을 적어 주세요. 예: :sudo whoami")
	}
	sessBefore("session.sudo", meta, kv{"command", jsSliceTo(command, 2000)})
	hostID := liveHost(meta)
	logEvents(meta, []any{M{"k": "line", "text": "🔐 관리자 권한으로 실행: `" + jsSliceTo(collapse(command), 200) + "`"}})
	sessAfter("session.sudo", meta, kv{"command", jsSliceTo(command, 2000)})
	goLocked("sudo", func() {
		r := ask(hostID, M{"t": "sudo", "sid": meta.id(), "command": command}, 10*60_000)
		out := trailingWSRe.ReplaceAllString(ansiRe.ReplaceAllString(strOr(r["out"], ""), ""), "")
		var text string
		if truthy(r["ok"]) {
			if out == "" {
				out = "(출력 없음)"
			}
			text = "# " + command + "\n" + out
			if truthy(r["code"]) {
				text += "\n(종료 코드 " + jsString(r["code"]) + ")"
			}
			logEvents(meta, []any{M{"k": "local", "text": text, "error": !(r["code"] == 0.0)}})
			record(uid, hostID, M{"level": "info", "area": "sudo", "sid": meta.id(), "text": "관리자 권한으로 명령 실행 (종료 코드 " + jsStringU(r["code"]) + ")"})
		} else {
			e := "실패했어요"
			if r["error"] != nil {
				e = jsString(r["error"])
			}
			text = "🔐 실행하지 않았어요: " + e
			logEvents(meta, []any{M{"k": "notice", "tone": "warn", "text": text}})
			record(uid, hostID, M{"level": "warn", "area": "sudo", "sid": meta.id(), "text": "관리자 권한 명령 실패: " + strOr(r["error"], "")})
		}
	})
	return "관리자 권한으로 실행해요"
}

func orStr(v any, fallback ...string) string {
	if truthy(v) {
		return jsString(v)
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

// startSession starts a session on one of the person's Macs (새 세션, 제보의 "이 오류 고치기"). Returns its id.
func startSession(uid string, b M, req *Req) string {
	hostID := strOr(b["hostId"], "")
	ownHost(uid, b["hostId"])
	if !online(hostID) {
		refuse(409, "호스트가 연결돼 있지 않습니다")
	}
	internal := req != nil && req.internal
	from := "new"
	if f, ok := b["from"].(startFrom); ok {
		from = string(f)
	} else if b["via"] == "delegate" && internal {
		from = "delegate"
	}
	if from != "report" && len(hooksOf("session.create.before")) > 0 {
		mode := orStr(b["mode"])
		if _, has := b["mode"]; !has {
			mode = mstr(launchOf(uid), "mode")
		}
		cwd := "~"
		if truthy(b["cwd"]) {
			cwd = jsString(b["cwd"])
		}
		title := jsSliceTo(orStr(b["title"]), 80)
		if title == "" {
			title = jsSliceTo(collapse(orStr(b["prompt"])), 80)
		}
		if p := createBefore(uid, hostID, cwd, title, mode, from); p != nil {
			for _, k := range []string{"title", "prompt", "mode"} {
				if v, ok := p[k]; ok {
					b[k] = v
				}
			}
		}
	}
	sid := uuidv4()
	prompt := jsSliceTo(orStr(b["prompt"]), 100_000)
	// The session exists from here on, as "starting".
	title := jsSliceTo(orStr(b["title"]), 80)
	if title == "" {
		title = jsSliceTo(collapse(prompt), 80)
	}
	meta := newMeta(uid, sid, hostID, M{"title": title})
	st := noState()
	st["alive"] = true
	st["phase"] = "starting"
	meta.set("state", st)
	// One started from a Slack message is worked on in Slack until it is moved.
	if b["via"] == "slack" && internal {
		meta.set("seat", M{"where": "slack", "at": float64(nowMs()), "url": nil})
	}
	if b["chrome"] == false {
		meta.set("chrome", false)
	}
	// Started from a group's menu (이 그룹에 새 세션): it goes in that group, last.
	var into M
	if g, ok := b["group"].(string); ok {
		for _, x := range groupsList(prefsOf(uid)) {
			if x["id"] == g {
				into = x
				break
			}
		}
	}
	if into != nil && !containsAny(asArr(into["items"]), sid) {
		into["items"] = append(asArr(into["items"]), sid)
	}
	// The first prompt is said now, before claude starts: its echo in the transcript must find it already logged.
	if jsTrim(prompt) != "" {
		via := "web"
		if b["via"] == "slack" {
			via = "slack"
		} else if b["via"] == "delegate" && internal {
			via = "delegate"
		}
		logSaid(meta, uuidv4(), jsTrim(prompt), via, nil)
	}
	if into != nil {
		savePrefs(uid)
	} else {
		broadcastState(uid)
	}
	// A field the request leaves out takes the person's default (설정); one sent empty means the Mac's own default.
	L := launchOf(uid)
	for _, k := range []string{"model", "effort", "mode"} {
		if _, has := b[k]; !has {
			b[k] = L[k]
		}
	}
	account := ""
	if safeAccount(b["account"]) {
		account = b["account"].(string)
	}
	cwd := "~"
	if truthy(b["cwd"]) {
		cwd = jsString(b["cwd"])
	}
	mode, autoAllow := startMode(jsSliceTo(orStr(b["mode"]), 20))
	cmd := M{"t": "new", "sid": sid, "sysPrompt": sysPromptOf(uid), "create": b["create"] == true, "cwd": jsSliceTo(cwd, 1000), "prompt": prompt, "autoPush": true, "model": jsSliceTo(orStr(b["model"]), 60), "effort": jsSliceTo(orStr(b["effort"]), 10), "mode": mode}
	if b["chrome"] == false {
		cmd["chrome"] = false
	}
	if account != "" {
		cmd["account"] = account
	}
	r := ask(hostID, cmd, 60_000)
	if !truthy(r["ok"]) {
		sessions.Delete(sid)
		dirty.Delete(sid)
		_ = os.RemoveAll(sessionDir(meta))
		if into != nil {
			into["items"] = removeAll(asArr(into["items"]), sid)
			savePrefs(uid)
		}
		broadcastState(uid)
		record(uid, hostID, M{"level": "error", "area": "new", "sid": sid, "text": "세션을 시작하지 못함: " + jsStringU(r["error"])})
		status := 502
		extra := M{}
		if truthy(r["missing"]) {
			status = 404
			extra["missing"] = true
		}
		e := "세션을 시작하지 못했습니다"
		if truthy(r["error"]) {
			e = jsString(r["error"])
		}
		refuseX(status, e, extra)
	}
	meta.set("cwd", r["cwd"])
	if safeAccount(r["account"]) {
		meta.set("account", r["account"])
	} else {
		meta.set("account", account)
	}
	if truthy(b["model"]) {
		meta.set("launchModel", jsSliceTo(jsString(b["model"]), 60))
	}
	if autoAllow {
		turnOnAutoAllow(meta, jsSliceTo(orStr(b["mode"]), 20) == "allowAll")
	}
	touch(meta)
	// Anything it said before this point may have been said to nobody: have it say where it stands.
	toHost(hostID, M{"t": "report", "sid": sid})
	if from == "report" {
		withBy("system", func() { createdAfter(meta, from, mode) }) // the server opens it for a report: told only
	} else {
		createdAfter(meta, from, mode)
	}
	return sid
}

func ownHost(uid string, hostID any) M {
	s, _ := hostID.(string)
	h, ok := hosts.Get(s)
	if !ok || mstr(h, "uid") != uid {
		refuse(404, "호스트가 없습니다")
	}
	return h
}

// DISK_HELP_MS: how long an owner's 디스크 정리 도움 grant lasts (REQ-F-804).
const DISK_HELP_MS = 24 * 3600_000

// diskHost: a host's disk may be managed by its owner, and by the operator the owner granted it to until it ends.
func diskHost(uid string, hostID string) M {
	h, ok := hosts.Get(hostID)
	if ok && mstr(h, "uid") == uid {
		return h
	}
	if ok && isAdmin(uid) {
		if help, _ := h["diskHelp"].(M); help != nil && mstr(help, "by") == uid {
			if until, _ := help["until"].(float64); until > float64(nowMs()) {
				return h
			}
		}
	}
	refuse(404, "호스트가 없습니다")
	return nil
}

// diskHelpView: who asked to help with a host's disk and until when it was granted (0: asked, not granted), no uid.
func diskHelpView(v any) any {
	help, _ := v.(M)
	if help == nil {
		return nil
	}
	return M{"login": help["login"], "askedAt": help["askedAt"], "until": help["until"]}
}

// readableHost: a host's status and log may be read by its owner and by an operator.
func readableHost(uid string, hostID string) M {
	h, ok := hosts.Get(hostID)
	if !ok || (mstr(h, "uid") != uid && !isAdmin(uid)) {
		refuse(404, "호스트가 없습니다")
	}
	return h
}

// byOperator: said after a host log line when an operator did it on someone else's Mac.
func byOperator(uid string, h M) string {
	if mstr(h, "uid") == uid {
		return ""
	}
	who := uid
	if u, ok := users.Get(uid); ok && u["login"] != nil {
		who = jsString(u["login"])
	}
	return " · 운영자 " + who
}

func liveHost(meta *Sess) string {
	if truthy(meta.get("closed")) {
		refuse(409, "끝난 세션입니다")
	}
	if truthy(meta.get("moving")) {
		refuse(409, "세션을 옮기는 중입니다")
	}
	if !online(meta.host()) {
		refuse(409, "세션의 호스트가 연결돼 있지 않습니다")
	}
	return meta.host()
}

// moveCopies: sid -> the transcript passing from the sending Mac to the receiving one during a move. Memory only.
var moveCopies = map[string]string{}

func hostName(id string) any {
	if h, ok := hosts.Get(id); ok {
		return h["name"]
	}
	return nil
}

// moveSession moves a session to another host (a move, a switch after a disconnect, a reopen, another account or folder).
func moveSession(meta *Sess, target string, toAccount any, newCwd any) M {
	if truthy(meta.get("moving")) {
		refuse(409, "이미 옮기는 중입니다")
	}
	if truthy(meta.get("closed")) {
		refuse(409, "끝난 세션입니다")
	}
	if !online(target) {
		refuse(409, "받는 호스트가 연결돼 있지 않습니다")
	}
	source := meta.host()
	fromAccount := strOr(meta.get("account"), "")
	newCwdS, relocate := newCwd.(string)
	if relocate && target != source {
		refuse(400, "작업 폴더는 같은 맥에서만 바꿀 수 있어요")
	}
	account := ""
	switch {
	case relocate:
		account = fromAccount
	case safeAccount(toAccount):
		account = toAccount.(string)
	case target == source:
		account = fromAccount
	}
	tAccts := asArr(hosts.Val(target)["accounts"])
	findAcct := func(list []any, id string) M {
		for _, a := range list {
			if mget(a, "id") == id {
				return asM(a)
			}
		}
		return nil
	}
	if account != "" && findAcct(tAccts, account) == nil {
		refuse(409, "받는 맥에 그 Claude 계정이 없습니다")
	}
	if account != "" && findAcct(tAccts, account)["loggedIn"] == false {
		refuse(409, "그 Claude 계정은 로그인돼 있지 않습니다. 설정 → Claude 계정에서 먼저 로그인해 주세요")
	}
	switching := !relocate && target == source && account != fromAccount
	accountName := func(hostID, id string) string {
		if a := findAcct(asArr(mget(hosts.Val(hostID), "accounts")), id); a != nil && a["name"] != nil {
			return jsString(a["name"])
		}
		if id != "" {
			return "다른 계정"
		}
		return "기본 계정"
	}
	reopen := !relocate && target == source && !switching
	st := meta.state()
	if reopen && truthy(st["alive"]) {
		refuse(409, "이미 그 호스트에서 돌고 있습니다")
	}
	sourceOnline := !reopen && online(source)
	srcName := "보내는 맥"
	if n := hostName(source); n != nil {
		srcName = jsString(n)
	}
	if !reopen && !switching && !relocate && !sourceOnline {
		refuse(409, srcName+" 이 연결돼 있지 않아 옮길 수 없어요. 서버는 대화 사본을 갖고 있지 않아요. 그 맥을 켜고 연동한 뒤 다시 해 주세요")
	}
	if !reopen && !switching && !relocate && !storeOn(source) {
		refuse(409, srcName+" 의 에이전트가 업데이트되면 옮길 수 있어요")
	}
	if sourceOnline && truthy(st["alive"]) && st["phase"] == "busy" {
		refuse(409, "작업 중입니다. 턴이 끝난 뒤에 옮겨 주세요")
	}
	if card := meta.get("card"); sourceOnline && truthy(st["alive"]) && truthy(card) && mget(card, "kind") != "stuck" {
		refuse(409, "응답을 기다리는 확인 창이 있습니다. 답한 뒤에 옮겨 주세요")
	}
	meta.set("moving", M{"to": target, "at": float64(nowMs())})
	broadcastState(meta.uid())
	note := func(level, text string) {
		record(meta.uid(), target, M{"level": level, "area": "move", "sid": meta.id(), "text": text})
		if target != source {
			record(meta.uid(), source, M{"level": level, "area": "move", "sid": meta.id(), "text": text})
		}
	}
	lines := jsString(numOr0(meta.get("lines")))
	tName := jsStringU(hostName(target))
	switch {
	case relocate:
		note("info", "작업 폴더 바꾸기 시작 (사본 "+lines+"줄)")
	case reopen:
		note("info", tName+" 에서 다시 열기 시작")
	case switching:
		note("info", "Claude 계정 "+accountName(source, fromAccount)+" → "+accountName(target, account)+" 옮기기 시작 (사본 "+lines+"줄)")
	default:
		so := "끊김"
		if sourceOnline {
			so = "연결됨"
		}
		note("info", jsStringU(hostName(source))+" → "+tName+" 옮기기 시작 (보내는 쪽 "+so+", 사본 "+lines+"줄)")
	}
	defer func() {
		delete(moveCopies, meta.id())
		meta.set("moving", nil)
		touch(meta)
	}()
	var folder any
	if !relocate {
		folder = meta.get("folder")
	}
	if sourceOnline && !((switching || relocate) && !truthy(st["alive"])) {
		flushed := ask(source, M{"t": "flush", "sid": meta.id()}, 90_000)
		if truthy(flushed["folder"]) && !relocate {
			folder = flushed["folder"]
		}
		if !truthy(flushed["ok"]) {
			note("error", "보내는 호스트의 마지막 싱크 실패: "+strOr(flushed["error"], ""))
			refuse(502, "보내는 호스트에서 마지막 싱크를 하지 못했습니다: "+strOr(flushed["error"], ""))
		}
	}
	conv := meta.get("conv")
	if conv == nil {
		conv = meta.id()
	}
	local := reopen || switching || relocate
	if !local {
		var parts [][]byte
		from := 0
		for n := 0; n < 200; n++ {
			r := ask(source, M{"t": "export", "sid": meta.id(), "conv": conv, "from": float64(from)}, 120_000)
			if !truthy(r["ok"]) {
				note("error", "보내는 맥에서 대화를 받지 못함: "+strOr(r["error"], ""))
				refuse(502, "보내는 맥에서 대화를 받지 못했어요: "+strOr(r["error"], ""))
			}
			part := decodeB64(strOr(r["data"], ""))
			parts = append(parts, part)
			from += len(part)
			if truthy(r["done"]) || len(part) == 0 {
				break
			}
		}
		moveCopies[meta.id()] = validUTF8(string(bytes.Join(parts, nil)))
	}
	cwd := meta.get("cwd")
	var home any = meta.get("home")
	if relocate {
		cwd = newCwdS
		home = nil
	}
	open := M{"t": "open", "sysPrompt": sysPromptOf(meta.uid()), "sid": meta.id(), "conv": conv, "cwd": cwd, "home": home, "folder": folder, "autoPush": meta.get("autoPush"), "autoAllow": meta.get("autoAllow"), "allowAll": truthy(meta.get("autoAllow")) && truthy(meta.get("allowAll")), "model": orStr(meta.get("launchModel")), "effort": orStr(st["effort"]), "mode": orStr(st["mode"])}
	if home == nil {
		delete(open, "home")
	}
	if local {
		open["local"] = true
	}
	if truthy(meta.get("mdFile")) {
		open["mdFile"] = meta.get("mdFile")
	}
	if meta.get("chrome") == false {
		open["chrome"] = false
	}
	if account != "" {
		open["account"] = account
	}
	opened := ask(target, open, 600_000)
	// Nothing has changed on the source yet: a failure here leaves the session where it was.
	if !truthy(opened["ok"]) {
		note("error", "받는 호스트에서 열지 못함: "+strOr(opened["error"], "")+". 세션은 원래 자리에 그대로 있음")
		refuse(502, "받는 호스트에서 열지 못했습니다: "+strOr(opened["error"], ""))
	}
	warnings := asArr(opened["warnings"])
	warnText := strings.Join(strList(warnings), " / ")
	if len(warnings) > 0 {
		note("warn", "완료 — 확인할 것: "+warnText)
	} else {
		note("info", "완료")
	}
	hadLog := truthy(meta.get("agentLog"))
	carried := hadLog
	if !local && hadLog {
		carried = carryLog(meta, source, target)
		if !carried {
			note("warn", "세션 기록을 받는 맥으로 다 옮기지 못함: 보내는 맥이 다시 연결되면 이어서 옮김")
		}
	}
	resetVolatile(meta)
	ns := noState()
	ns["alive"] = true
	ns["phase"] = "idle"
	meta.set("state", ns)
	var where string
	switch {
	case relocate:
		c := opened["cwd"]
		if c == nil {
			c = newCwdS
		}
		where = "작업 폴더를 " + jsString(c) + " 로 바꿨습니다"
	case reopen:
		where = tName + " 에서 다시 열었습니다"
	case switching:
		where = "Claude 계정 " + accountName(source, fromAccount) + " → " + accountName(target, account) + " 로 옮겼습니다"
	default:
		sn := "알 수 없는 기기"
		if n := hostName(source); n != nil {
			sn = jsString(n)
		}
		where = sn + " → " + tName + " 로 옮겼습니다"
	}
	tone := "info"
	text := where + " · 사본 " + lines + "줄 기준"
	if len(warnings) > 0 {
		tone = "warn"
		text += " · 확인할 것: " + warnText
	}
	notice := M{"k": "notice", "tone": tone, "text": text}
	if switching {
		notice["icon"] = "move"
	}
	if safeAccount(opened["account"]) {
		meta.set("account", opened["account"])
	} else {
		meta.set("account", account)
	}
	if relocate {
		c := opened["cwd"]
		if c == nil {
			c = newCwdS
		}
		meta.set("cwd", c)
		meta.set("folder", nil)
	}
	if warnings == nil {
		warnings = []any{}
	}
	if switching {
		meta.set("moves", append(asArr(meta.get("moves")), M{"at": float64(nowMs()), "from": source, "to": target, "lines": meta.get("lines"), "sourceOnline": sourceOnline, "warnings": warnings, "fromAccount": fromAccount, "account": account}))
	}
	// Released only on another Mac.
	if !reopen && !switching && !relocate {
		meta.set("moves", append(asArr(meta.get("moves")), M{"at": float64(nowMs()), "from": source, "to": target, "lines": meta.get("lines"), "sourceOnline": sourceOnline, "warnings": warnings}))
		meta.set("prevHostId", source)
		meta.set("hostId", target)
		meta.set("cwd", opened["cwd"])
		meta.set("home", hosts.Val(target)["home"])
		meta.set("folder", nil)
		meta.set("agentLog", carried)
		if !carried && hadLog {
			meta.set("carryFrom", source)
		}
		toHost(source, M{"t": "release", "sid": meta.id()})
	}
	logEvents(meta, []any{notice})
	toHost(target, M{"t": "report", "sid": meta.id()})
	if !truthy(meta.get("agentLog")) && storeOn(target) {
		uid := meta.uid()
		setTimeout(0, func() { goLocked("migrate", func() { migrateHost(uid, target) }) })
	}
	return M{"ok": true, "warnings": warnings}
}

// carryLog: a session's log from one Mac to another, a page at a time, each page kept before the next (REQ-S-069).
func carryLog(meta *Sess, from, to string) bool {
	after := 0.0
	for n := 0; n < 10_000; n++ {
		if !online(from) || !online(to) {
			return false
		}
		r := ask(from, M{"t": "events", "sid": meta.id(), "after": after, "limit": 500.0}, 30_000)
		evs, ok := r["events"].([]any)
		if !truthy(r["ok"]) || !ok {
			return false
		}
		if len(evs) > 0 {
			lid := handDown(to, M{"t": "log", "sid": meta.id(), "events": evs})
			if lid == "" || !allTrue([]chan bool{waitKept(lid, 120_000)}) {
				return false
			}
			after = numOr0(mget(evs[len(evs)-1], "seq"))
		}
		if !truthy(r["more"]) {
			return true
		}
	}
	return false
}

var _ = regexp.MustCompile
var _ = time.Second
