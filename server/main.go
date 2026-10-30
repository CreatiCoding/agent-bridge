// claude-bridge server: the Go port of server/server.mjs. Same routes, messages, files and environment.
package main

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var (
	preview      *Preview
	processStart = nowMs()
	settling     *struct {
		hosts []string
		until int64
	}
)

func rssBytes() float64 {
	if b, err := os.ReadFile("/proc/self/statm"); err == nil {
		f := strings.Fields(string(b))
		if len(f) > 1 {
			return jsNumber(f[1]) * float64(os.Getpagesize())
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.Sys)
}

const RECOVERY = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/icon.svg" type="image/svg+xml"><title>문제가 생겼을 때 · Agent Bridge</title>
<style>__FONT_TOKENS__body{font:var(--fs-large)/1.65 -apple-system,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px 16px 64px}h1{font-size:var(--fs-xlarge)}h2{font-size:var(--fs-large);margin-top:28px}code{background:rgba(127,127,127,.18);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}li{margin:6px 0}a{color:inherit}</style>
<h1>문제가 생겼을 때</h1>
<p>세션은 맥에서 돌고, 이 사이트는 맥의 브라우저에 열린 페이지를 거쳐 그 맥과 이어집니다. 대부분의 문제는 그 연결이 끊긴 것입니다.</p>
<h2>기기가 "연결 끊김" 일 때</h2><ol><li>그 맥의 Chrome 에서 이 사이트를 엽니다. 열려 있는 동안 연결됩니다.</li><li>그래도 안 되면 <a href="/bridge">기기와 연동 상태</a> 에서 에이전트와 서버 어느 쪽이 끊겼는지 봅니다.</li><li>에이전트가 꺼져 있으면 맥의 터미널에서 다시 설치합니다: <code>curl -fsSL __ORIGIN__/install.sh | bash</code></li></ol>
<h2>세션이 멈춘 것 같을 때</h2><ol><li>세션의 <b>화면</b> 칩으로 터미널이 무엇을 기다리는지 봅니다.</li><li>메뉴의 <b>새로고침</b> 은 대화를 그대로 두고 세션만 다시 엽니다.</li><li>맥이 꺼져 있으면 세션 화면의 안내에서 다른 맥으로 이어서 열 수 있습니다.</li></ol>
<h2>화면이 이상할 때</h2><ol><li>새로고침합니다.</li><li>브라우저의 사이트 데이터를 지우고 다시 로그인합니다. 대화는 서버에 있어 사라지지 않습니다.</li></ol>
<p><a href="/">← 돌아가기</a></p></html>`

const APPLE_BUTTON = `<style>.sign-pair .btn{display:flex;width:100%;height:44px;justify-content:center;font-weight:600}.btn.apple{gap:8px;background:#000;color:#fff;border-color:#000}.btn.apple svg{width:18px;height:18px;fill:currentColor}@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .btn.apple{background:#fff;color:#000;border-color:#fff}}:root[data-theme=dark] .btn.apple{background:#fff;color:#000;border-color:#fff}.apple-error{color:var(--red,#c00);margin:6px 0 0;font-size:var(--fs-small)}</style><button type="button" class="btn apple" id="apple-login" aria-label="Apple로 로그인"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.27-1.6 2.78-.41 6.9 1.15 9.15.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.67zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z"/></svg>Apple로 로그인</button><p class="apple-error" id="apple-error" hidden></p><script src="/apple-login.js"></script>`

var inAppRe = regexp.MustCompile(`\bAgentBridge/`)

func inApp(req *Req) bool { return inAppRe.MatchString(req.H("user-agent")) }

var (
	settleSkipRe = regexp.MustCompile(`^/api/(bridge|auth|health)`)
	uploadPathRe = regexp.MustCompile(`^/api/sessions/[\w-]+/upload$`)
	assetRe      = regexp.MustCompile(`^/assets/([\w.-]+\.(?:js|css|svg|png|woff2))$`)
	skillsPageRe = regexp.MustCompile(`^/skills/[a-z0-9-]+$`)
	agentFileRe  = regexp.MustCompile(`^/agent/([a-z]+\.mjs)$`)
	webFileRe    = regexp.MustCompile(`^/[a-z-]+\.(js|css|svg)$`)
)

func ctype(req *Req) string {
	if !req.Has("content-type") {
		return "undefined"
	}
	return req.H("content-type")
}

// route is the request handler of server.mjs (http.createServer), run with the lock held.
func route(req *Req, res *Res) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		status := 500
		msg := "서버 오류"
		var extra M
		switch x := r.(type) {
		case *Refuse:
			status, msg, extra = x.Status, x.Msg, x.Extra
		case *jsError:
			logLine("error", req.Method, strings.Split(req.RawURL, "?")[0], x.msg)
		default:
			logLine("error", req.Method, strings.Split(req.RawURL, "?")[0], r)
		}
		if res.headersSent {
			res.ended = true
			return
		}
		// { ok: false, error, ...extra }, in that order.
		out := orderedObj{{"ok", false}, {"error", msg}}
		for _, k := range sortedKeys(extra) {
			out = append(out, kv{k, extra[k]})
		}
		// A Refuse thrown inside jsonRes after some headers were set: the answer starts over.
		res.header = http.Header{}
		res.body = nil
		res.file = nil
		jsonRes(res, status, out)
	}()
	if preview.is(req.r) {
		needFeature("preview")
		preview.handle(req, res)
		return
	}
	if wait := settling; wait != nil && strings.HasPrefix(req.RawURL, "/api/") && !settleSkipRe.MatchString(req.RawURL) {
		for nowMs() < wait.until {
			missing := false
			for _, h := range wait.hosts {
				if !bridges.Has(h) {
					missing = true
				}
			}
			if !missing {
				break
			}
			sleep(40 * time.Millisecond)
		}
		if settling == wait {
			settling = nil
		}
	}
	u := req.URL
	p := u.Path
	if p == "/api/health" {
		jsonRes(res, 200, orderedObj{{"ok", true}, {"version", VERSION}, {"instance", handover.id}})
		return
	}
	service := strings.HasPrefix(p, "/api/service/")
	if !service {
		pickOrigin(req)
	}
	migrateLegacyCb(req, res)
	if !service && headerSignIn(req, res) {
		return
	}
	if strings.HasPrefix(p, "/api/auth/") {
		if headerOnly() && p != "/api/auth/logout" {
			refuse(404, "없는 주소입니다") // every way in but the proxy's header is closed (REQ-F-816)
		}
		auth(req, res, u)
		return
	}
	// Bearer token only, no cookie: kept apart from the browser routes below.
	if service {
		serviceAPI(req, res, p)
		return
	}
	if strings.HasPrefix(p, "/api/") {
		form := req.Method == "POST" && p == "/api/plugins/slack/link"
		upload := req.Method == "POST" && (uploadPathRe.MatchString(p) || p == "/api/reports/upload")
		if req.Method != "GET" {
			origin := req.H("origin")
			if (origin != "" || form || upload) && origin != originOf(req) {
				refuse(403, "다른 출처의 요청입니다")
			}
			if upload && !contains(VIDEO_TYPES, strings.TrimSpace(strings.Split(ctype(req), ";")[0])) {
				refuse(415, "지원하지 않는 영상 형식이에요")
			}
			want := "application/json"
			if form {
				want = "application/x-www-form-urlencoded"
			}
			if req.Method == "POST" && !upload && !strings.HasPrefix(ctype(req), want) {
				refuse(415, "application/json 만 받습니다")
			}
		}
		uid := whoami(req)
		if uid == "" && headerOnly() {
			refuseX(401, "로그인이 필요합니다", M{"headerOnly": true})
		}
		if uid == "" {
			refuse(401, "로그인이 필요합니다")
		}
		if isDemoUid(uid) {
			demoGate(req, p, uid)
		}
		api(req, res, u, uid)
		return
	}
	if req.Method != "GET" {
		res.WriteHead(405).End()
		return
	}
	htmlHead := func() M {
		h := shallow(SECURITY)
		h["Content-Type"] = "text/html; charset=utf-8"
		return h
	}
	if p == "/" && whoami(req) == "" {
		h := htmlHead()
		h["Cache-Control"] = "no-store"
		if headerOnly() {
			res.WriteHead(401, h).EndS(headerOnlyPage())
			return
		}
		sign := `<a class="btn primary" href="/api/auth/github">GitHub 로 로그인</a>`
		if inApp(req) {
			sign = `<div class="sign-pair">` + APPLE_BUTTON + sign + `</div>`
		}
		demo := ""
		if demoOn {
			demo = DEMO_BUTTON
		}
		res.WriteHead(200, h).EndS(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>` + APP_NAME + `</title><script src="/old-hash.js"></script><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/login.css"><body class="bridge-login"><div class="panel"><h1>` + APP_NAME + `</h1><p class="muted">맥에서 도는 Claude 세션을 옮기고, 어디서든 이어서 조작합니다.</p>` + sign + demo + `<p class="muted" style="margin:16px 0 0">처음이세요? <a href="/guide">시작 가이드</a></p>` + FOOTER + `</div></body></html>`)
		return
	}
	if p == "/" {
		if exists(filepath.Join(UI, "index.html")) {
			sendUi(res)
		} else {
			res.WriteHead(503, M{"Content-Type": "text/plain; charset=utf-8"}).EndS("화면이 빌드되지 않았어요 (cd ui && corepack yarn build)\n")
		}
		return
	}
	login := func(next string) {
		if headerOnly() {
			h := htmlHead()
			h["Cache-Control"] = "no-store"
			res.WriteHead(401, h).EndS(headerOnlyPage())
			return
		}
		loc := "/"
		if GITHUB_CLIENT_ID != "" {
			loc = "/api/auth/github?next=" + encodeURIComponent(next)
		}
		res.WriteHead(302, M{"Location": loc}).End()
	}
	if APP_PATH.MatchString(p) {
		if whoami(req) != "" {
			if exists(filepath.Join(UI, "index.html")) {
				sendUi(res)
			} else {
				res.WriteHead(302, M{"Location": "/"}).End()
			}
			return
		}
		if strings.HasPrefix(p, "/guide") {
			sendFile(res, filepath.Join(ROOT, "web/start.html"), "")
			return
		}
		search := ""
		if u.RawQuery != "" {
			search = "?" + u.RawQuery
		}
		login(safeNext(p + search))
		return
	}
	if p == "/cs" || p == "/classic" {
		res.WriteHead(302, M{"Location": "/"}).End()
		return
	}
	if m := assetRe.FindStringSubmatch(p); m != nil {
		sendFile(res, filepath.Join(UI, "assets", m[1]), "public, max-age=31536000, immutable")
		return
	}
	switch p {
	case "/prepaint.js":
		sendFile(res, filepath.Join(UI, "prepaint.js"), "")
		return
	case "/bridge":
		if !linksHere(req) {
			h := htmlHead()
			h["Cache-Control"] = "no-store"
			res.WriteHead(200, h).EndS(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>` + APP_NAME + `</title><link rel="stylesheet" href="/app.css"><body><div class="panel"><h1>기기와 연동</h1><p>` + NOT_LINKED_HERE + `: <a href="` + ORIGIN + `/bridge">` + ORIGIN + `</a></p></div></body></html>`)
			return
		}
		sendFile(res, filepath.Join(ROOT, "web/bridge.html"), "")
		return
	case "/skills/version":
		who := whoami(req)
		var skills *Skills
		if who != "" {
			skills = skillsFor(skillsRepoOf(who))
		}
		if skills == nil {
			jsonRes(res, 200, M{"code": SKILLS_CODE})
			return
		}
		c := skills.current()
		jsonRes(res, 200, orderedObj{{"code", SKILLS_CODE}, {"repo", c["repo"]}, {"sha", c["sha"]}, {"date", c["date"]}, {"skills", len(asArr(c["skills"]))}, {"check", c["check"]}, {"auth", skills.auth}})
		return
	case "/skills/install.sh":
		want := strings.ToLower(strings.TrimSpace(u.Query().Get("repo")))
		repo := ""
		if want != "" && skillsInstallOk(want, u.Query().Get("t")) {
			cands := []any{SKILLS_REPO_ENV}
			for _, id := range users.Keys() {
				cands = append(cands, prefsOf(id)["skillsRepo"])
			}
			for _, r := range cands {
				if s, ok := r.(string); ok && s != "" && strings.ToLower(s) == want {
					repo = s
					break
				}
			}
		}
		if repo == "" {
			res.WriteHead(404).EndS("not found\n")
			return
		}
		if !(SKILLS_APP != nil || SKILLS_TOKEN != "") {
			res.WriteHead(503).EndS("skills not configured\n")
			return
		}
		c := skillsFor(repo).current()
		res.WriteHead(200, M{"Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-cache"}).EndS(jsStringU(c["install"]))
		return
	case "/guide/mcp":
		if whoami(req) == "" {
			login(p)
			return
		}
		b, err := os.ReadFile(filepath.Join(ROOT, "web/guide-mcp.html"))
		if err != nil {
			panic(err)
		}
		html := strings.ReplaceAll(string(b), "__DOKPLOY_URL__", escPage(GUIDE_DOKPLOY_URL))
		h := htmlHead()
		h["Cache-Control"] = "no-cache"
		res.WriteHead(200, h).EndS(html)
		return
	}
	if p == "/skills" || skillsPageRe.MatchString(p) {
		needFeature("skills")
		if whoami(req) == "" {
			login(p)
			return
		}
		sendFile(res, filepath.Join(ROOT, "web/skills.html"), "")
		return
	}
	af := agentFileRe.FindStringSubmatch(p)
	if p == "/agent.mjs" || (af != nil && contains(AGENT_FILES, af[1])) {
		name := "agent.mjs"
		if af != nil {
			name = af[1]
		}
		sendFile(res, filepath.Join(ROOT, "agent", name), "")
		return
	}
	switch p {
	case "/install.sh":
		b, err := os.ReadFile(filepath.Join(ROOT, "agent/install.sh"))
		if err != nil {
			panic(err)
		}
		script := strings.ReplaceAll(strings.ReplaceAll(string(b), "__ORIGIN__", siteOrigin(req)), "__FILES__", strings.Join(AGENT_FILES, " "))
		res.WriteHead(200, M{"Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-cache"}).EndS(script)
		return
	case "/privacy":
		// privacy.file (REQ-F-812): the operator's own policy replaces the one this project ships.
		if f := cfgGet("privacy.file").(string); f != "" {
			sendFile(res, f, "")
		} else if len(recipients()) > 0 {
			// The operator's notify destinations, added where the policy says nothing leaves (REQ-F-818).
			b, err := os.ReadFile(filepath.Join(ROOT, "web/privacy.html"))
			if err != nil {
				panic(err)
			}
			h := htmlHead()
			h["Cache-Control"] = "no-cache"
			res.WriteHead(200, h).EndS(privacyWithRecipients(string(b)))
		} else {
			sendFile(res, filepath.Join(ROOT, "web/privacy.html"), "")
		}
		return
	case "/support":
		h := htmlHead()
		h["Cache-Control"] = "no-cache"
		res.WriteHead(200, h).EndS(supportPage())
		return
	case "/recovery":
		h := htmlHead()
		h["Cache-Control"] = "no-cache"
		res.WriteHead(200, h).EndS(strings.ReplaceAll(strings.Replace(RECOVERY, "__FONT_TOKENS__", FONT_TOKENS, 1), "__ORIGIN__", siteOrigin(req)))
		return
	case "/favicon.ico":
		sendFile(res, filepath.Join(ROOT, "web/icon.svg"), "")
		return
	case "/manifest.webmanifest":
		res.WriteHead(200, M{"Content-Type": "application/manifest+json", "Cache-Control": "no-cache"}).EndS(jsonStr(orderedObj{{"name", APP_NAME}, {"short_name", APP_NAME}, {"start_url", "/"}, {"display", "standalone"}, {"background_color", "#262624"}, {"theme_color", "#1f1e1d"}, {"icons", []any{orderedObj{{"src", "/icon.svg"}, {"sizes", "any"}, {"type", "image/svg+xml"}}}}}))
		return
	}
	if webFileRe.MatchString(p) {
		sendFile(res, filepath.Join(ROOT, "web", p), "")
		return
	}
	res.WriteHead(404).EndS("not found")
}

func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
				return true
			}
		}
	}
	return false
}

func handler(w http.ResponseWriter, r *http.Request) {
	if isUpgrade(r) {
		if preview.is(r) && handover.getState() == "running" {
			preview.upgrade(w, r)
			return
		}
		if c, _, err := hijack(w); err == nil {
			_ = c.Close()
		}
		return
	}
	req := newReq(r)
	transportHeaders(w.Header(), req)
	if handover.intercept(w, r) {
		return
	}
	res := newRes(req)
	mu.Lock()
	route(req, res)
	mu.Unlock()
	res.flush(w, r)
}

// cutStreams: every open stream ends with a short retry hint, so its page reconnects at once.
func cutStreams() {
	for _, b := range bridges.Values() {
		b.End("retry: 300\n\n")
	}
	for _, c := range controls {
		for _, s := range c.Values() {
			s.End("retry: 300\n\n")
		}
	}
}

// migrateSkillsRepo: the server-wide skills repo of 1.294 goes to the person whose GitHub login owns it (REQ-F-792).
func migrateSkillsRepo() {
	old, ok := mget(readJSON(SKILLS_FILE, nil), "repo").(string)
	if !ok || !SKILLS_REPO_RE.MatchString(old) {
		return
	}
	owner := strings.ToLower(strings.Split(old, "/")[0])
	for _, uid := range users.Keys() {
		gh := githubLoginOf(uid)
		if gh == nil || strings.ToLower(jsString(gh)) != owner {
			continue
		}
		if !truthy(prefsOf(uid)["skillsRepo"]) {
			prefsOf(uid)["skillsRepo"] = old
			writeJson(prefsFile(uid), prefsOf(uid))
		}
		_ = os.Rename(SKILLS_FILE, SKILLS_FILE+".migrated")
		logLine("skills: 서버 하나의 스킬 저장소를 " + mstr(users.Val(uid), "login") + " 의 설정으로 옮김")
		return
	}
}

func main() {
	// Subcommands first: before configure() and the handover, so they never start a second server (REQ-F-810).
	if len(os.Args) > 1 && os.Args[1] == "config" {
		os.Exit(configCLI(os.Args[2:]))
	}
	if !configure() {
		os.Exit(1)
	}
	_ = os.MkdirAll(DATA, 0o777)
	handover = createHandover(DATA)
	handover.takeOver()
	logLine("user: " + dropRoot(DATA))
	logLine("data: " + itoa(tightenTree(DATA)) + "개의 권한을 0600/0700 으로 맞춤")
	_ = os.Remove(filepath.Join(DATA, "config-error.json")) // this start read the settings file (REQ-F-809)
	if CONFIG.path != "" {
		logLine("config: " + CONFIG.path + " (" + CONFIG.state + ")")
	}
	for _, d := range CONFIG_DIFF {
		if !d.RefEnv && d.EnvSet {
			errorLine("config: 환경변수 " + d.Env + " 를 고쳐도 반영되지 않습니다. bridge.yaml 의 " + d.Key + " 가 쓰입니다")
		}
	}
	mu.Lock()
	prepare()
	loadStore()
	startFlushing()
	loadVapid()
	loadRetention()
	loadPidSeq()
	fixOldSessions()
	loadModels()
	startModelsCheck()
	startHeartbeat()
	loadAppBuild()
	loadReportAuto()
	startReportTimers()
	setupPlugins()
	preview = createPreview(DATA, ORIGIN, PORT, func(uid, hostID, sid string) string {
		if h, ok := hosts.Get(hostID); !ok || mstr(h, "uid") != uid {
			return "이 미리보기의 기기를 찾지 못했어요."
		}
		if s, ok := sessions.Get(sid); !ok || s.uid() != uid || truthy(s.get("closed")) {
			return "이 미리보기를 연 세션이 끝났어요. 세션 화면의 컴퓨터 버튼으로 다시 열어 주세요."
		}
		if online(hostID) {
			return ""
		}
		return "그 맥이 지금 연결돼 있지 않아요. 맥이 켜져 있고 연동 탭이나 헤드리스 연동이 돌고 있는지 봐 주세요."
	})
	initSecurity()
	UI = filepath.Join(ROOT, "ui", "dist")
	go locked("preload", preloadAssets)
	startAttemptSweep()
	startDemoSweep()
	demoCleanStart()
	migrateSkillsRepo()
	if c := handover.carried(); c != nil {
		hs := []string{}
		for _, h := range asArr(c["online"]) {
			if s, ok := h.(string); ok && hosts.Has(s) {
				hs = append(hs, s)
			}
		}
		if len(asArr(c["online"])) > 0 {
			settling = &struct {
				hosts []string
				until int64
			}{hs, nowMs() + 6000}
		}
	}
	mu.Unlock()

	ln, err := net.Listen("tcp", ":"+itoa(PORT))
	if err != nil {
		errorLine(err.Error())
		os.Exit(1)
	}
	srv := &http.Server{Handler: http.HandlerFunc(handler), ReadHeaderTimeout: 60 * time.Second}
	handover.serve(hoHooks{
		port: PORT,
		drain: func() M {
			var out M
			mu.Lock()
			for i := 0; i < 30 && len(pending) > 0; i++ {
				sleep(100 * time.Millisecond)
			}
			plug.stopAll()
			flushToDisk()
			frozen = true
			// peerHeader: the requests passed on carry their peer, signed (REQ-F-814), so trustFrom still holds.
			out = M{"online": anyList(realBridges()), "peerHeader": true}
			mu.Unlock()
			return out
		},
		resume: func() {
			mu.Lock()
			frozen = false
			if err := try(func() { plug.startAll(users.Keys()) }); err != nil {
				logLine("plugins", err)
			}
			mu.Unlock()
		},
		cut: func() {
			mu.Lock()
			cutStreams()
			mu.Unlock()
		},
	})
	go locked("plugins", func() { plug.startAll(users.Keys()) })
	allowed := strings.Join(ALLOWED, ", ")
	if allowed == "" {
		allowed = "(none)"
	}
	admins := strings.Join(ADMINS, ", ")
	if admins == "" {
		admins = "(none)"
	}
	logLine("claude-bridge " + VERSION + " on :" + itoa(PORT) + ", data " + DATA + ", allowed logins: " + allowed + ", admins: " + admins)
	if DEV_LOGIN {
		logLine("WARNING: BRIDGE_DEV_LOGIN=1 — anyone who can reach this server can sign in without GitHub")
	}
	_ = srv.Serve(ln)
}

var _ = url.Parse
