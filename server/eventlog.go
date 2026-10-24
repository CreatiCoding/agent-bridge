package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// ---------- event log ----------
// Every session has its own numbered log of what happened in it. The numbers belong to the session: they keep
// counting across `/clear` and across hosts.

// MOVES: what moves a session up the 최신순 list: the conversation itself.
var MOVES = map[string]bool{"user": true, "text": true, "tool": true, "tool_end": true, "card": true, "card_end": true, "local": true, "side": true, "todos": true}

func movedAt(events []any) any {
	for i := len(events) - 1; i >= 0; i-- {
		if MOVES[mstr(events[i], "k")] {
			return mget(events[i], "at")
		}
	}
	return nil
}

var seqRe = regexp.MustCompile(`"seq":(\d+)`)

// lastSeqIn: the highest seq among the last lines of a log file (0 when there is none).
func lastSeqIn(file string, size int64) float64 {
	f, err := os.Open(file)
	if err != nil {
		panic(err)
	}
	n := size
	if n > 64*1024 {
		n = 64 * 1024
	}
	buf := make([]byte, n)
	_, _ = f.ReadAt(buf, size-n)
	f.Close()
	max := 0.0
	for _, m := range seqRe.FindAllSubmatch(buf, -1) {
		if v, err := strconv.ParseFloat(string(m[1]), 64); err == nil && v > max {
			max = v
		}
	}
	return max
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

func logEvents(meta *Sess, events []any) {
	if len(events) == 0 {
		return
	}
	now := float64(nowMs())
	// Two servers of a deploy never hand out the same numbers: a log longer than this server last left it is counted
	// on from its own last number.
	file := eventsFile(meta)
	size := fileSize(file)
	if size != 0 && float64(size) != numOr0(meta.get("logSize")) {
		meta.set("seq", maxF(numOr0(meta.get("seq")), lastSeqIn(file, size)))
	}
	for _, ev := range events {
		e := asM(ev)
		seq := numOr0(meta.get("seq")) + 1
		meta.set("seq", seq)
		e["seq"] = seq
		if e["at"] == nil {
			e["at"] = now
		}
		k := mstr(e, "k")
		if k == "text" {
			meta.set("lastMine", false)
		}
		if k == "text" || k == "user" {
			last := jsSliceTo(collapse(mstr(e, "text")), PREVIEW_MAX)
			if last == "" && truthy(e["images"]) {
				last = "이미지 " + itoa(len(asArr(e["images"]))) + "장"
			}
			meta.set("last", last)
		}
		if k == "user" && !truthy(e["command"]) && !truthy(meta.get("preview")) {
			meta.set("preview", jsSliceTo(collapse(mstr(e, "text")), PREVIEW_MAX))
		}
	}
	if at := movedAt(events); at != nil {
		meta.set("lastAt", at)
	} else if meta.get("lastAt") == nil {
		meta.set("lastAt", meta.get("createdAt"))
	}
	// Not written here: the Mac keeps the log (REQ-S-069). This server holds the newest few in memory.
	meta.set("logSize", float64(size))
	remember(meta, events, false)
	touch(meta)
	toControls(meta.uid(), M{"t": "ev", "sid": meta.id(), "events": events})
	handDown(meta.host(), M{"t": "log", "sid": meta.id(), "events": events})
}

// ---------- the logs go to the Mac (REQ-S-069) ----------

const PREVIEW_MAX = 80

// tails: sid -> the session's newest events, in memory only.
var tails = newOMap[[]any]()

const (
	TAIL_MAX      = 1000
	TAIL_DEMO_MAX = 5000
	TAIL_SESSIONS = 200
)

func remember(meta *Sess, events []any, older bool) {
	t, _ := tails.Get(meta.id())
	tails.Delete(meta.id())
	if older {
		have := map[float64]bool{}
		for _, e := range t {
			have[mnum(e, "seq")] = true
		}
		n := []any{}
		for _, e := range events {
			if !have[mnum(e, "seq")] {
				n = append(n, e)
			}
		}
		t = append(n, t...)
		sort.SliceStable(t, func(i, j int) bool { return mnum(t[i], "seq") < mnum(t[j], "seq") })
	} else {
		t = append(append([]any{}, t...), events...)
	}
	max := TAIL_MAX
	if isDemoHost(meta.host()) {
		max = TAIL_DEMO_MAX
	}
	if len(t) > max {
		t = t[len(t)-max:]
	}
	tails.Set(meta.id(), t)
	for _, k := range tails.Keys() {
		if tails.Len() <= TAIL_SESSIONS {
			break
		}
		s, _ := sessions.Get(k)
		h := ""
		if s != nil {
			h = s.host()
		}
		if k != meta.id() && !isDemoHost(h) {
			tails.Delete(k)
		}
	}
}

// readEvents: the session's events this server can see now: an older server's copy, if not yet moved, and the newest.
func readEvents(meta *Sess, keep bool) []any {
	tail := tails.Val(meta.id())
	if tail == nil {
		tail = []any{}
	}
	if truthy(meta.get("agentLog")) || !exists(eventsFile(meta)) {
		return tail
	}
	old := readLegacyEvents(meta, keep)
	last := 0.0
	if len(old) > 0 {
		last = numOr0(mget(old[len(old)-1], "seq"))
	}
	if len(tail) == 0 {
		return old
	}
	out := append([]any{}, old...)
	for _, e := range tail {
		if mnum(e, "seq") > last {
			out = append(out, e)
		}
	}
	return out
}

// recentEvents: the newest events, asked of the Mac when this server has none in memory.
func recentEvents(meta *Sess, kinds []string) []any {
	have := readEvents(meta, true)
	wanted := have
	if kinds != nil {
		wanted = []any{}
		for _, e := range have {
			if contains(kinds, mstr(e, "k")) {
				wanted = append(wanted, e)
			}
		}
	}
	if len(wanted) > 0 || !online(meta.host()) || !storeOn(meta.host()) {
		return wanted
	}
	cmd := M{"t": "events", "sid": meta.id(), "limit": 500.0}
	if kinds != nil {
		cmd["limit"] = 50.0
		cmd["kinds"] = anyList(kinds)
	}
	r := ask(meta.host(), cmd, 15_000)
	evs, ok := r["events"].([]any)
	if !truthy(r["ok"]) || !ok {
		return wanted
	}
	if kinds == nil {
		remember(meta, evs, true)
	}
	return evs
}

// handedNotKept: events handed to the Mac and not yet heard kept there.
func handedNotKept(meta *Sess) []any {
	out := []any{}
	q := logOut[meta.host()]
	if q == nil {
		return out
	}
	for _, cmd := range q.m.Values() {
		if cmd["t"] == "log" && cmd["sid"] == meta.id() {
			out = append(out, asArr(cmd["events"])...)
		}
	}
	return out
}

// logOut: hostId -> (lid -> command): events and pictures handed to a Mac and not yet heard kept there.
type logQueue struct {
	m     *OMap[M]
	bytes int
}

var logOut = map[string]*logQueue{}

const (
	LOG_OUT_MAX   = 5000
	LOG_OUT_BYTES = 32 * 1024 * 1024
)

// lidWaits: lid -> resolve, for migrateSession, which waits for each to be kept.
var lidWaits = map[string]func(bool){}

func storeOn(hostID string) bool {
	caps := asArr(live(hostID)["caps"])
	return containsAny(caps, "store")
}

func handDown(hostID string, cmd M) string {
	if hostID == "" || !hosts.Has(hostID) || isDemoHost(hostID) {
		return ""
	}
	lid := base64.RawURLEncoding.EncodeToString(randBytes(9))
	out := logOut[hostID]
	if out == nil {
		out = &logQueue{m: newOMap[M]()}
		logOut[hostID] = out
	}
	msg := shallow(cmd)
	msg["lid"] = lid
	msg["size"] = float64(jsLen(jsonStr(msg)))
	out.m.Set(lid, msg)
	out.bytes += int(mnum(msg, "size"))
	for out.m.Len() > LOG_OUT_MAX || out.bytes > LOG_OUT_BYTES {
		old := out.m.keys[0]
		dropped := out.m.Val(old)
		out.m.Delete(old)
		out.bytes -= int(mnum(dropped, "size"))
		if w := lidWaits[old]; w != nil {
			w(false)
		}
		if sid, ok := dropped["sid"].(string); ok && sid != "" {
			if m, ok := sessions.Get(sid); ok && truthy(m.get("agentLog")) {
				m.set("agentLog", false)
				dirty.Set(m.id(), true)
			}
		}
	}
	if online(hostID) && storeOn(hostID) {
		c := shallow(cmd)
		c["lid"] = lid
		toHost(hostID, c)
	}
	return lid
}

func heardKept(hostID string, lids []any) {
	out := logOut[hostID]
	for _, l := range lids {
		lid := jsString(l)
		if out != nil {
			if msg, ok := out.m.Get(lid); ok {
				out.m.Delete(lid)
				out.bytes -= int(mnum(msg, "size"))
			}
		}
		if w := lidWaits[lid]; w != nil {
			w(true)
		}
	}
}

// waitKept resolves (on the returned channel) when the Mac says it kept lid, or false after ms.
func waitKept(lid string, ms int64) chan bool {
	ch := make(chan bool, 1)
	var t *Timer
	t = setTimeout(msDur(ms), func() {
		delete(lidWaits, lid)
		ch <- false
	})
	lidWaits[lid] = func(ok bool) {
		clearTimeout(t)
		delete(lidWaits, lid)
		select {
		case ch <- ok:
		default:
		}
	}
	return ch
}

func allTrue(flight []chan bool) bool {
	ok := true
	await(func() {
		for _, c := range flight {
			if !<-c {
				ok = false
			}
		}
	})
	return ok
}

// migrating: the copies an older server kept go to the session's Mac once it can keep them (REQ-S-075).
var migrating = map[string]bool{}

func migrateHost(uid, hostID string) {
	if migrating[hostID] {
		return
	}
	migrating[hostID] = true
	failed := map[string]bool{}
	defer delete(migrating, hostID)
	err := tryLog(func() {
		for {
			if !online(hostID) || !storeOn(hostID) {
				break
			}
			var meta *Sess
			for _, m := range sessions.Values() {
				if m.uid() == uid && m.host() == hostID && !truthy(m.get("agentLog")) && !truthy(m.get("moving")) && !failed[m.id()] {
					meta = m
					break
				}
			}
			if meta == nil {
				break
			}
			if cf := meta.str("carryFrom"); truthy(meta.get("carryFrom")) {
				ok := hosts.Has(cf) && storeOn(cf) && carryLog(meta, cf, hostID)
				if ok && meta.host() == hostID {
					meta.set("agentLog", true)
					meta.del("carryFrom")
					dirty.Set(meta.id(), true)
				} else {
					failed[meta.id()] = true
				}
			} else if !migrateSession(meta, hostID) {
				failed[meta.id()] = true
			}
		}
	})
	if err != nil {
		logLine("error", "migrate", err)
	}
}

var imgFileRe = regexp.MustCompile(`^[0-9a-f]{40}\.(png|jpg|gif|webp)$`)

func migrateSession(meta *Sess, hostID string) bool {
	events := []any{}
	if exists(eventsFile(meta)) {
		events = readLegacyEvents(meta, false)
	}
	upTo := numOr0(meta.get("seq"))
	var flight []chan bool
	send := func(cmd M) bool {
		lid := handDown(hostID, cmd)
		if lid == "" {
			return false
		}
		flight = append(flight, waitKept(lid, 120_000))
		if len(flight) < 4 {
			return true
		}
		ok := allTrue(flight)
		flight = nil
		return ok
	}
	chunk := []any{}
	size := 0
	ok := true
	for _, e := range events {
		if mnum(e, "seq") > upTo {
			break
		}
		chunk = append(chunk, e)
		size += jsLen(jsonStr(e))
		if len(chunk) >= 500 || size > 800_000 {
			ok = ok && send(M{"t": "log", "sid": meta.id(), "events": chunk})
			chunk = []any{}
			size = 0
		}
		if !ok {
			break
		}
	}
	if ok && len(chunk) > 0 {
		ok = send(M{"t": "log", "sid": meta.id(), "events": chunk})
	}
	pics := 0
	if ok {
		seen := map[string]bool{}
		var ids []string
		for _, e := range events {
			for _, id := range asArr(mget(e, "images")) {
				s := jsString(id)
				if !seen[s] {
					seen[s] = true
					ids = append(ids, s)
				}
			}
		}
		for _, id := range ids {
			file := filepath.Join(imgDir(meta.uid()), id)
			if !imgFileRe.MatchString(id) || !exists(file) {
				continue
			}
			b, _ := os.ReadFile(file)
			ok = send(M{"t": "putimg", "id": id, "data": base64.StdEncoding.EncodeToString(b)})
			pics++
			if !ok {
				break
			}
		}
	}
	if ok && len(flight) > 0 {
		ok = allTrue(flight)
	}
	if !ok || !sessions.Has(meta.id()) || meta.host() != hostID {
		return false
	}
	meta.set("agentLog", true)
	dirty.Set(meta.id(), true)
	if len(events) > 0 {
		record(meta.uid(), hostID, M{"area": "store", "sid": meta.id(), "text": "서버에 있던 세션 기록 " + itoa(len(events)) + "개와 그림 " + itoa(pics) + "장을 이 맥으로 옮김"})
	}
	return true
}

// forkSkip: a forked conversation starts as a copy of the original's lines, same uuids; those are not drawn twice.
var forkSkip = map[string]map[string]bool{}

func forkSkipFile(meta *Sess) string { return filepath.Join(sessionDir(meta), "fork-skip.txt") }

func copiedInFork(meta *Sess) map[string]bool {
	if !truthy(meta.get("forked")) {
		return nil
	}
	if _, ok := forkSkip[meta.id()]; !ok {
		set := map[string]bool{}
		if b, err := os.ReadFile(forkSkipFile(meta)); err == nil {
			for _, l := range strings.Split(string(b), "\n") {
				set[l] = true
			}
		}
		forkSkip[meta.id()] = set
	}
	return forkSkip[meta.id()]
}

var uuidRe = regexp.MustCompile(`"uuid":"([0-9a-f-]{36})"`)

func uuidOf(line string) (string, bool) {
	m := uuidRe.FindStringSubmatch(line)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// BG_START: what the session started in the background and has not finished.
var BG_START = []struct {
	re   *regexp.Regexp
	kind string
}{
	{re(`^Command running in background with ID: (\S+?)\.?(?:\s|$)`), "bash"},
	{re(`^Command [^\n]{0,120}?moved to the background \(ID: ([^)]+)\)`), "bash"},
	{re(`^Monitor started \(task (\S+?),`), "monitor"},
	{re(`^Async agent launched`), "agent"},
}

var bgLabels = newOMap[M]()

func trackBackground(meta *Sess, line string) {
	trackTodosTool(meta, line)
	before := len(asArr(meta.get("bg")))
	trackBackgroundLine(meta, line)
	// A monitor ends on its own after its timeout; nothing in the transcript says so.
	bg := []any{}
	now := float64(nowMs())
	for _, t := range asArr(meta.get("bg")) {
		timeout := 300_000.0
		if v := mget(t, "timeout"); v != nil {
			timeout = jsNumber(v)
		}
		if mstr(t, "kind") != "monitor" || now < numOr0(mget(t, "at"))+timeout {
			bg = append(bg, t)
		}
	}
	meta.set("bg", bg)
	if len(bg) != before && online(meta.host()) {
		toHost(meta.host(), M{"t": "bg", "sid": meta.id(), "n": float64(len(bg))})
	}
}

const TODO_HIDDEN_MAX = 200
const TODO_KEY_MAX = 300

// trackTodosTool: whether the session's Claude has the bridge todos tool (REQ-F-778), seen in its own transcript.
func trackTodosTool(meta *Sess, line string) {
	if truthy(meta.get("sawTodosTool")) || !strings.Contains(line, "mcp__bridge__todos") {
		return
	}
	v, err := parseJSON([]byte(line))
	if err != nil {
		return
	}
	o := asM(v)
	att := asM(o["attachment"])
	offered := o["type"] == "attachment" && att["type"] == "deferred_tools_delta" && containsAny(asArr(att["addedNames"]), "mcp__bridge__todos")
	called := false
	if o["type"] == "assistant" {
		for _, b := range asArr(mget(o["message"], "content")) {
			if mget(b, "type") == "tool_use" && mget(b, "name") == "mcp__bridge__todos" {
				called = true
			}
		}
	}
	if offered || called {
		meta.set("sawTodosTool", true)
	}
}

var bgLineRe = regexp.MustCompile(`tool_use|tool_result|task-notification`)
var taskNoteRe = re(`<task-notification>([\s\S]*?)</task-notification>`)
var tagRes = map[string]*regexp.Regexp{}

func pickTag(tag, s string) (string, bool) {
	r, ok := tagRes[tag]
	if !ok {
		r = re(`<` + regexp.QuoteMeta(tag) + `>([\s\S]*?)</` + regexp.QuoteMeta(tag) + `>`)
		tagRes[tag] = r
	}
	m := r.FindStringSubmatch(s)
	if m == nil {
		return "", false
	}
	return jsTrim(m[1]), true
}

var successStopRe = regexp.MustCompile(`^Successfully stopped`)
var agentIDRe = regexp.MustCompile(`agentId: (\w+)`)

func timestampOr(o M) float64 {
	if ts, ok := o["timestamp"].(string); ok && ts != "" {
		return parseDate(ts)
	}
	if truthy(o["timestamp"]) {
		return parseDate(jsString(o["timestamp"]))
	}
	return float64(nowMs())
}

func trackBackgroundLine(meta *Sess, line string) {
	// Not while an old session's log is being built at startup: what finished long ago is not news.
	if meta.get("seq") == nil {
		return
	}
	if !bgLineRe.MatchString(line) {
		return
	}
	v, err := parseJSON([]byte(line))
	if err != nil {
		return
	}
	o := asM(v)
	content := mget(o["message"], "content")
	text := ""
	switch c := content.(type) {
	case string:
		text = c
	case []any:
		parts := make([]string, len(c))
		for i, x := range c {
			if mget(x, "type") == "text" {
				parts[i] = jsString(mget(x, "text"))
			}
		}
		text = strings.Join(parts, "\n")
	default:
		if s, ok := o["content"].(string); ok {
			text = s
		} else if s, ok := mget(o["attachment"], "prompt").(string); ok {
			text = s
		}
	}
	// Only the harness delivers task notifications; one in Claude's own answer is made up and ends nothing.
	if o["type"] != "assistant" {
		for _, mi := range taskNoteRe.FindAllStringSubmatchIndex(text, -1) {
			inner := text[mi[2]:mi[3]]
			status, _ := pickTag("status", inner)
			if status == "" || status == "running" {
				continue
			}
			id, hasID := pickTag("tool-use-id", inner)
			taskID, hasTask := pickTag("task-id", inner)
			var task any
			for _, t := range asArr(meta.get("bg")) {
				if hasID && mget(t, "toolUseId") == id {
					task = t
					break
				}
			}
			if task == nil {
				for _, t := range asArr(meta.get("bg")) {
					if truthy(mget(t, "id")) && hasTask && mget(t, "id") == taskID {
						task = t
						break
					}
				}
			}
			bg := []any{}
			for _, t := range asArr(meta.get("bg")) {
				if !sameObj(t, task) {
					bg = append(bg, t)
				}
			}
			meta.set("bg", bg)
			ok := status == "completed"
			key := ""
			switch {
			case hasID:
				key = id
			case hasTask:
				key = taskID
			default:
				key = itoa(jsLen(text[:mi[0]]))
			}
			title := meta.str("title")
			if !truthy(meta.get("title")) {
				title = "세션"
			}
			summary, _ := pickTag("summary", inner)
			if summary == "" {
				summary = "백그라운드 작업이 끝났어요 (" + status + ")"
			}
			tone := "fail"
			if ok {
				tone = "ok"
			}
			// Kept in the notice list only: a finished job is no reason to buzz a phone (REQ-F-519, REQ-F-795).
			addNotice(meta.uid(), M{"sid": meta.id(), "key": key + "|" + status, "title": title, "text": summary, "tone": tone})
		}
	}
	list, ok := content.([]any)
	if !ok {
		return
	}
	for _, cv := range list {
		c := asM(cv)
		if o["type"] == "assistant" && c["type"] == "tool_use" {
			i := asM(c["input"])
			lab := i["description"]
			if lab == nil {
				lab = i["command"]
			}
			if lab == nil {
				lab = i["prompt"]
			}
			if lab == nil {
				lab = c["name"]
			}
			tag := M{"name": c["name"], "label": jsSliceTo(collapse(jsString(lab)), 120)}
			if t := jsNumber(i["timeout_ms"]); t > 0 {
				tag["timeout"] = t
			}
			if c["name"] == "TaskStop" {
				tid := i["task_id"]
				if tid == nil {
					tid = i["shell_id"]
				}
				if tid == nil {
					tid = ""
				}
				tag["taskId"] = jsString(tid)
			}
			bgLabels.Set(jsString(c["id"]), tag)
			if bgLabels.Len() > 2000 {
				bgLabels.Delete(bgLabels.keys[0])
			}
		} else if o["type"] == "user" && c["type"] == "tool_result" {
			tuid := jsString(c["tool_use_id"])
			tag, _ := bgLabels.Get(tuid)
			bgLabels.Delete(tuid)
			body := ""
			switch x := c["content"].(type) {
			case string:
				body = x
			case []any:
				parts := make([]string, len(x))
				for i, y := range x {
					if t := mget(y, "text"); t != nil {
						parts[i] = jsString(t)
					}
				}
				body = strings.Join(parts, "\n")
			}
			if tag["name"] == "TaskStop" {
				if !truthy(c["is_error"]) && successStopRe.MatchString(jsTrim(body)) {
					bg := []any{}
					for _, t := range asArr(meta.get("bg")) {
						if mget(t, "id") != tag["taskId"] {
							bg = append(bg, t)
						}
					}
					meta.set("bg", bg)
				}
				continue
			}
			// A background agent that had finished, woken again with a message: it runs again.
			if tag["name"] == "SendMessage" {
				r, _ := parseJSON([]byte(body))
				id, _ := mget(r, "resumedAgentId").(string)
				if !truthy(mget(r, "success")) {
					id = ""
				}
				if id != "" {
					has := false
					for _, t := range asArr(meta.get("bg")) {
						if mget(t, "kind") == "agent" && mget(t, "id") == id {
							has = true
						}
					}
					if !has {
						label := mget(meta.get("agentLabels"), id)
						if label == nil {
							label = "agent"
						}
						bg := append(append([]any{}, asArr(meta.get("bg"))...), M{"toolUseId": c["tool_use_id"], "id": id, "kind": "agent", "label": label, "at": timestampOr(o)})
						if len(bg) > 50 {
							bg = bg[len(bg)-50:]
						}
						meta.set("bg", bg)
					}
				}
				continue
			}
			first := jsSliceTo(strings.Split(body, "\n")[0], 400)
			for _, bs := range BG_START {
				m := bs.re.FindStringSubmatch(first)
				if m == nil {
					continue
				}
				var id any
				if bs.kind == "agent" {
					if a := agentIDRe.FindStringSubmatch(body); a != nil {
						id = a[1]
					}
				} else {
					id = m[1]
				}
				var label any = bs.kind
				if tag != nil && tag["label"] != nil {
					label = tag["label"]
				}
				ent := M{"toolUseId": c["tool_use_id"], "id": id, "kind": bs.kind, "label": label, "at": timestampOr(o)}
				if tag != nil && truthy(tag["timeout"]) {
					ent["timeout"] = tag["timeout"]
				}
				if id == nil {
					delete(ent, "id")
				}
				bg := append(append([]any{}, asArr(meta.get("bg"))...), ent)
				if len(bg) > 50 {
					bg = bg[len(bg)-50:]
				}
				meta.set("bg", bg)
				// An agent's name, for when it is woken again later.
				if bs.kind == "agent" && truthy(id) {
					labels := asM(meta.get("agentLabels"))
					keys := sortedKeys(labels)
					n := M{}
					order := []string{}
					for _, k := range keys {
						if k != id.(string) {
							n[k] = labels[k]
							order = append(order, k)
						}
					}
					n[id.(string)] = label
					order = append(order, id.(string))
					if len(order) > 50 {
						for _, k := range order[:len(order)-50] {
							delete(n, k)
						}
					}
					meta.set("agentLabels", n)
				}
				break
			}
		}
	}
}

// sameObj is JavaScript's === for objects.
func sameObj(a, b any) bool {
	ma, ok1 := a.(M)
	mb, ok2 := b.(M)
	if ok1 && ok2 {
		if ma == nil || mb == nil {
			return ma == nil && mb == nil
		}
		return ptrOf(ma) == ptrOf(mb)
	}
	if ok1 || ok2 {
		return false
	}
	return a == b
}

// ---------- echoes ----------

var attachedRe = regexp.MustCompile(`\[(?:Image|File) attached: [^\]]+\]`)
var imageNRe = regexp.MustCompile(`\[Image #\d+\]`)

func normal(t any) string {
	s := ""
	if t != nil {
		s = jsString(t)
	}
	s = attachedRe.ReplaceAllString(s, "")
	s = imageNRe.ReplaceAllString(s, "")
	return jsTrim(collapse(s))
}

func isEcho(meta *Sess, text any) bool {
	now := float64(nowMs())
	echo := []any{}
	for _, x := range asArr(meta.get("echo")) {
		if now-mnum(x, "at") < 30*60_000 {
			echo = append(echo, x)
		}
	}
	said := normal(text)
	hit := false
	keep := []any{}
	for _, x := range echo {
		norm := mstr(x, "norm")
		match := false
		if norm != "" {
			match = strings.Contains(said, jsSliceTo(norm, 200))
		} else {
			match = said == ""
		}
		if match {
			hit = true
		} else {
			keep = append(keep, x)
		}
	}
	if !hit {
		meta.set("echo", echo)
		return false
	}
	meta.set("echo", keep)
	return true
}

// logSaid: log what a person said from the page (or Slack), and expect it back from the transcript.
func logSaid(meta *Sess, id any, text string, via string, images []any) {
	if via == "" {
		via = "web"
	}
	echo := append(append([]any{}, asArr(meta.get("echo"))...), M{"id": id, "norm": normal(text), "at": float64(nowMs())})
	if len(echo) > 50 {
		echo = echo[len(echo)-50:]
	}
	meta.set("echo", echo)
	meta.set("lastMine", true)
	e := M{"k": "user", "id": id, "via": via, "text": text}
	if len(images) > 0 {
		e["images"] = images
	}
	logEvents(meta, []any{e})
}

var bridgeTypedRe = regexp.MustCompile(`^(\[정정\] |\[새로고침\] |\[이전 대화에서 이어감 |지금까지의 대화를 이어받을 다음 세션이 읽을 SESSION\.md|Write SESSION\.md in the working folder now|Continue the work described in this handover)`)
var reviewLoopRe = regexp.MustCompile(`pr-review-loop`)
var roundRe = regexp.MustCompile(`ROUND_CLEAN|ROUND_ABORT`)
var familyRe = regexp.MustCompile(`(opus|sonnet|haiku|fable)`)

func family(m string) string {
	if x := familyRe.FindStringSubmatch(m); x != nil {
		return x[1]
	}
	return ""
}

// convert: transcript lines → events, taking the title and the model out as facts about the session.
func convert(meta *Sess, lines []string) []any {
	out := []any{}
	copied := copiedInFork(meta)
	for _, line := range lines {
		trackBackground(meta, line)
		if len(copied) > 0 {
			if u, ok := uuidOf(line); ok && copied[u] {
				continue
			}
		}
		meta.hasSilent = true
		opts := evOpts{cwd: meta.str("cwd"), home: meta.str("home"), silent: meta.silentTools, image: func(t, d any) any { return imageRef(meta.uid(), t, d, nil) }}
		for _, ea := range lineToEvents(line, opts) {
			e := asM(ea)
			k := mstr(e, "k")
			if k == "user" && isEcho(meta, e["text"]) {
				continue
			}
			// What the bridge itself typed into the session is not something the person said.
			if k == "user" && e["text"] == COMPACT_TEXT {
				continue
			}
			if k == "user" && bridgeTypedRe.MatchString(mstr(e, "text")) {
				continue
			}
			if k == "tool" {
				meta.openTools.Set(jsString(e["tool"]), true)
				meta.hasOpen = true
				if contains([]string{"Edit", "MultiEdit", "Write", "NotebookEdit"}, mstr(e, "name")) {
					meta.set("coding", true)
				}
				if e["name"] == "Skill" && reviewLoopRe.MatchString(mstr(e, "label")) {
					meta.set("reviewLoop", true)
				}
			} else if k == "tool_end" {
				meta.openTools.Delete(jsString(e["tool"]))
				if truthy(meta.get("reviewLoop")) && roundRe.MatchString(mstr(e, "text")) {
					meta.set("reviewLoop", false)
				}
			} else if k == "text" && truthy(meta.get("reviewLoop")) && roundRe.MatchString(mstr(e, "text")) {
				meta.set("reviewLoop", false)
			}
			if k == "text" && truthy(meta.get("reportAuto")) && REPORT_DONE_RE.MatchString(mstr(e, "text")) {
				meta.set("reportDeployed", true)
			}
			if k == "title" {
				if !truthy(meta.get("manualTitle")) {
					meta.set("title", e["title"])
				}
			} else if k == "model" {
				// The model actually answering differs in family from the one asked for: what was asked for is stale.
				lm := meta.str("launchModel")
				if lm != "" && family(lm) != "" && family(mstr(e, "model")) != "" && family(lm) != family(mstr(e, "model")) {
					meta.set("launchModel", "")
				}
				meta.set("model", e["model"])
			} else {
				out = append(out, e)
			}
		}
	}
	return out
}

// ---------- the events.jsonl an older server wrote (REQ-S-075) ----------

const EVENT_CACHE_MAX = 24

type evCache struct {
	size   int64
	ino    uint64
	rest   string
	events []any
}

var eventCache = newOMap[*evCache]()

func inoOf(st os.FileInfo) uint64 {
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		return uint64(s.Ino)
	}
	return 0
}

func readLegacyEvents(meta *Sess, keep bool) []any {
	file := eventsFile(meta)
	st, err := os.Stat(file)
	if err != nil {
		eventCache.Delete(file)
		return []any{}
	}
	hit, _ := eventCache.Get(file)
	if hit != nil && (hit.ino != inoOf(st) || st.Size() < hit.size) {
		hit = nil
	}
	if hit == nil {
		hit = &evCache{ino: inoOf(st), events: []any{}}
	}
	if st.Size() > hit.size {
		f, err := os.Open(file)
		if err == nil {
			buf := make([]byte, st.Size()-hit.size)
			_, _ = f.ReadAt(buf, hit.size)
			f.Close()
			text := hit.rest + string(buf)
			lines := strings.Split(text, "\n")
			hit.rest = lines[len(lines)-1]
			for _, l := range lines[:len(lines)-1] {
				if l == "" {
					continue
				}
				if v, err := parseJSON([]byte(l)); err == nil {
					hit.events = append(hit.events, v)
				}
			}
			hit.size = st.Size()
		}
	}
	if !keep && !eventCache.Has(file) {
		return hit.events
	}
	eventCache.Delete(file)
	eventCache.Set(file, hit)
	if eventCache.Len() > EVENT_CACHE_MAX {
		eventCache.Delete(eventCache.keys[0])
	}
	return hit.events
}

// fixOldSessions: sessions from before the event log start counting from nothing; lastAt worked out again once.
func fixOldSessions() {
	for _, meta := range sessions.Values() {
		if meta.get("seq") != nil || exists(eventsFile(meta)) {
			continue
		}
		meta.set("seq", 0.0)
		dirty.Set(meta.id(), true)
	}
	for _, meta := range sessions.Values() {
		if meta.get("lastAtV") == 2.0 {
			continue
		}
		func() {
			file := eventsFile(meta)
			st, err := os.Stat(file)
			if err != nil {
				return
			}
			size := st.Size()
			n := size
			if n > 256*1024 {
				n = 256 * 1024
			}
			f, err := os.Open(file)
			if err != nil {
				return
			}
			buf := make([]byte, n)
			_, _ = f.ReadAt(buf, size-n)
			f.Close()
			lines := strings.Split(string(buf), "\n")
			if n < size {
				lines = lines[1:]
			}
			tail := []any{}
			for _, l := range lines {
				if v, err := parseJSON([]byte(l)); err == nil {
					tail = append(tail, v)
				}
			}
			if at := movedAt(tail); truthy(at) {
				meta.set("lastAt", at)
			}
		}()
		meta.set("lastAtV", 2.0)
		dirty.Set(meta.id(), true)
	}
}

// ---------- usage statistics ----------

type prSearch struct {
	at   int64
	done chan struct{}
	prs  []any
	ok   bool
}

var prSearches = map[string]*prSearch{}
var prURLRe = regexp.MustCompile(`https://[\w.-]+/[\w.-]+/[\w.-]+/pull/\d+`)

func prStatsOf(uid string, days float64) M {
	got := prSearches[uid]
	if got == nil || nowMs()-got.at > 600_000 {
		hostID := ""
		for _, h := range hosts.Keys() {
			if mstr(hosts.Val(h), "uid") == uid && online(h) {
				hostID = h
				break
			}
		}
		if hostID == "" {
			return nil
		}
		got = &prSearch{at: nowMs(), done: make(chan struct{})}
		prSearches[uid] = got
		g := got
		goLocked("prsearch", func() {
			defer close(g.done)
			r := ask(hostID, M{"t": "prsearch"}, 120_000)
			if truthy(r["ok"]) {
				g.prs, g.ok = asArr(r["prs"]), r["prs"] != nil
			}
		})
	}
	await(func() { <-got.done })
	if !got.ok {
		if prSearches[uid] == got {
			delete(prSearches, uid)
		}
		return nil
	}
	prs := got.prs
	mine := map[string]bool{}
	for _, p := range prs {
		mine[jsString(mget(p, "url"))] = true
	}
	linked := map[string]bool{}
	for _, m := range sessions.Values() {
		if m.uid() != uid {
			continue
		}
		for _, u := range asArr(m.get("prLinks")) {
			if s, ok := u.(string); ok && mine[s] {
				linked[s] = true
			}
		}
		for _, e := range readEvents(m, true) {
			k := mstr(e, "k")
			if k == "user" || k == "text" {
				t := ""
				if x := mget(e, "text"); x != nil {
					t = jsString(x)
				}
				for _, u := range prURLRe.FindAllString(t, -1) {
					if mine[u] {
						linked[u] = true
					}
				}
			}
		}
	}
	out := prSummary(prs, float64(nowMs()), days)
	out["linked"] = float64(len(linked))
	return out
}

type statsHit struct {
	at    int64
	value M
}

var statsCache = newOMap[statsHit]()

func computeStats(uid string, days float64) M {
	key := uid + "|" + numStr(days)
	if hit, ok := statsCache.Get(key); ok && nowMs()-hit.at < 30_000 {
		return hit.value
	}
	value := computeStatsFresh(uid, days)
	statsCache.Set(key, statsHit{nowMs(), value})
	for _, k := range statsCache.Keys() {
		if nowMs()-statsCache.Val(k).at > 60_000 {
			statsCache.Delete(k)
		}
	}
	return value
}

var legacyStats = map[string]statsHit{}

func computeStatsFresh(uid string, days float64) M {
	now := float64(nowMs())
	list := []M{}
	for _, meta := range sessions.Values() {
		la := meta.get("lastAt")
		if la == nil {
			la = meta.get("updatedAt")
		}
		if meta.uid() != uid || jsNumber(la) < now-days*86_400_000 {
			continue
		}
		stats, _ := meta.get("stats").(M)
		if !truthy(meta.get("stats")) && !truthy(meta.get("agentLog")) && exists(eventsFile(meta)) {
			hit, ok := legacyStats[meta.id()]
			if ok && int64(now)-hit.at < 600_000 {
				stats = hit.value
			} else {
				stats = sessionStats(readLegacyEvents(meta, false), now)
				legacyStats[meta.id()] = statsHit{int64(now), stats}
			}
		}
		if stats != nil {
			list = append(list, M{"stats": stats, "cwd": meta.get("cwd"), "id": meta.id()})
		}
	}
	return addStats(list, days, now)
}

var _ = bufio.NewReader
var _ = bytes.NewReader
