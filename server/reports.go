package main

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- 제보 ----------

var REPORTS string

const (
	REPORT_IMAGES = 8
	REPORT_VIDEOS = 3
	REPORT_LOG    = 40
	REPORT_GROUP  = "Bridge 제보 대응"
)

func reportFile(id string) string      { return filepath.Join(REPORTS, id+".json") }
func reportVideoFile(id string) string { return filepath.Join(REPORTS, "video", id) }

func reportImgId(s any) bool {
	str, ok := s.(string)
	return ok && imgFileRe.MatchString(str)
}

func reportImgFile(r M, id string) string {
	own := filepath.Join(REPORTS, "img", id)
	if exists(own) {
		return own
	}
	return filepath.Join(imgDir(mstr(r, "uid")), id)
}

func saveReportImage(mediaType any, b64 any) any {
	ext := IMG_TYPES[jsString(mediaType)]
	bytes := decodeB64(jsString(b64))
	if ext == "" || len(bytes) == 0 || len(bytes) > 12*1024*1024 {
		return nil
	}
	sum := sha1.Sum(bytes)
	id := hex.EncodeToString(sum[:]) + "." + ext
	_ = os.MkdirAll(filepath.Join(REPORTS, "img"), 0o700)
	if err := os.WriteFile(filepath.Join(REPORTS, "img", id), bytes, 0o600); err != nil {
		panic(err)
	}
	return id
}

// dropReport: the record goes, and its videos and its own pictures with it (a picture another report also has stays).
func dropReport(r M) {
	for _, v := range asArr(r["videos"]) {
		if uploadId(mget(v, "id")) {
			_ = os.Remove(reportVideoFile(mstr(v, "id")))
		}
	}
	_ = os.Remove(reportFile(mstr(r, "id")))
	others := map[string]bool{}
	for _, x := range readReports() {
		for _, id := range asArr(mget(x, "images")) {
			others[jsString(id)] = true
		}
	}
	for _, id := range asArr(r["images"]) {
		if reportImgId(id) && !others[id.(string)] {
			_ = os.Remove(filepath.Join(REPORTS, "img", id.(string)))
		}
	}
}

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// sendVideo: a video played in the page: Safari plays nothing that cannot be asked for in parts.
func sendVideo(req *Req, res *Res, file string, typ string) {
	st, err := os.Stat(file)
	if err != nil {
		refuse(404, "영상이 없습니다")
	}
	size := st.Size()
	head := M{"Content-Type": typ, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
	m := rangeRe.FindStringSubmatch(req.H("range"))
	if m != nil && (m[1] != "" || m[2] != "") {
		var start, end int64
		a, _ := strconv.ParseInt(m[1], 10, 64)
		b, _ := strconv.ParseInt(m[2], 10, 64)
		if m[1] != "" {
			start = a
		} else {
			start = size - b
			if start < 0 {
				start = 0
			}
		}
		end = size - 1
		if m[1] != "" && m[2] != "" && b < end {
			end = b
		}
		if start > end || start >= size {
			res.WriteHead(416, M{"Content-Range": "bytes */" + strconv.FormatInt(size, 10)}).End()
			return
		}
		h := shallow(head)
		h["Content-Range"] = "bytes " + strconv.FormatInt(start, 10) + "-" + strconv.FormatInt(end, 10) + "/" + strconv.FormatInt(size, 10)
		h["Content-Length"] = end - start + 1
		res.WriteHead(206, h)
		res.file = &fileSend{path: file, start: start, end: end, ranged: true}
		res.ended = true
		return
	}
	h := shallow(head)
	h["Content-Length"] = size
	res.WriteHead(200, h)
	res.file = &fileSend{path: file}
	res.ended = true
}

// reportDebug: what a report carries besides the words: the page's own account of itself, and the server's.
func reportDebug(uid string, b M) M {
	client := clipClient(b["client"])
	own := []string{}
	for _, id := range hosts.Keys() {
		if mstr(hosts.Val(id), "uid") == uid {
			own = append(own, id)
		}
	}
	var seen *Sess
	if safeId(b["sid"]) {
		if m, ok := sessions.Get(b["sid"].(string)); ok && m.uid() == uid {
			seen = m
		}
	}
	// Kept 90 days, past the account (REQ-S-072): no folder paths or remote addresses in it (REQ-S-074).
	logOf := func(hostID, sid string) []any {
		l := readHostLog(uid, hostID, sid, "")
		if len(l) > REPORT_LOG {
			l = l[len(l)-REPORT_LOG:]
		}
		out := []any{}
		for _, e := range l {
			x := shallow(asM(e))
			x["text"] = hidePaths(x["text"])
			out = append(out, x)
		}
		return out
	}
	hs := []any{}
	for _, id := range own {
		s := hostSummary(id, hosts.Val(id), true)
		delete(s, "sudo")
		n := 0
		for _, m := range sessions.Values() {
			if m.host() == id && !truthy(m.get("closed")) {
				n++
			}
		}
		s["sessions"] = float64(n)
		hs = append(hs, s)
	}
	var session any
	if seen != nil {
		st := seen.state()
		var hn any
		if h, ok := hosts.Get(seen.host()); ok && h["name"] != nil {
			hn = h["name"]
		}
		var tool any
		if t := mget(st["tool"], "name"); t != nil {
			tool = t
		}
		session = M{"id": seen.id(), "title": seen.get("title"), "cwd": hidePaths(seen.get("cwd")), "host": hn, "hostId": seen.host(), "closed": truthy(seen.get("closed")), "resting": truthy(seen.get("resting")), "state": M{"phase": st["phase"], "alive": truthy(st["alive"]), "tool": tool, "size": st["size"], "model": st["model"]}, "lastAt": seen.get("lastAt")}
	}
	logs := M{}
	if seen != nil {
		logs["session"] = logOf(seen.host(), seen.id())
	}
	for _, id := range own {
		h := hosts.Val(id)
		name := id
		if truthy(h["name"]) {
			name = jsString(h["name"])
		}
		l := []any{}
		for _, e := range logOf(id, "") {
			if lv := mget(e, "level"); lv == "error" || lv == "warn" {
				l = append(l, e)
			}
		}
		logs[name] = l
	}
	return M{
		"client":  client,
		"server":  M{"version": VERSION, "agentBuild": AGENT_BUILD, "page": PAGE_BUILD(), "at": float64(nowMs())},
		"hosts":   hs,
		"session": session,
		"logs":    logs,
	}
}

// namedGroup: the id of uid's group named so, made at the top when there is none; nil when it cannot be made.
func namedGroup(uid, name string) any {
	pf := prefsOf(uid)
	for _, x := range groupsList(pf) {
		if x["name"] == name && !truthy(x["parent"]) {
			return x["id"]
		}
	}
	for _, x := range groupsList(pf) {
		if x["name"] == name {
			return x["id"]
		}
	}
	var id any
	_ = try(func() { id = groupOp(uid, M{"op": "create", "name": name})["id"] })
	return id
}

func readReports() []M {
	out := []M{}
	names, err := os.ReadDir(REPORTS)
	if err != nil {
		return out
	}
	for _, f := range names {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		if r, ok := readJSON(filepath.Join(REPORTS, f.Name()), nil).(M); ok && r != nil {
			out = append(out, r)
		}
	}
	return out
}

func extOfID(id string) string {
	parts := strings.Split(id, ".")
	if len(parts) > 1 {
		return parts[1]
	}
	return ""
}

func typeOfExt(ext string) any {
	for _, t := range IMG_TYPE_ORDER {
		if IMG_TYPES[t] == ext {
			return t
		}
	}
	return nil
}

// fixReport starts a session on one of uid's connected Macs and sends it the report as its first message (R1-H1).
func fixReport(r M, uid string, want any, cwd any, auto bool, req *Req) string {
	mine := []string{}
	for _, h := range hosts.Keys() {
		if mstr(hosts.Val(h), "uid") == uid && online(h) {
			mine = append(mine, h)
		}
	}
	hostID := ""
	if s, ok := want.(string); ok && contains(mine, s) {
		hostID = s
	} else if len(mine) > 0 {
		hostID = mine[0]
	}
	if hostID == "" {
		refuse(409, "연결된 내 맥이 없어요. 맥을 연결한 뒤 다시 해 주세요")
	}
	group := namedGroup(uid, REPORT_GROUP)
	said1 := mstr(r, "text")
	if said1 == "" {
		if len(asArr(r["images"])) > 0 {
			said1 = "그림 제보"
		} else {
			said1 = "영상 제보"
		}
	}
	said1 = jsTrim(collapse(said1))
	trusted := mstr(r, "uid") == uid && isAdmin(uid)
	var mode any
	if !trusted {
		mode = "default"
	} else if auto {
		mode = "autoAllow"
	}
	c := "~"
	if truthy(cwd) {
		c = jsString(cwd)
	}
	title := "제보 고치기:" + jsSliceTo(said1, 60)
	if auto {
		title = jsSliceTo(said1, 80)
	}
	opts := M{"hostId": hostID, "cwd": jsSliceTo(c, 1000), "create": true, "title": title, "prompt": "", "group": group, "from": startFrom("report")}
	if mode != nil {
		opts["mode"] = mode
	}
	if req == nil {
		req = &Req{Header: map[string][]string{}}
	}
	sid := startSession(uid, opts, req)
	meta, _ := sessions.Get(sid)
	if auto {
		meta.set("reportAuto", r["id"])
		meta.set("manualTitle", true)
		touch(meta)
	}
	files := []any{}
	for _, idv := range asArr(r["images"]) {
		id := jsString(idv)
		file := reportImgFile(r, id)
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		data := base64.StdEncoding.EncodeToString(b)
		ref := imageRef(uid, typeOfExt(extOfID(id)), data, nil)
		if truthy(ref) {
			files = append(files, M{"id": ref, "data": data})
		}
	}
	videos := []any{}
	for _, v := range asArr(r["videos"]) {
		vid := mstr(v, "id")
		from := reportVideoFile(vid)
		if !uploadId(vid) || !exists(from) {
			continue
		}
		id := randHex(20) + "." + extOfID(vid)
		file := filepath.Join(uploadsDir(uid), id)
		_ = os.MkdirAll(uploadsDir(uid), 0o700)
		copyFile(from, file)
		writeJson(file+".json", M{"name": mget(v, "name"), "type": mget(v, "type"), "size": mget(v, "size"), "at": float64(nowMs())})
		videos = append(videos, M{"id": id, "name": mget(v, "name"), "type": mget(v, "type"), "size": mget(v, "size")})
	}
	said := uuidv4()
	text := fixPrompt(r, auto, trusted, REPORT_DONE)
	lines := []string{text}
	for _, v := range videos {
		lines = append(lines, "🎬 "+jsStringU(mget(v, "name")))
	}
	ids := []any{}
	for _, f := range files {
		ids = append(ids, mget(f, "id"))
	}
	logSaid(meta, said, strings.Join(lines, "\n"), "", ids)
	if len(videos) > 0 {
		list := [][2]string{}
		for _, v := range videos {
			list = append(list, [2]string{uid, mstr(v, "id")})
		}
		sentUploads[said] = list
	}
	cmd := M{"t": "send", "sid": sid, "id": said, "text": text}
	if len(files) > 0 {
		cmd["files"] = files
	}
	if len(videos) > 0 {
		cmd["videos"] = videos
	}
	toHost(hostID, cmd)
	if m, ok := sessions.Get(sid); ok {
		withBy("system", func() {
			sessAfter("message.send", m, kv{"text", text}, kv{"images", len(files)}, kv{"videos", len(videos)})
		})
	}
	r["status"] = "fixing"
	by := mget(users.Val(uid), "login")
	if by == nil {
		by = "?"
	}
	fix := M{"sid": sid, "at": float64(nowMs()), "by": by}
	if auto {
		fix["auto"] = true
	}
	r["fix"] = fix
	writeJson(reportFile(mstr(r, "id")), r)
	return sid
}

func copyFile(from, to string) {
	in, err := os.Open(from)
	if err != nil {
		panic(err)
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		panic(err)
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		panic(err)
	}
}

// 자동 대응 (REQ-F-738): an operator's switch.
var REPORT_AUTO_FILE string

const (
	REPORT_AUTO_TRIES    = 3
	REPORT_AUTO_RETRY_MS = 60_000
)

var reportAuto M

func loadReportAuto() {
	REPORTS = filepath.Join(DATA, "reports")
	REPORT_AUTO_FILE = filepath.Join(DATA, "report-auto.json")
	reportAuto = M{"on": false, "uid": nil, "by": nil, "since": nil, "cwd": "~/projects/claude-bridge", "hostId": nil}
	if saved, ok := readJSON(REPORT_AUTO_FILE, M{}).(M); ok {
		for k, v := range saved {
			reportAuto[k] = v
		}
	}
}

func reportAutoView() M {
	return M{"on": reportAuto["on"], "by": reportAuto["by"], "since": reportAuto["since"], "cwd": reportAuto["cwd"], "hostId": reportAuto["hostId"]}
}

var autoRunning = map[string]bool{}

func autoFix(r M) {
	id := mstr(r, "id")
	if !truthy(reportAuto["on"]) || !truthy(reportAuto["uid"]) || r["status"] != "new" || autoRunning[id] {
		return
	}
	autoRunning[id] = true
	defer delete(autoRunning, id)
	tries := numOr0(mget(r["auto"], "tries")) + 1
	r["auto"] = M{"tries": tries, "at": float64(nowMs()), "error": nil}
	err := try(func() {
		writeJson(reportFile(id), r)
		sid := fixReport(r, jsString(reportAuto["uid"]), reportAuto["hostId"], reportAuto["cwd"], true, nil)
		logLine("report " + id + ": 자동 대응 세션 " + sid)
	})
	if err != nil {
		a := asM(r["auto"])
		a["error"] = jsSliceTo(err.Error(), 300)
		writeJson(reportFile(id), r)
		logLine("report " + id + ": 자동 대응 실패 (" + numStr(tries) + "/" + itoa(REPORT_AUTO_TRIES) + ") " + jsString(a["error"]))
	}
}

var SERVER_AT int64

const REPORT_SWEEP_MS = 60_000

// sweepReports (REQ-F-740): a report whose fix session has been deployed and has ended leaves the list on its own.
func sweepReports() {
	for _, r := range readReports() {
		fix := asM(r["fix"])
		if r["status"] != "fixing" || !truthy(fix["sid"]) || !(truthy(reportAuto["on"]) || jsNumber(fix["at"]) < float64(SERVER_AT)) {
			continue
		}
		if meta, ok := sessions.Get(jsString(fix["sid"])); ok && !truthy(meta.get("closed")) {
			continue
		}
		dropReport(r)
		after := ""
		if jsNumber(fix["at"]) < float64(SERVER_AT) {
			after = "배포 뒤 "
		}
		logLine("report " + mstr(r, "id") + ": 고치기 세션이 " + after + "끝나 목록에서 지움")
	}
}

func userIds() []string {
	out := []string{}
	names, _ := os.ReadDir(filepath.Join(DATA, "u"))
	for _, n := range names {
		if !strings.HasPrefix(n.Name(), ".") {
			out = append(out, n.Name())
		}
	}
	return out
}

func accessAt(a M) float64 {
	if v := numOr0(a["lastAt"]); v != 0 {
		return v
	}
	return numOr0(a["firstAt"])
}

func accessStale(a M, past pastFn) bool {
	st := a["status"]
	return (st == "pending" || st == "denied") && past(accessAt(a), ACCESS_KEEP_MS, float64(nowMs()))
}

// sweepRetention: notices past 30 days, reports past 90 and access requests past 90 go (REQ-S-071, -072, -074 (8)).
func sweepRetention(past pastFn) M {
	if past == nil {
		past = pastKeep
	}
	n := map[string]int{"notices": 0, "reports": 0, "access": 0}
	for _, uid := range userIds() {
		if !exists(noticesFile(uid)) {
			continue
		}
		var before int
		if l, ok := noticeCache[uid]; ok {
			before = len(l)
		} else {
			l, _ := readJSON(noticesFile(uid), []any{}).([]any)
			before = len(l)
		}
		n["notices"] += before - len(noticesOf(uid, past))
	}
	for _, r := range readReports() {
		if past(r["at"], REPORT_KEEP_MS, float64(nowMs())) {
			dropReport(r)
			n["reports"]++
		}
	}
	for _, k := range access.Keys() {
		if accessStale(access.Val(k), past) {
			access.Delete(k)
			n["access"]++
		}
	}
	if n["access"] > 0 {
		touchGlobals()
	}
	if n["notices"] > 0 || n["reports"] > 0 || n["access"] > 0 {
		logLine("retention: 알림 " + itoa(n["notices"]) + "개, 제보 " + itoa(n["reports"]) + "개, 접근 요청 " + itoa(n["access"]) + "개 지움")
	}
	return M{"notices": float64(n["notices"]), "reports": float64(n["reports"]), "access": float64(n["access"])}
}

const CONVERSATION_PURGE_READY = true

var transcriptRe = regexp.MustCompile(`^transcript.*\.jsonl$`)

// purgeTargets: what the operator's clearing would take (REQ-S-075), counted on disk.
func purgeTargets() M {
	t := M{}
	add := func(key, file string) {
		e, ok := t[key].(M)
		if !ok {
			e = M{"files": 0.0, "bytes": 0.0}
			t[key] = e
		}
		e["files"] = numOr0(e["files"]) + 1
		if st, err := os.Stat(file); err == nil {
			e["bytes"] = numOr0(e["bytes"]) + float64(st.Size())
		}
	}
	now := float64(nowMs())
	for _, uid := range userIds() {
		sdir := filepath.Join(DATA, "u", uid, "s")
		sids, _ := os.ReadDir(sdir)
		for _, sd := range sids {
			sid := sd.Name()
			names, _ := os.ReadDir(filepath.Join(sdir, sid))
			for _, fe := range names {
				f := fe.Name()
				file := filepath.Join(sdir, sid, f)
				if transcriptRe.MatchString(f) {
					add("transcripts", file)
				} else if f == "events.jsonl" {
					add("events", file)
					if m, ok := sessions.Get(sid); ok && m.get("agentLog") == false {
						e := asM(t["events"])
						e["notMoved"] = numOr0(e["notMoved"]) + 1
					}
				}
			}
		}
		idir := imgDir(uid)
		files, _ := os.ReadDir(idir)
		for _, f := range files {
			add("images", filepath.Join(idir, f.Name()))
		}
		var list []any
		if exists(noticesFile(uid)) {
			list, _ = readJSON(noticesFile(uid), []any{}).([]any)
		}
		old := 0
		for _, x := range list {
			if pastAny(mget(x, "at"), NOTICE_KEEP_MS, now) {
				old++
			}
		}
		if old > 0 {
			e, ok := t["notices"].(M)
			if !ok {
				e = M{"files": 0.0, "bytes": 0.0, "items": 0.0}
				t["notices"] = e
			}
			e["items"] = numOr0(e["items"]) + float64(old)
			e["files"] = numOr0(e["files"]) + 1
		}
	}
	for _, m := range sessions.Values() {
		if truthy(m.get("_legacy")) {
			e, ok := t["legacyMeta"].(M)
			if !ok {
				e = M{"files": 0.0, "bytes": 0.0}
				t["legacyMeta"] = e
			}
			e["files"] = numOr0(e["files"]) + 1
			e["bytes"] = numOr0(e["bytes"]) + float64(jsLen(jsonStr(m.get("_legacy"))))
		}
	}
	for _, r := range readReports() {
		if !pastAny(r["at"], REPORT_KEEP_MS, now) {
			continue
		}
		add("reports", reportFile(mstr(r, "id")))
		for _, v := range asArr(r["videos"]) {
			if uploadId(mget(v, "id")) && exists(reportVideoFile(mstr(v, "id"))) {
				add("reports", reportVideoFile(mstr(v, "id")))
			}
		}
		for _, id := range asArr(r["images"]) {
			if reportImgId(id) && exists(filepath.Join(REPORTS, "img", id.(string))) {
				add("reports", filepath.Join(REPORTS, "img", id.(string)))
			}
		}
	}
	oldAccess := 0
	for _, a := range access.Values() {
		if accessStale(a, pastAny) {
			oldAccess++
		}
	}
	if oldAccess > 0 {
		t["access"] = M{"files": 0.0, "bytes": 0.0, "items": float64(oldAccess)}
	}
	return t
}

var PURGE_KINDS = M{"transcripts": "대화 원본 줄", "events": "화면 이벤트(맥으로 옮긴 세션만)", "images": "대화 그림", "legacyMeta": "옛 세션 정보(지침 본문 등)", "notices": "30일 지난 알림", "reports": "90일 지난 제보", "access": "90일 지난 접근 요청"}
var PURGE_KIND_ORDER = []string{"transcripts", "events", "images", "legacyMeta", "notices", "reports", "access"}
var CONVERSATION_KINDS = []string{"transcripts", "events", "images"}

// purge clears the kinds asked for (REQ-S-075). Called only with BRIDGE_PURGE=1 and an operator's request.
func purge(kinds []string) *OMap[float64] {
	done := newOMap[float64]()
	if contains(kinds, "notices") || contains(kinds, "reports") || contains(kinds, "access") {
		n := sweepRetention(pastAny)
		for _, k := range []string{"notices", "reports", "access"} {
			if contains(kinds, k) {
				done.Set(k, numOr0(n[k]))
			}
		}
	}
	if contains(kinds, "legacyMeta") {
		done.Set("legacyMeta", 0)
		for _, m := range sessions.Values() {
			if truthy(m.get("_legacy")) {
				m.del("_legacy")
				dirty.Set(m.id(), true)
				done.Set("legacyMeta", done.Val("legacyMeta")+1)
			}
		}
	}
	for _, k := range kinds {
		if !contains(CONVERSATION_KINDS, k) {
			continue
		}
		done.Set(k, 0)
		for _, uid := range userIds() {
			if k == "images" {
				if exists(imgDir(uid)) {
					_ = os.RemoveAll(imgDir(uid))
					delete(imgInfoCache, uid)
					done.Set(k, done.Val(k)+1)
				}
				continue
			}
			sdir := filepath.Join(DATA, "u", uid, "s")
			sids, _ := os.ReadDir(sdir)
			for _, sd := range sids {
				sid := sd.Name()
				names, _ := os.ReadDir(filepath.Join(sdir, sid))
				for _, fe := range names {
					f := fe.Name()
					var hit bool
					if k == "transcripts" {
						hit = transcriptRe.MatchString(f)
					} else {
						m, ok := sessions.Get(sid)
						hit = f == "events.jsonl" && !(ok && m.get("agentLog") == false)
					}
					if hit {
						_ = os.Remove(filepath.Join(sdir, sid, f))
						done.Set(k, done.Val(k)+1)
					}
				}
			}
		}
	}
	parts := []string{}
	for _, k := range done.Keys() {
		parts = append(parts, k+" "+numStr(done.Val(k)))
	}
	logLine("purge: " + strings.Join(parts, ", "))
	return done
}

// closeSession — 종료: claude stops on its Mac; the session stays in the list and its folder is left alone.
func closeSession(meta *Sess, text string) {
	if text == "" {
		text = "종료"
	}
	// What it handed to other Macs stops with it (REQ-F-760).
	for _, c := range delegatesOf(meta) {
		closeSession(c, "맡긴 세션이 닫혀 같이 닫음")
	}
	toHost(meta.host(), M{"t": "close", "sid": meta.id()})
	meta.set("closed", true)
	meta.set("closedAt", float64(nowMs()))
	resetVolatile(meta)
	logEvents(meta, []any{M{"k": "end", "text": text}})
	sessAfter("session.close", meta, kv{"kind", "end"})
}

// forgetSession — 제거: the server's copy of a session goes (its folder and conversation on the Mac stay).
func forgetSession(meta *Sess) {
	if meta.host() != "" && !isDemoHost(meta.host()) {
		toHost(meta.host(), M{"t": "forget", "sid": meta.id()})
	}
	sessions.Delete(meta.id())
	dirty.Delete(meta.id())
	dropNotices(meta.uid(), func(x M) bool { return x["sid"] == meta.id() })
	_ = os.RemoveAll(sessionDir(meta))
	pf := prefsOf(meta.uid())
	pf["loose"] = removeAll(asArr(pf["loose"]), meta.id())
	for _, x := range groupsList(pf) {
		x["items"] = removeAll(asArr(x["items"]), meta.id())
	}
}

// REQ-F-742: an ended session is kept in 이어서 하기 for 7 days, then removed like 제거.
const (
	ENDED_KEEP_MS  = 7 * 86_400_000
	ENDED_SWEEP_MS = 86_400_000
)

func endedAt(m *Sess) float64 {
	c := m.get("closedAt")
	if c == nil {
		c = m.get("updatedAt")
	}
	return maxF(numOr0(m.get("lastAt")), numOr0(c))
}

func sweepEnded(now float64) int {
	uids := []string{}
	n := 0
	for _, meta := range sessions.Values() {
		// A 자동 대응 session closed after its deploy (kept by a server from before such ones were removed at once) goes now.
		deployed := meta.get("reportAuto") != nil && truthy(meta.get("reportDeployed"))
		// So does a session the service API opened (1.376): nobody keeps one to come back to.
		service := truthy(meta.get("service"))
		if !truthy(meta.get("closed")) || truthy(meta.get("moving")) || (!deployed && !service && now-endedAt(meta) < ENDED_KEEP_MS) {
			continue
		}
		forgetSession(meta)
		if !contains(uids, meta.uid()) {
			uids = append(uids, meta.uid())
		}
		n++
		why := "끝난 지 7일이 지나"
		if deployed {
			why = "자동 대응이 배포를 마쳐"
		} else if service {
			why = "서비스 API 세션이 끝나"
		}
		logLine("session " + meta.id() + ": " + why + " 이어서 하기에서 지움")
	}
	for _, uid := range uids {
		savePrefs(uid)
	}
	return n
}

// A 자동 대응 session that said the deploy is done is closed once its turn is over.
const REPORT_DONE = "[제보 대응: 배포 완료]"

var REPORT_DONE_RE = regexp.MustCompile(`(?m)^[ \t]*\[제보 대응: 배포 완료\][ \t]*$`)

const REPORT_CLOSE_MS = 5000

var reportClosing = map[string]bool{}

func closeWhenReportDone(meta *Sess) {
	if !truthy(meta.get("reportDeployed")) || truthy(meta.get("closed")) || reportClosing[meta.id()] {
		return
	}
	reportClosing[meta.id()] = true
	setTimeout(REPORT_CLOSE_MS*time.Millisecond, func() {
		delete(reportClosing, meta.id())
		cur, _ := sessions.Get(meta.id())
		ph := meta.state()["phase"]
		if truthy(meta.get("closed")) || truthy(meta.get("moving")) || cur != meta || !(ph == "idle" || ph == "ended") {
			return
		}
		// Ended and taken off the list too, as 제거 does: a fix already deployed needs nobody to look at it.
		closeSession(meta, "종료(자동 대응: 배포 완료)")
		forgetSession(meta)
		savePrefs(meta.uid())
		broadcastState(meta.uid())
		logLine("report " + jsStringU(meta.get("reportAuto")) + ": 배포 완료, 자동 대응 세션 " + meta.id() + " 종료·목록에서 지움")
	})
}

func ownSession(uid string, sid string) *Sess {
	meta, ok := sessions.Get(sid)
	if !ok || meta.uid() != uid {
		refuse(404, "세션이 없습니다")
	}
	return meta
}

func startReportTimers() {
	SERVER_AT = nowMs()
	setInterval(REPORT_AUTO_RETRY_MS*time.Millisecond, func() {
		if !truthy(reportAuto["on"]) {
			return
		}
		for _, r := range readReports() {
			a := asM(r["auto"])
			if r["status"] == "new" && numOr0(a["tries"]) < REPORT_AUTO_TRIES && float64(nowMs())-numOr0(a["at"]) >= REPORT_AUTO_RETRY_MS {
				rr := r
				goLocked("autofix", func() { autoFix(rr) })
			}
		}
	})
	setTimeout(1000*time.Millisecond, sweepReports)
	setInterval(REPORT_SWEEP_MS*time.Millisecond, sweepReports)
	setTimeout(2000*time.Millisecond, func() { sweepRetention(nil) })
	setInterval(RETENTION_SWEEP_MS*time.Millisecond, func() { sweepRetention(nil) })
	setTimeout(60_000*time.Millisecond, func() { sweepEnded(float64(nowMs())) })
	setInterval(ENDED_SWEEP_MS*time.Millisecond, func() { sweepEnded(float64(nowMs())) })
	setInterval(3600_000*time.Millisecond, dropOldUploads)
}

var _ = sort.Strings
