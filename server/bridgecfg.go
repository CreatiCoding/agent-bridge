package main

// bridge.yaml (REQ-F-809): the server's settings file, read once at start in configure() (before the
// handover, so a wrong file leaves the old instance working). Environment variables stay the defaults of
// the keys that mean the same; the file wins. A key whose value is exactly a reference to its own
// environment variable ("${BRIDGE_ADMIN_LOGINS:-}") is read with that variable's rules, so an exported
// file means the same as the environment it came from and follows later edits of it.

import (
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// cfgKey: a key the file takes. The first four have an environment variable of the same meaning (the table in
// SPEC REQ-F-809); the rest have none and fall back to def, which is today's behaviour (REQ-F-812).
type cfgKey struct {
	key  string // dotted, as in the file
	env  string // "" when no environment variable means the same
	kind string // origin | list | purge | bool | hours | path | modes | src | origins | providers | notify
	def  any    // the value when neither the file nor an environment variable gives one (env keys: unused)
}

var CFG_KEYS = []cfgKey{
	{"origins.primary", "BRIDGE_ORIGIN", "origin", nil},
	{"auth.allow", "GITHUB_ALLOWED_LOGINS", "list", nil},
	{"auth.admins", "BRIDGE_ADMIN_LOGINS", "list", nil},
	{"retention.allowPurge", "BRIDGE_PURGE", "purge", nil},
	{"retention.uploadsHours", "", "hours", 24},
	{"retention.previews", "", "bool", true},
	{"features.sessionMove", "", "bool", true},
	{"features.webpush", "", "bool", true},
	{"features.voice", "", "bool", true},
	{"features.preview", "", "bool", true},
	{"features.skills", "", "bool", true},
	{"features.slack", "", "bool", true},
	{"features.remoteKeys", "", "bool", true},
	{"features.permissionModes", "", "modes", LAUNCH_MODES},
	{"csp.frameSrc", "", "src", []string{}},
	{"csp.imgSrc", "", "src", []string{}},
	{"privacy.file", "", "path", ""},
	{"origins.extra", "", "origins", []string{}},
	{"auth.providers", "", "providers", []authProvider{}},
	{"auth.headerOnly", "", "bool", false},
	{"notify", "", "notify", []notifyTarget{}}, // a top-level list: no dot
}

// cfgKeyOf: the key by its dotted name (the rest of the server reads values through cfgGet).
func cfgKeyOf(name string) cfgKey {
	for _, k := range CFG_KEYS {
		if k.key == name {
			return k
		}
	}
	panic("bridge.yaml 키가 아님: " + name)
}

// cfgGet: a key's value on this server (file over environment over the default). Before configure() ran, the default.
func cfgGet(name string) any {
	k := cfgKeyOf(name)
	if CONFIG == nil {
		return envOnly(k, func(string) string { return "" })
	}
	return CONFIG.effective(k, env)
}

func cfgOn(name string) bool { return cfgGet(name).(bool) }

// cfgVal: one key's value after reading (string, []string or bool) and whether the file wrote it as a
// reference to its own environment variable somewhere (then edits of that variable still reach it).
type cfgVal struct {
	v      any
	refEnv bool
}

type bridgeCfg struct {
	path  string // the file read, "" when none
	state string // none | empty | file
	set   map[string]cfgVal
}

// cfgDiff: a key whose value differs from what the environment alone gives (the check list, the warnings).
type cfgDiff struct {
	Key    string
	Env    string
	File   string // the file's value as text
	EnvVal string // the environment's value as text ("" when unset)
	RefEnv bool
	EnvSet bool
}

var (
	CONFIG      *bridgeCfg
	CONFIG_DIFF []cfgDiff
	PURGE       bool
)

var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var originRe = regexp.MustCompile(`^https?://[^/\s?#@]+$`)

// configPath: where the file is and whether the operator named it (BRIDGE_CONFIG must be absolute).
func configPath(data string, getenv func(string) string) (string, bool, error) {
	p := getenv("BRIDGE_CONFIG")
	if p == "" {
		return filepath.Join(data, "bridge.yaml"), false, nil
	}
	if !filepath.IsAbs(p) {
		return "", true, errf("BRIDGE_CONFIG 는 절대 경로여야 합니다(지금 값: " + p + ")")
	}
	return filepath.Clean(p), true, nil
}

func errf(s string) error { return &yamlErr{0, s} }

// emptyCfgText: nothing but blank lines and comments (a mount point left in the volume is 0 bytes).
func emptyCfgText(b []byte) bool {
	for _, l := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(strings.TrimPrefix(l, "\ufeff"))
		if t != "" && !strings.HasPrefix(t, "#") {
			return false
		}
	}
	return true
}

// loadBridgeConfig finds, reads and checks the file. A missing default file, or an empty one, is no file.
func loadBridgeConfig(data string, getenv func(string) string) (*bridgeCfg, error) {
	p, named, err := configPath(data, getenv)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) && !named {
			return &bridgeCfg{state: "none", set: map[string]cfgVal{}}, nil
		}
		if os.IsNotExist(err) {
			return nil, errf("BRIDGE_CONFIG 의 파일이 없습니다: " + p + " (마운트가 빠졌는지 보세요)")
		}
		return nil, errf("설정 파일을 볼 수 없습니다: " + p + " (" + err.Error() + ")")
	}
	if st.IsDir() {
		return nil, errf("설정 파일 자리가 폴더입니다: " + p + " (없는 파일을 -v 로 마운트하면 Docker 가 폴더를 만듭니다)")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, errf("설정 파일을 읽지 못했습니다: " + p + " (" + err.Error() + ")")
	}
	return parseBridgeConfig(p, b, getenv)
}

// parseBridgeConfig checks the text against the keys this version knows and reads their values.
func parseBridgeConfig(p string, b []byte, getenv func(string) string) (*bridgeCfg, error) {
	c := &bridgeCfg{path: p, state: "empty", set: map[string]cfgVal{}}
	if emptyCfgText(b) {
		return c, nil
	}
	root, err := parseYAML(b)
	if err != nil {
		return nil, err
	}
	if root == nil {
		return c, nil
	}
	c.state = "file"
	known := map[string][]string{}
	top := map[string]bool{} // keys that are a whole section (notify)
	order := []string{}
	for _, k := range CFG_KEYS {
		sec, name, dotted := strings.Cut(k.key, ".")
		if _, ok := known[sec]; !ok {
			order = append(order, sec)
		}
		if !dotted {
			top[sec] = true
			known[sec] = nil
			continue
		}
		known[sec] = append(known[sec], name)
	}
	keys := func() string {
		out := []string{}
		for _, s := range order {
			if top[s] {
				out = append(out, s)
			}
			for _, n := range known[s] {
				out = append(out, s+"."+n)
			}
		}
		return strings.Join(out, ", ")
	}
	for _, sec := range root.pairs {
		names, ok := known[sec.key]
		if !ok {
			return nil, &yamlErr{sec.line, "모르는 키 " + sec.key + " (이 서버(" + VERSION + ")가 받는 키: " + keys() + ")"}
		}
		if top[sec.key] || (sec.val.kind == yScalar && sec.val.null) {
			continue // `retention:` with nothing under it is the section left out; notify is read below
		}
		if sec.val.kind != yMap {
			return nil, &yamlErr{sec.line, sec.key + " 아래는 \"키: 값\" 이어야 합니다"}
		}
		for _, kv := range sec.val.pairs {
			if !contains(names, kv.key) {
				return nil, &yamlErr{kv.line, "모르는 키 " + sec.key + "." + kv.key + " (이 서버(" + VERSION + ")가 받는 키: " + keys() + ")"}
			}
		}
	}
	for _, k := range CFG_KEYS {
		sec, name, dotted := strings.Cut(k.key, ".")
		n := root.get(sec)
		if dotted {
			n = n.get(name)
		}
		if n == nil || (n.kind == yScalar && n.null) {
			continue
		}
		v, ok, err := readCfgKey(k, n, getenv)
		if err != nil {
			return nil, err
		}
		if ok {
			if k.kind == "path" && !filepath.IsAbs(v.v.(string)) {
				v.v = filepath.Join(filepath.Dir(p), v.v.(string)) // relative to the settings file's folder
			}
			c.set[k.key] = v
		}
	}
	if err := c.crossCheck(root, getenv); err != nil {
		return nil, err
	}
	return c, nil
}

// crossCheck: rules between keys (REQ-F-814, REQ-F-815). More origins need sign-in by header, because the sign-in
// cookie is host-only and OAuth comes back to the primary origin alone.
func (c *bridgeCfg) crossCheck(root *yNode, getenv func(string) string) error {
	extra, _ := c.set["origins.extra"].v.([]string)
	provs, _ := c.set["auth.providers"].v.([]authProvider)
	line := func(sec, name string) int {
		if n := root.get(sec).get(name); n != nil {
			return n.line
		}
		return 0
	}
	if only, _ := c.set["auth.headerOnly"].v.(bool); only && len(provs) == 0 {
		return &yamlErr{line("auth", "headerOnly"), "auth.headerOnly 는 auth.providers 에 trusted-header 가 있어야 씁니다(없으면 아무도 들어올 수 없습니다)"}
	}
	if len(extra) > 0 {
		if len(provs) == 0 {
			return &yamlErr{line("origins", "extra"), "origins.extra 는 auth.providers 에 trusted-header 가 있어야 씁니다(OAuth 로그인은 origins.primary 에서만 됩니다)"}
		}
		primary := c.effective(CFG_KEYS[0], getenv).(string)
		if primary == "" {
			return &yamlErr{line("origins", "extra"), "origins.extra 를 쓰려면 origins.primary(또는 BRIDGE_ORIGIN)가 있어야 합니다"}
		}
		for _, o := range extra {
			if hostOfURL(o) == hostOfURL(primary) {
				return &yamlErr{line("origins", "extra"), "origins.extra 의 " + o + " 는 origins.primary 와 같은 호스트입니다"}
			}
		}
	}
	return nil
}

// sameRef: the scalar is exactly a reference to this key's own environment variable.
func sameRef(raw, env string) (bool, bool) {
	if raw == "${"+env+"}" {
		return true, false
	}
	if raw == "${"+env+":-}" {
		return true, true
	}
	return false, false
}

// substEnv resolves ${NAME} (empty refuses start), ${NAME:-} (empty is allowed) and $${ (a literal ${).
// soft: the text used ${NAME:-} and came out empty, which means the value is left out.
func substEnv(raw string, line int, getenv func(string) string) (out string, soft bool, err error) {
	var b strings.Builder
	usedSoft := false
	for i := 0; i < len(raw); {
		if strings.HasPrefix(raw[i:], "$${") {
			b.WriteString("${")
			i += 3
			continue
		}
		if !strings.HasPrefix(raw[i:], "${") {
			b.WriteByte(raw[i])
			i++
			continue
		}
		end := strings.IndexByte(raw[i:], '}')
		if end < 0 {
			return "", false, &yamlErr{line, "${ 가 닫히지 않았습니다(글자 그대로라면 $${ 로 쓰세요)"}
		}
		inner := raw[i+2 : i+end]
		name, allowEmpty := inner, false
		if n, rest, ok := strings.Cut(inner, ":-"); ok {
			if rest != "" {
				return "", false, &yamlErr{line, "${" + inner + "}: 비어 있지 않은 기본값은 받지 않습니다(${" + n + ":-} 만 됩니다)"}
			}
			name, allowEmpty = n, true
		}
		if !envNameRe.MatchString(name) {
			return "", false, &yamlErr{line, "${" + inner + "}: 환경변수 이름이 아닙니다"}
		}
		v := getenv(name)
		if v == "" && !allowEmpty {
			return "", false, &yamlErr{line, "환경변수 " + name + " 가 비어 있습니다(비어도 되면 ${" + name + ":-})"}
		}
		if allowEmpty {
			usedSoft = true
		}
		b.WriteString(v)
		i += end + 1
	}
	out = b.String()
	return out, usedSoft && out == "", nil
}

func scalarOf(k cfgKey, n *yNode) (*yNode, error) {
	if n.kind != yScalar {
		return nil, &yamlErr{n.line, k.key + " 는 값 하나여야 합니다"}
	}
	return n, nil
}

// readCfgKey reads one key. ok=false: the value was a ${NAME:-} that came out empty (left out).
func readCfgKey(k cfgKey, n *yNode, getenv func(string) string) (cfgVal, bool, error) {
	switch k.kind {
	case "origin":
		s, err := scalarOf(k, n)
		if err != nil {
			return cfgVal{}, false, err
		}
		if same, soft := sameRef(s.raw, k.env); same {
			v := strings.TrimRight(getenv(k.env), "/") // the environment's rule (no format check, case kept)
			if v == "" {
				if !soft {
					return cfgVal{}, false, &yamlErr{s.line, "환경변수 " + k.env + " 가 비어 있습니다(비어도 되면 ${" + k.env + ":-})"}
				}
				return cfgVal{}, false, nil
			}
			return cfgVal{v, true}, true, nil
		}
		v, soft, err := substEnv(s.raw, s.line, getenv)
		if err != nil || soft {
			return cfgVal{}, false, err
		}
		v = strings.TrimRight(v, "/")
		if !originRe.MatchString(v) {
			return cfgVal{}, false, &yamlErr{s.line, k.key + " 는 https://호스트[:포트] 모양이어야 합니다(경로 없이)"}
		}
		return cfgVal{v, false}, true, nil
	case "purge":
		s, err := scalarOf(k, n)
		if err != nil {
			return cfgVal{}, false, err
		}
		if same, soft := sameRef(s.raw, k.env); same {
			v := getenv(k.env)
			if v == "" {
				if !soft {
					return cfgVal{}, false, &yamlErr{s.line, "환경변수 " + k.env + " 가 비어 있습니다(비어도 되면 ${" + k.env + ":-})"}
				}
				return cfgVal{}, false, nil
			}
			return cfgVal{v == "1", true}, true, nil // exactly 1, as the environment variable
		}
		v, soft, err := substEnv(s.raw, s.line, getenv)
		if err != nil || soft {
			return cfgVal{}, false, err
		}
		if v != "true" && v != "false" {
			return cfgVal{}, false, &yamlErr{s.line, k.key + " 는 true 나 false 여야 합니다"}
		}
		return cfgVal{v == "true", false}, true, nil
	case "bool", "hours", "path":
		sc, err := scalarOf(k, n)
		if err != nil {
			return cfgVal{}, false, err
		}
		v, soft, err := substEnv(sc.raw, sc.line, getenv)
		if err != nil || soft {
			return cfgVal{}, false, err
		}
		switch k.kind {
		case "bool":
			if v != "true" && v != "false" {
				return cfgVal{}, false, &yamlErr{sc.line, k.key + " 는 true 나 false 여야 합니다"}
			}
			return cfgVal{v == "true", false}, true, nil
		case "hours":
			h, e := strconv.Atoi(v)
			if e != nil || h < 1 || h > 8760 {
				return cfgVal{}, false, &yamlErr{sc.line, k.key + " 는 1 부터 8760 까지의 정수(시간)여야 합니다"}
			}
			return cfgVal{h, false}, true, nil
		}
		if strings.TrimSpace(v) == "" || strings.ContainsAny(v, "\x00\n") {
			return cfgVal{}, false, &yamlErr{sc.line, k.key + " 는 파일 경로여야 합니다"}
		}
		if !strings.HasSuffix(strings.ToLower(v), ".html") {
			return cfgVal{}, false, &yamlErr{sc.line, k.key + " 는 .html 파일이어야 합니다(그대로 웹 페이지로 내줍니다)"}
		}
		return cfgVal{v, false}, true, nil // made absolute against the file's folder in parseBridgeConfig
	}
	switch k.kind {
	case "providers":
		return readProviders(k, n, getenv)
	case "notify":
		return readNotify(k, n, getenv)
	case "origins":
		items, err := plainList(k, n, getenv)
		if err != nil {
			return cfgVal{}, false, err
		}
		out := []string{}
		for _, o := range items {
			o = strings.ToLower(strings.TrimRight(o, "/"))
			if !originRe.MatchString(o) {
				return cfgVal{}, false, &yamlErr{n.line, k.key + " 의 " + o + " 는 https://호스트[:포트] 모양이어야 합니다(경로 없이)"}
			}
			if !contains(out, o) {
				out = append(out, o)
			}
		}
		return cfgVal{out, false}, true, nil
	}
	// list: a scalar (a reference or a comma list) or a list whose items may be references.
	if n.kind == yScalar {
		if same, soft := sameRef(n.raw, k.env); same {
			v := getenv(k.env)
			if v == "" {
				if !soft {
					return cfgVal{}, false, &yamlErr{n.line, "환경변수 " + k.env + " 가 비어 있습니다(비어도 되면 ${" + k.env + ":-})"}
				}
				return cfgVal{}, false, nil
			}
			return cfgVal{splitList(v), true}, true, nil
		}
		v, soft, err := substEnv(n.raw, n.line, getenv)
		if err != nil || soft {
			return cfgVal{}, false, err
		}
		return checkList(k, n.line, splitListCase(v, k.kind == "list"), false)
	}
	if n.kind != yList {
		return cfgVal{}, false, &yamlErr{n.line, k.key + " 는 목록이어야 합니다"}
	}
	out, ref := []string{}, false
	for _, it := range n.items {
		if it.kind != yScalar || it.null {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 의 항목은 글자여야 합니다"}
		}
		if same, soft := sameRef(it.raw, k.env); same {
			ref = true
			v := getenv(k.env)
			if v == "" && !soft {
				return cfgVal{}, false, &yamlErr{it.line, "환경변수 " + k.env + " 가 비어 있습니다(비어도 되면 ${" + k.env + ":-})"}
			}
			out = append(out, splitList(v)...)
			continue
		}
		v, soft, err := substEnv(it.raw, it.line, getenv)
		if err != nil {
			return cfgVal{}, false, err
		}
		if soft {
			continue
		}
		v = strings.TrimSpace(v)
		if k.kind == "list" {
			v = strings.ToLower(v) // logins; modes and CSP sources keep their case
		}
		if v == "" {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 에 빈 항목이 있습니다"}
		}
		if !contains(out, v) {
			out = append(out, v)
		}
	}
	return checkList(k, n.line, out, ref)
}

var cspSrcRe = regexp.MustCompile(`^https://(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?(/[A-Za-z0-9._~%/-]*)?$`)

// checkList: what a list key's items may be. Permission modes are this server's launch modes and always hold
// default; CSP sources are https origins (a path is allowed), so nothing can add a quote, a ; or a keyword.
func checkList(k cfgKey, line int, items []string, ref bool) (cfgVal, bool, error) {
	switch k.kind {
	case "modes":
		out := []string{"default"}
		for _, m := range items {
			if !contains(LAUNCH_MODES, m) {
				return cfgVal{}, false, &yamlErr{line, k.key + " 의 " + m + " 는 모르는 모드입니다(받는 모드: " + strings.Join(LAUNCH_MODES, ", ") + ")"}
			}
			if !contains(out, m) {
				out = append(out, m)
			}
		}
		return cfgVal{out, ref}, true, nil
	case "src":
		for _, x := range items {
			if !cspSrcRe.MatchString(x) {
				return cfgVal{}, false, &yamlErr{line, k.key + " 의 " + x + " 는 https://호스트[:포트][/경로] 모양이어야 합니다"}
			}
		}
	}
	return cfgVal{items, ref}, true, nil
}

// splitListCase: splitList that keeps the case (modes, CSP sources).
func splitListCase(s string, lower bool) []string {
	if lower {
		return splitList(s)
	}
	out := []string{}
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" && !contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

// envOnly: what the environment alone gives for a key (today's rules).
func envOnly(k cfgKey, getenv func(string) string) any {
	if k.env == "" {
		return k.def
	}
	switch k.kind {
	case "origin":
		return strings.TrimRight(getenv(k.env), "/")
	case "purge":
		return getenv(k.env) == "1"
	}
	return splitList(getenv(k.env))
}

func cfgText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case []string:
		return strings.Join(x, ",")
	case int:
		return itoa(x)
	}
	return ""
}

// effective: the value of each key with the file over the environment.
func (c *bridgeCfg) effective(k cfgKey, getenv func(string) string) any {
	if v, ok := c.set[k.key]; ok {
		return v.v
	}
	return envOnly(k, getenv)
}

// diffs: keys where the file changes what the environment alone gives.
func (c *bridgeCfg) diffs(getenv func(string) string) []cfgDiff {
	out := []cfgDiff{}
	for _, k := range CFG_KEYS {
		v, ok := c.set[k.key]
		if !ok || k.env == "" {
			continue
		}
		f, e := cfgText(v.v), cfgText(envOnly(k, getenv))
		if f != e {
			out = append(out, cfgDiff{Key: k.key, Env: k.env, File: f, EnvVal: e, RefEnv: v.refEnv, EnvSet: getenv(k.env) != ""})
		}
	}
	return out
}

// readableBy: whether uid/gid can read the file, from its mode and the folders above (the server reads the
// file as root in configure() and then runs as node, REQ-F-809).
func readableBy(p string, uid, gid int) bool {
	ok := func(st os.FileInfo, bit os.FileMode) bool {
		s, isSys := st.Sys().(*syscall.Stat_t)
		if !isSys {
			return true
		}
		m := st.Mode().Perm()
		switch {
		case int(s.Uid) == uid:
			return m&(bit<<6) != 0
		case int(s.Gid) == gid:
			return m&(bit<<3) != 0
		}
		return m&bit != 0
	}
	st, err := os.Stat(p)
	if err != nil || !ok(st, 0o4) {
		return false
	}
	for d := filepath.Dir(p); ; d = filepath.Dir(d) {
		if ds, err := os.Stat(d); err != nil || !ok(ds, 0o1) {
			return false
		}
		if d == filepath.Dir(d) {
			return true
		}
	}
}

// inside: p is dir or under it, by whole path parts.
func inside(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// files: the settings file and the files it names (privacy.file), as absolute paths.
func (c *bridgeCfg) files() []string {
	out := []string{}
	if c.path != "" {
		out = append(out, c.path)
	}
	if v, ok := c.set["privacy.file"]; ok {
		out = append(out, v.v.(string))
	}
	return out
}

// prepareConfigFile makes a settings file (or one it names) readable by the user the server will run as, before
// the handover. Inside DATA it tries to hand the file to node once (a failure is not counted: a read-only mount
// must not keep the whole server root). Outside DATA it never changes anything. Then it checks the read.
func prepareConfigFile(p, data string, getenv func(string) string, proc procOps) error {
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return errf("설정이 가리키는 파일이 없습니다: " + p)
	}
	if proc.getuid() != 0 || getenv("BRIDGE_RUN_AS_ROOT") == "1" {
		f, err := os.Open(p) // already the user that will keep running: just try
		if err != nil {
			return errf("설정이 가리키는 파일을 읽을 수 없습니다: " + p + " (" + err.Error() + ")")
		}
		_ = f.Close()
		return nil
	}
	if inside(p, data) {
		_ = os.Lchown(p, NODE_UID, NODE_GID)
	}
	if !readableBy(p, NODE_UID, NODE_GID) {
		return errf("설정이 가리키는 파일을 서버 사용자(uid " + itoa(NODE_UID) + ")가 읽을 수 없습니다: " + p + " (권한을 0644 로 하거나 소유자를 바꾸세요)")
	}
	return nil
}

// configFailed: the settings file stops this start. Say why on stderr and leave config-error.json for the
// instance that keeps running (it is root here and that one is node, so the file goes to DATA's owner).
func configFailed(err error) {
	errorLine("설정 파일 오류로 시작하지 않습니다: " + err.Error())
	st, e := os.Stat(DATA)
	if e != nil || !st.IsDir() {
		return
	}
	p, _, _ := configPath(DATA, env)
	f := filepath.Join(DATA, "config-error.json")
	tmp := f + "." + randHex(4) + ".tmp"
	if os.WriteFile(tmp, jsonBytes(M{"at": nowMs(), "version": VERSION, "path": p, "errors": []any{err.Error()}}), 0o600) != nil {
		return
	}
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(tmp, int(s.Uid), int(s.Gid))
	}
	_ = os.Rename(tmp, f)
}

// plainList: a list key with no environment variable of the same meaning: a list of scalars, or one scalar with
// commas. ${NAME:-} items that come out empty are left out; case is kept.
func plainList(k cfgKey, n *yNode, getenv func(string) string) ([]string, error) {
	if n.kind == yScalar {
		v, soft, err := substEnv(n.raw, n.line, getenv)
		if err != nil || soft {
			return nil, err
		}
		return splitListCase(v, false), nil
	}
	if n.kind != yList {
		return nil, &yamlErr{n.line, k.key + " 는 목록이어야 합니다"}
	}
	out := []string{}
	for _, it := range n.items {
		if it.kind != yScalar || it.null {
			return nil, &yamlErr{it.line, k.key + " 의 항목은 글자여야 합니다"}
		}
		v, soft, err := substEnv(it.raw, it.line, getenv)
		if err != nil {
			return nil, err
		}
		if v = strings.TrimSpace(v); soft {
			continue
		}
		if v == "" {
			return nil, &yamlErr{it.line, k.key + " 에 빈 항목이 있습니다"}
		}
		out = append(out, v)
	}
	return out, nil
}

// authProvider: one entry of auth.providers. Only trusted-header for now (REQ-F-814): a proxy in front (an SSO
// gate) says who the person is in userHeader, and proves it is that proxy with secretHeader and its address.
type authProvider struct {
	Type         string
	UserHeader   string
	SecretHeader string
	Secret       string
	TrustFrom    []*net.IPNet
	TrustText    []string // as written, for screens
}

var headerNameRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// readProviders: auth.providers, a list of maps. Every field is required; secret is at least 16 letters.
func readProviders(k cfgKey, n *yNode, getenv func(string) string) (cfgVal, bool, error) {
	if n.kind != yList {
		return cfgVal{}, false, &yamlErr{n.line, k.key + " 는 목록이어야 합니다(- type: trusted-header ...)"}
	}
	fields := []string{"type", "userHeader", "secretHeader", "secret", "trustFrom"}
	out := []authProvider{}
	for _, it := range n.items {
		if it.kind != yMap {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 의 항목은 \"키: 값\" 이어야 합니다"}
		}
		for _, kv := range it.pairs {
			if !contains(fields, kv.key) {
				return cfgVal{}, false, &yamlErr{kv.line, "모르는 키 " + k.key + "[]." + kv.key + " (받는 키: " + strings.Join(fields, ", ") + ")"}
			}
		}
		one := func(name string) (string, int, error) {
			f := it.get(name)
			if f == nil || f.null {
				return "", it.line, &yamlErr{it.line, k.key + " 의 항목에 " + name + " 가 없습니다"}
			}
			if f.kind != yScalar {
				return "", f.line, &yamlErr{f.line, k.key + "[]." + name + " 는 값 하나여야 합니다"}
			}
			v, soft, err := substEnv(f.raw, f.line, getenv)
			if err == nil && (soft || strings.TrimSpace(v) == "") {
				err = &yamlErr{f.line, k.key + "[]." + name + " 가 비어 있습니다"}
			}
			return strings.TrimSpace(v), f.line, err
		}
		typ, line, err := one("type")
		if err != nil {
			return cfgVal{}, false, err
		}
		if typ != "trusted-header" {
			return cfgVal{}, false, &yamlErr{line, k.key + "[].type 의 " + typ + " 는 모르는 제공자입니다(받는 값: trusted-header)"}
		}
		if len(out) > 0 {
			return cfgVal{}, false, &yamlErr{line, "trusted-header 는 하나만 둘 수 있습니다"}
		}
		p := authProvider{Type: typ}
		for _, h := range []struct {
			name string
			to   *string
		}{{"userHeader", &p.UserHeader}, {"secretHeader", &p.SecretHeader}} {
			v, line, err := one(h.name)
			if err != nil {
				return cfgVal{}, false, err
			}
			if !headerNameRe.MatchString(v) || strings.EqualFold(v, "cookie") || strings.EqualFold(v, "host") {
				return cfgVal{}, false, &yamlErr{line, k.key + "[]." + h.name + " 는 헤더 이름이어야 합니다(영문·숫자·-, Cookie·Host 는 안 됨)"}
			}
			*h.to = v
		}
		if strings.EqualFold(p.UserHeader, p.SecretHeader) {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 의 userHeader 와 secretHeader 는 달라야 합니다"}
		}
		sec, line, err := one("secret")
		if err != nil {
			return cfgVal{}, false, err
		}
		if len(sec) < 16 {
			return cfgVal{}, false, &yamlErr{line, k.key + "[].secret 은 16자 이상이어야 합니다"}
		}
		p.Secret = sec
		tf := it.get("trustFrom")
		if tf == nil || tf.null {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 의 항목에 trustFrom 이 없습니다(프록시의 주소, 예: [10.0.0.0/8])"}
		}
		items, err := plainList(cfgKey{key: k.key + "[].trustFrom"}, tf, getenv)
		if err != nil {
			return cfgVal{}, false, err
		}
		if len(items) == 0 {
			return cfgVal{}, false, &yamlErr{tf.line, k.key + "[].trustFrom 이 비어 있습니다"}
		}
		for _, x := range items {
			cidr := x
			if !strings.Contains(x, "/") {
				if ip := net.ParseIP(x); ip != nil && ip.To4() != nil {
					cidr = x + "/32"
				} else {
					cidr = x + "/128"
				}
			}
			_, nw, e := net.ParseCIDR(cidr)
			if e != nil {
				return cfgVal{}, false, &yamlErr{tf.line, k.key + "[].trustFrom 의 " + x + " 는 IP 주소나 CIDR(10.0.0.0/8)이어야 합니다"}
			}
			p.TrustFrom = append(p.TrustFrom, nw)
			p.TrustText = append(p.TrustText, x)
		}
		out = append(out, p)
	}
	return cfgVal{out, false}, true, nil
}
