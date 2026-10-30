package main

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var csCmdRe = re(`^(\d+):(\S+)\s*([\s\S]*)$`)
var ansiRe = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var trailWSRe = re(`(?m)\s+$`)

type csOptsCmd struct {
	via      any
	unlocked bool
	videos   []any
}

// cleanScreen: a terminal's text without its colours, trailing blanks, the last 60 lines.
func cleanScreen(t any, empty string) string {
	s := ""
	if t != nil {
		s = jsString(t)
	}
	s = ansiRe.ReplaceAllString(s, "")
	s = trailWSRe.ReplaceAllString(s, "")
	lines := strings.Split(jsTrim(s), "\n")
	if len(lines) > 60 {
		lines = lines[len(lines)-60:]
	}
	out := strings.Join(lines, "\n")
	if out == "" {
		return empty
	}
	return out
}

// csCommand: a command as a Slack card or a `:` line sends it: `<pid>:<what> [arguments]`. Returns the note to show.
func csCommand(uid string, value any, opts csOptsCmd) string {
	v := ""
	if value != nil {
		v = jsString(value)
	}
	m := csCmdRe.FindStringSubmatch(v)
	var meta *Sess
	if m != nil {
		meta = byPid(uid, m[1])
	}
	if meta == nil {
		refuse(400, "이미 끝난 세션이에요")
	}
	if truthy(meta.get("lock")) && !opts.unlocked {
		refuse(423, LOCKED)
	}
	seatGuard(meta, opts.via)
	cmd, arg := m[2], jsTrim(m[3])
	op := func(name string, data any) M { return sessionOp(uid, meta, name, data, "", "") }
	st := meta.state()
	switch {
	case cmd == "card":
		parts := wsRun.Split(arg, -1)
		card, n := parts[0], ""
		if len(parts) > 1 {
			n = parts[1]
		}
		if n == "esc" || n == "enter" {
			op("answer", M{"card": card, "n": n})
		} else {
			op("answer", M{"card": card, "n": jsNumber(n)})
		}
	case cmd == "sendnow" || cmd == "esc":
		op(cmd, nil)
	case cmd == "dropheld":
		op("dropheld", M{})
	case cmd == "continue":
		csSend(uid, meta, "계속해", []any{}, nil, opts)
	case cmd == "refresh":
		when := "now"
		if arg == "later" || arg == "cancel" {
			when = arg
		}
		op("refresh", M{"when": when})
	case cmd == "exit":
		op("close", M{})
	case cmd == "status":
		op("report", M{})
		st = meta.state()
		head := "🟢 대기"
		if st["phase"] == "busy" {
			head = "⏳ 작업 중"
		} else if st["phase"] == "waiting" {
			head = "⏸ 응답 대기"
		}
		model := meta.str("launchModel")
		if model == "" {
			model = meta.str("model")
		}
		if model == "" {
			model = "?"
		}
		parts := []string{head, "모델 " + model}
		if truthy(st["effort"]) {
			parts = append(parts, "effort "+jsString(st["effort"]))
		}
		if truthy(st["mode"]) {
			parts = append(parts, "권한 "+jsString(st["mode"]))
		}
		if truthy(st["context"]) {
			parts = append(parts, "컨텍스트 "+jsString(st["context"]))
		}
		logEvents(meta, []any{M{"k": "line", "text": strings.Join(parts, " · ")}})
	case cmd == "lightfork":
		// It takes minutes: the press is answered now, and a failure is said in the conversation when it is known.
		goLocked("lightfork", func() {
			var r M
			if err := try(func() { r = op("lightfork", M{"mode": arg}) }); err != nil {
				logEvents(meta, []any{M{"k": "line", "text": "❌ 가벼운 복제로 새 세션을 열지 못했어요. " + err.Error()}})
				return
			}
			if !truthy(r["ok"]) {
				return
			}
			// The work goes on in the new session: the original is put to rest.
			meta.set("resting", true)
			touch(meta)
			broadcastState(uid)
		})
		if arg == "cut" {
			return "앞부분만 넘겨요"
		}
		md := meta.str("mdFile")
		if md == "" {
			md = mstr(st, "mdFile")
		}
		if md == "" {
			md = "SESSION.md"
		}
		return "가벼운 복제를 시작했어요. 이 세션이 " + md + " 를 쓰고 나면 새 세션이 떠요"
	case cmd == "auto":
		op("settings", M{"autoAllow": arg == "on"})
		if arg == "on" {
			return "전부 허용을 켰어요"
		}
		return "전부 허용을 껐어요"
	case cmd == "rest":
		op("settings", M{"resting": arg == "on"})
		if arg == "on" {
			return "휴면으로 뒀어요"
		}
		return "휴면을 풀었어요"
	case cmd == "mode" && arg == "autoAllow":
		op("settings", M{"autoAllow": true})
		return "안전한 전부 허용을 켰어요"
	case cmd == "mode" && arg == "allowAll":
		op("settings", M{"autoAllow": true, "allowAll": true})
		return "전부 허용을 켰어요 · 위험한 호출도 묻지 않아요"
	case cmd == "model" || cmd == "effort" || cmd == "mode":
		if cmd == "mode" && (truthy(st["autoAllow"]) || truthy(meta.get("autoAllow"))) {
			op("settings", M{"autoAllow": false})
		}
		op("setting", M{"kind": cmd, "value": arg})
		if cmd == "mode" {
			return "권한 모드를 바꿨어요"
		}
		return "눌렀어요"
	case cmd == "compact":
		if !truthy(st["alive"]) || st["phase"] != "idle" {
			refuse(409, "쉬고 있는 세션만 압축할 수 있어요")
		}
		sessBefore("session.do", meta, kv{"do", "compact"})
		toHost(liveHost(meta), M{"t": "send", "sid": meta.id(), "id": uuidv4(), "text": COMPACT_TEXT})
		sessAfter("session.do", meta, kv{"do", "compact"})
		logEvents(meta, []any{M{"k": "notice", "tone": "info", "text": "🗜️ 컨텍스트 압축을 요청했어요. 끝나면 이 세션에서 그대로 이어가요"}})
		return "압축을 요청했어요"
	case cmd == "screen":
		r := ask(liveHost(meta), M{"t": "screen", "sid": meta.id()}, 15_000)
		logEvents(meta, []any{M{"k": "local", "text": cleanScreen(r["text"], "(빈 화면)")}})
	default:
		refuse(400, "알 수 없는 명령이에요")
	}
	return "눌렀어요"
}

var btwRe = re(`^[/:]btw\s+([\s\S]+)`)
var colonRe = re(`^:([a-z]+)(?:\s+([\s\S]*))?$`)
var digitsRe = regexp.MustCompile(`^\d+$`)

var csColonCmds = []string{"esc", "sendnow", "dropheld", "refresh", "exit", "status", "lightfork", "compact", "auto", "rest", "screen", "model", "effort", "mode", "continue"}

// csSend: a message from the page: a side question goes its own way, everything else is sent as it is.
func csSend(uid string, meta *Sess, text string, images []any, via any, opts csOptsCmd) M {
	if truthy(meta.get("lock")) && !opts.unlocked {
		refuse(423, LOCKED)
	}
	// The commands below come from the same place as the message.
	if via != nil {
		opts.via = via
	}
	seatGuard(meta, opts.via)
	t := jsTrim(text)
	btw := btwRe.FindStringSubmatch(t)
	// A line that starts with ":" is a command for the bridge (REQ-F-057).
	var colon []string
	if btw == nil {
		colon = colonRe.FindStringSubmatch(t)
	}
	if colon != nil {
		cmd, arg := colon[1], jsTrim(colon[2])
		pid := numStr(numOr0(csIds(meta).get("pid")))
		switch {
		case cmd == "rename":
			if arg == "" {
				refuse(400, "이름이 비어 있어요")
			}
			sessionOp(uid, meta, "settings", M{"title": arg}, "", "")
			logEvents(meta, []any{M{"k": "line", "text": "✏️ 이름: *" + jsSliceTo(arg, 80) + "*"}})
		case cmd == "retract":
			sessionOp(uid, meta, "retract", M{}, "", "")
		case cmd == "answer":
			card := asM(meta.get("card"))
			if !truthy(card["open"]) || !digitsRe.MatchString(arg) {
				refuse(400, "답할 질문이 없거나 번호가 아니에요. 예: :answer 2")
			}
			csCommand(uid, pid+":card "+jsString(card["id"])+" "+arg, opts)
		case cmd == "kill":
			sessionOp(uid, meta, "close", M{}, "", "")
		case cmd == "sudo" || cmd == "root":
			sudoCommand(uid, meta, arg, opts)
		case contains(csColonCmds, cmd):
			csCommand(uid, pid+":"+cmd+" "+arg, opts)
		default:
			refuse(400, "모르는 명령이에요: :"+cmd+". 쓸 수 있는 것: :status :screen :esc :sendnow :dropheld :refresh :retract :rename 이름 :answer 번호 :auto on|off :model 값 :effort 값 :mode 값 :lightfork :compact :rest :kill :btw 질문 :sudo 명령")
		}
		return M{"ok": true}
	}
	if btw == nil {
		data := M{"text": text, "images": images, "via": via}
		if images == nil {
			delete(data, "images")
		}
		if via == nil {
			delete(data, "via")
		}
		if len(opts.videos) > 0 {
			data["videos"] = opts.videos
		}
		return sessionOp(uid, meta, "send", data, "", "")
	}
	id := uuidv4()
	q := jsTrim(btw[1])
	logEvents(meta, []any{M{"k": "side", "id": id, "q": q}})
	goLocked("btw", func() {
		var r M
		if err := try(func() { r = sessionOp(uid, meta, "btw", M{"text": q}, "", "") }); err != nil {
			logEvents(meta, []any{M{"k": "side", "id": id, "q": q, "update": true, "error": err.Error()}})
			return
		}
		e := M{"k": "side", "id": id, "q": q, "update": true}
		if truthy(r["ok"]) {
			e["answer"] = r["answer"]
		} else {
			er := r["error"]
			if !truthy(er) {
				er = "답을 화면에서 읽지 못했어요. 화면을 확인하세요"
			}
			e["error"] = er
		}
		logEvents(meta, []any{e})
	})
	return M{"ok": true}
}

// ---------- plugins ----------
// What a person added to their own bridge. A plugin is lent these calls and nothing else: it acts as that person.

var pluginCache = map[string]M{}

func pluginsFile(uid string) string { return filepath.Join(userDir(uid), "plugins.json") }

var plug *Plugins

func setupPlugins() {
	plug = newPlugins(pluginDeps{
		load: func(uid string) M {
			if p, ok := pluginCache[uid]; ok {
				return p
			}
			p, _ := readJSON(pluginsFile(uid), M{}).(M)
			if p == nil {
				p = M{}
			}
			pluginCache[uid] = p
			return p
		},
		store: func(uid string, all M) {
			mkdirAll(userDir(uid))
			writeJson(pluginsFile(uid), all)
		},
		changed: func(uid string) { broadcastState(uid) },
		host:    func(uid string) PluginHost { return &bridgeHost{uid: uid} },
	})
}

// bridgeHost is what a plugin may call, as its person.
type bridgeHost struct{ uid string }

func (h *bridgeHost) Origin() string {
	if ORIGIN != "" {
		return ORIGIN
	}
	return "http://localhost:" + itoa(PORT)
}

func (h *bridgeHost) Code() string { return randHex(16) }

func (h *bridgeHost) Sessions() []any { return csRows(h.uid) }

func (h *bridgeHost) Find(thread string) M {
	if m := byThread(h.uid, thread); m != nil {
		return csRow(m)
	}
	return nil
}

func (h *bridgeHost) Command(value string) (out string) {
	withBy("slack", func() { out = csCommand(h.uid, value, csOptsCmd{via: "slack"}) })
	return
}

// Seat: where the session is driven from, and the page to go to for it.
func (h *bridgeHost) Seat(thread string) M {
	meta := byThread(h.uid, thread)
	if meta == nil {
		return nil
	}
	return M{"where": seatOf(meta), "link": sessionLink(meta), "closed": truthy(meta.get("closed"))}
}

// Summary: what a thread says about a session when it comes in from the bridge.
func (h *bridgeHost) Summary(thread string) M {
	meta := byThread(h.uid, thread)
	if meta == nil {
		return nil
	}
	evs := readEvents(meta, true)
	if len(evs) > 400 {
		evs = evs[len(evs)-400:]
	}
	var said M
	for _, e := range evs {
		if mstr(e, "k") == "text" && truthy(mget(e, "text")) {
			said = asM(e)
		}
	}
	var last any
	if said != nil {
		last = said["text"]
	} else if truthy(meta.get("lastMine")) {
		last = ""
	} else {
		last = meta.get("last")
		if last == nil {
			last = ""
		}
	}
	var hn any = ""
	if hh, ok := hosts.Get(meta.host()); ok && hh["name"] != nil {
		hn = hh["name"]
	}
	cwd := tilde(meta)
	if cwd == nil {
		cwd = ""
	}
	return M{"title": strOr(meta.get("title"), ""), "host": hn, "cwd": cwd, "last": last, "link": sessionLink(meta)}
}

// SeatUrl: a thread's address once it is known: the session page links to it.
func (h *bridgeHost) SeatUrl(thread string, u any) {
	meta := byThread(h.uid, thread)
	s, ok := u.(string)
	if meta == nil || seatOf(meta) != "slack" || !ok {
		return
	}
	seat := shallow(asM(meta.get("seat")))
	seat["url"] = jsSliceTo(s, 500)
	meta.set("seat", seat)
	touch(meta)
	broadcastState(h.uid)
}

func (h *bridgeHost) MoveTo(thread string, to string) (out M) {
	withBy("slack", func() { out = h.moveTo(thread, to) })
	return
}

func (h *bridgeHost) moveTo(thread string, to string) M {
	meta := byThread(h.uid, thread)
	if meta == nil {
		refuse(400, "세션을 찾지 못했어요")
	}
	return moveSeat(h.uid, meta, to)
}

func (h *bridgeHost) Send(thread string, text string, images []any) (out M) {
	meta := byThread(h.uid, thread)
	if meta == nil || truthy(meta.get("closed")) {
		refuse(400, "이미 끝난 세션이에요")
	}
	if images == nil {
		images = []any{}
	}
	withBy("slack", func() { out = csSend(h.uid, meta, text, images, "slack", csOptsCmd{}) })
	return
}

// Start: on the main Mac when it is connected, else the first connected one, in the folder set for that Mac.
func (h *bridgeHost) Start(prompt string, cwd any, places string) M {
	ids := []string{}
	for _, id := range hosts.Keys() {
		if mstr(hosts.Val(id), "uid") == h.uid && online(id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		refuse(400, "연결된 맥이 없어요. 맥의 브라우저에서 Agent Bridge 를 열어 두세요.")
	}
	if places == "" {
		places = "{}"
	}
	pl, _ := parseJSON([]byte(places))
	plm := asM(pl)
	hostID := ids[0]
	if s, ok := plm["main"].(string); ok && contains(ids, s) {
		hostID = s
	}
	dir := cwd
	if d, ok := mget(plm["dirs"], hostID).(string); ok && d != "" {
		dir = d
	}
	req := internalReq("POST", M{"hostId": hostID, "cwd": dir, "prompt": prompt, "via": "slack", "create": true})
	res := newRes(req)
	u := mustURL("http://x/api/sessions")
	req.URL = u
	withBy("slack", func() { api(req, res, u, h.uid) })
	v, err := parseJSON(res.body)
	if err != nil {
		panic(err)
	}
	s, _ := sessions.Get(mstr(v, "id"))
	if s == nil {
		throw("Cannot read properties of undefined (reading 'thread')")
	}
	return M{"thread": csIds(s).get("thread")}
}

// tilde: a session's folder the short way: the home folder as ~.
func tilde(meta *Sess) any {
	home := meta.str("home")
	if home == "" {
		home = mstr(hosts.Val(meta.host()), "home")
	}
	cwd, ok := meta.get("cwd").(string)
	if home != "" && ok && (cwd == home || strings.HasPrefix(cwd, home+"/")) {
		return "~" + cwd[len(home):]
	}
	return meta.get("cwd")
}

// seenJustNow: the same thing asked twice within a moment is done once.
var recentKeys = newOMap[int64]()

func seenJustNow(key string, ms int64) bool {
	if ms == 0 {
		ms = 1500
	}
	now := nowMs()
	for _, k := range recentKeys.Keys() {
		if now-recentKeys.Val(k) > ms {
			recentKeys.Delete(k)
		}
	}
	if recentKeys.Has(key) {
		return true
	}
	recentKeys.Set(key, now)
	return false
}

// prStates: a PR's state as gh last told it, by its address.
type prState struct {
	at int64
	pr M
}

var prStates = map[string]prState{}

const PR_PAGE = 8

// sessionLinks: the folder's own pull requests, then the ones the conversation mentions, most recent first.
func sessionLinks(meta *Sess, limit int) M {
	own := []any{}
	for _, x := range asArr(mget(meta.get("folder"), "repos")) {
		pr := mobj(x, "pr")
		if !truthy(mget(x, "pr")) {
			continue
		}
		own = append(own, M{"url": pr["url"], "label": "#" + jsString(pr["number"]) + " " + jsString(pr["title"]), "state": pr["state"], "number": pr["number"]})
	}
	mentioned := []any{}
	more := 0
	if online(meta.host()) {
		evs := readEvents(meta, true)
		if len(evs) > 2000 {
			evs = evs[len(evs)-2000:]
		}
		found := []string{}
		for _, e := range evs {
			k := mstr(e, "k")
			if k == "text" || k == "user" {
				t := ""
				if x := mget(e, "text"); x != nil {
					t = jsString(x)
				}
				found = append(found, prURLRe.FindAllString(t, -1)...)
			}
		}
		seen := map[string]bool{}
		urls := []string{}
		add := func(u string) {
			if seen[u] {
				return
			}
			seen[u] = true
			for _, o := range own {
				if mget(o, "url") == u {
					return
				}
			}
			urls = append(urls, u)
		}
		for i := len(found) - 1; i >= 0; i-- {
			add(found[i])
		}
		for _, u := range asArr(meta.get("prLinks")) {
			add(jsString(u))
		}
		n := limit
		if n > 100 {
			n = 100
		}
		if n < 1 {
			n = 1
		}
		want := urls
		if len(want) > n {
			want = want[:n]
		}
		more = len(urls) - len(want)
		stale := []string{}
		for _, u := range want {
			if !(nowMs()-prStates[u].at < 60_000) {
				stale = append(stale, u)
			}
		}
		fs := []func(){}
		for i := 0; i < len(stale); i += PR_PAGE {
			end := i + PR_PAGE
			if end > len(stale) {
				end = len(stale)
			}
			part := stale[i:end]
			fs = append(fs, func() {
				r := ask(meta.host(), M{"t": "prstates", "urls": anyList(part)}, 15_000)
				if truthy(r["ok"]) {
					for _, pr := range asArr(r["prs"]) {
						prStates[jsString(mget(pr, "url"))] = prState{nowMs(), asM(pr)}
					}
				}
			})
		}
		if len(fs) > 0 {
			parallel(fs...)
		}
		for _, u := range want {
			x := prStates[u].pr
			if x == nil {
				continue
			}
			label := "#" + jsString(x["number"])
			if truthy(x["title"]) {
				label += " " + jsString(x["title"])
			}
			mentioned = append(mentioned, M{"url": x["url"], "label": label, "state": x["state"], "number": x["number"]})
		}
	}
	return M{"prs": append(own, mentioned...), "more": float64(more), "threads": []any{}}
}

func linksLimit(q map[string][]string) int {
	if v, ok := q["limit"]; ok && len(v) > 0 {
		if n := jsNumber(v[0]); n == n && n != 0 {
			return int(n)
		}
	}
	return PR_PAGE
}

var _ = time.Second
