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
	sessionRouteRe = regexp.MustCompile(`^/api/sessions/([a-zA-Z0-9-]+)(?:/(\w+))?$`)
	proofRe        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	b64Re          = regexp.MustCompile(`^[A-Za-z0-9+/]+=*$`)
	sessionMdRe    = regexp.MustCompile(`^SESSION(-[0-9a-f]{8})?\.md$`)
	localImgRe     = regexp.MustCompile(`(?i)^(~|/)[^\x00\n]{1,1000}\.(png|jpe?g|gif|webp)$`)
	cmdWordRe      = regexp.MustCompile(`^[a-z]{2,20}$`)
	slashColonRe   = regexp.MustCompile(`^[/:]`)
	correctionRe   = regexp.MustCompile(`^\[정정\]`)
	cwdStartRe     = regexp.MustCompile(`^(/|~(/|$))`)
	cwdBadRe       = regexp.MustCompile(`[\x00\n\r]`)
	trailSlashRe   = regexp.MustCompile(`/+$`)
	uuid36Re       = regexp.MustCompile(`^[0-9a-f-]{36}$`)
)

func apiSessions(req *Req, res *Res, u *url.URL, uid string) bool {
	m := sessionRouteRe.FindStringSubmatch(u.Path)
	if m == nil {
		return false
	}
	get := req.Method == "GET"
	post := req.Method == "POST"
	meta := ownSession(uid, m[1])
	op := m[2]
	if post && (op == "lock" || op == "unlock" || op == "lockclear") {
		// Per address, and per session whatever address the attempts claim (R1-M4).
		if limited(req, 10, "lock") || hit("lock-session|"+meta.id(), 10) {
			refuse(429, "너무 자주 시도했어요. 잠시 뒤에 다시 해 주세요")
		}
		b := body(req, 4096)
		if op == "unlock" {
			if !truthy(meta.get("lock")) {
				jsonRes(res, 200, M{"ok": true, "token": nil})
				return true
			}
			if !proofOk(meta, b["proof"]) {
				refuse(403, "비밀번호가 맞지 않아요")
			}
			sessBefore("session.lock", meta, kv{"do", "unlock"})
			if !truthy(meta.get("lock")) {
				jsonRes(res, 200, M{"ok": true, "token": nil}) // cleared while the hook answered
				return true
			}
			sessAfter("session.lock", meta, kv{"do", "unlock"})
			jsonRes(res, 200, M{"ok": true, "token": lockToken(meta)})
			return true
		}
		if op == "lockclear" {
			if !truthy(meta.get("lock")) {
				jsonRes(res, 200, M{"ok": true})
				return true
			}
			if !proofOk(meta, b["proof"]) {
				refuse(403, "비밀번호가 맞지 않아요")
			}
			sessBefore("session.lock", meta, kv{"do", "lockclear"})
			meta.del("lock")
			dropUnlocks(meta.id())
			touch(meta)
			broadcastState(uid)
			sessAfter("session.lock", meta, kv{"do", "lockclear"})
			jsonRes(res, 200, M{"ok": true, "note": "잠금을 없앴어요"})
			return true
		}
		if truthy(meta.get("lock")) && !unlockedBy(req, meta) {
			refuse(423, LOCKED)
		}
		if seatOf(meta) == "slack" {
			refuse(409, "Slack 에서 작업 중인 세션은 잠글 수 없어요. 브릿지로 가져온 뒤 잠가 주세요")
		}
		if !proofRe.MatchString(strField(b, "proof")) {
			refuse(400, "비밀번호가 올바르지 않아요")
		}
		sessBefore("session.lock", meta, kv{"do", "lock"})
		salt := randHex(16)
		meta.set("lock", orderedObj{{"salt", salt}, {"hash", stretch(b["proof"].(string), salt)}, {"at", float64(nowMs())}}.toM())
		dropUnlocks(meta.id())
		touch(meta)
		broadcastState(uid)
		sessAfter("session.lock", meta, kv{"do", "lock"})
		jsonRes(res, 200, M{"ok": true, "token": lockToken(meta), "note": "잠갔어요. 다른 기기와 탭에서는 비밀번호를 물어요"})
		return true
	}
	if truthy(meta.get("lock")) && !req.internal && !unlockedBy(req, meta) {
		refuseX(423, LOCKED, M{"locked": true})
	}
	if post && !req.internal && SEAT_DRIVES[op] {
		seatGuard(meta, "web")
	}
	if post && op == "seat" {
		b := body(req, 16*1024)
		jsonRes(res, 200, moveSeat(uid, meta, b["to"]))
		return true
	}
	if post && op == "voice" {
		needFeature("voice")
		b := body(req, 4*1024*1024)
		prefs := cleanVoice(prefsOf(uid)["voice"])
		if !truthy(prefs["on"]) {
			refuse(409, "음성 입력이 꺼져 있어요. 설정 → 음성에서 켜 주세요")
		}
		audio := strField(b, "audio")
		if audio == "" || !b64Re.MatchString(audio) {
			refuse(400, "녹음이 비어 있어요")
		}
		hostID := liveHost(meta)
		over := cleanVoiceHost(mget(prefsOf(uid)["voiceHosts"], hostID))
		model := over["model"]
		if !truthy(model) {
			model = prefs["model"]
		}
		r := ask(hostID, M{"t": "voice", "audio": audio, "opts": orderedObj{{"model", model}, {"language", prefs["language"]}, {"denoise", prefs["denoise"]}, {"tidy", prefs["tidy"]}, {"terms", prefs["terms"]}}}, 90_000)
		if !truthy(r["ok"]) {
			status := 502
			if r["code"] == "silent" || r["code"] == "audio" {
				status = 422
			}
			code := r["code"]
			if code == nil {
				code = "error"
			}
			refuseX(status, orStr(r["error"], "받아쓰지 못했어요"), M{"code": code})
		}
		jsonRes(res, 200, orderedObj{{"ok", true}, {"raw", strField(r, "raw")}, {"text", strField(r, "text")}, {"sec", r["sec"]}, {"backend", r["backend"]}, {"model", r["model"]}, {"denoise", r["denoise"]}, {"ms", r["ms"]}}.dropNil())
		return true
	}
	if post && op == "preview" {
		needFeature("preview")
	}
	if post && (op == "preview" || op == "killserver") {
		b := body(req, 4096)
		port := jsNumber(b["port"])
		hostID := liveHost(meta)
		found := false
		for _, x := range asArr(meta.state()["servers"]) {
			if mget(x, "port") == port {
				found = true
			}
		}
		if !found {
			refuse(404, "이 세션이 띄운 "+jsStringU(b["port"])+" 포트 서버가 없어요")
		}
		if op == "preview" {
			jsonRes(res, 200, M{"ok": true, "url": preview.url(uid, meta.host(), port, meta.id())})
			return true
		}
		sessBefore("session.do", meta, kv{"do", "killserver"}, kv{"port", port})
		r := ask(hostID, M{"t": "killserver", "sid": meta.id(), "port": port}, 15_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "서버를 끄지 못했어요"))
		}
		sessAfter("session.do", meta, kv{"do", "killserver"}, kv{"port", port})
		jsonRes(res, 200, M{"ok": true, "note": r["note"]})
		return true
	}
	if get && op == "events" {
		sessionEvents(res, u, meta)
		return true
	}
	if get && op == "agentsmd" {
		which := ""
		if qstr(u, "file") == "session" {
			which = "session"
		}
		cmd := M{"t": "readfile", "sid": meta.id()}
		if which != "" {
			cmd["which"] = which
		}
		r := ask(liveHost(meta), cmd, 15_000)
		if !truthy(r["ok"]) {
			refuse(404, orStr(r["error"], "파일을 읽지 못했습니다"))
		}
		if which != "" && !sessionMdRe.MatchString(jsStringU(r["name"])) {
			refuse(404, "에이전트가 업데이트되면 볼 수 있어요")
		}
		jsonRes(res, 200, M{"ok": true, "name": r["name"], "path": r["path"], "content": jsSliceTo(jsStringU(r["content"]), 512*1024)})
		return true
	}
	if get && op == "localimg" {
		want := qstr(u, "path")
		if !localImgRe.MatchString(want) {
			refuse(400, "그림 파일 경로가 아니에요")
		}
		if !online(meta.host()) {
			refuse(409, "세션의 호스트가 연결돼 있지 않습니다")
		}
		r := ask(meta.host(), M{"t": "readimage", "sid": meta.id(), "path": want}, 30_000)
		if !truthy(r["ok"]) {
			refuse(404, orStr(r["error"], "그림을 읽지 못했습니다"))
		}
		bytes := decodeB64(strField(r, "data"))
		typ, _ := r["type"].(string)
		if IMG_TYPES[typ] == "" || len(bytes) == 0 || len(bytes) > 12*1024*1024 {
			refuse(404, "그림을 읽지 못했습니다")
		}
		res.WriteHead(200, M{"Content-Type": typ, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"}).End(bytes)
		return true
	}
	if get && op == "skills" {
		r := ask(liveHost(meta), M{"t": "skills", "sid": meta.id()}, 20_000)
		if !truthy(r["ok"]) {
			refuse(502, orStr(r["error"], "스킬 목록을 읽지 못했습니다"))
		}
		menu := r["menu"]
		if menu == nil {
			other := []any{}
			for _, x := range asArr(r["skills"]) {
				other = append(other, orderedObj{{"name", mget(x, "name")}, {"kind", "skill"}, {"source", mget(x, "source")}, {"count", 0}, {"description", mget(x, "description")}}.dropNil())
			}
			menu = M{"direct": []any{}, "auto": []any{}, "other": other}
		}
		mv, _ := parseJSON(jsonBytes(menu))
		mm := asM(mv)
		flat := []any{}
		add := func(list any, direct, auto func(M) any) {
			for _, x := range asArr(list) {
				y := shallow(asM(x))
				y["direct"] = direct(asM(x))
				y["auto"] = auto(asM(x))
				flat = append(flat, y)
			}
		}
		zero := func(M) any { return 0 }
		count := func(x M) any { return x["count"] }
		add(mm["direct"], count, zero)
		add(mm["auto"], zero, count)
		add(mm["other"], zero, zero)
		jsonRes(res, 200, M{"ok": true, "menu": mm, "skills": flat})
		return true
	}
	if get && op == "screen" {
		r := ask(liveHost(meta), M{"t": "screen", "sid": meta.id()}, 15_000)
		if !truthy(r["ok"]) && truthy(r["error"]) {
			refuse(502, jsString(r["error"]))
		}
		jsonRes(res, 200, M{"ok": true, "text": jsSliceTo(strField(r, "text"), 200_000)})
		return true
	}
	if get && op == "links" {
		jsonRes(res, 200, sessionLinks(meta, linksLimit(u.Query())))
		return true
	}
	if get && op == "trash" {
		r := ask(liveHost(meta), M{"t": "trashinfo", "sid": meta.id()}, 30_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "폴더를 살펴보지 못했습니다"))
		}
		jsonRes(res, 200, M{"ok": true, "cwd": r["cwd"], "repos": r["repos"]})
		return true
	}
	if req.Method == "DELETE" && op == "" {
		if truthy(meta.get("moving")) {
			refuse(409, "세션을 옮기는 중입니다")
		}
		sessBefore("session.close", meta, kv{"kind", "remove"})
		toHost(meta.host(), M{"t": "close", "sid": meta.id()})
		sessAfter("session.close", meta, kv{"kind", "remove"})
		forgetSession(meta)
		savePrefs(uid)
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	if !post {
		refuse(405, "지원하지 않는 요청입니다")
	}
	if op == "upload" {
		out := M{"ok": true}
		for k, v := range saveUpload(uid, req, u) {
			out[k] = v
		}
		jsonRes(res, 200, out)
		return true
	}
	limit := 256 * 1024
	if op == "send" || op == "say" {
		limit = 6 * 1024 * 1024
	}
	b := body(req, limit)
	if sessionPost(req, res, uid, meta, op, b) {
		return true
	}
	jsonRes(res, 200, M{"ok": true})
	return true
}

func dropUnlocks(sid string) {
	for k, t := range unlocks {
		if t["sid"] == sid {
			delete(unlocks, k)
		}
	}
}

func (o orderedObj) toM() M {
	m := M{}
	for _, e := range o {
		m[e.K] = e.V
	}
	return m
}

func sessionEvents(res *Res, u *url.URL, meta *Sess) {
	q := u.Query()
	extra := func(o orderedObj) orderedObj {
		last := meta.get("seq")
		if last == nil {
			last = 0.0
		}
		w := meta.get("writing")
		if !truthy(w) {
			w = ""
		}
		o = append(o, kv{"last", last})
		if v, ok := meta.m["lines"]; ok {
			o = append(o, kv{"lines", v})
		}
		o = append(o, kv{"writing", w})
		if v, ok := meta.m["card"]; ok {
			o = append(o, kv{"card", v})
		}
		return o
	}
	_, hasAfter := q["after"]
	_, hasBefore := q["before"]
	after := jsNumber(q.Get("after"))
	before := jsNumber(q.Get("before"))
	if truthy(meta.get("agentLog")) && !isDemoHost(meta.host()) {
		if !online(meta.host()) {
			jsonRes(res, 409, extra(orderedObj{{"error", "맥 연결 끊김"}, {"offline", true}}))
			return
		}
		if storeOn(meta.host()) {
			cmd := M{"t": "events", "sid": meta.id(), "limit": EVENTS_PAGE}
			if hasAfter {
				cmd["after"] = after
			}
			if hasBefore {
				cmd["before"] = before
			}
			r := ask(meta.host(), cmd, 15_000)
			if !truthy(r["ok"]) {
				jsonRes(res, 502, extra(orderedObj{{"error", orStr(r["error"], "맥에서 세션 기록을 읽지 못했어요")}}))
				return
			}
			evs := asArr(r["events"])
			bySeq := map[float64]any{}
			for _, e := range evs {
				bySeq[jsNumber(mget(e, "seq"))] = e
			}
			lo := math.Inf(-1)
			if hasAfter {
				lo = after
			}
			hi := math.Inf(1)
			if hasBefore {
				hi = before
			}
			top := 0.0
			if len(evs) > 0 {
				top = numOr0(mget(evs[len(evs)-1], "seq"))
			}
			for _, e := range handedNotKept(meta) {
				s := jsNumber(mget(e, "seq"))
				if _, has := bySeq[s]; s > lo && s < hi && !has && (!hasAfter || !truthy(r["more"]) || s < top) {
					bySeq[s] = e
				}
			}
			keys := make([]float64, 0, len(bySeq))
			for k := range bySeq {
				keys = append(keys, k)
			}
			sort.Float64s(keys)
			page := make([]any, 0, len(keys))
			for _, k := range keys {
				page = append(page, bySeq[k])
			}
			more := truthy(r["more"])
			if len(page) > EVENTS_PAGE {
				more = true
				if hasAfter {
					page = page[:EVENTS_PAGE]
				} else {
					page = page[len(page)-EVENTS_PAGE:]
				}
			}
			if !hasAfter && !hasBefore {
				remember(meta, page, true)
			}
			jsonRes(res, 200, extra(orderedObj{{"events", page}, {"more", more}}))
			return
		}
	}
	all := readEvents(meta, false)
	var page []any
	var more bool
	if hasAfter {
		rest := []any{}
		for _, e := range all {
			if jsNumber(mget(e, "seq")) > after {
				rest = append(rest, e)
			}
		}
		page = rest
		if len(page) > EVENTS_PAGE {
			page = page[:EVENTS_PAGE]
		}
		more = len(rest) > len(page)
	} else {
		older := all
		if hasBefore {
			older = []any{}
			for _, e := range all {
				if jsNumber(mget(e, "seq")) < before {
					older = append(older, e)
				}
			}
		}
		page = older
		if len(page) > EVENTS_PAGE {
			page = page[len(page)-EVENTS_PAGE:]
		}
		more = len(older) > len(page)
	}
	jsonRes(res, 200, extra(orderedObj{{"events", page}, {"more", more}}))
}

func sessionPost(req *Req, res *Res, uid string, meta *Sess, op string, b M) bool {
	switch op {
	case "say":
		text := strField(b, "text")
		key := uid + "|say|" + meta.id() + "|" + text + "|" + itoa(len(asArr(b["images"]))) + "|" + itoa(len(asArr(b["videos"])))
		if seenJustNow(key, 0) {
			jsonRes(res, 200, M{"ok": true, "note": "같은 글을 방금 보냈어요"})
			return true
		}
		var via any
		if b["via"] == "slack" {
			via = "slack"
		}
		var r M
		if err := try(func() {
			r = csSend(uid, meta, text, asArr(b["images"]), via, csOptsCmd{unlocked: true, videos: asArr(b["videos"])})
		}); err != nil {
			recentKeys.Delete(key)
			panic(err)
		}
		out := M{"ok": true}
		if r != nil && truthy(r["note"]) {
			out["note"] = r["note"]
		}
		jsonRes(res, 200, out)
		return true
	case "do":
		cmd := strField(b, "cmd")
		if !cmdWordRe.MatchString(cmd) {
			refuse(400, "알 수 없는 명령이에요")
		}
		arg := strField(b, "arg")
		key := uid + "|do|" + meta.id() + "|" + cmd + "|" + arg
		if seenJustNow(key, 0) {
			jsonRes(res, 200, M{"ok": true, "note": ""})
			return true
		}
		var note string
		pid := numStr(numOr0(csIds(meta).get("pid")))
		if err := try(func() {
			note = csCommand(uid, pid+":"+cmd+" "+jsSliceTo(arg, 200), csOptsCmd{unlocked: true})
		}); err != nil {
			recentKeys.Delete(key)
			panic(err)
		}
		if note == "눌렀어요" {
			note = ""
		}
		jsonRes(res, 200, M{"ok": true, "note": note})
		return true
	case "send":
		sendOp(req, uid, meta, b)
	case "retract":
		said := []any{}
		ev := recentEvents(meta, nil)
		if len(ev) > 3000 {
			ev = ev[len(ev)-3000:]
		}
		for _, e := range ev {
			if mget(e, "k") == "user" && !truthy(mget(e, "command")) && !correctionRe.MatchString(jsStringU(mget(e, "text"))) {
				said = append(said, e)
			}
		}
		var last any
		idOf := func(e any) any {
			if v := mget(e, "id"); v != nil {
				return v
			}
			return "u" + numStr(jsNumber(mget(e, "seq")))
		}
		if ts, ok := b["ts"].(string); ok && ts != "" {
			for _, e := range said {
				if idOf(e) == ts {
					last = e
					break
				}
			}
		} else if len(said) > 0 {
			last = said[len(said)-1]
		}
		if last == nil {
			refuse(400, "그 메시지를 찾지 못했어요")
		}
		quoted := jsTrim(wsRun.ReplaceAllString(jsStringU(mget(last, "text")), " "))
		if jsLen(quoted) > 80 {
			quoted = jsSliceTo(quoted, 79) + "…"
		}
		sessBefore("message.retract", meta, kv{"do", "retract"})
		toHost(liveHost(meta), M{"t": "retract", "sid": meta.id(), "quoted": quoted})
		logEvents(meta, []any{M{"k": "react", "id": idOf(last), "name": "x", "on": true}})
		sessAfter("message.retract", meta, kv{"do", "retract"})
		jsonRes(res, 200, M{"ok": true, "note": "멈추고 잘못 보냈다고 알렸어요"})
		return true
	case "sendnow", "esc":
		sessBefore("session.do", meta, kv{"do", op})
		toHost(liveHost(meta), M{"t": op, "sid": meta.id()})
		if op == "esc" {
			for _, c := range delegatesOf(meta) {
				toHost(c.host(), M{"t": "esc", "sid": c.id()})
			}
		}
		sessAfter("session.do", meta, kv{"do", op})
	case "dropheld":
		sessBefore("message.retract", meta, kv{"do", "dropheld"})
		cmd := M{"t": "dropheld", "sid": meta.id()}
		if s, ok := b["id"].(string); ok {
			cmd["id"] = jsSliceTo(s, 64)
		}
		r := ask(liveHost(meta), cmd, 10_000)
		ids := []any{}
		for _, x := range asArr(r["ids"]) {
			if _, ok := x.(string); ok && len(ids) < 50 {
				ids = append(ids, x)
			}
		}
		if len(ids) > 0 {
			evs := []any{}
			for _, id := range ids {
				evs = append(evs, M{"k": "react", "id": id, "name": "hourglass_flowing_sand", "on": false}, M{"k": "react", "id": id, "name": "x", "on": true})
			}
			logEvents(meta, evs)
		}
		held := []any{}
		for _, x := range asArr(meta.get("heldIds")) {
			if !containsAny(ids, x) {
				held = append(held, x)
			}
		}
		meta.set("heldIds", held)
		echo := []any{}
		for _, x := range asArr(meta.get("echo")) {
			if !containsAny(ids, mget(x, "id")) {
				echo = append(echo, x)
			}
		}
		meta.set("echo", echo)
		sessAfter("message.retract", meta, kv{"do", "dropheld"}, kv{"ids", ids})
		jsonRes(res, 200, M{"ok": true, "ids": ids})
		return true
	case "answer":
		if !safeId(b["card"]) {
			refuse(400, "카드가 올바르지 않습니다")
		}
		var n any
		if b["n"] == "esc" || b["n"] == "enter" {
			n = b["n"]
		} else {
			n = jsNumber(b["n"])
		}
		card, option := answerOf(meta, b["card"].(string), n)
		if otherCardOpen(meta, b["card"].(string)) {
			refuse(409, OTHER_CARD)
		}
		if len(hooksOf("permission.answer.before")) > 0 {
			cid := b["card"].(string)
			actionBefore("permission.answer", uid, meta.id()+"|"+cid, orderedObj{{"session", sessionOfEvent(meta)}, {"card", card}, {"option", option}, {"by", curBy()}}, func() bool {
				cur, ok := sessions.Get(meta.id())
				return ok && cur == meta && !otherCardOpen(meta, cid)
			})
		}
		toHost(liveHost(meta), M{"t": "answer", "sid": meta.id(), "card": b["card"], "n": n})
		noteAnswer(b["card"].(string), M{"n": n, "via": "card", "by": curBy()})
		sessAfter("permission.answer", meta, kv{"card", card}, kv{"option", option})
	case "setting":
		if !containsAny([]any{"model", "effort", "mode"}, b["kind"]) {
			refuse(400, "없는 설정입니다")
		}
		if b["kind"] == "mode" && !modeOk(strField(b, "value")) {
			refuse(403, FEATURE_OFF)
		}
		sessBefore("session.setting", meta, kv{"kind", b["kind"]}, kv{"value", jsSliceTo(strField(b, "value"), 60)})
		toHost(liveHost(meta), M{"t": "setting", "sid": meta.id(), "kind": b["kind"], "value": jsSliceTo(strField(b, "value"), 60)})
		sessAfter("session.setting", meta, kv{"kind", b["kind"]}, kv{"value", jsSliceTo(strField(b, "value"), 60)})
	case "refresh":
		when := "now"
		if b["when"] == "later" || b["when"] == "cancel" {
			when = b["when"].(string)
		}
		sessBefore("session.do", meta, kv{"do", "refresh"}, kv{"when", when})
		refreshSession(uid, meta, liveHost(meta), when)
		sessAfter("session.do", meta, kv{"do", "refresh"}, kv{"when", when})
	case "report":
		toHost(liveHost(meta), M{"t": "report", "sid": meta.id()})
	case "btw":
		q := jsTrim(strField(b, "text"))
		if q == "" {
			refuse(400, "질문을 적어 주세요")
		}
		sessBefore("message.btw", meta, kv{"text", q})
		r := ask(liveHost(meta), M{"t": "btw", "sid": meta.id(), "text": q}, 150_000)
		sessAfter("message.btw", meta, kv{"text", q})
		if truthy(r["ok"]) {
			jsonRes(res, 200, M{"ok": true, "answer": jsSliceTo(jsStringU(r["answer"]), 20_000)})
		} else {
			jsonRes(res, 200, orderedObj{{"ok", false}, {"error", r["error"]}}.dropNil())
		}
		return true
	case "trash":
		sessBefore("session.close", meta, kv{"kind", "trash"})
		r := ask(liveHost(meta), M{"t": "trash", "sid": meta.id()}, 60_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "폴더를 휴지통으로 옮기지 못했습니다"))
		}
		meta.set("closed", true)
		meta.set("closedAt", float64(nowMs()))
		resetVolatile(meta)
		logEvents(meta, []any{M{"k": "end", "text": "폴더를 휴지통으로 옮김"}})
		sessAfter("session.close", meta, kv{"kind", "trash"})
		jsonRes(res, 200, M{"ok": true, "note": "세션을 끝내고 폴더를 휴지통으로 옮겼어요 · " + jsStringU(r["to"])})
		return true
	case "resume":
		if !truthy(meta.get("closed")) {
			refuse(409, "끝난 세션이 아닙니다")
		}
		target := meta.host()
		if s, ok := b["hostId"].(string); ok {
			target = s
		}
		ownHost(uid, target)
		if target != meta.host() {
			needFeature("sessionMove")
		}
		sessBefore("session.move", meta, kv{"do", "resume"}, kv{"hostId", target})
		if !truthy(meta.get("closed")) {
			refuse(409, "끝난 세션이 아닙니다")
		}
		meta.set("closed", false)
		meta.set("resting", false)
		same := target == meta.host()
		var r M
		if err := try(func() {
			if same {
				meta.set("state", noState())
			}
			var acc any
			if safeAccount(b["account"]) {
				acc = b["account"]
			}
			r = moveSession(meta, target, acc, nil)
		}); err != nil {
			meta.set("closed", true)
			touch(meta)
			panic(err)
		}
		sessAfter("session.move", meta, kv{"do", "resume"}, kv{"hostId", target})
		jsonRes(res, 200, r)
		return true
	case "trimlog":
		st := meta.state()
		if !truthy(st["alive"]) || st["phase"] != "idle" {
			refuse(409, "쉬고 있는 세션만 기록을 정리할 수 있어요")
		}
		sessBefore("session.do", meta, kv{"do", "trimlog"})
		r := ask(liveHost(meta), M{"t": "trimlog", "sid": meta.id()}, 120_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], "대화 기록을 정리하지 못했어요"))
		}
		after := numOr0(numOrNaN0(r["after"]))
		bef := numOr0(numOrNaN0(r["before"]))
		meta.state()["size"] = after
		broadcastState(uid)
		sessAfter("session.do", meta, kv{"do", "trimlog"})
		jsonRes(res, 200, M{"ok": true, "before": bef, "after": after, "note": "대화 기록을 " + numStr(jsRound(bef/1048576)) + "MB → " + numStr(math.Max(1, jsRound(after/1048576))) + "MB 로 정리했어요"})
		return true
	case "lightfork":
		hostID := liveHost(meta)
		title := meta.str("title")
		if title == "" {
			title = "세션"
		}
		title = patched(forkBefore(meta, "lightfork", title), "title", title)
		hostID = liveHost(meta)
		sid := uuidv4()
		over := launchOver(uid)
		lm := over["model"]
		if !truthy(lm) {
			lm = meta.get("launchModel")
			if !truthy(lm) {
				lm = ""
			}
		}
		acc := meta.get("account")
		if acc == nil {
			acc = ""
		}
		cp := newMeta(uid, sid, hostID, M{"cwd": meta.get("cwd"), "title": jsSliceTo(title, 80), "manualTitle": true, "launchModel": lm, "autoPush": meta.get("autoPush"), "account": acc})
		st := noState()
		st["alive"] = true
		st["phase"] = "starting"
		cp.set("state", st)
		cmd := M{"t": "lightfork", "sid": meta.id(), "newSid": sid, "sysPrompt": sysPromptOf(uid), "launch": over}
		if b["mode"] == "shrink" || b["mode"] == "cut" {
			cmd["mode"] = b["mode"]
		}
		r := ask(hostID, cmd, 240_000)
		if !truthy(r["ok"]) {
			sessions.Delete(sid)
			dirty.Delete(sid)
			broadcastState(uid)
			if truthy(r["tooBig"]) {
				name := "SESSION.md"
				if r["name"] != nil && sessionMdRe.MatchString(jsString(r["name"])) {
					name = jsString(r["name"])
				}
				max := numOrNaN0(r["max"])
				if max == 0 {
					max = 20_000
				}
				text := name + " 가 " + numStr(jsRound(jsNumber(r["tooBig"])/1000)) + " KB 예요(넘길 수 있는 건 " + numStr(jsRound(max/1000)) + " KB) · 줄여서 넘길까요?"
				pid := numStr(numOr0(csIds(meta).get("pid")))
				btn := func(label, value, style string) orderedObj {
					o := orderedObj{{"type", "button"}, {"text", orderedObj{{"type", "plain_text"}, {"text", label}, {"emoji", true}}}, {"action_id", "ctl_btn"}, {"value", value}}
					if style != "" {
						o = append(o, kv{"style", style})
					}
					return o
				}
				logEvents(meta, []any{M{"k": "line", "text": text, "blocks": toJSONValue([]any{
					orderedObj{{"type", "section"}, {"text", orderedObj{{"type", "mrkdwn"}, {"text", text}}}},
					orderedObj{{"type", "actions"}, {"block_id", "lightfork_" + pid}, {"elements", []any{btn("줄이기", pid+":lightfork shrink", "primary"), btn("앞부분만", pid+":lightfork cut", "")}}},
				})}})
				jsonRes(res, 200, M{"ok": false, "tooBig": true})
				return true
			}
			refuse(502, orStr(r["error"], "가벼운 복제를 하지 못했습니다"))
		}
		inheritAllow(cp, meta, uid)
		touch(cp)
		besideInGroup(uid, meta.id(), sid)
		savePrefs(uid)
		toHost(hostID, M{"t": "report", "sid": sid})
		createdAfter(cp, "lightfork", "")
		jsonRes(res, 200, M{"ok": true, "id": sid})
		return true
	case "fork":
		forkOp(res, uid, meta)
		return true
	case "key":
		needFeature("remoteKeys")
		keys := []any{}
		for _, k := range asArr(b["keys"]) {
			if len(keys) < 20 {
				keys = append(keys, jsStringU(k))
			}
		}
		sessBefore("session.key", meta, kv{"keys", keys})
		toHost(liveHost(meta), M{"t": "key", "sid": meta.id(), "keys": keys})
		sessAfter("session.key", meta, kv{"keys", keys})
	case "screen":
		toHost(liveHost(meta), M{"t": "screen", "sid": meta.id()})
	case "cwd":
		cwd := ""
		if s, ok := b["cwd"].(string); ok {
			cwd = trailSlashRe.ReplaceAllString(jsTrim(s), "")
			if cwd == "" {
				cwd = "/"
			}
		}
		if !cwdStartRe.MatchString(cwd) || jsLen(cwd) > 1000 || cwdBadRe.MatchString(cwd) || contains(strings.Split(cwd, "/"), "..") {
			refuse(400, "작업 폴더는 / 또는 ~ 로 시작하는 경로여야 해요")
		}
		ownHost(uid, meta.host())
		sessBefore("session.move", meta, kv{"do", "cwd"}, kv{"cwd", cwd})
		r := moveSession(meta, meta.host(), nil, M{"cwd": cwd})
		sessAfter("session.move", meta, kv{"do", "cwd"}, kv{"cwd", cwd})
		jsonRes(res, 200, r)
		return true
	case "move":
		hostID := b["hostId"]
		if hostID == nil {
			hostID = meta.host()
		}
		if hostID != meta.host() {
			needFeature("sessionMove") // another account on the same Mac stays
		}
		ownHost(uid, hostID)
		if v, has := b["account"]; has && !safeAccount(v) {
			refuse(400, "계정 id 가 올바르지 않습니다")
		}
		sessBefore("session.move", meta, kv{"do", "move"}, kv{"hostId", hostID})
		r := moveSession(meta, hostID.(string), b["account"], nil)
		sessAfter("session.move", meta, kv{"do", "move"}, kv{"hostId", hostID})
		jsonRes(res, 200, r)
		return true
	case "settings":
		_, aa := b["autoAllow"].(bool)
		_, ap := b["autoPush"].(bool)
		if !req.internal && (aa || ap) {
			seatGuard(meta, "web")
		}
		if v, _ := b["autoAllow"].(bool); v && !modeOk(allowMode(b["allowAll"] == true)) {
			refuse(403, FEATURE_OFF)
		}
		if len(hooksOf("session.settings.before")) > 0 {
			asked := orderedObj{}
			for _, k := range []string{"autoAllow", "allowAll", "autoPush", "resting", "favorite", "title"} {
				if v, ok := b[k]; ok {
					asked = append(asked, kv{k, v})
				}
			}
			if p := sessBefore("session.settings", meta, kv{"changed", asked}); p != nil {
				if _, has := b["title"]; has {
					b["title"] = patched(p, "title", strField(b, "title"))
				}
			}
		}
		if v, ok := b["autoPush"].(bool); ok {
			meta.set("autoPush", v)
			toHost(meta.host(), M{"t": "set", "sid": meta.id(), "autoPush": v})
		}
		if v, ok := b["autoAllow"].(bool); ok {
			// allowAll (REQ-F-796) rides on autoAllow: on only with it, and an autoAllow that does not say is the safe one.
			all := v && b["allowAll"] == true
			for _, s := range append([]*Sess{meta}, delegatesOf(meta)...) {
				s.set("autoAllow", v)
				s.set("allowAll", all)
				toHost(s.host(), M{"t": "set", "sid": s.id(), "autoAllow": v, "allowAll": all})
				if s != meta {
					touch(s)
				}
			}
		}
		if v, ok := b["resting"].(bool); ok {
			meta.set("resting", v)
		}
		if v, ok := b["favorite"].(bool); ok {
			if v {
				meta.set("favorite", true)
			} else {
				meta.del("favorite")
			}
		}
		if list, ok := b["todoHidden"].([]any); ok {
			seen := map[string]bool{}
			keys := []any{}
			for _, k := range list {
				s, ok := k.(string)
				if !ok || jsTrim(s) == "" {
					continue
				}
				t := jsSliceTo(jsTrim(s), TODO_KEY_MAX)
				if !seen[t] {
					seen[t] = true
					keys = append(keys, t)
				}
			}
			if len(keys) > TODO_HIDDEN_MAX {
				keys = keys[len(keys)-TODO_HIDDEN_MAX:]
			}
			if len(keys) > 0 {
				meta.set("todoHidden", keys)
			} else {
				meta.del("todoHidden")
			}
		}
		if s, ok := b["title"].(string); ok {
			meta.set("title", jsSliceTo(jsTrim(s), 80))
			meta.set("manualTitle", jsTrim(s) != "")
		}
		touch(meta)
		changed := orderedObj{}
		for _, k := range []string{"autoAllow", "allowAll", "autoPush", "resting", "favorite", "title"} {
			if v, ok := b[k]; ok {
				changed = append(changed, kv{k, v})
			}
		}
		sessAfter("session.settings", meta, kv{"changed", changed})
	case "close":
		if truthy(meta.get("moving")) {
			refuse(409, "세션을 옮기는 중입니다")
		}
		sessBefore("session.close", meta, kv{"kind", "end"})
		if truthy(meta.get("closed")) {
			return false // closed while the hook answered
		}
		closeSession(meta, "")
	default:
		refuse(404, "없는 동작입니다")
	}
	return false
}

// numOrNaN0 is Number(x) || 0.
func numOrNaN0(x any) float64 {
	f := jsNumber(x)
	if math.IsNaN(f) {
		return 0
	}
	return f
}

func sendOp(req *Req, uid string, meta *Sess, b M) {
	text := ""
	if truthy(b["text"]) {
		text = jsString(b["text"])
	}
	pics := asArr(b["images"])
	if len(pics) > 8 {
		refuse(400, "이미지는 한 번에 8장까지 보낼 수 있어요")
	}
	type file struct {
		typ, data string
		name      any
		id        any
	}
	files := []*file{}
	total := 0
	for _, x := range pics {
		d := ""
		if v := mget(x, "data"); v != nil {
			d = jsString(v)
		}
		m := reportDataRe.FindStringSubmatch(d)
		if m == nil {
			refuse(400, "지원하지 않는 그림 형식이에요")
		}
		var name any
		if s, ok := mget(x, "name").(string); ok {
			name = s
		}
		files = append(files, &file{typ: m[1], data: m[2], name: name})
		total += len(m[2])
	}
	if total > 3_145_728 {
		refuse(413, "이 메시지에 담기에는 그림이 너무 커요")
	}
	vids := asArr(b["videos"])
	if len(vids) > 3 {
		refuse(400, "영상은 한 번에 3개까지 보낼 수 있어요")
	}
	videos := []M{}
	for _, v := range vids {
		id := ""
		if x := mget(v, "id"); x != nil {
			id = jsString(x)
		}
		up := uploadOf(uid, id)
		if up == nil {
			refuse(400, "올린 영상을 찾지 못했어요. 다시 골라 주세요")
		}
		videos = append(videos, up)
	}
	if jsTrim(text) == "" && len(files) == 0 && len(videos) == 0 {
		refuse(400, "보낼 내용이 없어요")
	}
	if p := sessBefore("message.send", meta, kv{"text", text}, kv{"images", len(files)}, kv{"videos", len(videos)}); p != nil {
		text = patched(p, "text", text)
		if jsTrim(text) == "" && len(files) == 0 && len(videos) == 0 {
			refuse(400, "보낼 내용이 없어요")
		}
	}
	st := meta.state()
	if to, ok := st["handedOffTo"].(string); ok && to != "" {
		if s, has := sessions.Get(to); has && !truthy(s.get("closed")) && !slashColonRe.MatchString(jsTrim(text)) {
			refuse(409, "🧵 이 세션은 더 가벼운 새 세션으로 넘겨졌어요. 거기서 이어가세요.")
		}
	}
	if !truthy(st["alive"]) {
		if truthy(meta.get("closed")) || truthy(meta.get("moving")) || !online(meta.host()) {
			if truthy(meta.get("closed")) {
				refuse(409, "이미 끝난 세션이에요")
			}
			refuse(409, "세션이 멈춰 있습니다. 다시 연 뒤 보내 주세요")
		}
		logEvents(meta, []any{M{"k": "line", "text": "🔄 끊긴 세션을 대화 그대로 이어서 다시 엽니다."}})
		meta.set("bg", []any{})
		moveSession(meta, meta.host(), nil, nil)
	}
	hostID := liveHost(meta)
	if numOr0(meta.state()["size"]) >= 100*1024*1024 && !strings.HasPrefix(jsTrim(text), "/") {
		refuse(409, "🚫 대화 기록이 100MB 를 넘어 입력을 막았어요. 세션 메뉴의 대화 기록 정리(압축한 뒤)나 가벼운 복제를 쓰거나, 터미널에서 직접 입력하세요.")
	}
	meta.set("resting", false)
	for _, f := range files {
		f.id = imageRef(uid, f.typ, f.data, f.name)
	}
	id := uuidv4()
	parts := []string{}
	if t := jsTrim(text); t != "" {
		parts = append(parts, t)
	}
	for _, v := range videos {
		parts = append(parts, "🎬 "+jsStringU(v["name"]))
	}
	via := "web"
	if b["via"] == "slack" {
		via = "slack"
	} else if (b["via"] == "delegate" || b["via"] == "delegated") && req.internal {
		via = b["via"].(string)
	}
	imgs := []any{}
	for _, f := range files {
		if truthy(f.id) {
			imgs = append(imgs, f.id)
		}
	}
	// A question or plan card answered in words (REQ-F-817 decision.answered via message).
	if c, ok := meta.get("card").(M); ok && (c["kind"] == "question" || c["kind"] == "plan") && safeId(c["id"]) {
		noteAnswer(c["id"].(string), M{"n": nil, "via": "message", "by": curBy()})
	}
	logSaid(meta, id, strings.Join(parts, "\n"), via, imgs)
	if len(videos) > 0 {
		list := [][2]string{}
		for _, v := range videos {
			list = append(list, [2]string{uid, mstr(v, "id")})
		}
		sentUploads[id] = list
	}
	cmd := M{"t": "send", "sid": meta.id(), "id": id, "text": jsSliceTo(text, 100_000)}
	if len(files) > 0 {
		fl := []any{}
		for _, f := range files {
			fl = append(fl, orderedObj{{"id", f.id}, {"data", f.data}}.dropNil())
		}
		cmd["files"] = fl
	}
	if len(videos) > 0 {
		vl := []any{}
		for _, v := range videos {
			vl = append(vl, orderedObj{{"id", v["id"]}, {"name", v["name"]}, {"type", v["type"]}, {"size", v["size"]}})
		}
		cmd["videos"] = vl
	}
	toHost(hostID, cmd)
	sessAfter("message.send", meta, kv{"text", text}, kv{"images", len(files)}, kv{"videos", len(videos)})
}

func forkOp(res *Res, uid string, meta *Sess) {
	hostID := liveHost(meta)
	title := meta.str("title")
	if title == "" {
		title = "세션"
	}
	title = patched(forkBefore(meta, "fork", title+"의 사본"), "title", title+"의 사본")
	hostID = liveHost(meta)
	sid := uuidv4()
	over := launchOver(uid)
	lm := over["model"]
	if !truthy(lm) {
		lm = meta.get("launchModel")
		if !truthy(lm) {
			lm = ""
		}
	}
	acc := meta.get("account")
	if acc == nil {
		acc = ""
	}
	cp := newMeta(uid, sid, hostID, M{"cwd": meta.get("cwd"), "title": jsSliceTo(title, 80), "manualTitle": true, "launchModel": lm, "autoPush": meta.get("autoPush"), "account": acc})
	st := noState()
	st["alive"] = true
	st["phase"] = "starting"
	cp.set("state", st)
	mkdirAll(sessionDir(cp), 0o777)
	legacy := !truthy(meta.get("agentLog")) && exists(eventsFile(meta))
	seq := meta.get("seq")
	if seq == nil {
		seq = 0.0
	}
	cp.set("forked", meta.id())
	cp.set("seq", seq)
	cp.set("last", meta.get("last"))
	cp.set("preview", meta.get("preview"))
	cp.set("lastAt", float64(nowMs()))
	cp.set("model", meta.get("model"))
	cp.set("agentLog", true)
	besideInGroup(uid, meta.id(), sid)
	savePrefs(uid)
	cmd := M{"t": "fork", "sid": meta.id(), "newSid": sid, "sysPrompt": sysPromptOf(uid), "launch": over}
	if !legacy {
		cmd["copyLog"] = seq
	}
	r := ask(hostID, cmd, 60_000)
	if truthy(r["ok"]) {
		uuids := []string{}
		set := map[string]bool{}
		for _, x := range asArr(r["uuids"]) {
			if s, ok := x.(string); ok && uuid36Re.MatchString(s) {
				uuids = append(uuids, s)
				set[s] = true
			}
		}
		_ = os.WriteFile(forkSkipFile(cp), []byte(strings.Join(uuids, "\n")), 0o666)
		forkSkip[sid] = set
		if legacy {
			keep := []any{}
			for _, e := range readLegacyEvents(meta, false) {
				if !containsAny([]any{"card", "card_end", "react", "status", "held"}, mget(e, "k")) {
					keep = append(keep, e)
				}
			}
			for i := 0; i < len(keep); i += 500 {
				end := i + 500
				if end > len(keep) {
					end = len(keep)
				}
				handDown(hostID, M{"t": "log", "sid": sid, "events": keep[i:end]})
			}
		}
		logEvents(cp, []any{M{"k": "notice", "icon": "undo", "text": "여기까지 복제한 대화예요 (" + jsSliceTo(meta.id(), 8) + " 에서). 이 아래부터 새 세션이에요"}})
	}
	if !truthy(r["ok"]) {
		sessions.Delete(sid)
		dirty.Delete(sid)
		_ = os.RemoveAll(sessionDir(cp))
		broadcastState(uid)
		refuse(502, orStr(r["error"], "세션을 복제하지 못했습니다"))
	}
	inheritAllow(cp, meta, uid)
	touch(cp)
	toHost(hostID, M{"t": "report", "sid": sid})
	createdAfter(cp, "fork", "")
	jsonRes(res, 200, M{"ok": true, "id": sid})
}

func apiEnd(req *Req, res *Res, u *url.URL, uid string) {
	refuse(404, "없는 경로입니다")
}
