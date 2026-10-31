package main

// Extensions (REQ-F-825): folders the operator lists in bridge.yaml, read into memory at start, served from this
// origin at /ext/<id>/<hash>/ to the people who agreed to that hash. An extension's page code runs with the
// person's own rights; its server side (routes, hooks) only reaches the addresses its extension.yaml names, with
// the environment variables bridge.yaml allows it.

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// EXT_API: the extensionApi this server gives (REQ-F-825); an extension asking for more is not loaded.
const EXT_API = 1

// EXT_MAX_BYTES: one extension's folder, read into memory.
const EXT_MAX_BYTES = 5 << 20

var (
	extIdRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	extKeyRe  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	extPathRe = regexp.MustCompile(`^/([A-Za-z0-9._~-]+/)*$`)
	// What the page's actions and the events it hears are called (uses.actions): lib/actions plus the events.
	EXT_ACTIONS = []string{"composer.submit", "message.send", "permission.answer", "session.open", "session.create", "session.close", "link.open", "clipboard.copy", "renderer.block", "notify.show", "session.done", "decision.waiting", "decision.answered"}
	EXT_SLOTS   = []string{"composer.actions", "session.menu", "session-list.row.badges", "settings.section"}
	// What /ext/ serves; anything else (HTML, SVG) is 404 so nothing in the folder opens as a page of this origin.
	EXT_FILE_TYPES = map[string]string{".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2"}
	// Headers a route may not set: the server's own and what the transport owns.
	extHeaderNo = regexp.MustCompile(`(?i)^(x-bridge-.*|cookie|set-cookie|host|content-length|content-type|connection|transfer-encoding|te|upgrade|proxy-.*)$`)
)

// extEntry: one line of bridge.yaml's extensions: the folder and the environment variables it may read.
type extEntry struct {
	Path string
	Env  []string
}

type extRoute struct {
	Path     string // "/docs/": what follows /api/ext/<id>/call
	Upstream string // ends in "/"
	Secret   string
	Headers  [][2]string // the value may still hold ${user.KEY}
}

type extDef struct {
	ID, Name, Version, Entry, Dir string
	API                           int
	Actions, Slots                []string
	Routes                        []extRoute
	Hooks                         map[string][]hookTarget
	Env                           []string
	Files                         map[string][]byte
	Hash                          string
	Err                           string // why it is not loaded ("" when it is)
}

// EXTS: the extensions of this server, in bridge.yaml's order; those with Err are listed but not served.
var EXTS []*extDef

func extByID(id string) *extDef {
	for _, d := range EXTS {
		if d.ID == id && d.Err == "" {
			return d
		}
	}
	return nil
}

// readExtensions: bridge.yaml's `extensions: [{path, env: [NAME…]}]`. Paths are made absolute in parseBridgeConfig.
func readExtensions(k cfgKey, n *yNode, getenv func(string) string) (cfgVal, bool, error) {
	if n.kind != yList {
		return cfgVal{}, false, &yamlErr{n.line, "extensions 는 목록이어야 합니다(- path: ./ext/이름)"}
	}
	out := []extEntry{}
	for _, it := range n.items {
		if it.kind != yMap {
			return cfgVal{}, false, &yamlErr{it.line, "extensions[] 의 항목은 \"키: 값\" 이어야 합니다"}
		}
		for _, kv := range it.pairs {
			if kv.key != "path" && kv.key != "env" {
				return cfgVal{}, false, &yamlErr{kv.line, "모르는 키 extensions[]." + kv.key + " (받는 키: path, env)"}
			}
		}
		p := it.get("path")
		if p == nil || p.kind != yScalar || p.null {
			return cfgVal{}, false, &yamlErr{it.line, "extensions[] 에 path 가 없습니다"}
		}
		v, soft, err := substEnv(p.raw, p.line, getenv)
		if err == nil && (soft || strings.TrimSpace(v) == "") {
			err = &yamlErr{p.line, "extensions[].path 가 비어 있습니다"}
		}
		if err != nil {
			return cfgVal{}, false, err
		}
		e := extEntry{Path: strings.TrimSpace(v), Env: []string{}}
		if en := it.get("env"); en != nil && !en.null {
			if en.kind != yList {
				return cfgVal{}, false, &yamlErr{en.line, "extensions[].env 는 환경변수 이름의 목록이어야 합니다"}
			}
			for _, x := range en.items {
				if x.kind != yScalar || !envNameRe.MatchString(x.raw) {
					return cfgVal{}, false, &yamlErr{x.line, "extensions[].env 의 " + x.raw + " 는 환경변수 이름이 아닙니다"}
				}
				e.Env = append(e.Env, x.raw)
			}
		}
		out = append(out, e)
	}
	return cfgVal{out, false}, true, nil
}

// loadExtensions reads every listed folder. A folder that cannot be used is kept with its reason (운영 탭); the
// server starts anyway. Two folders with the same id: the second is not loaded.
func loadExtensions(entries []extEntry, getenv func(string) string) []*extDef {
	out := []*extDef{}
	seen := map[string]bool{}
	for _, e := range entries {
		d := &extDef{Dir: e.Path, Env: e.Env}
		if err := d.load(getenv); err != nil {
			d.Err = err.Error()
			if d.ID == "" {
				d.ID = filepath.Base(e.Path)
			}
		} else if seen[d.ID] {
			d.Err = "같은 id 의 익스텐션이 앞에 있습니다"
		}
		seen[d.ID] = true
		out = append(out, d)
	}
	return out
}

// snapshot reads the folder's regular files (symbolic links are left out) up to EXT_MAX_BYTES.
func snapshotDir(dir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	total := 0
	err := filepath.WalkDir(dir, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// What a build leaves in the folder (node_modules) and hidden files (.git) are never served: not read.
		if p != dir && (de.Name() == "node_modules" || strings.HasPrefix(de.Name(), ".")) {
			if de.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !de.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		total += len(b)
		if total > EXT_MAX_BYTES {
			return errf("폴더가 " + strconv.Itoa(EXT_MAX_BYTES>>20) + "MB 를 넘습니다")
		}
		rel, _ := filepath.Rel(dir, p)
		files[filepath.ToSlash(rel)] = b
		return nil
	})
	return files, err
}

// hashFiles: every file's path and content, in path order; what a person agrees to.
func hashFiles(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		h.Write([]byte(n))
		h.Write([]byte{0})
		h.Write([]byte(strconv.Itoa(len(files[n]))))
		h.Write([]byte{0})
		h.Write(files[n])
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func (d *extDef) load(getenv func(string) string) (err error) {
	st, err := os.Stat(d.Dir)
	if err != nil || !st.IsDir() {
		return errf("폴더가 없습니다: " + d.Dir)
	}
	files, err := snapshotDir(d.Dir)
	if err != nil {
		return errf("폴더를 읽지 못했습니다: " + err.Error())
	}
	d.Files = files
	d.Hash = hashFiles(files)
	src, ok := files["extension.yaml"]
	if !ok {
		return errf("extension.yaml 이 없습니다")
	}
	root, err := parseYAML(src)
	if err != nil {
		return errf("extension.yaml: " + err.Error())
	}
	if root == nil || root.kind != yMap {
		return errf("extension.yaml 은 \"키: 값\" 이어야 합니다")
	}
	// Only the names bridge.yaml gave this extension are read; any other is refused, not read as empty. Found in
	// the text first, so the reason is the name and not what an empty value broke.
	bad := []string{}
	for _, m := range envRefRe.FindAllStringSubmatch(strings.ReplaceAll(string(src), "$${", ""), -1) {
		if !contains(d.Env, m[1]) && !contains(bad, m[1]) {
			bad = append(bad, m[1])
		}
	}
	refused := func(names []string) error {
		return errf("bridge.yaml 이 이 익스텐션에 허락하지 않은 환경변수를 읽습니다: " + strings.Join(names, ", ") + " (extensions[].env 에 넣어야 합니다)")
	}
	if len(bad) > 0 {
		return refused(bad)
	}
	// The reading itself is held to the names too (REQ-S-088): a value the YAML unescapes (${…}) becomes a
	// reference the text above never showed. Any other name reads as nothing, and the extension does not load.
	allowed := func(name string) string {
		if !contains(d.Env, name) {
			if !contains(bad, name) {
				bad = append(bad, name)
			}
			return ""
		}
		return getenv(name)
	}
	defer func() {
		if len(bad) > 0 {
			err = refused(bad)
		}
	}()
	top := []string{"id", "name", "version", "extensionApi", "entry", "uses", "server"}
	for _, kv := range root.pairs {
		if !contains(top, kv.key) {
			return &yamlErr{kv.line, "모르는 키 " + kv.key + " (받는 키: " + strings.Join(top, ", ") + ")"}
		}
	}
	str := func(n *yNode, where string, need bool) (string, error) {
		if n == nil || n.null {
			if need {
				return "", errf("extension.yaml 에 " + where + " 가 없습니다")
			}
			return "", nil
		}
		if n.kind != yScalar {
			return "", &yamlErr{n.line, where + " 는 값 하나여야 합니다"}
		}
		v, _, err := substEnv(n.raw, n.line, allowed)
		return strings.TrimSpace(v), err
	}
	if d.ID, err = str(root.get("id"), "id", true); err != nil {
		return err
	}
	if !extIdRe.MatchString(d.ID) || d.ID == "errors" {
		id := d.ID
		d.ID = ""
		return errf("id " + id + " 는 쓸 수 없습니다(소문자로 시작하는 소문자·숫자·- 2~32자, errors 는 안 됨)")
	}
	if d.Name, err = str(root.get("name"), "name", true); err != nil {
		return err
	}
	if d.Version, err = str(root.get("version"), "version", true); err != nil {
		return err
	}
	api, err := str(root.get("extensionApi"), "extensionApi", true)
	if err != nil {
		return err
	}
	if d.API, err = strconv.Atoi(api); err != nil || d.API < 1 {
		return errf("extensionApi 는 1 이상의 정수여야 합니다")
	}
	if d.API > EXT_API {
		return errf("extensionApi " + api + " 를 요구하지만 이 서버(" + VERSION + ")는 " + strconv.Itoa(EXT_API) + " 까지예요")
	}
	if d.Entry, err = str(root.get("entry"), "entry", true); err != nil {
		return err
	}
	d.Entry = strings.TrimPrefix(path.Clean("/"+d.Entry), "/")
	if _, ok := files[d.Entry]; !ok || (path.Ext(d.Entry) != ".js" && path.Ext(d.Entry) != ".mjs") {
		return errf("entry " + d.Entry + " 는 폴더 안의 .js·.mjs 파일이어야 합니다")
	}
	d.Actions, d.Slots = []string{}, []string{}
	if u := root.get("uses"); u != nil && !u.null {
		if u.kind != yMap {
			return &yamlErr{u.line, "uses 아래는 actions·slots 목록입니다"}
		}
		for _, kv := range u.pairs {
			var into *[]string
			var known []string
			switch kv.key {
			case "actions":
				into, known = &d.Actions, EXT_ACTIONS
			case "slots":
				into, known = &d.Slots, EXT_SLOTS
			default:
				return &yamlErr{kv.line, "모르는 키 uses." + kv.key + " (받는 키: actions, slots)"}
			}
			if kv.val.kind != yList {
				return &yamlErr{kv.line, "uses." + kv.key + " 는 목록이어야 합니다"}
			}
			for _, x := range kv.val.items {
				if x.kind != yScalar || !contains(known, x.raw) {
					return &yamlErr{x.line, "uses." + kv.key + " 의 " + x.raw + " 는 모르는 이름입니다(받는 이름: " + strings.Join(known, ", ") + ")"}
				}
				*into = append(*into, x.raw)
			}
		}
	}
	d.Routes = []extRoute{}
	d.Hooks = map[string][]hookTarget{}
	if s := root.get("server"); s != nil && !s.null {
		if s.kind != yMap {
			return &yamlErr{s.line, "server 아래는 routes·hooks 입니다"}
		}
		for _, kv := range s.pairs {
			switch kv.key {
			case "routes":
				if err := d.readRoutes(kv.val, allowed); err != nil {
					return err
				}
			case "hooks":
				if err := d.readHooks(kv.val, allowed); err != nil {
					return err
				}
			default:
				return &yamlErr{kv.line, "모르는 키 server." + kv.key + " (받는 키: routes, hooks)"}
			}
		}
	}
	return nil
}

func (d *extDef) readRoutes(n *yNode, getenv func(string) string) error {
	if n.kind != yList {
		return &yamlErr{n.line, "server.routes 는 목록이어야 합니다"}
	}
	fields := []string{"path", "upstream", "signingSecret", "headers"}
	for _, it := range n.items {
		if it.kind != yMap {
			return &yamlErr{it.line, "server.routes[] 의 항목은 \"키: 값\" 이어야 합니다"}
		}
		for _, kv := range it.pairs {
			if !contains(fields, kv.key) {
				return &yamlErr{kv.line, "모르는 키 server.routes[]." + kv.key + " (받는 키: " + strings.Join(fields, ", ") + ")"}
			}
		}
		one := func(f string) (string, int, error) {
			x := it.get(f)
			if x == nil || x.null || x.kind != yScalar {
				return "", it.line, &yamlErr{it.line, "server.routes[] 에 " + f + " 가 없습니다"}
			}
			v, _, err := substEnv(x.raw, x.line, getenv)
			return strings.TrimSpace(v), x.line, err
		}
		r := extRoute{}
		var line int
		var err error
		if r.Path, line, err = one("path"); err != nil {
			return err
		}
		if !extPathRe.MatchString(r.Path) || strings.Contains(r.Path, "/../") || strings.Contains(r.Path, "/./") {
			return &yamlErr{line, "server.routes[].path 는 / 로 시작하고 끝나야 합니다(예: /docs/): " + r.Path}
		}
		for _, o := range d.Routes {
			if strings.HasPrefix(r.Path, o.Path) || strings.HasPrefix(o.Path, r.Path) {
				return &yamlErr{line, "server.routes[].path " + r.Path + " 가 " + o.Path + " 와 겹칩니다"}
			}
		}
		if r.Upstream, line, err = one("upstream"); err != nil {
			return err
		}
		pu, perr := url.Parse(r.Upstream)
		if perr != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" || pu.User != nil || pu.RawQuery != "" || pu.Fragment != "" {
			return &yamlErr{line, "server.routes[].upstream 은 http(s)://호스트/경로 모양이어야 합니다: " + rawOrigin(r.Upstream)}
		}
		if !strings.HasSuffix(r.Upstream, "/") {
			r.Upstream += "/"
		}
		if r.Secret, line, err = one("signingSecret"); err != nil {
			return err
		}
		if len(r.Secret) < 16 {
			return &yamlErr{line, "server.routes[].signingSecret 은 16자 이상이어야 합니다"}
		}
		if h := it.get("headers"); h != nil && !h.null {
			if h.kind != yMap {
				return &yamlErr{h.line, "server.routes[].headers 아래는 \"헤더: 값\" 이어야 합니다"}
			}
			for _, kv := range h.pairs {
				if !headerNameRe.MatchString(kv.key) || extHeaderNo.MatchString(kv.key) {
					return &yamlErr{kv.line, "server.routes[].headers 에 " + kv.key + " 는 쓸 수 없습니다"}
				}
				if kv.val.kind != yScalar {
					return &yamlErr{kv.line, "server.routes[].headers." + kv.key + " 는 값 하나여야 합니다"}
				}
				// ${user.KEY} stays for each request (the person's secret); everything else is read now.
				raw := strings.ReplaceAll(kv.val.raw, "${user.", "$${user.")
				v, _, err := substEnv(raw, kv.val.line, getenv)
				if err != nil {
					return err
				}
				for _, m := range userRefRe.FindAllStringSubmatch(v, -1) {
					if !extKeyRe.MatchString(m[1]) {
						return &yamlErr{kv.val.line, "${user." + m[1] + "} 의 이름은 쓸 수 없습니다"}
					}
				}
				r.Headers = append(r.Headers, [2]string{kv.key, v})
			}
		}
		d.Routes = append(d.Routes, r)
	}
	return nil
}

var (
	userRefRe = regexp.MustCompile(`\$\{user\.([^}]*)\}`)
	envRefRe  = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-)?\}`)
)

// readHooks: an extension's server hooks are after hooks and webhooks only (before and exec are the operator's,
// in bridge.yaml: a person taking back consent must not turn a guardrail off).
func (d *extDef) readHooks(n *yNode, getenv func(string) string) error {
	if n.kind != yMap {
		return &yamlErr{n.line, "server.hooks 아래는 \"훅 이름: 목록\" 이어야 합니다"}
	}
	for _, p := range n.pairs {
		base, ok := strings.CutSuffix(p.key, ".after")
		if !ok || !(contains(HOOK_ACTIONS, base) || contains(HOOK_EVENTS, base)) {
			return &yamlErr{p.line, "server.hooks 의 " + p.key + " 는 쓸 수 없습니다(익스텐션은 <액션·이벤트>.after 만)"}
		}
		if p.val.kind != yList {
			return &yamlErr{p.line, "server.hooks." + p.key + " 는 목록이어야 합니다"}
		}
		for _, it := range p.val.items {
			t, err := readHookTarget(p.key, it, getenv)
			if err != nil {
				return err
			}
			if t.Type != "webhook" {
				return &yamlErr{it.line, "익스텐션의 훅은 webhook 만 씁니다(exec 는 bridge.yaml 의 hooks 에서)"}
			}
			d.Hooks[p.key] = append(d.Hooks[p.key], t)
		}
	}
	return nil
}

// ---------- consent ----------

func consentPath(uid string) string { return filepath.Join(userDir(uid), "ext-consent.json") }

// consentOf: the hash this person agreed to for each extension.
func consentOf(uid string) M {
	if m, ok := readJSON(consentPath(uid), M{}).(M); ok {
		return m
	}
	return M{}
}

// agreed: the extension may run for this person (its hash agreed to, or consent turned off for this server). The
// demo account never runs one.
func agreed(uid string, d *extDef) bool {
	if d == nil || d.Err != "" || isDemoUid(uid) {
		return false
	}
	if !cfgOn("extensionConsent") {
		return true
	}
	return consentOf(uid)[d.ID] == d.Hash
}

// extList: GET /api/ext and /api/me's extensions.
func extList(uid string) []any {
	out := []any{}
	if isDemoUid(uid) {
		return out
	}
	c := consentOf(uid)
	for _, d := range EXTS {
		routes := []any{}
		for _, r := range d.Routes {
			routes = append(routes, orderedObj{{"path", r.Path}, {"upstream", rawOrigin(r.Upstream)}})
		}
		hooks := []any{}
		for name, ts := range d.Hooks {
			for _, t := range ts {
				hooks = append(hooks, orderedObj{{"name", name}, {"url", rawOrigin(t.URLText)}})
			}
		}
		sort.Slice(hooks, func(i, j int) bool { return jsonStr(hooks[i]) < jsonStr(hooks[j]) })
		o := orderedObj{{"id", d.ID}, {"name", d.Name}, {"version", d.Version}, {"entry", "/ext/" + d.ID + "/" + d.Hash + "/" + d.Entry}, {"hash", d.Hash},
			{"extensionApi", d.API}, {"uses", orderedObj{{"actions", d.Actions}, {"slots", d.Slots}}}, {"routes", routes}, {"hooks", hooks}, {"storesData", true},
			{"consented", d.Err == "" && (!cfgOn("extensionConsent") || c[d.ID] == d.Hash)}}
		if d.Err != "" {
			o = append(o, kv{"loadError", d.Err})
		}
		if isAdmin(uid) {
			errs := []any{}
			for _, e := range extErrors[d.ID] {
				errs = append(errs, e)
			}
			o = append(o, kv{"errors", errs}) // 운영 탭: what the pages reported, newest last
		}
		out = append(out, o)
	}
	return out
}

// ---------- /ext/<id>/<hash>/<file> ----------

var extFileRe = regexp.MustCompile(`^/ext/([a-z][a-z0-9-]{1,31})/([0-9a-f]{16})/(.+)$`)

// serveExt: an extension's file, to a signed-in person who agreed to that very hash. Only script, style, data,
// picture and font files; nosniff on every answer.
func serveExt(req *Req, res *Res, p string) bool {
	if !strings.HasPrefix(p, "/ext/") {
		return false
	}
	serveExtAs(res, p, whoami(req))
	return true
}

func serveExtAs(res *Res, p, uid string) bool {
	no := func(code int) bool {
		res.WriteHead(code, M{"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}).EndS("not found")
		return true
	}
	m := extFileRe.FindStringSubmatch(p)
	if m == nil {
		return no(404)
	}
	if uid == "" {
		return no(401)
	}
	d := extByID(m[1])
	if d == nil || d.Hash != m[2] {
		return no(404) // an old hash: its files are gone (the page reloads on ext-reload)
	}
	if !agreed(uid, d) {
		return no(403)
	}
	name := path.Clean("/" + m[3])[1:]
	typ, ok := EXT_FILE_TYPES[strings.ToLower(path.Ext(name))]
	b, has := d.Files[name]
	if !ok || !has {
		return no(404)
	}
	cache := "private, max-age=31536000, immutable"
	if EXT_DEV {
		cache = "no-store"
	}
	res.WriteHead(200, SECURITY, M{"Content-Type": typ, "Cache-Control": cache, "X-Content-Type-Options": "nosniff"}).End(b)
	return true
}

// ---------- errors ----------

// extErrors: the latest page errors each extension reported (운영 탭), newest last; never the conversation.
var extErrors = map[string][]orderedObj{}

func noteExtError(id, uid, msg, stack string) {
	cut := func(s string, n int) string {
		if len(s) > n {
			return s[:n]
		}
		return s
	}
	e := orderedObj{{"at", nowMs()}, {"uid", uid}, {"message", cut(msg, 1024)}, {"stack", cut(stack, 1024)}}
	l := append(extErrors[id], e)
	if len(l) > 50 {
		l = l[len(l)-50:]
	}
	extErrors[id] = l
}

// ---------- development ----------

// EXT_DEV (BRIDGE_EXT_DEV=1): files served with no-store, folders read again every two seconds; a changed hash
// tells every open page to load again (ext-reload), and consent is asked again for the new hash.
var EXT_DEV bool

func startExtDev(getenv func(string) string) {
	if !EXT_DEV || len(EXTS) == 0 {
		return
	}
	setInterval(2*time.Second, func() {
		changed := false
		var entries []extEntry
		for _, d := range EXTS {
			entries = append(entries, extEntry{Path: d.Dir, Env: d.Env})
		}
		next := loadExtensions(entries, getenv)
		for i, d := range next {
			if d.Hash != EXTS[i].Hash || d.Err != EXTS[i].Err {
				changed = true
			}
		}
		if changed {
			EXTS = next
			extReload()
		}
	})
}

// extReload: every open page loads its extensions again.
func extReload() {
	for uid := range controls {
		for _, s := range controlsOf(uid) {
			sse(s, M{"t": "ext-reload"})
		}
	}
}

// ---------- API ----------

var extApiRe = regexp.MustCompile(`^/api/ext(?:/([a-z][a-z0-9-]{1,31}))?(/.*)?$`)

// apiExt: /api/ext and below (REQ-F-825). Every request carries X-Bridge-Ext: 1 (no other site can add it without a
// preflight), and is counted per person and extension (120 a minute).
func apiExt(req *Req, res *Res, u *url.URL, uid string) bool {
	m := extApiRe.FindStringSubmatch(u.Path)
	if m == nil {
		return false
	}
	if req.H("x-bridge-ext") != "1" {
		refuse(403, "X-Bridge-Ext 헤더가 없습니다")
	}
	if isDemoUid(uid) {
		refuse(403, "데모 계정은 익스텐션을 쓰지 않아요")
	}
	if req.Method == "PUT" && !strings.HasPrefix(ctype(req), "application/json") {
		refuse(415, "application/json 만 받습니다")
	}
	id, rest := m[1], m[2]
	if id == "" && rest == "" && req.Method == "GET" {
		jsonRes(res, 200, M{"ok": true, "extensions": extList(uid)})
		return true
	}
	if id == "errors" && rest == "" && req.Method == "POST" {
		if hit("ext-errors|"+uid, 10) {
			refuse(429, "오류 보고가 너무 많아요")
		}
		b := body(req, 8192)
		eid := mstr(b, "id")
		if extByID(eid) == nil {
			refuse(404, "모르는 익스텐션이에요")
		}
		noteExtError(eid, uid, mstr(b, "message"), mstr(b, "stack"))
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	d := extByID(id)
	if d == nil {
		refuse(404, "모르는 익스텐션이에요")
	}
	if hit("ext|"+uid+"|"+id, 120) {
		refuse(429, "익스텐션 요청이 너무 많아요. 잠시 뒤에 다시 해 주세요")
	}
	if rest == "/consent" {
		c := consentOf(uid)
		switch req.Method {
		case "POST":
			if mstr(body(req, 4096), "hash") != d.Hash {
				refuse(409, "익스텐션이 바뀌었어요. 다시 확인해 주세요")
			}
			c[d.ID] = d.Hash
		case "DELETE":
			delete(c, d.ID)
		default:
			refuse(405, "지원하지 않는 메서드예요")
		}
		writeJson(consentPath(uid), c)
		jsonRes(res, 200, M{"ok": true})
		return true
	}
	if !agreed(uid, d) {
		refuse(403, "이 익스텐션에 동의하지 않았어요")
	}
	extApiAgreed(req, res, u, uid, d, rest)
	return true
}
