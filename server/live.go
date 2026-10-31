package main

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- per-host live status ----------

var liveStatus = map[string]M{}

func live(hostID string) M {
	if st, ok := liveStatus[hostID]; ok {
		return st
	}
	st := M{"connectedAt": nil, "disconnectedAt": nil, "connects": 0.0, "health": nil, "healthAt": nil, "page": nil, "pageAt": nil, "rtt": nil, "rttAt": nil, "stale": false, "errors": 0.0, "lastError": nil}
	liveStatus[hostID] = st
	return st
}

// ---------- per-host log ----------

func hostLogFile(uid, hostID string) string {
	return filepath.Join(userDir(uid), "hosts", hostID+".log")
}

// record: one line in a host's log. Printed to stdout too, with the user and host named but not what it says (REQ-S-074).
func record(uid, hostID string, entry M) {
	ts := jsNumber(entry["ts"])
	if !(ts != 0 && ts == ts) {
		ts = float64(nowMs())
	}
	src := "server"
	if truthy(entry["src"]) {
		src = jsString(entry["src"])
	}
	level := "info"
	if l, ok := entry["level"].(string); ok && contains([]string{"info", "warn", "error"}, l) {
		level = l
	}
	area := ""
	if truthy(entry["area"]) {
		area = jsString(entry["area"])
	}
	e := M{"ts": ts, "src": src, "level": level, "area": jsSliceTo(area, 40), "text": jsSliceTo(hideRemotes(entry["text"]), 2000)}
	if safeId(entry["sid"]) {
		e["sid"] = entry["sid"]
	}
	file := hostLogFile(uid, hostID)
	func() {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			logLine("log write failed", err.Error())
			return
		}
		if st, err := os.Stat(file); err == nil && st.Size() > LOG_ROTATE {
			_ = os.Rename(file, file+".1")
		}
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			logLine("log write failed", err.Error())
			return
		}
		_, _ = f.WriteString(jsonStr(orderedObj{{"ts", e["ts"]}, {"src", e["src"]}, {"level", e["level"]}, {"area", e["area"]}, {"sid", e["sid"]}, {"text", e["text"]}}.dropNil()) + "\n")
		f.Close()
	}()
	if level == "error" {
		st := live(hostID)
		st["errors"] = numOr0(st["errors"]) + 1
		le := M{"ts": ts, "src": src, "area": e["area"], "text": jsSliceTo(mstr(e, "text"), 300)}
		if e["sid"] != nil {
			le["sid"] = e["sid"]
		}
		st["lastError"] = le
	}
	who := uid
	if u, ok := users.Get(uid); ok && u["login"] != nil {
		who = jsString(u["login"])
	}
	hn := jsSliceTo(hostID, 8)
	if h, ok := hosts.Get(hostID); ok && h["name"] != nil {
		hn = jsString(h["name"])
	}
	sidPart := ""
	if s, ok := e["sid"].(string); ok {
		sidPart = " sid=" + jsSliceTo(s, 8)
	}
	lv := strings.ToUpper(level)
	for len(lv) < 5 {
		lv += " "
	}
	os.Stdout.WriteString(isoTime(int64(ts)) + " " + lv + " user=" + who + " host=" + hn + " src=" + src + " [" + mstr(e, "area") + "]" + sidPart + "\n")
}

// dropNil leaves out keys whose value is nil (JSON.stringify drops undefined).
func (o orderedObj) dropNil() orderedObj {
	out := orderedObj{}
	for _, e := range o {
		if e.V != nil {
			out = append(out, e)
		}
	}
	return out
}

func readHostLog(uid, hostID string, sid, level string) []any {
	file := hostLogFile(uid, hostID)
	var lines []string
	for _, f := range []string{file + ".1", file} {
		if b, err := os.ReadFile(f); err == nil {
			lines = append(lines, strings.Split(string(b), "\n")...)
		}
	}
	out := []any{}
	for i := len(lines) - 1; i >= 0 && len(out) < LOG_VIEW; i-- {
		if lines[i] == "" {
			continue
		}
		v, err := parseJSON([]byte(lines[i]))
		if err != nil {
			continue
		}
		e := asM(v)
		if (sid == "" || e["sid"] == sid) && (level == "" || e["level"] == level || (level == "warn" && e["level"] == "error")) {
			out = append(out, v)
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// ---------- live connections ----------

// bridges: hostId -> the event stream of that host's bridge page (or the demo Mac).
var bridges = newOMap[Sink]()

// controls: uid -> the event streams of control pages, in the order they opened.
var controls = map[string]*OMap[*Stream]{}

type pendingEntry struct {
	resolve  func(M)
	got      bool
	hostID   string
	timer    *Timer
	gotTimer *Timer
}

var pending = map[string]*pendingEntry{}

func online(hostID string) bool { return bridges.Has(hostID) }

// LINK_GRACE: a bridge stream that drops and is back within this long is not shown or logged as a disconnect
// (REQ-F-831). A Mac that runs this server's own Docker reaches it through the router's hairpin, and every container
// that starts or stops there cuts that connection for a moment; the page is back in a second, and the host flapped.
var LINK_GRACE = func() time.Duration {
	if n, err := strconv.Atoi(env("BRIDGE_LINK_GRACE_MS")); err == nil && n > 0 {
		return time.Duration(n) * time.Millisecond
	}
	return 10 * time.Second
}()

// linkGone: hostId -> the timer that says its bridge is gone if it is not back within LINK_GRACE.
var linkGone = map[string]*Timer{}

// shownOnline: what screens show. A host whose stream dropped a moment ago and is reconnecting still counts.
func shownOnline(hostID string) bool {
	_, waiting := linkGone[hostID]
	return online(hostID) || waiting
}

// stopLinkGone: forget a host's grace timer; true when there was one (its stream had dropped and not yet come back).
func stopLinkGone(hostID string) bool {
	t, ok := linkGone[hostID]
	if ok {
		clearTimeout(t)
		delete(linkGone, hostID)
	}
	return ok
}

// realBridges: the connected Macs that are real: the demo Mac (REQ-F-766) is never asked anything.
func realBridges() []string {
	out := []string{}
	for _, h := range bridges.Keys() {
		if !isDemoHost(h) {
			out = append(out, h)
		}
	}
	return out
}

func sse(res Sink, obj any) bool { return res.Write("data: " + jsonStr(obj) + "\n\n") }

func controlsOf(uid string) []*Stream {
	if c := controls[uid]; c != nil {
		return c.Values()
	}
	return nil
}

func toHost(hostID string, cmd M) bool {
	res, ok := bridges.Get(hostID)
	if !ok {
		return false
	}
	flushed := sse(res, cmd)
	if TRACE {
		req := ""
		if r, ok := cmd["reqId"].(string); ok && r != "" {
			req = " req=" + jsSliceTo(r, 8)
		}
		trace(hostID, "down "+jsString(cmd["t"])+req+" buffered="+boolStr(!flushed)+" writable=true pendingBytes="+itoa(res.Pending()))
	}
	return true
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// HOST_BACK_MS: a command waits for a host's link to come back instead of failing at once.
const HOST_BACK_MS = 20_000

func hostBack(hostID string) bool {
	until := nowMs() + HOST_BACK_MS
	for !bridges.Has(hostID) && nowMs() < until {
		sleep(250 * time.Millisecond)
	}
	return bridges.Has(hostID)
}

// ask: send a command to a host and wait for the reply that carries the same reqId.
func ask(hostID string, cmd M, timeoutMs int64) M {
	if !bridges.Has(hostID) && hosts.Has(hostID) {
		hostBack(hostID)
	}
	ch := make(chan M, 1)
	reqID := uuidv4()
	// The host asked: an answer is taken only from it (R1-I4).
	entry := &pendingEntry{hostID: hostID, resolve: func(v M) {
		select {
		case ch <- v:
		default:
		}
	}}
	give := func(e string) {
		clearTimeout(entry.timer)
		clearTimeout(entry.gotTimer)
		delete(pending, reqID)
		record(mstr(hosts.Val(hostID), "uid"), hostID, M{"level": "error", "area": cmd["t"], "sid": cmd["sid"], "text": e})
		entry.resolve(M{"ok": false, "error": e})
	}
	// The bridge tab acknowledges a command as soon as it has it.
	entry.gotTimer = setTimeout(GOT_MS*time.Millisecond, func() {
		give("그 맥의 연동 탭이 명령을 받지 못했습니다. 탭이 멈췄거나 가려져 있을 수 있습니다 — 그 맥에서 연동 탭을 앞으로 가져오거나 새로고침해 주세요")
	})
	entry.timer = setTimeout(msDur(timeoutMs), func() { give("에이전트가 명령을 받았지만 제때 답하지 않았습니다") })
	pending[reqID] = entry
	c := shallow(cmd)
	c["reqId"] = reqID
	if !toHost(hostID, c) {
		clearTimeout(entry.gotTimer)
		clearTimeout(entry.timer)
		delete(pending, reqID)
		return M{"ok": false, "error": "호스트가 연결돼 있지 않습니다"}
	}
	var out M
	await(func() { out = <-ch })
	return out
}

func toControls(uid string, obj M) {
	sid, _ := obj["sid"].(string)
	var meta *Sess
	if sid != "" {
		meta, _ = sessions.Get(sid)
	}
	t := mstr(obj, "t")
	if meta != nil && truthy(meta.get("lock")) && (t == "ev" || t == "preview" || t == "screen") {
		if t == "ev" {
			for _, res := range controlsOf(uid) {
				sse(res, M{"t": "ev", "sid": sid, "locked": true, "last": numOr0(meta.get("seq"))})
			}
		}
		return
	}
	for _, res := range controlsOf(uid) {
		if t == "state" {
			sendState(res, obj)
		} else {
			sse(res, obj)
		}
	}
	if t == "ev" && meta != nil {
		for _, e := range asArr(obj["events"]) {
			plug.event(uid, csIds(meta).str("thread"), csEvent(meta, asM(e)))
		}
	}
}

// ---------- Slack-shaped sessions ----------

var pidSeq float64

func loadPidSeq() {
	pidSeq = numOr0(mget(readJSON(filepath.Join(DATA, "pid.json"), M{"n": 1000.0}), "n"))
}

// csIds: the Slack plugin addresses a session by a thread key and a pid, made once and kept with the session.
func csIds(meta *Sess) *Sess {
	if !truthy(meta.get("thread")) {
		meta.set("thread", threadOf(meta.m))
		dirty.Set(meta.id(), true)
	}
	if !truthy(meta.get("pid")) {
		pidSeq++
		meta.set("pid", pidSeq)
		writeJson(filepath.Join(DATA, "pid.json"), M{"n": pidSeq})
		dirty.Set(meta.id(), true)
	}
	return meta
}

func byThread(uid string, thread any) *Sess {
	for _, m := range sessions.Values() {
		if m.uid() == uid && csIds(m).get("thread") == thread {
			return m
		}
	}
	return nil
}

func byPid(uid string, pid any) *Sess {
	n := jsNumber(pid)
	for _, m := range sessions.Values() {
		if m.uid() == uid && numOr0(csIds(m).get("pid")) == n {
			return m
		}
	}
	return nil
}

func csRow(meta *Sess) M {
	csIds(meta)
	return toCsSession(shielded(meta), M{"thread": meta.get("thread"), "pid": meta.get("pid"), "host": hostOrNil(meta.host()), "online": shownOnline(meta.host())})
}

func hostOrNil(id string) any {
	if h, ok := hosts.Get(id); ok {
		return h
	}
	return nil
}

func csRows(uid string) []any {
	list := []*Sess{}
	for _, m := range sessions.Values() {
		if m.uid() == uid && !truthy(m.get("closed")) {
			list = append(list, m)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return jsNumber(list[i].get("createdAt")) < jsNumber(list[j].get("createdAt")) })
	out := make([]any, len(list))
	for i, m := range list {
		out[i] = csRow(m)
	}
	return out
}

// cardsOf: the cards of a session by id: built from the log once, then kept up.
func cardsOf(meta *Sess) *OMap[any] {
	if meta.cardIndex == nil || !meta.cardBuilt {
		meta.cardIndex = newOMap[any]()
		for _, e := range readEvents(meta, true) {
			if mstr(e, "k") == "card" {
				meta.cardIndex.Set(jsString(mget(mget(e, "card"), "id")), mget(e, "card"))
			}
		}
		meta.cardBuilt = true
	}
	return meta.cardIndex
}

func csEvent(meta *Sess, e M) any {
	return toCsEvent(e, csOpts{pid: csIds(meta).get("pid"), cards: cardsOf(meta), image: func(id string) any { return imgInfoOf(meta.uid())[id] }})
}

// csGroups: groups hold session ids here; GET /api/groups gives them as thread keys.
func csGroups(uid string) M {
	pf := prefsOf(uid)
	key := func(sid any) any {
		s, _ := sid.(string)
		m, ok := sessions.Get(s)
		if ok && m.uid() == uid {
			return csIds(m).get("thread")
		}
		return nil
	}
	mapKeys := func(items []any) []any {
		out := []any{}
		for _, i := range items {
			if k := key(i); truthy(k) {
				out = append(out, k)
			}
		}
		return out
	}
	groups := []any{}
	for _, g := range groupsList(pf) {
		groups = append(groups, M{"id": g["id"], "name": g["name"], "items": mapKeys(asArr(g["items"]))})
	}
	col := pf["collapsed"]
	if col == nil {
		col = []any{}
	}
	return M{"groups": groups, "loose": mapKeys(asArr(pf["loose"])), "collapsed": col}
}

// sessionOp: run one of the session routes for a caller that is not that HTTP request: a plugin, another route.
func sessionOp(uid string, meta *Sess, op string, data any, method string, query string) M {
	if method == "" {
		method = "POST"
	}
	if data == nil {
		data = M{}
	}
	req := internalReq(method, data)
	res := newRes(req)
	p := "/api/sessions/" + meta.id()
	if op != "" {
		p += "/" + op
	}
	u, _ := url.Parse("http://x" + p + query)
	req.URL = u
	api(req, res, u, uid)
	if len(res.body) == 0 {
		return M{}
	}
	v, err := parseJSON(res.body)
	if err != nil {
		panic(err)
	}
	return asM(v)
}

func labeled(pairs [][2]string) []any {
	out := []any{}
	for _, p := range pairs {
		out = append(out, M{"label": p[0], "value": p[1]})
	}
	return out
}

var CS_OPTIONS = M{
	"models":  labeled([][2]string{{"Fable 5.1 (1M)", "claude-fable-5-1[1m]"}, {"Fable 5.1", "claude-fable-5-1"}, {"Opus 5.5 (1M)", "claude-opus-5-5[1m]"}, {"Opus 5.5", "claude-opus-5-5"}, {"Sonnet 5.5", "claude-sonnet-5-5"}, {"Haiku 5.5", "claude-haiku-5-5"}, {"Opus 5", "claude-opus-5"}, {"Sonnet 5", "claude-sonnet-5"}, {"Haiku 4.5", "claude-haiku-4-5-20251001"}, {"Opus plan / Sonnet work", "opusplan"}, {"Default", "default"}}),
	"efforts": []any{"low", "medium", "high", "xhigh", "max"},
	"modes":   labeled([][2]string{{"manual · 편집·명령마다 물어봄", "default"}, {"acceptEdits · 파일 편집은 자동 승인", "acceptEdits"}, {"plan · 계획만 세우고 실행 안 함", "plan"}, {"auto · 거의 모두 자동 승인", "auto"}, {"안전한 전부 허용 · 위험한 호출만 물어봄", "autoAllow"}, {"전부 허용 · 하나도 묻지 않음", "allowAll"}}),
}

// The model list the new-session page offers: CS_OPTIONS.models, then Claude Code's own catalog while `auto` is on.
var MODELS_FILE string

const MODELS_EVERY_MS = 6 * 3_600_000

var models M

func loadModels() {
	MODELS_FILE = filepath.Join(DATA, "models.json")
	models = M{"auto": true, "list": nil, "checkedAt": nil, "changedAt": nil, "source": nil, "error": nil, "added": []any{}, "removed": []any{}}
	if saved, ok := readJSON(MODELS_FILE, M{}).(M); ok {
		for k, v := range saved {
			models[k] = v
		}
	}
}

func modelList() []any {
	if l, ok := models["list"].([]any); ok && len(l) > 0 {
		return l
	}
	return asArr(CS_OPTIONS["models"])
}

var modelsRun chan struct{}
var answerSlowRe = regexp.MustCompile(`답하지|응답`)

// refreshModels: ask one Mac (the operators' first, else any connected one) for the catalog; waits for it.
func refreshModels(why string) {
	if modelsRun == nil {
		done := make(chan struct{})
		modelsRun = done
		goLocked("models", func() {
			defer func() {
				modelsRun = nil
				close(done)
			}()
			refreshModelsRun(why)
		})
	}
	ch := modelsRun
	await(func() { <-ch })
}

func refreshModelsRun(why string) {
	on := []string{}
	for _, h := range realBridges() {
		if hosts.Has(h) {
			on = append(on, h)
		}
	}
	hostID := ""
	for _, h := range on {
		if isAdmin(mstr(hosts.Val(h), "uid")) {
			hostID = h
			break
		}
	}
	if hostID == "" && len(on) > 0 {
		hostID = on[0]
	}
	models["checkedAt"] = float64(nowMs())
	if hostID == "" {
		models["error"] = "연결된 맥이 없어 확인하지 못했어요"
		writeJson(MODELS_FILE, models)
		return
	}
	r := ask(hostID, M{"t": "models"}, 45_000)
	list, isList := r["models"].([]any)
	if !truthy(r["ok"]) || !isList || len(list) == 0 {
		e := "모델 목록을 받지 못했어요"
		if truthy(r["error"]) {
			e = jsString(r["error"])
		}
		hint := ""
		if answerSlowRe.MatchString(strOr(r["error"], "")) {
			hint = " (에이전트가 예전 버전이면 새 버전으로 바뀐 뒤 돼요)"
		}
		models["error"] = jsString(mget(hosts.Val(hostID), "name")) + ": " + e + hint
		writeJson(MODELS_FILE, models)
		return
	}
	before := modelList()
	next := modelsFromCatalog(list, before)
	models["error"] = nil
	ver := ""
	if r["version"] != nil {
		ver = jsString(r["version"])
	}
	models["source"] = M{"hostId": hostID, "name": mget(hosts.Val(hostID), "name"), "version": ver}
	if jsonStr(next) != jsonStr(before) {
		added, removed := []any{}, []any{}
		has := func(list []any, v any) bool {
			for _, x := range list {
				if mget(x, "value") == v {
					return true
				}
			}
			return false
		}
		for _, m := range next {
			if !has(before, mget(m, "value")) {
				added = append(added, mget(m, "label"))
			}
		}
		for _, b := range before {
			if !has(next, mget(b, "value")) {
				removed = append(removed, mget(b, "label"))
			}
		}
		models["added"], models["removed"], models["list"] = added, removed, next
		models["changedAt"] = float64(nowMs())
		join := func(l []any) string {
			if len(l) == 0 {
				return "없음"
			}
			return strings.Join(strList(l), ", ")
		}
		logLine("models (" + why + "): " + itoa(len(next)) + "개로 바꿈 · 더함 " + join(added) + " · 뺌 " + join(removed))
	}
	writeJson(MODELS_FILE, models)
}

func startModelsCheck() {
	setInterval(600_000*time.Millisecond, func() {
		if truthy(models["auto"]) && float64(nowMs())-numOr0(models["checkedAt"]) >= MODELS_EVERY_MS && len(realBridges()) > 0 {
			if err := try(func() { refreshModels("auto") }); err != nil {
				logLine("models", err)
			}
		}
	})
}

func modelsView() M {
	return M{"auto": models["auto"], "list": modelList(), "checkedAt": models["checkedAt"], "changedAt": models["changedAt"], "source": models["source"], "error": models["error"], "added": models["added"], "removed": models["removed"], "everyMs": float64(MODELS_EVERY_MS)}
}

// ---------- where a session is driven from ----------

func seatOf(meta *Sess) string {
	if mget(meta.get("seat"), "where") == "slack" {
		return "slack"
	}
	return "web"
}

var SEAT_AWAY = map[string]string{
	"slack": "이 세션은 Slack 에서 작업 중이에요. 웹에서는 읽기만 할 수 있어요. 브릿지로 가져온 뒤 보내 주세요.",
	"web":   "이 세션은 브릿지에서 작업 중이에요. Slack 으로 가져온 뒤 보내 주세요.",
}

// seatGuard refuses what comes from the place the session is not in.
func seatGuard(meta *Sess, via any) {
	where := seatOf(meta)
	v := "web"
	if via == "slack" {
		v = "slack"
	}
	if v != where {
		refuseX(409, SEAT_AWAY[where], M{"seat": where})
	}
}

var SEAT_DRIVES = map[string]bool{"say": true, "do": true, "send": true, "retract": true, "sendnow": true, "esc": true, "dropheld": true, "answer": true, "setting": true, "refresh": true, "report": true, "btw": true, "trash": true, "resume": true, "lightfork": true, "trimlog": true, "fork": true, "key": true, "move": true, "cwd": true}

func sessionLink(meta *Sess) string {
	o := ORIGIN
	if o == "" {
		o = "http://localhost:" + itoa(PORT)
	}
	return o + "/s/" + meta.id()
}

// moveSeat moves a session to the bridge or to Slack.
func moveSeat(uid string, meta *Sess, to any) M {
	if to != "web" && to != "slack" {
		refuse(400, "옮길 곳이 올바르지 않아요")
	}
	if to == "slack" {
		needFeature("slack") // bringing a session back to the bridge stays open
	}
	from := seatOf(meta)
	seatURL := func() any {
		if u := mget(meta.get("seat"), "url"); u != nil {
			return u
		}
		return nil
	}
	if from == to {
		note := "이미 브릿지에서 작업 중이에요"
		if to == "slack" {
			note = "이미 Slack 에서 작업 중이에요"
		}
		return M{"ok": true, "note": note, "url": seatURL()}
	}
	thread := csIds(meta).str("thread")
	if to == "slack" {
		if truthy(meta.get("lock")) {
			refuse(409, "잠긴 세션은 Slack 으로 옮길 수 없어요. 잠금을 없앤 뒤 옮겨 주세요")
		}
		place := plug.instance(uid, "slack")
		mover, ok := place.(seatMover)
		if place == nil || !ok || mget(place.status(), "state") != "on" {
			refuse(409, "Slack 플러그인이 켜져 있지 않아요. 설정 → 플러그인에서 켜 주세요")
		}
		var u any
		if err := try(func() { u = mget(mover.moveIn(thread), "url") }); err != nil {
			refuse(502, "Slack 으로 옮기지 못했어요: "+err.Error())
		}
		link := ""
		if truthy(u) {
			link = " [Slack 스레드 열기](" + jsString(u) + ")"
		}
		// Said while the seat is still here, so the plugin does not post it into the thread it just set up.
		logEvents(meta, []any{M{"k": "notice", "icon": "move", "text": "Slack 으로 옮겼어요. 이제 Slack 스레드에서 이어서 작업해요. 여기서는 읽기만 할 수 있어요." + link}})
		meta.set("seat", M{"where": "slack", "at": float64(nowMs()), "url": u})
	} else {
		u := seatURL()
		meta.set("seat", M{"where": "web", "at": float64(nowMs()), "url": u})
		link := ""
		if truthy(u) {
			link = " [Slack 스레드 열기](" + jsString(u) + ")"
		}
		logEvents(meta, []any{M{"k": "notice", "icon": "move", "text": "브릿지로 옮겼어요. Slack 에서 나눈 대화도 이 화면에 그대로 있어요." + link}})
		if mover, ok := plug.instance(uid, "slack").(seatMover); ok {
			mover.moveOut(thread)
		}
	}
	touch(meta)
	broadcastState(uid)
	note := "브릿지로 옮겼어요"
	if to == "slack" {
		note = "Slack 으로 옮겼어요"
	}
	return M{"ok": true, "note": note, "url": seatURL()}
}

// COMPACT_TEXT: what 지금 압축 (REQ-F-776) types into the session.
const COMPACT_TEXT = "/compact 이어서 할 수 있게 지금까지의 결정과 이유, 관련 파일, 진행 상황, 다음에 할 일을 남겨 주세요"
