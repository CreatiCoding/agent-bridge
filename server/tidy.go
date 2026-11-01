package main

// 세션 정리 (REQ-F-835~840): the agent judges and acts every hour (agent/guard.mjs idleStopWhy, folderTidyWhy, …);
// the server hands it the policy and what only the server knows (locks, auto-response, who waits on whom, the last
// input a person sent), keeps its report for the disk page, reflects it on the sessions and says what was done.

import (
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	TIDY_DAY_MS = 86_400_000.0
	// TIDY_SUMMARY_HOUR: the daily summary goes with the first report after this hour, the Mac's own clock.
	TIDY_SUMMARY_HOUR = 9
	TIDY_RUN_MS       = 300_000
)

var TIDY_MODES = []string{"auto", "suggest", "off"}

// TIDY_DAY_KEYS: the steps a person may turn off (0) or move, in days (0~3650).
var TIDY_DAY_KEYS = []string{"idleStopDays", "restDays", "closeSuggestDays", "folderTrashDays", "transcriptDays"}

var hostTidyRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/tidy$`)

// tidyYaml: bridge.yaml's tidy.* (REQ-F-812), as numbers and the mode.
func tidyYaml() M {
	out := M{"mode": cfgGet("tidy.mode").(string), "observeDays": float64(cfgGet("tidy.observeDays").(int)), "transcriptMB": float64(cfgGet("tidy.transcriptMB").(int))}
	for _, k := range TIDY_DAY_KEYS {
		out[k] = float64(cfgGet("tidy." + k).(int))
	}
	return out
}

// tidyPolicyOf (REQ-F-840): a Mac's policy from bridge.yaml (yaml), the account's choice and the Mac's own, whether
// the Mac's owner is an operator, and when the Mac first asked. A mode someone chose is taken as it is; the
// default auto waits observeDays from the first batch, and on someone else's Mac waits for its owner.
func tidyPolicyOf(yaml, account, host M, ownerAdmin bool, firstAt, now float64) M {
	pick := func(k string) any {
		for _, src := range []M{host, account} {
			if v, ok := src[k]; ok && v != nil {
				return v
			}
		}
		return yaml[k]
	}
	out := M{"why": nil, "observeUntil": nil}
	for _, k := range append(append([]string{}, TIDY_DAY_KEYS...), "transcriptMB") {
		out[k] = pick(k)
	}
	mode, _ := pick("mode").(string)
	chosen := host["mode"] != nil || account["mode"] != nil
	if !contains(TIDY_MODES, mode) {
		mode = "auto"
	}
	if !chosen && mode == "auto" {
		until := firstAt + numOr0(yaml["observeDays"])*TIDY_DAY_MS
		switch {
		case !ownerAdmin:
			mode, out["why"] = "suggest", "owner"
		case firstAt == 0 || now < until:
			mode, out["why"] = "suggest", "observe"
			if firstAt > 0 {
				out["observeUntil"] = until
			}
		}
	}
	out["mode"] = mode
	return out
}

// tidyPolicyFor: the policy a Mac runs with now.
func tidyPolicyFor(hostID string) M {
	h := hosts.Val(hostID)
	uid := mstr(h, "uid")
	return tidyPolicyOf(tidyYaml(), asM(prefsOf(uid)["tidy"]), asM(h["tidy"]), isAdmin(uid), numOr0(h["tidyFirstAt"]), float64(nowMs()))
}

// tidyHolds: what only the server knows about each open session of a Mac (REQ-F-835 rule 3, IF-263 holds).
func tidyHolds(hostID string) M {
	out := M{}
	for _, meta := range sessions.Values() {
		if meta.host() != hostID || truthy(meta.get("closed")) {
			continue
		}
		delegate := awaited[meta.id()] > 0
		for _, c := range delegatesOf(meta) {
			if ph := c.state()["phase"]; ph == "starting" || ph == "busy" || ph == "waiting" {
				delegate = true
			}
		}
		out[meta.id()] = M{"humanAt": numOrNull(meta.get("humanAt")), "keepAlive": truthy(meta.get("keepAlive")), "locked": truthy(meta.get("lock")),
			"reportAuto": meta.get("reportAuto") != nil && !truthy(meta.get("reportDeployed")), "delegate": delegate, "resting": truthy(meta.get("resting"))}
	}
	return out
}

// tidyRunFor: one batch's orders for a Mac (IF-263 tidyRun).
func tidyRunFor(hostID string) M {
	uid := mstr(hosts.Val(hostID), "uid")
	root := mstr(launchOf(uid), "folderBase")
	if root == "" {
		root = FOLDER_BASE
	}
	ended := []any{}
	for _, meta := range sessions.Values() {
		if meta.host() == hostID && truthy(meta.get("closed")) && meta.str("cwd") != "" {
			ended = append(ended, M{"cwd": meta.str("cwd"), "closedAt": endedAt(meta)})
		}
	}
	return M{"t": "tidyRun", "policy": tidyPolicyFor(hostID), "holds": tidyHolds(hostID), "roots": []any{root}, "ended": ended}
}

func tidyFile(uid, hostID string) string {
	return filepath.Join(userDir(uid), "tidy", safeFileName(hostID)+".json")
}

var unsafeFileRe = regexp.MustCompile(`[^a-zA-Z0-9-]`)

func safeFileName(s string) string { return unsafeFileRe.ReplaceAllString(s, "_") }

// tidyReports: the last report of each Mac, read from its file the first time.
var tidyReports = map[string]M{}

func tidyReportOf(hostID string) M {
	if r, ok := tidyReports[hostID]; ok {
		return r
	}
	h, ok := hosts.Get(hostID)
	if !ok {
		return nil
	}
	r, _ := readJSON(tidyFile(mstr(h, "uid"), hostID), nil).(M)
	tidyReports[hostID] = r
	return r
}

func sizeText(b float64) string {
	if b >= 1e9 {
		return numStr(jsRound(b/1e8)/10) + " GB"
	}
	return numStr(jsRound(b/1e6)) + " MB"
}

func sessionTitle(meta *Sess) string {
	if truthy(meta.get("lock")) && !truthy(meta.get("manualTitle")) {
		return "잠긴 세션"
	}
	if t := meta.str("title"); t != "" {
		return t
	}
	return jsSliceTo(meta.id(), 8)
}

// tidySummaryText (REQ-F-838 rule 4): the day's line, or "" when there is nothing to say.
func tidySummaryText(host, mode string, stopped, trashed, bytes, suggested, wouldStop, wouldTrash, wouldBytes float64) string {
	tail := ""
	if suggested > 0 {
		tail = " · 정리 제안 " + numStr(suggested) + "개"
	}
	if mode == "suggest" {
		if wouldStop+wouldTrash+suggested == 0 {
			return ""
		}
		return host + ": 제안만 모드 · 자동이었다면 세션 " + numStr(wouldStop) + "개 내림, 폴더 " + numStr(wouldTrash) + "개(" + sizeText(wouldBytes) + ") 휴지통" + tail
	}
	if stopped+trashed+suggested == 0 {
		return ""
	}
	return host + ": 세션 " + numStr(stopped) + "개 내림, 폴더 " + numStr(trashed) + "개(" + sizeText(bytes) + ") 휴지통" + tail
}

// applyTidyReport (REQ-F-838 rule 3): keeps the report, puts each session's coming stop on it, rests what is due
// a rest, writes down what was done, and once a day tells the owner.
func applyTidyReport(uid, hostID string, report M) {
	if report == nil {
		return
	}
	h := hosts.Val(hostID)
	hostName := strOr(h["name"], "맥")
	tidyReports[hostID] = report
	writeJson(tidyFile(uid, hostID), report)
	mode := jsString(report["mode"])
	listed := map[string]bool{}
	for _, row := range asArr(report["sessions"]) {
		r := asM(row)
		meta, ok := sessions.Get(jsString(r["sid"]))
		if !ok || meta.host() != hostID || meta.uid() != uid || truthy(meta.get("closed")) {
			continue
		}
		listed[meta.id()] = true
		switch r["act"] {
		case "notice", "wait":
			stopAt := numOr0(r["stopAt"])
			if stopAt > 0 && numOr0(meta.get("tidyStopAt")) != stopAt {
				meta.set("tidyStopAt", stopAt)
				touch(meta)
			}
			if r["act"] == "notice" {
				hours := jsRound((stopAt - numOr0(report["at"])) / 3_600_000)
				addNotice(uid, M{"sid": meta.id(), "key": "tidy|" + meta.id() + "|" + numStr(numOr0(report["at"])), "title": sessionTitle(meta), "text": "💤 사람 입력이 " + numStr(numOr0(r["idleDays"])) + "일 없어 약 " + numStr(hours) + "시간 뒤 claude 를 내려요. 유지하려면 세션을 열어 \"유지\"를 누르세요", "tone": "info", "push": true})
			}
		default:
			if meta.get("tidyStopAt") != nil {
				meta.del("tidyStopAt")
				touch(meta)
			}
		}
		if truthy(r["rest"]) && mode == "auto" && !truthy(meta.get("resting")) && !truthy(meta.get("keepAlive")) {
			meta.set("resting", true)
			touch(meta)
			record(uid, hostID, M{"area": "tidy", "sid": meta.id(), "text": "세션 정리: 휴면으로 둠 " + sessionTitle(meta) + " · " + numStr(numOr0(r["idleDays"])) + "일 입력 없음"})
		}
	}
	done := asM(report["done"])
	for _, x := range asArr(done["stopped"]) {
		sid := jsString(mget(x, "sid"))
		if meta, ok := sessions.Get(sid); ok && meta.host() == hostID {
			meta.del("tidyStopAt")
			touch(meta)
			record(uid, hostID, M{"area": "tidy", "sid": sid, "text": "세션 정리: claude 내림 " + sessionTitle(meta) + " · " + numStr(mnum(x, "idleDays")) + "일 입력 없음"})
		}
	}
	// A session no longer listed has no stop coming.
	for _, meta := range sessions.Values() {
		if meta.host() == hostID && meta.get("tidyStopAt") != nil && !listed[meta.id()] {
			meta.del("tidyStopAt")
			touch(meta)
		}
	}
	trashed, bytes := 0.0, 0.0
	for _, x := range asArr(done["trashed"]) {
		trashed++
		bytes += mnum(x, "size")
		record(uid, hostID, M{"area": "tidy", "text": "세션 정리: 휴지통으로 옮김 " + jsSliceTo(jsStringU(mget(x, "path")), 300) + " · " + sizeText(mnum(x, "size"))})
	}
	for _, x := range asArr(done["failed"]) {
		record(uid, hostID, M{"level": "warn", "area": "tidy", "text": "세션 정리 실패: " + jsSliceTo(jsStringU(mget(x, "what")), 200) + " · " + jsSliceTo(jsStringU(mget(x, "error")), 200)})
	}
	// The day's summary: what was done since the last one, said once, after 9 o'clock on the Mac.
	sum := asM(h["tidySummary"])
	sum["stopped"] = numOr0(sum["stopped"]) + float64(len(asArr(done["stopped"])))
	sum["trashed"] = numOr0(sum["trashed"]) + trashed
	sum["bytes"] = numOr0(sum["bytes"]) + bytes
	local := asM(report["local"])
	date := jsString(local["date"])
	if date != "" && numOr0(local["hour"]) >= TIDY_SUMMARY_HOUR && jsString(sum["date"]) != date {
		would := asM(report["would"])
		suggested := 0.0
		for _, row := range asArr(report["sessions"]) {
			if a := mget(row, "act"); a == "suggest" || truthy(mget(row, "close")) {
				suggested++
			}
		}
		for _, f := range asArr(report["folders"]) {
			if !truthy(mget(f, "auto")) {
				suggested++
			}
		}
		suggested += float64(len(asArr(report["transcripts"])))
		if text := tidySummaryText(hostName, mode, sum["stopped"].(float64), sum["trashed"].(float64), sum["bytes"].(float64), suggested, mnum(would, "stop"), mnum(would, "trash"), mnum(would, "bytes")); text != "" {
			addNotice(uid, M{"key": "tidy-day|" + hostID + "|" + date, "title": "세션 정리", "text": text, "tone": "info", "push": true})
			record(uid, hostID, M{"area": "tidy", "text": "세션 정리 요약: " + text})
		}
		sum = M{"date": date, "stopped": 0.0, "trashed": 0.0, "bytes": 0.0}
	}
	h["tidySummary"] = sum
	touchGlobals()
	broadcastState(uid)
}

// tidyGroups (REQ-F-839 rule 3): which list of the page a session row is in. 내릴 세션: its claude runs and the batch
// counts it (suggest), told it (notice), waits on it or stops it. 휴면·끝내기 제안: any other row offered a rest or an
// end. Rows in neither (a running session held back, with only its reason) are not counted. The page groups the
// same way (ui/src/lib/tidy-groups.ts); test/fixtures/tidy-groups.json holds both to it.
func tidyGroups(rows []any) (stop, rest []string) {
	for _, row := range rows {
		r := asM(row)
		act := jsString(r["act"])
		if truthy(r["alive"]) && (act == "suggest" || act == "notice" || act == "wait" || act == "stop") {
			stop = append(stop, jsString(r["sid"]))
		} else if truthy(r["rest"]) || truthy(r["close"]) {
			rest = append(rest, jsString(r["sid"]))
		}
	}
	return stop, rest
}

// tidyBrief: the host summary's line about it (REQ-F-839 rule 1), counted from the lists the page shows (tidyView:
// sessions ended or moved since the report are not in them).
func tidyBrief(hostID string) any {
	p := tidyPolicyFor(hostID)
	out := M{"mode": p["mode"], "why": p["why"], "observeUntil": p["observeUntil"], "at": nil, "stop": 0.0, "rest": 0.0, "files": 0.0}
	v := asM(tidyView(hostID))
	if v == nil {
		return out
	}
	stop, rest := tidyGroups(asArr(v["sessions"]))
	out["at"] = v["at"]
	out["stop"] = float64(len(stop))
	out["rest"] = float64(len(rest))
	out["files"] = float64(len(asArr(v["folders"])) + len(asArr(v["transcripts"])))
	return out
}

// tidyView: the report with each session's title (a locked one's hidden) for the page.
func tidyView(hostID string) any {
	r := tidyReportOf(hostID)
	if r == nil {
		return nil
	}
	out := shallow(r)
	rows := []any{}
	for _, row := range asArr(r["sessions"]) {
		x := shallow(asM(row))
		if meta, ok := sessions.Get(jsString(x["sid"])); ok && meta.host() == hostID && !truthy(meta.get("closed")) {
			x["title"] = sessionTitle(meta)
			x["keepAlive"] = truthy(meta.get("keepAlive"))
			x["resting"] = truthy(meta.get("resting"))
			rows = append(rows, x)
		}
	}
	out["sessions"] = rows
	return out
}

// markHuman (REQ-F-835 rule 1): a person just did something in this session; a coming stop is off.
func markHuman(meta *Sess) {
	meta.set("humanAt", float64(nowMs()))
	meta.del("tidyStopAt")
}

// tidySettings (REQ-F-840 rule 3): the fields given, each a value or null (back to the level above).
func tidySettings(cur M, b M) M {
	out := shallow(cur)
	if v, ok := b["mode"]; ok {
		if v == nil {
			delete(out, "mode")
		} else if s, _ := v.(string); contains(TIDY_MODES, s) {
			out["mode"] = s
		} else {
			refuse(400, TIDY_BAD)
		}
	}
	for _, k := range append(append([]string{}, TIDY_DAY_KEYS...), "transcriptMB") {
		v, ok := b[k]
		if !ok {
			continue
		}
		if v == nil {
			delete(out, k)
			continue
		}
		f, isNum := v.(float64)
		max := 3650.0
		min := 0.0
		if k == "transcriptMB" {
			max, min = 1_000_000, 1
		}
		if !isNum || !isInteger(f) || f < min || f > max {
			refuse(400, TIDY_BAD)
		}
		out[k] = f
	}
	return out
}

const TIDY_BAD = "방식은 auto·suggest·off, 일수는 0~3650 의 정수예요"
const TIDY_OLD_AGENT = "이 맥의 에이전트가 세션 정리를 모르는 버전이에요"

func tidySettingsText(m M) string {
	parts := []string{}
	if v := m["mode"]; v != nil {
		parts = append(parts, "방식 "+jsString(v))
	}
	for _, k := range append(append([]string{}, TIDY_DAY_KEYS...), "transcriptMB") {
		if v := m[k]; v != nil {
			parts = append(parts, k+" "+numStr(jsNumber(v)))
		}
	}
	if len(parts) == 0 {
		return "기본값 따름"
	}
	return strings.Join(parts, ", ")
}

// apiTidy: IF-264.
func apiTidy(req *Req, res *Res, u *url.URL, uid string, p string) bool {
	m := hostTidyRe.FindStringSubmatch(p)
	if m == nil || req.Method != "POST" {
		return false
	}
	b := body(req, 65_536)
	h := diskHost(uid, m[1])
	owner := mstr(h, "uid")
	hostID := m[1]
	switch jsString(b["op"]) {
	case "report":
		jsonRes(res, 200, M{"report": tidyView(hostID), "policy": tidyPolicyFor(hostID)})
	case "run":
		if !online(hostID) {
			refuse(409, NOT_CONNECTED)
		}
		cmd := tidyRunFor(hostID)
		r := ask(hostID, cmd, TIDY_RUN_MS)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], TIDY_OLD_AGENT))
		}
		applyTidyReport(owner, hostID, asM(r["report"]))
		jsonRes(res, 200, M{"report": tidyView(hostID), "policy": tidyPolicyFor(hostID)})
	case "settings":
		scope := jsString(b["scope"])
		if scope == "account" {
			if owner != uid {
				refuse(403, "계정 설정은 그 계정의 주인만 바꿀 수 있어요")
			}
			prefs := prefsOf(uid)
			prefs["tidy"] = tidySettings(asM(prefs["tidy"]), b)
			savePrefs(uid)
			record(owner, hostID, M{"area": "tidy", "text": "세션 정리 설정(계정): " + tidySettingsText(asM(prefs["tidy"]))})
		} else {
			h["tidy"] = tidySettings(asM(h["tidy"]), b)
			touchGlobals()
			record(owner, hostID, M{"area": "tidy", "text": "세션 정리 설정(이 기기): " + tidySettingsText(asM(h["tidy"])) + byOperator(uid, h)})
		}
		broadcastState(owner)
		jsonRes(res, 200, M{"ok": true, "policy": tidyPolicyFor(hostID)})
	case "stop", "close":
		sids := []any{}
		for _, x := range asArr(b["sids"]) {
			if s, ok := x.(string); ok && len(sids) < 200 {
				if meta, ok := sessions.Get(s); ok && meta.host() == hostID && meta.uid() == owner && !truthy(meta.get("closed")) {
					sids = append(sids, s)
				}
			}
		}
		if len(sids) == 0 {
			refuse(400, "고를 것이 없어요")
		}
		if b["op"] == "close" {
			for _, s := range sids {
				meta, _ := sessions.Get(s.(string))
				closeSession(meta, "종료(세션 정리)")
				touch(meta)
			}
			record(owner, hostID, M{"area": "tidy", "text": "세션 정리: 세션 " + itoa(len(sids)) + "개 끝냄" + byOperator(uid, h)})
			broadcastState(owner)
			jsonRes(res, 200, M{"ok": true, "closed": float64(len(sids))})
			return true
		}
		if !online(hostID) {
			refuse(409, NOT_CONNECTED)
		}
		r := ask(hostID, M{"t": "tidyStop", "sids": sids, "holds": tidyHolds(hostID)}, 60_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], TIDY_OLD_AGENT))
		}
		n := 0
		for _, x := range asArr(r["results"]) {
			if truthy(mget(x, "ok")) {
				n++
				if meta, ok := sessions.Get(jsString(mget(x, "sid"))); ok {
					meta.del("tidyStopAt")
					touch(meta)
				}
			}
		}
		record(owner, hostID, M{"area": "tidy", "text": "세션 정리: claude " + itoa(n) + "개 내림(손으로)" + byOperator(uid, h)})
		jsonRes(res, 200, M{"ok": true, "results": r["results"]})
	case "trash":
		items := []any{}
		for _, x := range asArr(b["items"]) {
			k, path := jsString(mget(x, "kind")), mget(x, "path")
			if s, ok := path.(string); ok && len(s) <= 4096 && (k == "folder" || k == "transcript") && len(items) < 200 {
				items = append(items, M{"kind": k, "path": s})
			}
		}
		if len(items) == 0 {
			refuse(400, "고를 것이 없어요")
		}
		if !online(hostID) {
			refuse(409, NOT_CONNECTED)
		}
		r := ask(hostID, M{"t": "tidyTrash", "items": items}, 180_000)
		if !truthy(r["ok"]) {
			refuse(409, orStr(r["error"], TIDY_OLD_AGENT))
		}
		n, bytes := 0, 0.0
		for _, x := range asArr(r["results"]) {
			if truthy(mget(x, "ok")) {
				n++
				bytes += mnum(x, "size")
			}
		}
		record(owner, hostID, M{"area": "tidy", "text": "세션 정리: " + itoa(n) + "개 휴지통으로 옮김(" + sizeText(bytes) + ", 손으로)" + byOperator(uid, h)})
		// The report no longer lists what went.
		if rep := tidyReportOf(hostID); rep != nil {
			gone := map[string]bool{}
			for _, x := range asArr(r["results"]) {
				if truthy(mget(x, "ok")) {
					gone[jsString(mget(x, "path"))] = true
				}
			}
			for _, k := range []string{"folders", "transcripts"} {
				kept := []any{}
				for _, f := range asArr(rep[k]) {
					if !gone[jsString(mget(f, "path"))] {
						kept = append(kept, f)
					}
				}
				rep[k] = kept
			}
			writeJson(tidyFile(owner, hostID), rep)
		}
		jsonRes(res, 200, M{"ok": true, "results": r["results"]})
	default:
		refuse(400, "모르는 동작이에요")
	}
	return true
}

func init() {
	fromAgent["tidyAsk"] = func(uid, hostID string, msg M) {
		h := hosts.Val(hostID)
		if numOr0(h["tidyFirstAt"]) == 0 {
			h["tidyFirstAt"] = float64(nowMs())
			touchGlobals()
		}
		toHost(hostID, tidyRunFor(hostID))
	}
	fromAgent["tidyReport"] = func(uid, hostID string, msg M) {
		applyTidyReport(uid, hostID, asM(msg["report"]))
	}
}
