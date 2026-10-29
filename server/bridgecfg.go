package main

// bridge.yaml (REQ-F-809): the server's settings file, read once at start in configure() (before the
// handover, so a wrong file leaves the old instance working). Environment variables stay the defaults of
// the keys that mean the same; the file wins. A key whose value is exactly a reference to its own
// environment variable ("${BRIDGE_ADMIN_LOGINS:-}") is read with that variable's rules, so an exported
// file means the same as the environment it came from and follows later edits of it.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// cfgKey: a key that has an environment variable of the same meaning (the table in SPEC §5.1 of the design).
type cfgKey struct {
	key  string // dotted, as in the file
	env  string
	kind string // origin | list | purge
}

var CFG_KEYS = []cfgKey{
	{"origins.primary", "BRIDGE_ORIGIN", "origin"},
	{"auth.allow", "GITHUB_ALLOWED_LOGINS", "list"},
	{"auth.admins", "BRIDGE_ADMIN_LOGINS", "list"},
	{"retention.allowPurge", "BRIDGE_PURGE", "purge"},
}

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
	order := []string{}
	for _, k := range CFG_KEYS {
		sec, name, _ := strings.Cut(k.key, ".")
		if _, ok := known[sec]; !ok {
			order = append(order, sec)
		}
		known[sec] = append(known[sec], name)
	}
	keys := func() string {
		out := []string{}
		for _, s := range order {
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
		if sec.val.kind == yScalar && sec.val.null {
			continue // `retention:` with nothing under it is the section left out
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
		sec, name, _ := strings.Cut(k.key, ".")
		n := root.get(sec).get(name)
		if n == nil || (n.kind == yScalar && n.null) {
			continue
		}
		v, ok, err := readCfgKey(k, n, getenv)
		if err != nil {
			return nil, err
		}
		if ok {
			c.set[k.key] = v
		}
	}
	return c, nil
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
		return cfgVal{splitList(v), false}, true, nil
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
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" {
			return cfgVal{}, false, &yamlErr{it.line, k.key + " 에 빈 항목이 있습니다"}
		}
		if !contains(out, v) {
			out = append(out, v)
		}
	}
	return cfgVal{out, ref}, true, nil
}

// envOnly: what the environment alone gives for a key (today's rules).
func envOnly(k cfgKey, getenv func(string) string) any {
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
		if !ok {
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

// prepareConfigFile makes the settings file readable by the user the server will run as, before the handover.
// Inside DATA it tries to hand the file to node once (a failure is not counted: a read-only mount must not keep
// the whole server root). Outside DATA it never changes anything. Then it checks the read.
func prepareConfigFile(p, data string, getenv func(string) string, proc procOps) error {
	if p == "" || proc.getuid() != 0 || getenv("BRIDGE_RUN_AS_ROOT") == "1" {
		return nil // already read as the user that will keep running
	}
	if inside(p, data) {
		_ = os.Lchown(p, NODE_UID, NODE_GID)
	}
	if !readableBy(p, NODE_UID, NODE_GID) {
		return errf("설정 파일을 서버 사용자(uid " + itoa(NODE_UID) + ")가 읽을 수 없습니다: " + p + " (권한을 0644 로 하거나 소유자를 바꾸세요)")
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
