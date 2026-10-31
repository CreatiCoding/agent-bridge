package main

// Moving an environment-only server to bridge.yaml (REQ-F-810): the admin page and the command line make the
// file from the environment as references (never values), check a file without starting, and save the
// export once into an empty place.

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// exportText: the settings file this environment means, as references to its variables (no value, no secret).
func exportText(getenv func(string) string, now time.Time) string {
	var b strings.Builder
	b.WriteString("# bridge.yaml: 이 서버의 환경변수에서 만든 설정 파일 (REQ-F-810)\n")
	b.WriteString("# 만든 때 " + now.UTC().Format(time.RFC3339) + ", 서버 " + VERSION + "\n")
	b.WriteString("# 값 대신 환경변수 참조만 적었습니다. 환경변수를 고치면 지금처럼 반영됩니다.\n")
	b.WriteString("# 같은 뜻의 환경변수를 지우지 마세요. 이전 버전으로 되돌리면 그 버전은 환경변수만 읽습니다.\n")
	last, unset := "", []string{}
	for _, k := range CFG_KEYS {
		sec, name, _ := strings.Cut(k.key, ".")
		if k.env == "" || getenv(k.env) == "" {
			unset = append(unset, k.key)
			continue
		}
		if sec != last {
			b.WriteString(sec + ":\n")
			last = sec
		}
		b.WriteString("  " + name + ": \"${" + k.env + ":-}\"\n")
	}
	if len(unset) > 0 {
		b.WriteString("# 이 서버가 더 받는 키: " + strings.Join(unset, ", ") + "\n")
	}
	return b.String()
}

// The path, query and fragment of a url go; an origin alone stays as it is.
var maskURLRe = regexp.MustCompile(`(https?://[^/\s"'?#]+)[/?#][^\s"']*`)
var maskUserRe = regexp.MustCompile(`(https?://)[^/\s"'?#@]*@`)
var maskKeyRe = regexp.MustCompile(`(?i)^(\s*-?\s*"?[a-z0-9_.-]*(secret|password|passwd|token|apikey|api_key|privatekey|private_key|credential)[a-z0-9_.-]*"?\s*:\s*).+$`)

// maskConfigText: a file's text for a screen: secret-looking values and every URL's path and query hidden.
func maskConfigText(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		l = maskKeyRe.ReplaceAllString(l, "${1}***")
		l = maskUserRe.ReplaceAllString(l, "${1}") // user:password@ in a url
		lines[i] = maskURLRe.ReplaceAllString(l, "${1}/…")
	}
	return strings.Join(lines, "\n")
}

// fileState: what is at the settings path now: none | empty | zero (0 bytes) | file | dir | error.
func fileState(p string) (string, []byte) {
	st, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "none", nil
		}
		return "error", nil
	}
	if st.IsDir() {
		return "dir", nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "error", nil
	}
	if len(b) == 0 {
		return "zero", b
	}
	if emptyCfgText(b) {
		return "empty", b
	}
	return "file", b
}

func diffsJSON(d []cfgDiff) []any {
	out := []any{}
	for _, x := range d {
		out = append(out, orderedObj{{"key", x.Key}, {"env", x.Env}, {"file", x.File}, {"envValue", x.EnvVal}, {"refEnv", x.RefEnv}, {"envSet", x.EnvSet},
			{"warn", !x.RefEnv && x.EnvSet}})
	}
	return out
}

var refNameRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)`)

// checkText: the start checks on a text. With limited names, ${OTHER} is not resolved (a pasted text must not
// probe the server's other variables, like secrets), and those names are listed instead.
func checkText(p string, b []byte, getenv func(string) string, limit []string) M {
	other := []any{}
	unsubstituted := func() M {
		return M{"ok": false, "errors": []any{"검사에서 치환하지 않는 이름이 있습니다(이 서버의 다른 환경변수는 붙여 넣은 글로 확인하지 않습니다). 저장한 뒤 \"지금 파일 검사\" 로 확인하세요"}, "unsubstituted": other, "diff": []any{}}
	}
	if limit != nil {
		for _, m := range refNameRe.FindAllStringSubmatch(strings.ReplaceAll(string(b), "$${", ""), -1) {
			if !contains(limit, m[1]) && !anyHas(other, m[1]) {
				other = append(other, m[1])
			}
		}
		if len(other) > 0 {
			return unsubstituted()
		}
		// The reading is held to the names as well (REQ-S-088): a value the YAML unescapes (${…}) becomes a
		// reference the text above never showed, and its value would come back in an error.
		full := getenv
		getenv = func(name string) string {
			if !contains(limit, name) {
				if !anyHas(other, name) {
					other = append(other, name)
				}
				return ""
			}
			return full(name)
		}
	}
	c, err := parseBridgeConfig(p, b, getenv)
	if len(other) > 0 {
		return unsubstituted()
	}
	if err != nil {
		return M{"ok": false, "errors": []any{maskConfigText(err.Error())}, "diff": []any{}}
	}
	out := M{"ok": true, "errors": []any{}, "state": c.state, "diff": diffsJSON(c.diffs(getenv))}
	// A file on disk: its extensions are read too (a pasted text never opens files). One that will not load does
	// not stop the server; it is said here and in 운영 탭.
	if limit == nil {
		if es, ok := c.set["extensions"].v.([]extEntry); ok {
			warn := []any{}
			for _, d := range loadExtensions(es, getenv) {
				if d.Err != "" {
					warn = append(warn, maskConfigText("익스텐션 "+d.ID+": "+d.Err))
				}
			}
			out["extWarnings"] = warn
		}
	}
	// A file that turns header-only sign-in on, on a server that is not yet: the hosts to turn off first.
	if only, _ := c.set["auth.headerOnly"].v.(bool); only && !headerOnly() && hosts != nil {
		out["headerOnlyHosts"] = headerOnlyHosts(hosts.Values())
	}
	return out
}

func anyHas(list []any, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// configLimit: the names a pasted text may use: the four of the table and those the file on disk already uses.
func configLimit(disk []byte) []string {
	out := []string{}
	for _, k := range CFG_KEYS {
		if k.env != "" {
			out = append(out, k.env)
		}
	}
	for _, m := range refNameRe.FindAllStringSubmatch(string(disk), -1) {
		if !contains(out, m[1]) {
			out = append(out, m[1])
		}
	}
	return out
}

func configError() any {
	v := readJSON(filepath.Join(DATA, "config-error.json"), nil)
	if m, ok := v.(M); ok {
		return m
	}
	return nil
}

// saveExport writes the export into an empty place: a temp file, then link(2), which fails if the name exists, so
// two instances sharing DATA during a handover cannot both write, and nobody reads a half-written file.
func saveExport(p, text string) (int, string) {
	switch st, b := fileState(p); st {
	case "zero":
		if err := os.Remove(p); err != nil {
			if errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.EPERM) {
				return 409, "마운트된 파일이라 여기서 쓸 수 없어요. 마운트한 곳에서 내용을 채우세요"
			}
			return 500, "빈 파일을 지우지 못했어요: " + err.Error()
		}
	case "empty":
		_ = b
		return 409, "주석만 있는 설정 파일이 있어요. 마운트를 고치거나 파일을 지운 뒤 저장하세요"
	case "none":
	case "dir":
		return 409, "설정 파일 자리가 폴더예요"
	default:
		return 409, "이미 설정 파일이 있어요"
	}
	tmp := p + "." + randHex(6) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 500, "임시 파일을 만들지 못했어요: " + err.Error()
	}
	_, werr := f.WriteString(text)
	serr := f.Sync()
	cerr := f.Close()
	defer os.Remove(tmp)
	if werr != nil || serr != nil || cerr != nil {
		return 500, "임시 파일을 쓰지 못했어요"
	}
	if err := os.Link(tmp, p); err != nil {
		if os.IsExist(err) {
			return 409, "이미 설정 파일이 있어요"
		}
		return 500, "설정 파일을 만들지 못했어요: " + err.Error()
	}
	if got, err := os.ReadFile(p); err != nil || string(got) != text {
		return 409, "설정 파일을 다른 곳에서 함께 썼어요. 지금 파일을 확인하세요"
	}
	return 200, ""
}

// apiConfig: /api/admin/config… (REQ-F-810).
func apiConfig(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	if p != "/api/admin/config" && !strings.HasPrefix(p, "/api/admin/config/") {
		return false
	}
	if !isAdmin(uid) {
		refuse(403, "운영자만 볼 수 있습니다")
	}
	get, post := req.Method == "GET", req.Method == "POST"
	path, named, perr := configPath(DATA, env)
	state, disk := "error", []byte(nil)
	if perr == nil {
		state, disk = fileState(path)
	}
	has := state == "file" || state == "dir" || state == "error"
	saveable := !named && perr == nil
	switch {
	case get && p == "/api/admin/config":
		start := M{"path": "", "state": "none"}
		if CONFIG != nil {
			start = M{"path": CONFIG.path, "state": CONFIG.state}
		}
		out := orderedObj{{"path", path}, {"named", named}, {"state", state}, {"start", start}, {"diff", diffsJSON(CONFIG_DIFF)},
			{"error", configError()}, {"exportable", !has}, {"saveable", saveable && !has}}
		if state == "file" || state == "empty" {
			out = append(out, kv{"masked", maskConfigText(string(disk))})
		}
		jsonRes(res, 200, out)
	case get && p == "/api/admin/config/export":
		if has {
			refuseX(409, "이미 설정 파일이 있어요. 내보내기는 표의 네 키만 만들어서, 붙여 넣으면 지금 파일의 다른 설정이 사라집니다", M{"exists": true, "path": path, "masked": maskConfigText(string(disk))})
		}
		res.WriteHead(200, M{"Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
			"Content-Disposition": "attachment; filename=bridge.yaml"}).End([]byte(exportText(env, time.Now())))
	case post && p == "/api/admin/config/save":
		body(req, 1024)
		if frozen {
			refuse(503, "서버를 바꾸는 중이에요. 잠시 뒤에 다시 해 주세요")
		}
		if !saveable {
			refuse(409, "BRIDGE_CONFIG 로 다른 곳을 정한 서버예요. 내보낸 내용을 그곳에 넣어 주세요")
		}
		text := exportText(env, time.Now())
		chk := checkText(path, []byte(text), env, nil)
		if chk["ok"] != true || len(asArr(chk["diff"])) > 0 {
			refuseX(422, "내보낸 내용이 검사를 통과하지 못해 저장하지 않았어요", M{"check": chk})
		}
		if st, msg := saveExport(path, text); st != 200 {
			refuseX(st, msg, M{"exists": st == 409, "path": path})
		}
		jsonRes(res, 200, M{"ok": true, "path": path, "check": chk, "next": "서버를 다시 시작해야(Dokploy 에서 다시 배포) 반영돼요"})
	case post && p == "/api/admin/config/check":
		b := body(req, 256*1024)
		if y, ok := b["yaml"].(string); ok {
			jsonRes(res, 200, checkText(path, []byte(y), env, configLimit(disk)))
			return true
		}
		if perr != nil {
			jsonRes(res, 200, M{"ok": false, "errors": []any{perr.Error()}, "diff": []any{}})
			return true
		}
		switch state {
		case "none":
			jsonRes(res, 200, M{"ok": true, "state": "none", "errors": []any{}, "diff": []any{}})
		case "file", "empty", "zero":
			jsonRes(res, 200, checkText(path, disk, env, nil))
		default:
			c, err := loadBridgeConfig(DATA, env)
			msg := "설정 파일을 읽지 못했습니다"
			if err != nil {
				msg = err.Error()
			} else if c != nil {
				msg = "설정 파일 상태: " + c.state
			}
			jsonRes(res, 200, M{"ok": false, "errors": []any{maskConfigText(msg)}, "diff": []any{}})
		}
	default:
		refuse(404, "없는 주소입니다")
	}
	return true
}

// configCLI: `bridge-server config export|check [file]` (REQ-F-810). Runs before configure() and the handover:
// it creates nothing and never talks to a running instance.
func configCLI(args []string) int {
	out, errw := os.Stdout, os.Stderr
	data := env("BRIDGE_DATA")
	if data == "" {
		data = filepath.Join(findRoot(), "data")
	}
	data, _ = filepath.Abs(data)
	if len(args) == 0 {
		fmt.Fprintln(errw, "사용법: bridge-server config export | config check [파일]")
		return 2
	}
	switch args[0] {
	case "export":
		fmt.Fprint(out, exportText(env, time.Now()))
		return 0
	case "check":
		p, _, err := configPath(data, env)
		if len(args) > 1 {
			p, err = filepath.Abs(args[1])
		}
		if err != nil {
			fmt.Fprintln(errw, "오류: "+err.Error())
			return 1
		}
		var c *bridgeCfg
		if len(args) > 1 {
			b, rerr := os.ReadFile(p)
			if rerr != nil {
				fmt.Fprintln(errw, "오류: 읽지 못했습니다: "+p)
				return 1
			}
			c, err = parseBridgeConfig(p, b, env)
		} else {
			c, err = loadBridgeConfig(data, env)
		}
		if err != nil {
			fmt.Fprintln(errw, "오류: "+maskConfigText(err.Error()))
			return 1
		}
		fmt.Fprintln(out, "파일: "+p+" ("+c.state+")")
		uid, gid := os.Getuid(), os.Getgid()
		if uid == 0 && env("BRIDGE_RUN_AS_ROOT") != "1" {
			uid, gid = NODE_UID, NODE_GID
		}
		fmt.Fprintln(out, "판정한 서버 사용자: uid "+itoa(uid))
		if c.state != "none" && uid != os.Getuid() && !readableBy(p, uid, gid) {
			fmt.Fprintln(errw, "오류: 서버 사용자(uid "+itoa(uid)+")가 이 파일을 읽을 수 없습니다")
			return 1
		}
		if only, _ := c.set["auth.headerOnly"].v.(bool); only {
			// Read only: the hosts whose headless browser may keep the link with an old cookie (REQ-F-816).
			hs := []M{}
			if m, ok := readJSON(filepath.Join(data, "hosts.json"), nil).(M); ok {
				for _, k := range sortedKeys(m) {
					if h, ok := m[k].(M); ok {
						hs = append(hs, h)
					}
				}
			}
			for _, x := range headerOnlyHosts(hs) {
				r := x.(orderedObj)
				fmt.Fprintln(out, "headerOnly 전에 끌 기기: "+jsString(r[0].V)+" · "+jsString(r[len(r)-1].V))
			}
		}
		d := c.diffs(env)
		if len(d) == 0 {
			fmt.Fprintln(out, "환경변수만으로 정한 값과 다른 키: 없음")
		}
		for _, x := range d {
			line := "다름: " + x.Key + " = " + x.File + " (환경변수 " + x.Env + " = " + x.EnvVal + ")"
			if !x.RefEnv && x.EnvSet {
				line += " · 환경변수를 고쳐도 반영되지 않음"
			}
			fmt.Fprintln(out, maskConfigText(line))
		}
		return 0
	}
	fmt.Fprintln(errw, "모르는 명령: config "+args[0])
	return 2
}
