package main

// Server hooks (REQ-F-819, REQ-F-820): bridge.yaml's hooks run a webhook or a command before an action (it may
// refuse it or change a few of its fields) and after an action or event (told only). They are a guardrail and a
// way to connect other systems, never a policy boundary: the Mac's owner can always go around the server (SPEC).
// Without hooks nothing here runs and the lock is never let go.

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// HOOK_ACTIONS: what people do through the server, each raised once where it takes effect (the table in SPEC).
var HOOK_ACTIONS = []string{"login", "session.create", "session.close", "message.send", "message.btw", "message.retract", "session.key", "session.do", "session.setting", "session.settings", "session.move", "session.lock", "session.sudo", "permission.answer"}

// HOOK_EVENTS: what happens on its own, said by the Mac (not trustworthy as an audit record).
var HOOK_EVENTS = []string{"session.done", "decision.waiting", "decision.answered"}

// hookKeys: the names hooks takes.
func hookKeys() []string {
	out := []string{}
	for _, a := range HOOK_ACTIONS {
		out = append(out, a+".before", a+".after")
	}
	for _, e := range HOOK_EVENTS {
		out = append(out, e+".after")
	}
	return out
}

// hookTarget: one entry under a hook name. A webhook is POSTed the event, signed as notify is; a command (exec) runs
// in the server's container with the event on stdin.
type hookTarget struct {
	Type    string // webhook | exec
	URL     string
	URLText string // as written, before ${ENV}
	Secret  string
	Run     string // exec: an absolute path outside DATA
	Timeout time.Duration
	Deny    bool // before: a hook that fails (no answer in time, an error, an answer it cannot read) refuses
}

const (
	HOOK_TIMEOUT_MS     = 3000
	HOOK_TIMEOUT_MAX_MS = 10_000
	HOOK_PER_NAME       = 5
)

// readHooks: hooks, a map of a hook name to a list of {type: webhook, url, secret, timeoutMs} or {type: exec, run,
// timeoutMs}.
func readHooks(k cfgKey, n *yNode, getenv func(string) string) (cfgVal, bool, error) {
	if n.kind != yMap {
		return cfgVal{}, false, &yamlErr{n.line, "hooks 아래는 \"훅 이름: 목록\" 이어야 합니다(예: session.create.after:)"}
	}
	out := map[string][]hookTarget{}
	for _, p := range n.pairs {
		if !contains(hookKeys(), p.key) {
			return cfgVal{}, false, &yamlErr{p.line, "hooks 의 " + p.key + " 는 이 서버(" + VERSION + ")가 모르는 훅입니다(받는 이름: " + strings.Join(hookKeys(), ", ") + ")"}
		}
		if p.val.kind != yList {
			return cfgVal{}, false, &yamlErr{p.line, "hooks." + p.key + " 는 목록이어야 합니다(- type: webhook ...)"}
		}
		list := []hookTarget{}
		for _, it := range p.val.items {
			t, err := readHookTarget(p.key, it, getenv)
			if err != nil {
				return cfgVal{}, false, err
			}
			list = append(list, t)
		}
		if len(list) > HOOK_PER_NAME {
			return cfgVal{}, false, &yamlErr{p.line, "hooks." + p.key + " 는 " + itoa(HOOK_PER_NAME) + "개까지입니다"}
		}
		if len(list) > 0 {
			out[p.key] = list
		}
	}
	return cfgVal{out, false}, true, nil
}

func readHookTarget(name string, it *yNode, getenv func(string) string) (hookTarget, error) {
	where := "hooks." + name + "[]"
	if it.kind != yMap {
		return hookTarget{}, &yamlErr{it.line, where + " 의 항목은 \"키: 값\" 이어야 합니다"}
	}
	fields := []string{"type", "url", "secret", "run", "timeoutMs", "onError"}
	for _, kv := range it.pairs {
		if !contains(fields, kv.key) {
			return hookTarget{}, &yamlErr{kv.line, "모르는 키 " + where + "." + kv.key + " (받는 키: " + strings.Join(fields, ", ") + ")"}
		}
	}
	one := func(f string, need bool) (string, string, int, error) {
		x := it.get(f)
		if x == nil || x.null {
			if need {
				return "", "", it.line, &yamlErr{it.line, where + " 에 " + f + " 가 없습니다"}
			}
			return "", "", it.line, nil
		}
		if x.kind != yScalar {
			return "", "", x.line, &yamlErr{x.line, where + "." + f + " 는 값 하나여야 합니다"}
		}
		v, soft, err := substEnv(x.raw, x.line, getenv)
		if err == nil && (soft || strings.TrimSpace(v) == "") {
			err = &yamlErr{x.line, where + "." + f + " 가 비어 있습니다"}
		}
		return strings.TrimSpace(v), x.raw, x.line, err
	}
	typ, _, line, err := one("type", true)
	if err != nil {
		return hookTarget{}, err
	}
	t := hookTarget{Type: typ, Timeout: HOOK_TIMEOUT_MS * time.Millisecond}
	switch typ {
	case "webhook":
		if it.get("run") != nil {
			return hookTarget{}, &yamlErr{it.line, where + " 의 webhook 에는 run 을 쓰지 않습니다"}
		}
		u, raw, line, err := one("url", true)
		if err != nil {
			return hookTarget{}, err
		}
		pu, perr := url.Parse(u)
		if perr != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" || pu.User != nil || pu.Fragment != "" {
			return hookTarget{}, &yamlErr{line, where + ".url 은 http(s)://호스트/경로 모양이어야 합니다: " + rawOrigin(raw)}
		}
		t.URL, t.URLText = u, raw
		sec, _, line, err := one("secret", true)
		if err != nil {
			return hookTarget{}, err
		}
		if len(sec) < 16 {
			return hookTarget{}, &yamlErr{line, where + ".secret 은 16자 이상이어야 합니다"}
		}
		t.Secret = sec
	case "exec":
		if it.get("url") != nil || it.get("secret") != nil {
			return hookTarget{}, &yamlErr{it.line, where + " 의 exec 에는 url·secret 을 쓰지 않습니다(run 에 명령의 절대 경로)"}
		}
		run, _, line, err := one("run", true)
		if err != nil {
			return hookTarget{}, err
		}
		if !filepath.IsAbs(run) || strings.ContainsAny(run, "\x00\n") {
			return hookTarget{}, &yamlErr{line, where + ".run 은 명령의 절대 경로여야 합니다(셸을 거치지 않습니다): " + run}
		}
		t.Run = filepath.Clean(run)
	default:
		return hookTarget{}, &yamlErr{line, where + ".type 의 " + typ + " 는 모르는 종류입니다(받는 값: webhook, exec)"}
	}
	if ms, _, line, err := one("timeoutMs", false); err != nil {
		return hookTarget{}, err
	} else if ms != "" {
		v, e := strconv.Atoi(ms)
		if e != nil || v < 1 || v > HOOK_TIMEOUT_MAX_MS {
			return hookTarget{}, &yamlErr{line, where + ".timeoutMs 는 1 부터 " + itoa(HOOK_TIMEOUT_MAX_MS) + " 까지의 정수(밀리초)여야 합니다"}
		}
		t.Timeout = time.Duration(v) * time.Millisecond
	}
	if oe, _, line, err := one("onError", false); err != nil {
		return hookTarget{}, err
	} else if oe != "" {
		if !strings.HasSuffix(name, ".before") {
			return hookTarget{}, &yamlErr{line, where + ".onError 는 before 훅에만 씁니다(after 는 결과를 기다리지 않습니다)"}
		}
		if oe != "allow" && oe != "deny" {
			return hookTarget{}, &yamlErr{line, where + ".onError 는 allow 나 deny 여야 합니다"}
		}
		t.Deny = oe == "deny"
	}
	return t, nil
}

func hooksOf(name string) []hookTarget {
	m, _ := cfgGet("hooks").(map[string][]hookTarget)
	return m[name]
}

// realBelow: a path with its links resolved as far as it exists, the rest added as written (a file that is not
// there yet, or a DATA made later).
func realBelow(p string) string {
	rest := ""
	for d := filepath.Clean(p); ; d = filepath.Dir(d) {
		if r, err := filepath.EvalSymlinks(d); err == nil {
			return filepath.Join(r, rest)
		}
		if d == filepath.Dir(d) {
			return p
		}
		rest = filepath.Join(filepath.Base(d), rest)
	}
}

// checkHookPaths: before the handover, a command of hooks must lie outside DATA (the server makes every file in
// DATA 0600 when it starts, so a command there loses its execute bit, and DATA holds what people send).
func checkHookPaths(c *bridgeCfg, data string) error {
	v, ok := c.set["hooks"]
	if !ok {
		return nil
	}
	d := realBelow(data)
	for _, name := range sortedKeysOf(v.v.(map[string][]hookTarget)) {
		for _, t := range v.v.(map[string][]hookTarget)[name] {
			if t.Type == "exec" && inside(realBelow(t.Run), d) {
				return &yamlErr{0, "hooks." + name + " 의 명령 " + t.Run + " 이 데이터 폴더(" + data + ") 안에 있습니다. 서버가 시작할 때 실행 권한을 지우므로 밖에 두세요(읽기 전용 마운트를 권합니다)"}
			}
		}
	}
	return nil
}

func sortedKeysOf(m map[string][]hookTarget) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// hookBroken: commands of hooks the server, as the user it runs as, cannot run (checked once after dropRoot). Each is
// told in the log and fails when called.
var hookBroken = map[string]string{}

func checkHookExec() {
	m, _ := cfgGet("hooks").(map[string][]hookTarget)
	for _, name := range sortedKeysOf(m) {
		for _, t := range m[name] {
			if t.Type != "exec" {
				continue
			}
			if err := syscall.Access(t.Run, 1); err != nil { // X_OK, by the kernel's rules for this user
				hookBroken[t.Run] = err.Error()
				errorLine("hooks: " + name + " 의 명령 " + t.Run + " 을 실행할 수 없습니다(" + err.Error() + "). 부를 때마다 실패로 다룹니다")
			}
		}
	}
}

// ---------- who is asking ----------

// hookScope: what one request is, for the hooks it raises: where it came from (by, from the way in, never from what
// a body says) and the actions it already raised, so an action wrapped in another (a command running an op) is
// raised once.
type hookScope struct {
	by    string
	fired map[string]bool
}

// scopeNow: the scope of whoever holds the lock. await clears it while the lock is let go and puts it back after.
var scopeNow *hookScope

// withBy runs f as a request from `by`: page (a sign-in cookie), slack, service, delegate or system.
func withBy(by string, f func()) {
	prev := scopeNow
	scopeNow = &hookScope{by: by, fired: map[string]bool{}}
	defer func() { scopeNow = prev }()
	f()
}

func curBy() string {
	if scopeNow == nil {
		return "system"
	}
	return scopeNow.by
}

// firstTime: whether this request raises name for key now for the first time.
func firstTime(name, key string) bool {
	if scopeNow == nil {
		return true
	}
	k := name + "|" + key
	if scopeNow.fired[k] {
		return false
	}
	scopeNow.fired[k] = true
	return true
}

// ---------- raising ----------

// actionAfter: one action took effect. Raised once per request and target (key: the session id, card id or host id).
func actionAfter(name, uid, key string, more orderedObj) {
	if firstTime(name+".after", key) {
		emitEvent(name, uid, more)
	}
}

// eventOf: {id, name, at, user: {uid, login}, ...more, url}, the one body notify, hooks and pages share (SPEC).
func eventOf(name, uid string, more orderedObj) (orderedObj, string) {
	login := ""
	if u, ok := users.Get(uid); ok {
		login = mstr(u, "login")
	}
	ev := orderedObj{{"id", randHex(16)}, {"name", name}, {"at", nowMs()}, {"user", orderedObj{{"uid", uid}, {"login", login}}}}
	ev = append(ev, more...)
	link := ORIGIN
	for _, x := range more {
		if x.K == "session" {
			if s, ok := x.V.(orderedObj); ok && ORIGIN != "" && len(s) > 0 && s[0].K == "id" {
				link = ORIGIN + "/s/" + jsString(s[0].V)
			}
		}
	}
	return append(ev, kv{"url", link}), login
}

// afterHook: one after hook, once, off the lock. A failure is one line in the log (origin or command only).
func afterHook(name string, t hookTarget, body []byte, uid, login string) {
	_, err := callHook(t, body, uid, login)
	if err != nil {
		logLine("hooks: " + name + ".after → " + hookWhere(t) + " 실패 (" + err.Error() + ")")
	}
}

func hookWhere(t hookTarget) string {
	if t.Type == "exec" {
		return t.Run
	}
	return rawOrigin(t.URLText)
}

type hookErr string

func (e hookErr) Error() string { return string(e) }

// callHook: the event to one hook, and what it answered (64 KB at most). A webhook must answer 2xx in time, a
// command must exit 0 in time.
func callHook(t hookTarget, body []byte, uid, login string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), t.Timeout)
	defer cancel()
	if t.Type == "exec" {
		if why, bad := hookBroken[t.Run]; bad {
			return nil, hookErr("실행할 수 없음: " + why)
		}
		cmd := exec.CommandContext(ctx, t.Run)
		cmd.Stdin = bytes.NewReader(body)
		out := &capped{max: 64 * 1024}
		cmd.Stdout = out
		// Only what a command needs: the server's own environment holds its secrets.
		cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=" + os.TempDir(), "BRIDGE_VERSION=" + VERSION}
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return nil, hookErr("시간 초과")
			}
			return nil, hookErr(err.Error())
		}
		return out.b.Bytes(), nil
	}
	pu, err := url.Parse(t.URL)
	if err != nil {
		return nil, err
	}
	pq := pu.EscapedPath()
	if pq == "" {
		pq = "/"
	}
	if pu.RawQuery != "" {
		pq += "?" + pu.RawQuery
	}
	r, err := signedPost(ctx, t.URL, pq, t.Secret, body, uid, login)
	if err != nil {
		if ctx.Err() != nil {
			return nil, hookErr("시간 초과")
		}
		return nil, hookErr("연결 실패")
	}
	defer r.Body.Close()
	out := &capped{max: 64 * 1024}
	_, _ = out.ReadFrom(r.Body)
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return nil, hookErr("HTTP " + itoa(r.StatusCode))
	}
	return out.b.Bytes(), nil
}

// capped keeps the first max bytes and drops the rest.
type capped struct {
	b   bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.b.Len(); room > 0 {
		if len(p) > room {
			c.b.Write(p[:room])
		} else {
			c.b.Write(p)
		}
	}
	return len(p), nil
}

func (c *capped) ReadFrom(r interface{ Read([]byte) (int, error) }) (int64, error) {
	buf := make([]byte, 8192)
	var n int64
	for {
		k, err := r.Read(buf)
		n += int64(k)
		_, _ = c.Write(buf[:k])
		if err != nil {
			return n, nil
		}
	}
}

// sessAfter: an action on one session took effect: {session, ...more, by}.
func sessAfter(name string, meta *Sess, more ...kv) {
	if !raised(name) {
		return
	}
	ev := orderedObj{{"session", sessionOfEvent(meta)}}
	ev = append(ev, more...)
	actionAfter(name, meta.uid(), meta.id(), append(ev, kv{"by", curBy()}))
}

// startFrom marks, inside the server, where a session start comes from when the body cannot say it (a body is JSON,
// so no request can carry this type).
type startFrom string

// createdAfter: a session was made: {session, mode, from, by}.
func createdAfter(meta *Sess, from, mode string) {
	if !raised("session.create") {
		return
	}
	if mode == "" {
		mode = mstr(meta.state(), "mode")
	}
	sessAfter("session.create", meta, kv{"mode", mode}, kv{"from", from})
}

// answerOf: the card and option an answer is about, as the server knows them (permission.answer). A card the server
// does not know (after a reconnect, a restart or a handover the open card is not kept) is {id} with an option of
// kind other, and goes on to the Mac as before.
func answerOf(meta *Sess, cid string, n any) (orderedObj, orderedObj) {
	c, _ := meta.get("card").(M)
	if c == nil || c["id"] != cid {
		label := ""
		if n == "esc" {
			label = "Esc"
		}
		kind := "other"
		if n == "esc" {
			kind = "deny"
		}
		return orderedObj{{"id", cid}}, orderedObj{{"n", n}, {"label", label}, {"kind", kind}}
	}
	card := orderedObj{{"id", cid}, {"kind", c["kind"]}, {"title", c["title"]}}
	if t, ok := c["tool"].(M); ok {
		card = append(card, kv{"tool", orderedObj{{"name", t["name"]}, {"input", t["input"]}}})
	}
	switch n {
	case "esc":
		return card, orderedObj{{"n", "esc"}, {"label", "Esc"}, {"kind", "deny"}}
	case "enter":
		return card, orderedObj{{"n", "enter"}, {"label", "확정"}, {"kind", "other"}}
	}
	for _, o := range asArr(c["options"]) {
		if jsNumber(mget(o, "n")) == jsNumber(n) {
			kind := mget(o, "kind")
			if !truthy(kind) {
				kind = "other" // an older agent's card (SPEC: allow means "not deny", never an allow prefix)
			}
			return card, orderedObj{{"n", n}, {"label", mget(o, "label")}, {"kind", kind}}
		}
	}
	return card, orderedObj{{"n", n}, {"label", ""}, {"kind", "other"}}
}

// hostSudoAfter: the person opened (or closed) admin rights on a Mac for the sudo Claude asked for (session.sudo,
// per host).
func hostSudoAfter(uid, hostID, do string) {
	if !raised("session.sudo") {
		return
	}
	name := ""
	if h, ok := hosts.Get(hostID); ok {
		name = mstr(h, "name")
	}
	actionAfter("session.sudo", uid, "host:"+hostID, orderedObj{{"host", orderedObj{{"id", hostID}, {"name", name}}}, {"do", do}, {"by", curBy()}})
}

// raised: whether anything hears of name (notify or an after hook); the event is built only then.
func raised(name string) bool {
	if len(hooksOf(name+".after")) > 0 {
		return true
	}
	for _, t := range notifyTargets() {
		if contains(t.Events, name) {
			return true
		}
	}
	return false
}

// ---------- before ----------

// PATCHABLE: the fields a before hook may change, each where the action has it (text: message.send; title:
// session.create, session.settings; prompt, mode: session.create).
var PATCHABLE = []string{"text", "title", "prompt", "mode"}

// actionBefore asks the before hooks of one action (REQ-F-820) and returns the fields they changed (nil: none).
// It lets the lock go while they answer; then still() must hold (the session is there, the card is still open),
// else 409. A refusal ends the request with 403 and the hook's reason. With no before hook it returns at once,
// holding the lock, so a server without hooks behaves as before. The server's own work (by system) is not asked,
// and neither is an admin signing in (a policy server that is down must not lock everyone out).
func actionBefore(name, uid, key string, more orderedObj, still func() bool) M {
	hs := hooksOf(name + ".before")
	if len(hs) == 0 || (curBy() == "system" && name != "login") || (name == "login" && isAdmin(uid)) {
		return nil
	}
	if !firstTime(name+".before", key) {
		return nil
	}
	ev, login := eventOf(name, uid, more)
	body := jsonBytes(append(ev, kv{"hook", name + ".before"}))
	var v hookVerdict
	await(func() { v = askBefore(name, hs, body, uid, login) })
	if !v.allow {
		logLine("hooks: " + name + ".before 가 막음 (" + jsSliceTo(v.reason, 200) + ")")
		refuse(403, v.reason)
	}
	if still != nil && !still() {
		refuse(409, "확인을 기다리는 사이 세션이 바뀌었어요. 다시 해 주세요")
	}
	return v.patch
}

// sessBefore: actionBefore for one session: {session, ...more, by}; the session must still be there after.
func sessBefore(name string, meta *Sess, more ...kv) M {
	if len(hooksOf(name+".before")) == 0 {
		return nil
	}
	ev := orderedObj{{"session", sessionOfEvent(meta)}}
	ev = append(ev, more...)
	return actionBefore(name, meta.uid(), meta.id(), append(ev, kv{"by", curBy()}), func() bool {
		cur, ok := sessions.Get(meta.id())
		return ok && cur == meta
	})
}

type hookVerdict struct {
	allow  bool
	reason string
	patch  M
}

// HOOK_DENIED: what a person sees when a hook says no without saying why.
const HOOK_DENIED = "이 서버의 규칙으로 막혔어요"

// askBefore runs the hooks in order, off the lock. Each answers {allow, reason?, patch?}; the first no ends it; the
// patches are merged in order (a later hook wins). A hook that fails counts as yes, or as no with onError: deny.
func askBefore(name string, hs []hookTarget, body []byte, uid, login string) hookVerdict {
	out := hookVerdict{allow: true}
	for _, t := range hs {
		allow, reason, patch, err := oneBefore(t, body, uid, login)
		if err != nil {
			logLine("hooks: " + name + ".before → " + hookWhere(t) + " 실패 (" + err.Error() + ")")
			if t.Deny {
				return hookVerdict{reason: "확인 서버에 묻지 못해 막았어요"}
			}
			continue
		}
		if !allow {
			if reason == "" {
				reason = HOOK_DENIED
			}
			return hookVerdict{reason: reason}
		}
		for k, v := range patch {
			if out.patch == nil {
				out.patch = M{}
			}
			out.patch[k] = v
		}
	}
	return out
}

// oneBefore: one hook's answer, read strictly: allow must be a boolean, reason a string (300 letters shown at most),
// patch only PATCHABLE strings, and a mode one of features.permissionModes.
func oneBefore(t hookTarget, body []byte, uid, login string) (bool, string, M, error) {
	raw, err := callHook(t, body, uid, login)
	if err != nil {
		return false, "", nil, err
	}
	v, err := parseJSON(raw)
	m, isMap := v.(M)
	if err != nil || !isMap {
		return false, "", nil, hookErr("답이 JSON 객체가 아님")
	}
	allow, ok := m["allow"].(bool)
	if !ok {
		return false, "", nil, hookErr("답에 allow(true/false)가 없음")
	}
	reason := ""
	if r, has := m["reason"]; has && r != nil {
		s, isStr := r.(string)
		if !isStr {
			return false, "", nil, hookErr("reason 이 글이 아님")
		}
		reason = jsSliceTo(jsTrim(s), 300)
	}
	if !allow {
		return false, reason, nil, nil
	}
	var patch M
	if p, has := m["patch"]; has && p != nil {
		pm, isMap := p.(M)
		if !isMap {
			return false, "", nil, hookErr("patch 가 객체가 아님")
		}
		patch = M{}
		for k, x := range pm {
			s, isStr := x.(string)
			if !contains(PATCHABLE, k) || !isStr {
				return false, "", nil, hookErr("patch 의 " + k + " 는 바꿀 수 없음(바꿀 수 있는 것: " + strings.Join(PATCHABLE, ", ") + ", 글만)")
			}
			if k == "mode" && !contains(cfgGet("features.permissionModes").([]string), s) {
				return false, "", nil, hookErr("patch 의 mode " + jsSliceTo(s, 20) + " 는 features.permissionModes 밖")
			}
			patch[k] = s
		}
	}
	return true, reason, patch, nil
}

// patched: the hook's value of field when it gave one.
func patched(p M, field string, cur string) string {
	if s, ok := p[field].(string); ok {
		return s
	}
	return cur
}

// OTHER_CARD: an answer to a card when the server knows another one is open on that session.
const OTHER_CARD = "다른 질문이 열려 있어요. 화면을 새로 고친 뒤 답해 주세요"

// otherCardOpen: the server knows a different card is open (a card it does not know at all goes on, as before).
func otherCardOpen(meta *Sess, cid string) bool {
	c, _ := meta.get("card").(M)
	return c != nil && truthy(c["open"]) && safeId(c["id"]) && c["id"] != cid
}

// newSession: the session part of a session.create event before the session exists (no id yet).
func newSession(hostID, cwd, title string) orderedObj {
	host := ""
	if h, ok := hosts.Get(hostID); ok {
		host = mstr(h, "name")
	}
	return orderedObj{{"host", host}, {"hostId", hostID}, {"cwd", cwd}, {"title", title}}
}

// createBefore: session.create's before hooks for a session about to start on hostID; the Mac must still be there.
func createBefore(uid, hostID, cwd, title, mode, from string) M {
	if len(hooksOf("session.create.before")) == 0 {
		return nil
	}
	return actionBefore("session.create", uid, "new:"+hostID, orderedObj{{"session", newSession(hostID, cwd, title)}, {"mode", mode}, {"from", from}, {"by", curBy()}}, func() bool { return online(hostID) })
}

// forkBefore: session.create for a copy of meta (fork, lightfork); meta must still be open.
func forkBefore(meta *Sess, from, title string) M {
	if len(hooksOf("session.create.before")) == 0 {
		return nil
	}
	return actionBefore("session.create", meta.uid(), from+":"+meta.id(), orderedObj{{"session", newSession(meta.host(), meta.str("cwd"), title)}, {"mode", mstr(meta.state(), "mode")}, {"from", from}, {"by", curBy()}}, func() bool {
		cur, ok := sessions.Get(meta.id())
		return ok && cur == meta && !truthy(meta.get("closed"))
	})
}

// hostSudoBefore: session.sudo for a Mac's admin rights; the Mac must still be connected.
func hostSudoBefore(uid, hostID, do string) {
	if len(hooksOf("session.sudo.before")) == 0 {
		return
	}
	name := ""
	if h, ok := hosts.Get(hostID); ok {
		name = mstr(h, "name")
	}
	actionBefore("session.sudo", uid, "host:"+hostID, orderedObj{{"host", orderedObj{{"id", hostID}, {"name", name}}}, {"do", do}, {"by", curBy()}}, func() bool { return online(hostID) })
}

// loginBefore: login's before hooks (admins skip them).
func loginBefore(uid, provider string) {
	actionBefore("login", uid, uid, orderedObj{{"provider", provider}}, nil)
}
