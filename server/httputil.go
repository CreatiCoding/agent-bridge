package main

import (
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ---------- http ----------

var MIME = map[string]string{".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".webp": "image/webp"}

var SECURITY M

func cspMore(key string) string {
	out := ""
	for _, x := range cfgGet(key).([]string) {
		out += " " + x
	}
	return out
}

func initSecurity() {
	SECURITY = M{
		// Inline styles are allowed for the HTML previews (a sandboxed frame that inherits this policy).
		// base-uri and object-src are not covered by default-src: a <base> or a plugin object stays off (REQ-S-011).
		// csp.imgSrc and csp.frameSrc (REQ-F-812) only add https sources; script-src and connect-src never widen.
		"Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com" + cspMore("csp.imgSrc") + "; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; frame-src 'self' " + strings.Join(preview.ORIGINS, " ") + cspMore("csp.frameSrc") + "; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
	}
}

// HSTS: a site served over https tells the browser to come back only over https (REQ-S-082). Not includeSubDomains:
// the other names under the same domain are not this server's.
const HSTS = "max-age=31536000"

// transportHeaders: headers every answer of an https site carries, the event streams and the previews' too.
func transportHeaders(h http.Header, req *Req) {
	if strings.HasPrefix(originOf(req), "https://") {
		h.Set("Strict-Transport-Security", HSTS)
	}
}

var UI string

type pageBuildCache struct {
	stamp time.Time
	id    string
}

var pageBuild *pageBuildCache

// PAGE_BUILD: which build of the page (ui/dist) this server sends, for a report.
func PAGE_BUILD() string {
	file := filepath.Join(UI, "index.html")
	st, err := os.Stat(file)
	if err != nil {
		return ""
	}
	if pageBuild == nil || !pageBuild.stamp.Equal(st.ModTime()) {
		b, err := os.ReadFile(file)
		if err != nil {
			return ""
		}
		sum := sha1.Sum(b)
		pageBuild = &pageBuildCache{st.ModTime(), hex.EncodeToString(sum[:])[:10]}
	}
	return pageBuild.id
}

// Text sent compressed when the browser takes it. Go has no Brotli: gzip, as the server sent until its Brotli copy
// was ready.
var COMPRESSIBLE = regexp.MustCompile(`^(text/|application/(json|javascript|manifest\+json)|image/svg\+xml)`)
var gzipWordRe = regexp.MustCompile(`\bgzip\b`)

type fileHit struct {
	mtime time.Time
	raw   []byte
	gzip  []byte
}

var compressedFiles = map[string]*fileHit{}

func fileEntry(file string, st os.FileInfo, typ string) *fileHit {
	if hit, ok := compressedFiles[file]; ok && hit.mtime.Equal(st.ModTime()) {
		return hit
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	hit := &fileHit{mtime: st.ModTime(), raw: raw}
	if COMPRESSIBLE.MatchString(typ) && len(raw) >= 1024 {
		hit.gzip = gzipBytes(raw, 9)
	}
	compressedFiles[file] = hit
	return hit
}

func mimeOf(file string) string {
	if t, ok := MIME[filepath.Ext(file)]; ok {
		return t
	}
	return "application/octet-stream"
}

func sendFile(res *Res, file string, cache string) {
	if cache == "" {
		cache = "no-cache"
	}
	st, err := os.Stat(file)
	if err != nil || !st.Mode().IsRegular() {
		res.WriteHead(404).EndS("not found")
		return
	}
	typ := mimeOf(file)
	hit := fileEntry(file, st, typ)
	if hit == nil {
		res.WriteHead(404).EndS("not found")
		return
	}
	enc := ""
	if hit.gzip != nil && res.req != nil && gzipWordRe.MatchString(res.req.H("accept-encoding")) {
		enc = "gzip"
	}
	h := M{"Content-Type": typ, "Cache-Control": cache, "Vary": "Accept-Encoding"}
	if enc != "" {
		h["Content-Encoding"] = enc
		res.WriteHead(200, SECURITY, h).End(hit.gzip)
		return
	}
	res.WriteHead(200, SECURITY, h).End(hit.raw)
}

// preloadAssets: at start the control page's files are read and compressed before anyone asks for them.
func preloadAssets() {
	dir := filepath.Join(ROOT, "ui", "dist", "assets")
	names, _ := os.ReadDir(dir)
	for _, n := range names {
		file := filepath.Join(dir, n.Name())
		if st, err := os.Stat(file); err == nil {
			fileEntry(file, st, mimeOf(file))
		}
	}
}

type uiBuildEntry struct {
	mtime time.Time
	name  any
}

var uiBuildCache *uiBuildEntry
var uiEntryRe = regexp.MustCompile(`/assets/(index-[\w-]+\.js)`)

// uiBuild: the entry file of the page in ui/dist (`index-<hash>.js`). nil without a build.
func uiBuild() any {
	file := filepath.Join(UI, "index.html")
	st, err := os.Stat(file)
	if err != nil {
		return nil
	}
	if uiBuildCache == nil || !uiBuildCache.mtime.Equal(st.ModTime()) {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		var name any
		if m := uiEntryRe.FindSubmatch(b); m != nil {
			name = string(m[1])
		}
		uiBuildCache = &uiBuildEntry{st.ModTime(), name}
	}
	return uiBuildCache.name
}

type uiPage struct {
	mtime time.Time
	body  []byte
}

var uiCache *uiPage

func sendUi(res *Res) {
	file := filepath.Join(UI, "index.html")
	st, err := os.Stat(file)
	if err != nil {
		panic(err)
	}
	if uiCache == nil || !uiCache.mtime.Equal(st.ModTime()) {
		b, err := os.ReadFile(file)
		if err != nil {
			panic(err)
		}
		uiCache = &uiPage{st.ModTime(), b}
	}
	res.WriteHead(200, SECURITY, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"}).End(uiCache.body)
}

// jsonRes is json(res, status, obj, headers): gzipped at a fast level when 1 KB or more and the browser takes it.
func jsonRes(res *Res, status int, obj any, headers ...M) {
	b := jsonBytes(obj)
	ae := ""
	if res.req != nil {
		ae = res.req.H("accept-encoding")
	}
	h := M{"Content-Type": "application/json", "Cache-Control": "no-store"}
	if jsLen(string(b)) >= 1024 && gzipWordRe.MatchString(ae) {
		h["Vary"] = "Accept-Encoding"
		h["Content-Encoding"] = "gzip"
		res.WriteHead(status, append([]M{h}, headers...)...).End(gzipBytes(b, 4))
		return
	}
	res.WriteHead(status, append([]M{h}, headers...)...).End(b)
}

func originOf(req *Req) string {
	if req.origin != "" {
		return req.origin
	}
	if ORIGIN != "" {
		return ORIGIN
	}
	proto := req.H("x-forwarded-proto")
	if proto == "" {
		proto = "http"
	}
	host := req.H("host")
	if host == "" && req.r != nil {
		host = req.r.Host
	}
	if host == "" {
		host = "undefined"
	}
	return proto + "://" + host
}

var cookieSplitRe = regexp.MustCompile(`;\s*`)

func cookiePairs(req *Req) [][2]string {
	out := [][2]string{}
	for _, c := range cookieSplitRe.Split(req.H("cookie"), -1) {
		if c == "" {
			continue
		}
		i := strings.Index(c, "=")
		if i < 0 {
			// c.slice(0, -1) and c.slice(0): the name loses its last letter, the value is all of it.
			out = append(out, [2]string{jsSliceTo(c, jsLen(c)-1), c})
			continue
		}
		out = append(out, [2]string{c[:i], c[i+1:]})
	}
	return out
}

func cookies(req *Req) map[string]string {
	out := map[string]string{}
	for _, p := range cookiePairs(req) {
		out[p[0]] = p[1]
	}
	return out
}

// cookieAll: every value a cookie name has in the request: a cookie planted for a parent domain comes along with ours.
func cookieAll(req *Req, name string) []string {
	out := []string{}
	for _, p := range cookiePairs(req) {
		if p[0] == name {
			out = append(out, p[1])
		}
	}
	return out
}

// siteOrigin: the origin Macs and scripts are given: the primary one even on a page opened at another (REQ-F-815).
func siteOrigin(req *Req) string {
	if ORIGIN != "" {
		return ORIGIN
	}
	return originOf(req)
}

// secureSite: a page that may hold Secure cookies: https, or this machine.
func secureSite(req *Req) bool {
	u, err := url.Parse(originOf(req))
	if err != nil {
		throw("Invalid URL")
	}
	h := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		h = "[" + h + "]"
	}
	return u.Scheme == "https" || h == "localhost" || h == "127.0.0.1" || h == "[::1]"
}

// cname: sign-in cookies are `__Host-` on a secure site (REQ-S-080).
func cname(req *Req, base string) string {
	if secureSite(req) {
		return "__Host-" + base
	}
	return base
}

func cookie(req *Req, name, value string, maxAge int64) string {
	s := name + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + itoa(int(maxAge))
	if strings.HasPrefix(name, "__Host-") || strings.HasPrefix(originOf(req), "https:") {
		s += "; Secure"
	}
	return s
}

var LEGACY_CB_UNTIL = parseDate("2026-11-02T00:00:00Z")
var ipHostRe = regexp.MustCompile(`^[\d.]+$|^\[|^localhost$`)

// legacyCbClears: Set-Cookie lines that drop the old `cb` the request carries (REQ-S-080).
func legacyCbClears(req *Req) []string {
	if !secureSite(req) || len(cookieAll(req, "cb")) == 0 {
		return []string{}
	}
	u, _ := url.Parse(originOf(req))
	host := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		host = "[" + host + "]"
	}
	parts := strings.Split(host, ".")
	domains := []string{}
	if !ipHostRe.MatchString(host) {
		for i := 0; i < len(parts)-1; i++ {
			domains = append(domains, strings.Join(parts[i:], "."))
		}
	}
	base := "cb=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"
	out := []string{base}
	for _, d := range domains {
		out = append(out, base+"; Domain="+d)
	}
	return out
}

// sessionToken: the sign-in token of a request; a moved one (migrateLegacyCb) counts in the same request.
func sessionToken(req *Req) string {
	if req.movedCb != nil {
		return *req.movedCb
	}
	return cookies(req)[cname(req, "cb")]
}

// migrateLegacyCb: the move from `cb` to `__Host-cb` (REQ-S-080), until LEGACY_CB_UNTIL.
func migrateLegacyCb(req *Req, res *Res) {
	if !secureSite(req) {
		return
	}
	old := cookieAll(req, "cb")
	if len(old) == 0 {
		return
	}
	clears := legacyCbClears(req)
	if _, has := cookies(req)["__Host-cb"]; (!has || cookies(req)["__Host-cb"] == "") && float64(nowMs()) < LEGACY_CB_UNTIL && len(old) == 1 {
		login, ok := logins.Get(sha256hexs(old[0]))
		if ok && jsNumber(login["exp"]) > float64(nowMs()) {
			v := old[0]
			req.movedCb = &v
			secs := int64((jsNumber(login["exp"]) - float64(nowMs())) / 1000)
			if secs < 1 {
				secs = 1
			}
			res.SetHeader("Set-Cookie", append([]string{cookie(req, "__Host-cb", old[0], secs)}, clears...)...)
			return
		}
	}
	res.SetHeader("Set-Cookie", clears...)
}

func whoami(req *Req) string {
	// The proxy's word wins over any cookie the request carries (REQ-F-814).
	if req.trusted {
		if u, ok := users.Get(req.headerUid); ok && isAllowed(mstr(u, "login")) {
			return req.headerUid
		}
		return ""
	}
	if headerOnly() {
		return "" // a cookie alone is not enough here (REQ-F-816)
	}
	token := sessionToken(req)
	if token == "" {
		return ""
	}
	login, ok := logins.Get(sha256hexs(token))
	if !ok || jsNumber(login["exp"]) < float64(nowMs()) {
		return ""
	}
	uid := mstr(login, "uid")
	// A demo sign-in never runs out while 데모 모드 is on (REQ-S-068).
	if isDemoUid(uid) {
		if demoOn {
			return demoTouch(uid)
		}
		return ""
	}
	u, ok := users.Get(uid)
	if !ok {
		return ""
	}
	// The allow-list is checked on every request, so removing a login from it takes effect at once.
	if !isAllowed(mstr(u, "login")) {
		return ""
	}
	return uid
}

func signIn(req *Req, res *Res, uid string, next string, more []string) {
	loginBefore(uid, providerOf(uid))
	token := newSignIn(uid)
	emitEvent("login", uid, orderedObj{{"provider", providerOf(uid)}})
	set := []string{cookie(req, cname(req, "cb"), token, LOGIN_DAYS*86_400), cookie(req, cname(req, "cb_state"), "", 0)}
	set = append(set, more...)
	set = append(set, legacyCbClears(req)...)
	res.WriteHead(302, M{"Location": next, "Set-Cookie": set}).End()
}

// dropExpiredLogins: sign-ins past their end go every hour (REQ-S-074).
func dropExpiredLogins() {
	now := float64(nowMs())
	n := 0
	for _, k := range logins.Keys() {
		if !(jsNumber(logins.Val(k)["exp"]) > now) {
			logins.Delete(k)
			n++
		}
	}
	if n > 0 {
		touchGlobals()
	}
}

// qrCodes: sha256(code) -> { uid, exp, sid }. Five minutes, one use, never written to disk.
var qrCodes = map[string]M{}

const QR_MS = 5 * 60_000

var attempts = map[string][]int64{}

// clientIp: behind the site's proxy the last X-Forwarded-For entry is the one that proxy wrote (R1-M4).
func clientIp(req *Req) string {
	parts := strings.Split(req.H("x-forwarded-for"), ",")
	for i := len(parts) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(parts[i]); s != "" {
			return s
		}
	}
	if req.remote != "" {
		host := req.remote
		if i := strings.LastIndex(host, ":"); i >= 0 {
			host = host[:i]
		}
		host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
		if strings.Contains(host, ".") && !strings.Contains(host, ":") {
			return "::ffff:" + host
		}
		return host
	}
	return ""
}

// hit: one more try under key; true when there have been more than max in the last minute.
func hit(key string, max int) bool {
	now := nowMs()
	a := []int64{}
	for _, t := range attempts[key] {
		if now-t < 60_000 {
			a = append(a, t)
		}
	}
	a = append(a, now)
	attempts[key] = a
	return len(a) > max
}

func limited(req *Req, max int, kind string) bool {
	if max == 0 {
		max = 20
	}
	if kind == "" {
		kind = "auth"
	}
	return hit(kind+"|"+clientIp(req), max)
}

func startAttemptSweep() {
	setInterval(60_000*time.Millisecond, func() {
		now := nowMs()
		for k, a := range attempts {
			keep := false
			for _, t := range a {
				if now-t < 60_000 {
					keep = true
				}
			}
			if !keep {
				delete(attempts, k)
			}
		}
	})
	dropExpiredLogins()
	setInterval(3600_000*time.Millisecond, dropExpiredLogins)
}

// rawBody: a request's body as text, up to limit bytes.
func rawBody(req *Req, limit int) []byte { return []byte(validUTF8(string(req.readAll(limit)))) }

func escHtml(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&', '<', '>', '"', '\'':
			b.WriteString("&#" + itoa(int(r)) + ";")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// body: the request's JSON object, up to limit bytes.
func body(req *Req, limit int) M {
	b := rawBody(req, limit)
	v, err := parseJSON(b)
	if err != nil {
		refuse(400, "JSON 이 아닙니다")
	}
	// Every route reads fields of an object: null, a number or a list would fail later as a server error.
	m, ok := v.(M)
	if !ok || m == nil {
		refuse(400, "JSON 객체가 아닙니다")
	}
	return m
}

// safeNext: a path on this site only: "//host/…" would be read by the browser as another site.
var safeNextRe = regexp.MustCompile(`^/[a-zA-Z0-9/_-]*(?:\?[\w=&,-]*)?$`)

func safeNext(n any) string {
	s, ok := n.(string)
	if ok && safeNextRe.MatchString(s) && !strings.HasPrefix(s, "//") {
		return s
	}
	return "/"
}

// APP_PATH: the control page's own addresses (ui/src/lib/router.ts matchRoute): each is served the same page.
var APP_PATH = regexp.MustCompile(`^/(?:s/[\w-]+|new|stats|quality|disk|hosts(?:/[\w-]+)?|admin(?:/reports/[\w-]+)?|settings(?:/[a-z]+)?|split|guide(?:/(?:move|accounts))?)$`)

const FONT_TOKENS = ":root{--fs-xsmall:12px;--fs-small:13px;--fs-medium:14px;--fs-large:16px;--fs-xlarge:20px}"

func page(title, text string) string {
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + title + `</title><style>` + FONT_TOKENS + `</style><body style="font:var(--fs-large) system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:var(--fs-xlarge)">` + title + `</h1><p>` + text + `</p><p><a href="/">처음으로</a></p>`
}

// requestAccess: a sign-in by an account that is not allowed becomes a request an operator can decide on.
func requestAccess(login, name, avatar string) M {
	k := strings.ToLower(login)
	a, ok := access.Get(k)
	if !ok {
		a = M{"login": login, "status": "pending", "firstAt": float64(nowMs()), "attempts": 0.0}
		access.Set(k, a)
	}
	if name == "" {
		name = login
	}
	a["login"] = login
	a["name"] = name
	a["avatar"] = avatar
	a["lastAt"] = float64(nowMs())
	a["attempts"] = numOr0(a["attempts"]) + 1
	touchGlobals()
	logLine("login refused: " + login + " (" + jsStringU(a["status"]) + ", attempt " + numStr(numOr0(a["attempts"])) + ")")
	return a
}

// appleUsed: hashes of nonces already used by a sign-in, until their tokens could no longer be in date.
var appleUsed = map[string]int64{}

// sameSite: same-site form or fetch: a form says so in Sec-Fetch-Site, not Origin.
func sameSite(req *Req) bool {
	o := req.H("origin")
	return (req.Has("origin") && o == originOf(req)) || ((!req.Has("origin") || o == "" || o == "null") && req.H("sec-fetch-site") == "same-origin")
}

func mkdirAll(dir string, mode ...os.FileMode) {
	m := os.FileMode(0o755)
	if len(mode) > 0 {
		m = mode[0]
	}
	_ = os.MkdirAll(dir, m)
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}
