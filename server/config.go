// claude-bridge web server: GitHub login, host registry, relay between bridge pages and control pages,
// and the on-disk copy of every session (transcript + folder state). It never runs Claude itself.
// No dependencies beyond Go's standard library.
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const VERSION = "0.2.0"

var (
	ROOT                 string
	PORT                 int
	DATA                 string
	ORIGIN               string
	GITHUB_CLIENT_ID     string
	GITHUB_CLIENT_SECRET string
	ALLOWED              []string
	DEV_LOGIN            bool
	ADMINS               []string
	SKILLS_REPO_ENV      string
	SKILLS_TOKEN         string
	SKILLS_APP           *skillsApp
	demoOn               bool
	APPLE_CLIENT_ID      string
	apple                *AppleClient
	apns                 *ApnsClient
	appleKeyOf           *AppleKeys
	TRACE                bool
	GUIDE_DOKPLOY_URL    string
	handover             *Handover
	frozen               bool
	SKILLS_CODE          string
	SKILLS_FILE          string
	skillsByRepo         = map[string]*Skills{}
	SKILLS_INSTALL_KEY   string
	AGENT_BUILD          string
	AGENT_SIG            M
	AGENT_SIG_OK         bool
	SEQ_FILE             string
	SEQ_SEEN             float64
	AGENT_SEQ_BACK       bool
	AGENT_SIGNED         bool
	seqRecorded          bool
	WEB_HASH             string
)

var SKILLS_REPO_RE = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

const (
	HEARTBEAT_MS  = 15_000
	STALE_MS      = 50_000
	GOT_MS        = 12_000
	LOGIN_DAYS    = 30
	META_FLUSH_MS = 5_000
	EVENTS_PAGE   = 500
	LOG_ROTATE    = 5 * 1024 * 1024
	LOG_VIEW      = 400
)

var CACHE_KINDS = []string{"start", "cold", "idle", "model", "compact", "other"}

// cacheOf: what the prompt cache did in a session (REQ-F-773), as the agent counted it: numbers only.
func cacheOf(c any) any {
	cm, ok := c.(M)
	if !ok {
		return nil
	}
	n := func(v any) float64 {
		if f, ok := v.(float64); ok && f >= 0 {
			return f
		}
		return 0
	}
	out := M{}
	for _, k := range []string{"calls", "read", "write", "input", "output", "ctx", "at"} {
		out[k] = n(cm[k])
	}
	out["hit"] = minF(100, n(cm["hit"]))
	evs, _ := cm["events"].([]any)
	if len(evs) > 5 {
		evs = evs[len(evs)-5:]
	}
	list := []any{}
	for _, e := range evs {
		kind := mstr(e, "kind")
		if !contains(CACHE_KINDS, kind) || !isStr(mget(e, "kind")) {
			continue
		}
		list = append(list, M{"at": n(mget(e, "at")), "kind": kind, "tokens": n(mget(e, "tokens")), "gap": n(mget(e, "gap"))})
	}
	out["events"] = list
	return out
}

var AGENT_FILES = []string{"agent.mjs", "dialog.mjs", "preview.mjs", "screen.mjs", "plugins.mjs", "skills.mjs", "split.mjs", "guard.mjs", "accounts.mjs", "voice.mjs", "mcp.mjs", "cache.mjs", "scrub.mjs", "store.mjs", "stats.mjs", "mux.mjs", "keys.mjs"}

func env(k string) string { return os.Getenv(k) }

func splitList(s string) []string {
	out := []string{}
	for _, x := range strings.Split(s, ",") {
		x = strings.ToLower(strings.TrimSpace(x))
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

// findRoot is the repository folder: where agent/ and web/ are. BRIDGE_ROOT, else beside the binary, else the
// working folder (and its parent, for `go test` in server/).
func findRoot() string {
	if r := env("BRIDGE_ROOT"); r != "" {
		abs, _ := filepath.Abs(r)
		return abs
	}
	var cands []string
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		d := filepath.Dir(exe)
		cands = append(cands, d, filepath.Dir(d))
	}
	if wd, err := os.Getwd(); err == nil {
		cands = append(cands, wd, filepath.Dir(wd))
	}
	for _, c := range cands {
		if st, err := os.Stat(filepath.Join(c, "agent", "agent.mjs")); err == nil && !st.IsDir() {
			return c
		}
	}
	if len(cands) > 0 {
		return cands[len(cands)-1]
	}
	return "."
}

// configure reads the environment (the module's top in server.mjs). Returns false when the server must not start.
func configure() bool {
	ROOT = findRoot()
	PORT = 4300
	if p := env("PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			PORT = n
		}
	}
	d := env("BRIDGE_DATA")
	if d == "" {
		d = filepath.Join(ROOT, "data")
	}
	DATA, _ = filepath.Abs(d)
	ORIGIN = strings.TrimRight(env("BRIDGE_ORIGIN"), "/")
	GITHUB_CLIENT_ID = env("GITHUB_CLIENT_ID")
	GITHUB_CLIENT_SECRET = env("GITHUB_CLIENT_SECRET")
	// A public server (GitHub sign-in on) states its own origin (R1-L16). Without it the server does not start.
	if GITHUB_CLIENT_ID != "" && ORIGIN == "" {
		errorLine("BRIDGE_ORIGIN 이 없습니다. GitHub 로그인을 쓰는 서버는 사이트 주소(예: https://bridge.example.com)를 BRIDGE_ORIGIN 으로 정해야 합니다.")
		return false
	}
	ALLOWED = splitList(env("GITHUB_ALLOWED_LOGINS"))
	DEV_LOGIN = env("BRIDGE_DEV_LOGIN") == "1"
	ADMINS = splitList(env("BRIDGE_ADMIN_LOGINS"))
	SKILLS_REPO_ENV = strings.TrimSpace(env("SKILLS_REPO"))
	SKILLS_TOKEN = env("SKILLS_GITHUB_TOKEN")
	SERVICE_TOKEN = strings.TrimSpace(env("BRIDGE_SERVICE_TOKEN"))
	SERVICE_UID = strings.TrimSpace(env("BRIDGE_SERVICE_UID"))
	if SERVICE_TOKEN != "" && len(SERVICE_TOKEN) < 32 {
		errorLine("BRIDGE_SERVICE_TOKEN 은 32자 이상이어야 합니다.")
		return false
	}
	if env("SKILLS_GITHUB_APP_ID") != "" && env("SKILLS_GITHUB_APP_KEY") != "" {
		if err := try(func() {
			SKILLS_APP = &skillsApp{id: strings.TrimSpace(env("SKILLS_GITHUB_APP_ID")), key: appKey(env("SKILLS_GITHUB_APP_KEY"))}
		}); err != nil {
			then := "/skills 는 꺼집니다"
			if SKILLS_TOKEN != "" {
				then = "SKILLS_GITHUB_TOKEN 으로 읽습니다"
			}
			errorLine("SKILLS_GITHUB_APP_KEY 를 읽지 못했습니다(" + err.Error() + "). " + then + ".")
			SKILLS_APP = nil
		}
	}
	demoOn = env("BRIDGE_DEMO") == "1"
	APPLE_CLIENT_ID = env("APPLE_CLIENT_ID")
	if APPLE_CLIENT_ID == "" {
		APPLE_CLIENT_ID = "dev.creco.bridge"
	}
	if err := try(func() {
		apple = appleClient(env("APPLE_TEAM_ID"), env("APPLE_KEY_ID"), strings.ReplaceAll(env("APPLE_PRIVATE_KEY"), `\n`, "\n"), APPLE_CLIENT_ID)
	}); err != nil {
		errorLine("APPLE_PRIVATE_KEY 를 읽지 못했습니다(" + err.Error() + "). 계정 삭제 때 Apple 토큰 취소를 건너뜁니다.")
		apple = nil
	}
	own := env("APNS_KEY_ID") != "" && env("APNS_PRIVATE_KEY") != ""
	if err := try(func() {
		keyID, pk := env("APPLE_KEY_ID"), env("APPLE_PRIVATE_KEY")
		if own {
			keyID, pk = env("APNS_KEY_ID"), env("APNS_PRIVATE_KEY")
		}
		var origins map[string]string
		if DEV_LOGIN && env("APNS_TEST_ORIGIN") != "" {
			origins = map[string]string{"production": env("APNS_TEST_ORIGIN"), "sandbox": env("APNS_TEST_ORIGIN")}
		}
		apns = apnsClient(env("APPLE_TEAM_ID"), keyID, strings.ReplaceAll(pk, `\n`, "\n"), APPLE_CLIENT_ID, origins)
	}); err != nil {
		errorLine("APNs 키를 읽지 못했습니다(" + err.Error() + "). 앱 알림을 보내지 않습니다.")
		apns = nil
	}
	if DEV_LOGIN && env("APPLE_TEST_JWKS") != "" {
		raw := env("APPLE_TEST_JWKS")
		appleKeyOf = newAppleKeys(func() (any, error) { return parseJSON([]byte(raw)) })
	} else {
		appleKeyOf = newAppleKeys(nil)
	}
	TRACE = env("BRIDGE_TRACE") == "1"
	GUIDE_DOKPLOY_URL = env("BRIDGE_GUIDE_DOKPLOY_URL")
	if GUIDE_DOKPLOY_URL == "" {
		GUIDE_DOKPLOY_URL = "https://<Dokploy 주소>"
	}
	GUIDE_DOKPLOY_URL = strings.TrimRight(GUIDE_DOKPLOY_URL, "/")
	initPages()
	return true
}

func trace(hostID, text string) {
	if !TRACE {
		return
	}
	h := hosts.Val(hostID)
	logLine("TRACE user=" + jsString(mget(users.Val(mstr(h, "uid")), "login")) + " host=" + jsString(mget(h, "name")) + " " + text)
}

// prepare runs what server.mjs ran at load, after the handover: its keys and fingerprints.
func prepare() {
	SKILLS_CODE = codeHash(func(f string) string {
		b, _ := os.ReadFile(filepath.Join(ROOT, f))
		return string(b)
	})
	SKILLS_FILE = filepath.Join(DATA, "skills-repo.json")
	SKILLS_INSTALL_KEY = func() string {
		f := filepath.Join(DATA, "skills-install.secret")
		if fh, err := os.OpenFile(f, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			_, _ = fh.WriteString(randHex(32))
			fh.Close()
		}
		if b, err := os.ReadFile(f); err == nil {
			return strings.TrimSpace(string(b))
		}
		return randHex(32)
	}()
	h := sha1.New()
	for _, f := range AGENT_FILES {
		b, _ := os.ReadFile(filepath.Join(ROOT, "agent", f))
		h.Write(b)
	}
	AGENT_BUILD = hex.EncodeToString(h.Sum(nil))[:12]
	AGENT_SIG = M{}
	if b, err := os.ReadFile(filepath.Join(ROOT, "agent/agent.sig")); err == nil {
		raw := strings.TrimSpace(string(b))
		if strings.HasPrefix(raw, "{") {
			if v, err := parseJSON([]byte(raw)); err == nil {
				if m, ok := v.(M); ok {
					AGENT_SIG = m
				}
			}
		} else {
			AGENT_SIG = M{"legacy": raw}
		}
	}
	files := map[string]string{}
	for _, f := range AGENT_FILES {
		b, _ := os.ReadFile(filepath.Join(ROOT, "agent", f))
		files[f] = string(b)
	}
	AGENT_SIG_OK = manifestSigned(files, AGENT_SIG["seq"], AGENT_SIG["msig"])
	SEQ_FILE = filepath.Join(DATA, "agent-seq.json")
	SEQ_SEEN = func() float64 {
		if !exists(SEQ_FILE) {
			return 0
		}
		v := jsNumber(mget(readJSON(SEQ_FILE, nil), "max"))
		if isSafeInteger(v) && v > 0 {
			return v
		}
		errorLine("agent-seq.json 을 읽지 못해 agent-seq.json.broken 으로 옮깁니다. 이번 배포의 순번부터 다시 셉니다")
		_ = os.Rename(SEQ_FILE, SEQ_FILE+".broken")
		return 0
	}()
	AGENT_SEQ_BACK = AGENT_SIG_OK && jsNumber(AGENT_SIG["seq"]) < SEQ_SEEN
	if AGENT_SEQ_BACK {
		errorLine("agent/agent.sig 의 순번(" + jsString(AGENT_SIG["seq"]) + ")이 전에 내보낸 것(" + numStr(SEQ_SEEN) + ")보다 작습니다. 맥들이 거절하므로 업데이트를 보내지 않습니다(node scripts/sign-agent.mjs 로 다시 서명).")
	}
	AGENT_SIGNED = AGENT_SIG_OK && !AGENT_SEQ_BACK
	if !AGENT_SIG_OK {
		errorLine("agent/agent.sig 가 에이전트 파일(build " + AGENT_BUILD + ")의 서명이 아닙니다. 맥들은 이 업데이트를 받지 않습니다(node scripts/sign-agent.mjs).")
	}
	WEB_HASH = func() string {
		h := sha256.New()
		for _, f := range []string{"bridge.html", "bridge.js", "relay.js", "app.css", "theme.js"} {
			b, err := os.ReadFile(filepath.Join(ROOT, "web", f))
			if err != nil {
				return ""
			}
			h.Write(b)
		}
		return hex.EncodeToString(h.Sum(nil))[:12]
	}()
}

func skillsFor(repo string) *Skills {
	if repo == "" || !(SKILLS_APP != nil || SKILLS_TOKEN != "") {
		return nil
	}
	k := strings.ToLower(repo)
	if _, ok := skillsByRepo[k]; !ok {
		skillsByRepo[k] = createSkills(SKILLS_TOKEN, SKILLS_APP, repo, env("SKILLS_GITHUB_API"))
	}
	return skillsByRepo[k]
}

func skillsInstallSig(repo string) string {
	m := hmac.New(sha256.New, []byte(SKILLS_INSTALL_KEY))
	m.Write([]byte("skills-install\x00" + strings.ToLower(repo)))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))[:32]
}

func skillsInstallOk(repo string, t any) bool {
	want := []byte(skillsInstallSig(repo))
	got := []byte(jsString(t))
	return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func readJSON(p string, fallback any) any {
	b, err := os.ReadFile(p)
	if err != nil {
		return fallback
	}
	v, err := parseJSON(b)
	if err != nil {
		return fallback
	}
	return v
}

// writeJson writes through a file of its own and a rename; readable by the server's user only (R1-L6, R10-L3).
func writeJson(p string, v any) {
	if frozen {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	tmp := p + "." + randHex(4) + ".tmp"
	if err := os.WriteFile(tmp, jsonBytes(v), 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		panic(err)
	}
}

func sha256hexs(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func isAdmin(uid string) bool {
	u, ok := users.Get(uid)
	return !isDemoUid(uid) && ok && !isAppleLogin(mstr(u, "login")) && contains(ADMINS, strings.ToLower(mstr(u, "login")))
}

// accessOf: who set a login's access: the server's configuration, or an operator on the access page.
func accessOf(login string) M {
	l := strings.ToLower(login)
	st := mstr(access.Val(l), "status")
	if isAppleLogin(l) {
		if st == "allowed" {
			return M{"allowed": true, "by": "operator"}
		}
		by := "none"
		if st == "denied" {
			by = "operator"
		}
		return M{"allowed": false, "by": by}
	}
	if contains(ADMINS, l) {
		return M{"allowed": true, "by": "admin"}
	}
	if contains(ALLOWED, l) {
		return M{"allowed": true, "by": "config"}
	}
	if st == "allowed" {
		return M{"allowed": true, "by": "operator"}
	}
	if st == "denied" {
		return M{"allowed": false, "by": "operator"}
	}
	star := contains(ALLOWED, "*")
	by := "none"
	if star {
		by = "config"
	}
	return M{"allowed": star, "by": by}
}

func isAllowed(login string) bool { return accessOf(login)["allowed"] == true }

var safeIDRe = regexp.MustCompile(`^[a-zA-Z0-9-]{8,64}$`)

func safeId(s any) bool {
	str, ok := s.(string)
	return ok && safeIDRe.MatchString(str)
}

func ms(n int64) time.Duration { return time.Duration(n) * time.Millisecond }
