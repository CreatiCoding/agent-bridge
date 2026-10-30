package main

import (
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// ---------- store ----------

var (
	users    *OMap[M] // uid -> { login, name, avatar }
	logins   *OMap[M] // sha256(token) -> { uid, exp }
	access   *OMap[M] // lowercased login -> { login, name, avatar, status, firstAt, lastAt, attempts, decidedBy, decidedAt }
	pins     M        // lowercased GitHub login -> gh<id> (login-pin, R1-L1)
	hosts    *OMap[M] // hostId -> { uid, name, home, lastSeen }
	sessions = newOMap[*Sess]()
	dirty    = newOMap[bool]()
)

// Sess is a session's meta as one object (unknown keys kept), with the in-memory Sets beside it.
type Sess struct {
	m           M
	openTools   *OMap[bool]
	silentTools *OMap[bool]
	cardIndex   *OMap[any]
	cardBuilt   bool
	// Whether the Node server's meta had its openTools / silentTools Set yet (a Set is written as {} in the state):
	// a session read from disk has both; a new one gets them at its first transcript line and its first tool.
	hasOpen, hasSilent bool
}

func (s *Sess) id() string  { return mstr(s.m, "id") }
func (s *Sess) uid() string { return mstr(s.m, "uid") }
func (s *Sess) host() string {
	return mstr(s.m, "hostId")
}
func (s *Sess) str(k string) string { return mstr(s.m, k) }
func (s *Sess) get(k string) any    { return s.m[k] }
func (s *Sess) set(k string, v any) { s.m[k] = v }
func (s *Sess) del(k string)        { delete(s.m, k) }
func (s *Sess) state() M {
	st, _ := s.m["state"].(M)
	if st == nil {
		st = noState()
		s.m["state"] = st
	}
	return st
}

func userDir(uid string) string { return filepath.Join(DATA, "u", uid) }

func sessionDir(meta *Sess) string { return filepath.Join(userDir(meta.uid()), "s", meta.id()) }

// transcriptFile: the copy of the conversation Claude Code would resume from (`/clear` starts a new one).
func transcriptFile(meta *Sess) string {
	conv := meta.str("conv")
	if conv == "" || conv == meta.id() {
		return filepath.Join(sessionDir(meta), "transcript.jsonl")
	}
	return filepath.Join(sessionDir(meta), "transcript-"+conv+".jsonl")
}

func eventsFile(meta *Sess) string { return filepath.Join(sessionDir(meta), "events.jsonl") }

// noState: what is known about a session whose agent is not reporting.
func noState() M {
	return M{"alive": false, "phase": "ended", "waiting": nil, "waitingSince": nil, "held": []any{}, "tool": nil, "tools": 0.0, "turnAt": nil, "mode": nil, "effort": nil, "context": nil, "autoAllow": false, "allowAll": false}
}

// newSess makes a session from saved meta, with the in-memory parts fresh.
func newSess(meta M) *Sess {
	m := shallow(meta)
	m["state"] = noState()
	m["moving"] = nil
	m["card"] = nil
	m["writing"] = ""
	return &Sess{m: m, openTools: newOMap[bool](), silentTools: newOMap[bool](), cardIndex: newOMap[any](), hasOpen: true, hasSilent: true}
}

var noNameRe = regexp.MustCompile(`^(\(제목 없음\)|\[Request interrupted by user(?: for tool use)?\])$`)

func loadStore() {
	users = readOMap(filepath.Join(DATA, "users.json"))
	logins = readOMap(filepath.Join(DATA, "logins.json"))
	access = readOMap(filepath.Join(DATA, "access.json"))
	pins = func() M {
		file := filepath.Join(DATA, "login-pins.json")
		usersRaw, _ := readJSON(filepath.Join(DATA, "users.json"), M{}).(M)
		if !exists(file) {
			return loadPins(nil, usersRaw)
		}
		// There but unreadable: kept aside, and made again from users.json (R4-M2, R8-L2).
		if saved := readJSON(file, undefinedV); saved != undefinedV {
			return loadPins(saved, M{})
		}
		errorLine("login-pins.json 을 읽지 못해 login-pins.json.broken 으로 옮기고 users.json 으로 다시 만듭니다")
		_ = os.Rename(file, file+".broken")
		return loadPins(nil, usersRaw)
	}()
	hosts = readOMap(filepath.Join(DATA, "hosts.json"))
	uids, _ := os.ReadDir(filepath.Join(DATA, "u"))
	for _, u := range uids {
		dir := filepath.Join(DATA, "u", u.Name(), "s")
		sids, _ := os.ReadDir(dir)
		for _, sd := range sids {
			sid := sd.Name()
			meta, ok := readJSON(filepath.Join(dir, sid, "meta.json"), nil).(M)
			if !ok || meta == nil {
				continue
			}
			if !truthy(meta["manualTitle"]) && noNameRe.MatchString(strOr(meta["title"], "")) {
				meta["title"] = ""
			}
			if noNameRe.MatchString(strOr(meta["preview"], "")) {
				meta["preview"] = ""
			}
			if !cfgOn("retention.previews") { // turned off: the words kept before go too (REQ-F-812)
				meta["preview"], meta["last"] = "", ""
			}
			// A remote address kept with a token in it loses the token at once (REQ-S-073); note contents an older
			// server kept wait aside for the operator (REQ-S-075).
			if f, ok := meta["folder"].(M); ok {
				files, _ := f["files"].(M)
				if len(files) > 0 {
					lg, _ := meta["_legacy"].(M)
					lg = shallow(lg)
					lg["folderFiles"] = files
					meta["_legacy"] = lg
				}
				clean := cleanFolder(f)
				if jsonStr(clean) != jsonStr(f) {
					meta["folder"] = clean
					dirty.Set(sid, true)
				}
			}
			sessions.Set(sid, newSess(meta))
		}
	}
}

// undefinedV stands for `undefined` where a fallback must differ from every JSON value.
var undefinedV = &struct{ x int }{}

var globalsDirty bool

func touchGlobals() { globalsDirty = true }

func touch(meta *Sess) {
	meta.set("updatedAt", float64(nowMs()))
	dirty.Set(meta.id(), true)
	broadcastState(meta.uid())
}

var metaDrop = []string{"state", "moving", "card", "writing", "cardIndex", "echo", "openTools", "silentTools", "logSize", "cardWant", "last", "localImgs"}

// savedMeta is what meta.json holds: the in-memory parts left out; a locked session keeps no first words and no
// title it was not given by hand (REQ-S-070).
func savedMeta(meta *Sess) M {
	out := shallow(meta.m)
	for _, k := range metaDrop {
		delete(out, k)
	}
	if truthy(meta.m["lock"]) {
		delete(out, "preview")
		if !truthy(meta.m["manualTitle"]) {
			delete(out, "title")
		}
	}
	return out
}

// flushToDisk: the periodic sync. Transcript lines are appended as they arrive; everything else lands here.
func flushToDisk() {
	if frozen {
		return
	}
	for _, sid := range dirty.Keys() {
		if meta, ok := sessions.Get(sid); ok {
			writeJson(filepath.Join(sessionDir(meta), "meta.json"), savedMeta(meta))
		}
	}
	dirty.Clear()
	if globalsDirty {
		// The demo account and its Mac are made again at every start: never written.
		var us orderedObj
		for _, id := range users.Keys() {
			if !isDemoUid(id) {
				us = append(us, kv{id, users.Val(id)})
			}
		}
		writeJson(filepath.Join(DATA, "users.json"), us)
		writeJson(filepath.Join(DATA, "logins.json"), logins)
		// A Mac's Claude account e-mail and plan are shown while it is connected and never written (REQ-S-074).
		var hs orderedObj
		for _, id := range hosts.Keys() {
			if isDemoHost(id) {
				continue
			}
			h := shallow(hosts.Val(id))
			if accts, ok := h["accounts"].([]any); ok {
				list := make([]any, 0, len(accts))
				for _, a := range accts {
					am := shallow(asM(a))
					delete(am, "email")
					delete(am, "plan")
					list = append(list, am)
				}
				h["accounts"] = list
			}
			if info, ok := h["info"].(M); ok {
				i := shallow(info)
				delete(i, "hostname")
				h["info"] = i
			}
			hs = append(hs, kv{id, h})
		}
		writeJson(filepath.Join(DATA, "hosts.json"), hs)
		writeJson(filepath.Join(DATA, "access.json"), access)
		writeJson(filepath.Join(DATA, "login-pins.json"), pins)
		globalsDirty = false
	}
}

func asM(v any) M {
	if oo, ok := v.(orderedObj); ok {
		m := make(M, len(oo))
		for _, e := range oo {
			m[e.K] = e.V
		}
		return m
	}
	m, _ := v.(M)
	if m == nil {
		return M{}
	}
	return m
}

func asArr(v any) []any {
	a, _ := v.([]any)
	return a
}

func startFlushing() {
	setInterval(META_FLUSH_MS*time.Millisecond, flushToDisk)
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-ch
		mu.Lock()
		flushToDisk()
		lin := handover.linger()
		mu.Unlock()
		if lin == 0 {
			os.Exit(0)
		}
		name := "SIGTERM"
		if sig == syscall.SIGINT {
			name = "SIGINT"
		}
		// A deploy is swapping this server out: requests still sent here go on to the new one for a few seconds more.
		logLine("handover: " + name + " while a newer server takes over; staying " + itoa(lin) + " ms for the requests still arriving")
		time.Sleep(ms(int64(lin)))
		os.Exit(0)
	}()
}

// ---------- what a person arranged: groups, order, the default prompt ----------

var prefsCache = map[string]M{}

func prefsFile(uid string) string { return filepath.Join(userDir(uid), "prefs.json") }

const BUILTIN_DEFAULT_PROMPT = "나는 한국어를 읽어. 페이지에 보이는 글은 모두 한국어로 써 줘: 최종 답, 도구를 쓰는 사이사이 쓰는 짧은 설명까지. 코드·명령·파일 경로·식별자·인용한 출력은 원래 그대로 둬."

func sysPromptOf(uid string) string {
	if p := jsTrim(strOr(prefsOf(uid)["defaultPrompt"], "")); p != "" {
		return p
	}
	return BUILTIN_DEFAULT_PROMPT
}

var LAUNCH_EFFORTS = []string{"low", "medium", "high", "xhigh", "max"}
var LAUNCH_MODES = []string{"default", "acceptEdits", "plan", "auto", "autoAllow", "allowAll"}

// startMode: the mode claude is started with, and whether 전부 허용 is turned on once it is up. autoAllow is
// 안전한 전부 허용 (risky calls still asked, REQ-F-759); allowAll is 전부 허용 that asks nothing (REQ-F-796).
func startMode(mode string) (string, bool) {
	if !modeOk(mode) {
		logLine("features.permissionModes 밖의 모드 " + mode + " 를 default 로 낮춤")
		mode = "default"
	}
	if mode == "autoAllow" || mode == "allowAll" {
		return "default", true
	}
	return mode, false
}

// modeOk: the mode is in features.permissionModes (REQ-F-812). "" is the Mac's own default, taken as default.
func modeOk(mode string) bool {
	return mode == "" || contains(cfgGet("features.permissionModes").([]string), mode)
}

// allowMode: the launch mode that 전부 허용 with or without asking stands for.
func allowMode(all bool) string {
	if all {
		return "allowAll"
	}
	return "autoAllow"
}

// featuresOf: the feature flags as /api/me gives them (REQ-F-812). background is read-only here (step 3 turns it
// off with auth.headerOnly); it is not a bridge.yaml key.
func featuresOf() M {
	out := M{"background": !headerOnly()} // read-only: the headless browser cannot pass the proxy (REQ-F-816)
	for _, f := range []string{"sessionMove", "webpush", "voice", "preview", "skills", "slack", "remoteKeys"} {
		out[f] = cfgOn("features." + f)
	}
	modes := []any{}
	for _, m := range cfgGet("features.permissionModes").([]string) {
		modes = append(modes, m)
	}
	out["permissionModes"] = modes
	return out
}

// FEATURE_OFF: the refusal of an API whose feature bridge.yaml turned off (REQ-F-812).
const FEATURE_OFF = "이 서버에서 꺼진 기능이에요"

// needFeature refuses with 403 when features.<name> is off.
func needFeature(name string) {
	if !cfgOn("features." + name) {
		refuse(403, FEATURE_OFF)
	}
}

func turnOnAutoAllow(meta *Sess, all bool) {
	if !modeOk(allowMode(all)) {
		return // outside permissionModes: lowered to default, which asks (REQ-F-812)
	}
	meta.set("autoAllow", true)
	meta.set("allowAll", all)
	toHost(meta.host(), M{"t": "set", "sid": meta.id(), "autoAllow": true, "allowAll": all})
}

// allowModeOf: a session's permission policy as a launch mode ("" when it asks as the terminal does).
func allowModeOf(meta *Sess) string {
	if !truthy(meta.get("autoAllow")) {
		return ""
	}
	if truthy(meta.get("allowAll")) {
		return "allowAll"
	}
	return "autoAllow"
}

// inheritAllow: a copy keeps the original's 전부 허용 as it is (REQ-F-796); an original that asks leaves it to the
// person's defaults.
func inheritAllow(cp, from *Sess, uid string) {
	if m := allowModeOf(from); m != "" {
		turnOnAutoAllow(cp, m == "allowAll")
	} else if launchAutoAllow(uid) {
		turnOnAutoAllow(cp, launchOf(uid)["mode"] == "allowAll")
	}
}

var launchModelRe = regexp.MustCompile(`^[\w.\[\]-]{1,60}$`)

func strField(v any, k string) string {
	x := mget(v, k)
	if x == nil {
		return ""
	}
	return jsString(x)
}

func cleanLaunch(v any) M {
	model := jsTrim(strField(v, "model"))
	effort := jsTrim(strField(v, "effort"))
	mode := jsTrim(strField(v, "mode"))
	if !launchModelRe.MatchString(model) {
		model = ""
	}
	if !contains(LAUNCH_EFFORTS, effort) {
		effort = ""
	}
	if !contains(LAUNCH_MODES, mode) || !modeOk(mode) {
		mode = ""
	}
	fb := cleanFolderBase(mget(v, "folderBase"))
	if fb == "" {
		fb = FOLDER_BASE
	}
	fng := folderPart(mget(v, "folderNoGroup"))
	if fng == "" {
		fng = FOLDER_NO_GROUP
	}
	return M{"model": model, "effort": effort, "mode": mode, "folderBase": fb, "folderNoGroup": fng}
}

func launchOf(uid string) M { return cleanLaunch(prefsOf(uid)["launch"]) }

var ICON_SIZES = []float64{14, 16, 18, 20, 22, 24}
var ICON_FILLS = []float64{0.87, 1, 1.09, 1.17}

func cleanIcons(v any) M {
	size, fill := 18.0, 1.0
	if s := jsNumber(mget(v, "size")); contains(ICON_SIZES, s) {
		size = s
	}
	if f := jsNumber(mget(v, "fill")); contains(ICON_FILLS, f) {
		fill = f
	}
	return M{"size": size, "fill": fill}
}

var VOICE_MODELS = []string{"large-v3-turbo-q5_0", "large-v3-turbo", "medium", "small", "base"}
var VOICE_LANGS = []string{"ko", "en", "auto"}

func cleanVoice(v any) M {
	model := VOICE_MODELS[0]
	if s, ok := mget(v, "model").(string); ok && contains(VOICE_MODELS, s) {
		model = s
	}
	lang := "ko"
	if s, ok := mget(v, "language").(string); ok && contains(VOICE_LANGS, s) {
		lang = s
	}
	return M{
		"on":       mget(v, "on") == true,
		"model":    model,
		"language": lang,
		"denoise":  mget(v, "denoise") != false,
		"tidy":     mget(v, "tidy") != false,
		"terms":    jsSliceTo(strField(v, "terms"), 4000),
	}
}

// cleanVoiceHost: one Mac's own choice over the account's (REQ-F-758): ” follows the account.
func cleanVoiceHost(v any) M {
	model := ""
	if s, ok := mget(v, "model").(string); ok && contains(VOICE_MODELS, s) {
		model = s
	}
	return M{"model": model}
}

// launchOver: the defaults that are set, and only those.
func launchOver(uid string) M {
	l := launchOf(uid)
	o := M{}
	for _, k := range []string{"model", "effort", "mode", "folderBase", "folderNoGroup"} {
		if truthy(l[k]) {
			o[k] = l[k]
		}
	}
	if m, ok := o["mode"].(string); ok && m != "" {
		o["mode"], _ = startMode(m)
	}
	return o
}

func launchAutoAllow(uid string) bool {
	m := launchOf(uid)["mode"]
	return m == "autoAllow" || m == "allowAll"
}

func prefsOf(uid string) M {
	if p, ok := prefsCache[uid]; ok {
		return p
	}
	p := M{"groups": []any{}, "loose": []any{}, "defaultPrompt": ""}
	if saved, ok := readJSON(prefsFile(uid), M{}).(M); ok {
		for k, v := range saved {
			p[k] = v
		}
	}
	prefsCache[uid] = p
	return p
}

func savePrefs(uid string) {
	writeJson(prefsFile(uid), prefsOf(uid))
	broadcastState(uid)
}

// githubLoginOf: the GitHub login of a person signed in with GitHub; "" for Apple and demo accounts.
func githubLoginOf(uid string) any {
	u, ok := users.Get(uid)
	if isDemoUid(uid) || !ok || truthy(u["apple"]) || isAppleLogin(mstr(u, "login")) || providerOf(uid) == "trusted-header" {
		return nil
	}
	return u["login"]
}

func skillsRepoOf(uid string) string {
	if s, ok := prefsOf(uid)["skillsRepo"].(string); ok && s != "" {
		return s
	}
	return SKILLS_REPO_ENV
}

func skillsView(uid string) M {
	own, _ := prefsOf(uid)["skillsRepo"].(string)
	var auth any
	if SKILLS_APP != nil {
		auth = "app"
	} else if SKILLS_TOKEN != "" {
		auth = "token"
	}
	return M{"repo": own, "fallback": own == "" && SKILLS_REPO_ENV != "", "login": githubLoginOf(uid), "auth": auth, "on": skillsFor(skillsRepoOf(uid)) != nil}
}

const SPLITS_MAX = 20

func splitsOf(uid string) []any {
	out := []any{}
	for _, x := range asArr(prefsOf(uid)["splits"]) {
		if m, ok := x.(M); ok && isStr(m["id"]) && isStr(m["name"]) {
			if _, ok := m["ids"].([]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

// groups as objects: the list in prefs, written back after each change.
func groupsList(g M) []M {
	out := []M{}
	for _, x := range asArr(g["groups"]) {
		if m, ok := x.(M); ok {
			out = append(out, m)
		}
	}
	return out
}

func setGroups(g M, list []M) { g["groups"] = anyList(list) }

func strs(v any) []string {
	out := []string{}
	for _, x := range asArr(v) {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func indexOfAny(list []any, v any) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}

func insertAt(list []any, i int, v any) []any {
	list = append(list, nil)
	copy(list[i+1:], list[i:])
	list[i] = v
	return list
}

func removeAll(list []any, v any) []any {
	out := make([]any, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// besideInGroup: a copy of a session goes where the original is: the same group, right after it.
func besideInGroup(uid, original, cp string) {
	g := prefsOf(uid)
	for _, x := range groupsList(g) {
		items := asArr(x["items"])
		if containsAny(items, original) {
			if !containsAny(items, cp) {
				x["items"] = insertAt(items, indexOfAny(items, original)+1, cp)
			}
			return
		}
	}
	loose := asArr(g["loose"])
	if containsAny(loose, original) && !containsAny(loose, cp) {
		g["loose"] = insertAt(loose, indexOfAny(loose, original)+1, cp)
	}
}

const GROUP_DEPTH = 3

// groupOp: group operations, on session ids. Throws a Refuse(400) with what was wrong.
func groupOp(uid string, b M) M {
	g := prefsOf(uid)
	if _, ok := g["groups"].([]any); !ok {
		g["groups"] = []any{}
	}
	if _, ok := g["loose"].([]any); !ok {
		g["loose"] = []any{}
	}
	clean := func(name any) string {
		s := ""
		if name != nil {
			s = jsString(name)
		}
		return jsSliceTo(jsTrim(s), 40)
	}
	find := func(id any) M {
		for _, x := range groupsList(g) {
			if x["id"] == id && id != nil {
				return x
			}
		}
		return nil
	}
	bad := func(text string) { refuse(400, text) }
	var depthOf func(id any, seen int) int
	depthOf = func(id any, seen int) int {
		if !truthy(id) || find(id) == nil || seen > 10 {
			return 0
		}
		return 1 + depthOf(find(id)["parent"], seen+1)
	}
	var heightOf func(id any, seen int) int
	heightOf = func(id any, seen int) int {
		if seen > 10 {
			return 1
		}
		m := 0
		for _, x := range groupsList(g) {
			if x["parent"] == id && x["parent"] != nil {
				if h := heightOf(x["id"], seen+1); h > m {
					m = h
				}
			}
		}
		return 1 + m
	}
	var inside func(id, of any) bool
	inside = func(id, of any) bool {
		if id == of {
			return true
		}
		f := find(id)
		return f != nil && truthy(f["parent"]) && inside(f["parent"], of)
	}
	placeUnder := func(it M, parent any) {
		if truthy(parent) && find(parent) == nil {
			bad("그룹을 찾지 못했어요.")
		}
		if truthy(parent) && inside(parent, it["id"]) {
			bad("그룹을 자기 안으로 넣을 수는 없어요.")
		}
		if depthOf(parent, 0)+heightOf(it["id"], 0) > GROUP_DEPTH {
			bad("그룹은 " + itoa(GROUP_DEPTH) + "단계까지만 넣을 수 있어요.")
		}
		if truthy(parent) {
			it["parent"] = parent
		} else {
			delete(it, "parent")
		}
	}
	collapsedWithout := func(id any) []any {
		return removeAll(asArr(g["collapsed"]), id)
	}
	switch b["op"] {
	case "create":
		name := clean(b["name"])
		if name == "" {
			bad("그룹 이름이 비어 있어요.")
		}
		if len(asArr(g["groups"])) >= 50 {
			bad("그룹이 너무 많아요.")
		}
		if truthy(b["parent"]) && find(b["parent"]) == nil {
			bad("그룹을 찾지 못했어요.")
		}
		if truthy(b["parent"]) && depthOf(b["parent"], 0) >= GROUP_DEPTH {
			bad("그룹은 " + itoa(GROUP_DEPTH) + "단계까지만 넣을 수 있어요.")
		}
		id := randHex(4)
		ng := M{"id": id, "name": name, "items": []any{}}
		if truthy(b["parent"]) {
			ng["parent"] = b["parent"]
		}
		g["groups"] = append(asArr(g["groups"]), ng)
		return M{"note": "그룹을 만들었어요.", "id": id}
	case "rename":
		name := clean(b["name"])
		if find(b["id"]) == nil || name == "" {
			bad("그룹을 찾지 못했거나 이름이 비어 있어요.")
		}
		find(b["id"])["name"] = name
	case "delete":
		it := find(b["id"])
		if it == nil {
			bad("그룹을 찾지 못했어요.")
		}
		// What it held goes up one level.
		if truthy(it["parent"]) && find(it["parent"]) != nil {
			p := find(it["parent"])
			p["items"] = append(asArr(p["items"]), asArr(it["items"])...)
		} else {
			g["loose"] = append(asArr(g["loose"]), asArr(it["items"])...)
		}
		for _, x := range groupsList(g) {
			if x["parent"] == it["id"] {
				if truthy(it["parent"]) {
					x["parent"] = it["parent"]
				} else {
					delete(x, "parent")
				}
			}
		}
		var keep []M
		for _, x := range groupsList(g) {
			if x["id"] != b["id"] {
				keep = append(keep, x)
			}
		}
		setGroups(g, keep)
		g["collapsed"] = collapsedWithout(b["id"])
	case "empty":
		if find(b["id"]) == nil {
			bad("그룹을 찾지 못했어요.")
		}
		held := []any{}
		for _, x := range groupsList(g) {
			if inside(x["id"], b["id"]) {
				held = append(held, asArr(x["items"])...)
			}
		}
		return M{"held": held}
	case "fold":
		if b["id"] != "loose" && find(b["id"]) == nil {
			bad("그룹을 찾지 못했어요.")
		}
		c := collapsedWithout(b["id"])
		if b["open"] == false {
			c = append(c, b["id"])
		}
		g["collapsed"] = c
	case "clearRecent":
		g["recentClearedAt"] = float64(nowMs())
		return M{"note": "이어서 하기 목록을 비웠어요. 대화 파일은 맥에 그대로예요"}
	case "move":
		if !safeId(b["session"]) {
			bad("세션을 찾지 못했어요.")
		}
		if truthy(b["group"]) && find(b["group"]) == nil {
			bad("그룹을 찾지 못했어요.")
		}
		g["loose"] = removeAll(asArr(g["loose"]), b["session"])
		for _, x := range groupsList(g) {
			x["items"] = removeAll(asArr(x["items"]), b["session"])
		}
		var list []any
		var put func([]any)
		if truthy(b["group"]) {
			gr := find(b["group"])
			list = asArr(gr["items"])
			put = func(l []any) { gr["items"] = l }
		} else {
			list = asArr(g["loose"])
			put = func(l []any) { g["loose"] = l }
		}
		at := -1
		if truthy(b["before"]) {
			at = indexOfAny(list, b["before"])
		}
		if at >= 0 {
			list = insertAt(list, at, b["session"])
		} else {
			list = append(list, b["session"])
		}
		put(list)
	case "nest":
		it := find(b["id"])
		if it == nil {
			bad("그룹을 찾지 못했어요.")
		}
		var parent any
		if truthy(b["parent"]) {
			parent = b["parent"]
		}
		placeUnder(it, parent)
		var keep []M
		for _, x := range groupsList(g) {
			if x["id"] != b["id"] {
				keep = append(keep, x)
			}
		}
		setGroups(g, append(keep, it))
	case "order":
		it := find(b["id"])
		if it == nil {
			bad("그룹을 찾지 못했어요.")
		}
		if truthy(b["before"]) && find(b["before"]) != nil && b["before"] != b["id"] {
			placeUnder(it, find(b["before"])["parent"])
		}
		var keep []M
		for _, x := range groupsList(g) {
			if x["id"] != b["id"] {
				keep = append(keep, x)
			}
		}
		at := -1
		if truthy(b["before"]) {
			for i, x := range keep {
				if x["id"] == b["before"] {
					at = i
					break
				}
			}
		}
		if at >= 0 {
			keep = append(keep[:at], append([]M{it}, keep[at:]...)...)
		} else {
			keep = append(keep, it)
		}
		setGroups(g, keep)
	case "loose":
		seen := map[string]bool{}
		order := []any{}
		for _, x := range asArr(b["order"]) {
			if safeId(x) && !seen[x.(string)] {
				seen[x.(string)] = true
				order = append(order, x)
			}
		}
		if len(order) > 500 {
			order = order[:500]
		}
		for _, x := range groupsList(g) {
			items := []any{}
			for _, i := range asArr(x["items"]) {
				if !containsAny(order, i) {
					items = append(items, i)
				}
			}
			x["items"] = items
		}
		g["loose"] = order
	default:
		bad("알 수 없는 동작이에요.")
	}
	return M{"note": ""}
}

// ---------- 보관 기한 (REQ-S-071, REQ-S-072, REQ-S-074 (8), REQ-S-075) ----------

const (
	NOTICE_KEEP_MS     = 30 * 86_400_000
	REPORT_KEEP_MS     = 90 * 86_400_000
	ACCESS_KEEP_MS     = 90 * 86_400_000
	RETENTION_SWEEP_MS = 3_600_000
)

var RETENTION M

func loadRetention() {
	file := filepath.Join(DATA, "retention.json")
	saved, _ := readJSON(file, nil).(M)
	if jsNumber(saved["since"]) > 0 {
		RETENTION = saved
		return
	}
	RETENTION = M{"since": float64(nowMs())}
	writeJson(file, RETENTION)
}

type pastFn func(at any, keep float64, now float64) bool

// pastKeep: whether something made at `at` is past `keep` and made under these limits.
func pastKeep(at any, keep float64, now float64) bool {
	a := jsNumber(at)
	return a >= jsNumber(RETENTION["since"]) && now-a > keep
}

// pastAny: whether something made at `at` is past `keep` at all: what the operator's clearing takes.
func pastAny(at any, keep float64, now float64) bool {
	a := jsNumber(at)
	if math.IsNaN(a) || a == 0 {
		a = 0
	}
	return now-a > keep
}

// ---------- notices ----------

var noticeCache = map[string][]any{}

func noticesFile(uid string) string { return filepath.Join(userDir(uid), "notices.json") }

// noticesOf: a person's notices, without those past NOTICE_KEEP_MS (REQ-S-071).
func noticesOf(uid string, past pastFn) []any {
	if past == nil {
		past = pastKeep
	}
	if _, ok := noticeCache[uid]; !ok {
		l, _ := readJSON(noticesFile(uid), []any{}).([]any)
		if l == nil {
			l = []any{}
		}
		noticeCache[uid] = l
	}
	list := noticeCache[uid]
	now := float64(nowMs())
	some := false
	for _, n := range list {
		if past(mget(n, "at"), NOTICE_KEEP_MS, now) {
			some = true
			break
		}
	}
	if some {
		keep := []any{}
		for _, n := range list {
			if !past(mget(n, "at"), NOTICE_KEEP_MS, now) {
				keep = append(keep, n)
			}
		}
		noticeCache[uid] = keep
		list = keep
		writeJson(noticesFile(uid), list)
	}
	return list
}

func itoa(n int) string { return numStr(float64(n)) }

var _ = strings.TrimSpace
