// The local preview (server/preview.mjs): a web server a session started on its Mac, shown on another device through
// a second origin of this server. Tokens, the key file and preview-given.json are the Node server's, unchanged.
package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	PREVIEW_TTL_MS   = 24 * 3_600_000
	PREVIEW_BODY_MAX = 16 * 1024 * 1024
	POOL_SIZE        = 8
	PREVIEW_PROBE_MS = 10 * 60_000
)

var previewHop = regexp.MustCompile(`(?i)^(host|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|accept-encoding|content-length|x-forwarded-.*|x-real-ip|forwarded|cf-.*|x-bridge-handover)$`)
var previewTokenPath = regexp.MustCompile(`^/t/([\w-]+\.[\w-]+)(/.*)?$`)
var previewRefPath = regexp.MustCompile(`^/t/([\w-]+\.[\w-]+)/`)
var previewRefStrip = regexp.MustCompile(`^https?://[^/]+/t/[\w-]+\.[\w-]+`)
var previewLocStrip = regexp.MustCompile(`(?i)^https?://(localhost|127\.0\.0\.1|\[::1\]):\d+`)
var previewDomain = regexp.MustCompile(`(?i);\s*domain=[^;]*`)
var frameAncestors = regexp.MustCompile(`(?i)^\s*frame-ancestors\b`)
var hex24 = regexp.MustCompile(`^[0-9a-f]{24}$`)
var htmlRe = regexp.MustCompile(`(?i)html`)

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// poolCandidates: the pool's candidate origins for a site.
func poolCandidates(origin string) []string {
	if v := os.Getenv("BRIDGE_PREVIEW_POOL"); v != "" {
		out := []string{}
		for _, s := range strings.Split(v, ",") {
			s = trailSlashRe.ReplaceAllString(strings.TrimSpace(s), "")
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	if !strings.HasPrefix(origin, "https://") {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil
	}
	parts := strings.Split(u.Hostname(), ".")
	if len(parts) < 2 {
		return nil
	}
	out := []string{}
	for i := 0; i < POOL_SIZE; i++ {
		out = append(out, "https://lp"+itoa(i+1)+"-"+parts[0]+"."+strings.Join(parts[1:], "."))
	}
	return out
}

type givenRec struct {
	o              string
	at, since, gne float64
}

type wsConn struct {
	conn    net.Conn
	out     chan []byte
	hostID  string
	seq     float64
	opened  bool
	closed  bool
	resolve chan M
}

type Preview struct {
	ORIGIN     string
	HOST       string
	CANDIDATES []string
	origins    map[string]string
	ORIGINS    []string
	pool       []string
	key        []byte
	givenFile  string
	given      map[string]*givenRec
	saving     *Timer
	sockets    map[string]*wsConn
	canUse     func(uid, hostID, sid string) string
	// For tests: what the Mac answers, whether a candidate origin answers as this server, and the clock.
	askFn   func(hostID string, cmd M, timeoutMs int64) M
	probeFn func(origin string) bool
	nowFn   func() float64
}

func (p *Preview) now() float64 {
	if p.nowFn != nil {
		return p.nowFn()
	}
	return float64(nowMs())
}

func (p *Preview) ask(hostID string, cmd M, timeoutMs int64) M {
	if p.askFn != nil {
		return p.askFn(hostID, cmd, timeoutMs)
	}
	return ask(hostID, cmd, timeoutMs)
}

func hostOfURL(o string) string {
	u, err := url.Parse(o)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Host)
}

func createPreview(dataDir, origin string, port int, canUse func(uid, hostID, sid string) string) *Preview {
	o := os.Getenv("BRIDGE_PREVIEW_ORIGIN")
	if o == "" {
		if origin != "" {
			o = strings.Replace(origin, "://", "://lp.", 1)
		} else {
			o = "http://lp.localhost:" + itoa(port)
		}
	}
	o = trailSlashRe.ReplaceAllString(o, "")
	p := &Preview{ORIGIN: o, HOST: hostOfURL(o), CANDIDATES: poolCandidates(origin), origins: map[string]string{}, given: map[string]*givenRec{}, sockets: map[string]*wsConn{}, canUse: canUse}
	p.origins[p.HOST] = o
	p.ORIGINS = []string{o}
	for _, c := range p.CANDIDATES {
		h := hostOfURL(c)
		if _, has := p.origins[h]; !has {
			p.ORIGINS = append(p.ORIGINS, c)
		}
		p.origins[h] = c
	}
	keyFile := filepath.Join(dataDir, "preview.key")
	if b, err := os.ReadFile(keyFile); err == nil {
		p.key = b
	} else {
		p.key = randBytes(32)
		_ = os.MkdirAll(dataDir, 0o777)
		_ = os.WriteFile(keyFile, p.key, 0o600)
	}
	p.givenFile = filepath.Join(dataDir, "preview-given.json")
	p.readGiven(func(sid string, g *givenRec) { p.given[sid] = g })
	if len(p.CANDIDATES) > 0 {
		setTimeout(5*time.Second, func() { p.probePool() })
		setInterval(PREVIEW_PROBE_MS*time.Millisecond, func() { p.probePool() })
	}
	return p
}

func (p *Preview) sign(body string) string {
	m := hmac.New(sha256.New, p.key)
	m.Write([]byte(body))
	return b64u(m.Sum(nil)[:16])
}

func (p *Preview) probeAnswer(host, n string) string {
	return p.sign("preview-origin:" + strings.ToLower(host) + ":" + n)
}

func cleanGiven(v any) *givenRec {
	g, ok := v.(M)
	if !ok {
		return nil
	}
	o, ok := g["o"].(string)
	if !ok {
		return nil
	}
	r := &givenRec{o: o, at: numOrNaN0(g["at"]), since: numOrNaN0(g["since"])}
	if truthy(g["gone"]) {
		r.gne = jsNumber(g["gone"])
	}
	return r
}

func (p *Preview) readGiven(f func(string, *givenRec)) {
	b, err := os.ReadFile(p.givenFile)
	if err != nil {
		return
	}
	v, err := parseJSON(b)
	if err != nil {
		return
	}
	keys := jsonKeyOrder(b)
	m, _ := v.(M)
	for _, sid := range keys {
		if g := cleanGiven(m[sid]); g != nil {
			f(sid, g)
		}
	}
}

func stamp(g *givenRec) float64 { return maxF(g.at, g.gne) }

func newerGiven(a, b *givenRec) *givenRec {
	if a.gne != 0 && b.gne == 0 {
		if b.since > a.gne {
			return b
		}
		return a
	}
	if b.gne != 0 && a.gne == 0 {
		if a.since > b.gne {
			return a
		}
		return b
	}
	if stamp(b) > stamp(a) {
		return b
	}
	return a
}

func holds(g *givenRec) bool { return g != nil && g.gne == 0 }

func (p *Preview) saveGiven() {
	if p.saving != nil {
		return
	}
	p.saving = setTimeout(time.Second, func() {
		p.saving = nil
		p.readGiven(func(sid string, g *givenRec) {
			if cur, ok := p.given[sid]; ok {
				p.given[sid] = newerGiven(cur, g)
			} else {
				p.given[sid] = g
			}
		})
		now := p.now()
		for sid, g := range p.given {
			if g.gne != 0 && now-g.gne > PREVIEW_TTL_MS {
				delete(p.given, sid)
			}
		}
		out := newOMap[orderedObj]()
		keys := []string{}
		for k := range p.given {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, sid := range keys {
			g := p.given[sid]
			o := orderedObj{{"o", g.o}, {"at", g.at}, {"since", g.since}}
			if g.gne != 0 {
				o = append(o, kv{"gone", g.gne})
			}
			out.Set(sid, o)
		}
		tmp := p.givenFile + "." + itoa(os.Getpid()) + "." + randHex(4) + ".tmp"
		if os.WriteFile(tmp, jsonBytes(out), 0o600) == nil {
			_ = os.Rename(tmp, p.givenFile)
		}
	})
}

func (p *Preview) originFor(sid string) string {
	if len(p.pool) == 0 {
		return p.ORIGIN
	}
	now := p.now()
	g := p.given[sid]
	if !holds(g) || !contains(p.pool, g.o) {
		held := map[string]bool{}
		for _, x := range p.given {
			if holds(x) {
				held[x.o] = true
			}
		}
		o := ""
		for _, x := range p.pool {
			if !held[x] {
				o = x
				break
			}
		}
		if o == "" {
			type e struct {
				sid string
				g   *givenRec
			}
			list := []e{}
			for s, x := range p.given {
				if holds(x) && contains(p.pool, x.o) {
					list = append(list, e{s, x})
				}
			}
			sort.SliceStable(list, func(i, j int) bool { return list[i].g.at < list[j].g.at })
			if len(list) > 0 {
				c := *list[0].g
				c.gne = now
				p.given[list[0].sid] = &c
				o = list[0].g.o
			} else {
				o = p.pool[0]
			}
		}
		g = &givenRec{o: o, at: 0, since: now}
	}
	since := g.since
	if since == 0 {
		since = now
	}
	p.given[sid] = &givenRec{o: g.o, at: now, since: since}
	p.saveGiven()
	return g.o
}

func (p *Preview) mint(uid, hostID string, port float64, sid string) string {
	o := p.originFor(sid)
	t := orderedObj{{"u", uid}, {"h", hostID}, {"s", sid}, {"p", port}, {"e", p.now() + PREVIEW_TTL_MS}}
	if o != p.ORIGIN {
		t = append(t, kv{"o", o})
	}
	body := b64u(jsonBytes(t))
	return body + "." + p.sign(body)
}

func (p *Preview) url(uid, hostID string, port float64, sid string) string {
	token := p.mint(uid, hostID, port, sid)
	b, _ := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[0])
	v, _ := parseJSON(b)
	o := p.ORIGIN
	if s, ok := mget(v, "o").(string); ok {
		o = s
	}
	return o + "/t/" + token + "/"
}

func (p *Preview) probePool() {
	ok := []string{}
	for _, o := range p.CANDIDATES {
		n := randHex(12)
		host := hostOfURL(o)
		var got string
		if p.probeFn != nil {
			if p.probeFn(o) {
				ok = append(ok, o)
			}
			continue
		}
		await(func() {
			c := &http.Client{Timeout: 5 * time.Second}
			r, err := c.Get(o + "/robots.txt?n=" + n)
			if err != nil {
				return
			}
			_ = r.Body.Close()
			got = r.Header.Get("x-bridge-preview")
		})
		if got != "" && got == p.probeAnswer(host, n) {
			ok = append(ok, o)
		}
	}
	if strings.Join(ok, ",") != strings.Join(p.pool, ",") {
		hs := []string{}
		for _, o := range ok {
			hs = append(hs, hostOfURL(o))
		}
		said := strings.Join(hs, ", ")
		if said == "" {
			said = "없음, 기본 하나만"
		}
		logLine("preview: 미리보기 출처 " + itoa(len(ok)) + "개 사용 (" + said + ")")
	}
	p.pool = ok
}

// open: a token's contents, when it is this server's, unexpired, for this origin and its session still holds it.
func (p *Preview) open(token, host string) M {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" || len(parts[1]) != 22 {
		return nil
	}
	body, mac := parts[0], parts[1]
	want := p.sign(body)
	if len(mac) != len(want) || subtle.ConstantTimeCompare([]byte(mac), []byte(want)) != 1 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(body, "="))
	if err != nil {
		return nil
	}
	v, err := parseJSON(b)
	t, ok := v.(M)
	if err != nil || !ok {
		return nil
	}
	o := p.ORIGIN
	if s, ok := t["o"].(string); ok {
		o = s
	} else if t["o"] != nil {
		return nil
	}
	if !(jsNumber(t["e"]) > p.now() && truthy(t["s"]) && hostOfURL(o) == strings.ToLower(host)) {
		return nil
	}
	if s, ok := t["o"].(string); ok {
		g := p.given[jsString(t["s"])]
		if !holds(g) || g.o != s {
			return nil
		}
		if p.now()-g.at > 60_000 {
			g.at = p.now()
			p.saveGiven()
		}
	}
	return t
}

func previewPage(res *Res, status int, title, text string) {
	res.WriteHead(status, M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"}).EndS(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>` + title + `</title><style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#888}h1{font-size:18px;color:CanvasText}</style><h1>` + title + `</h1><p>` + text + `</p></html>`)
}

func previewCookies(cookie string) map[string]string {
	out := map[string]string{}
	for _, c := range regexp.MustCompile(`;\s*`).Split(cookie, -1) {
		if c == "" {
			continue
		}
		i := strings.Index(c, "=")
		if i < 0 {
			// c.slice(0, -1), c.slice(0): as the Node code split it.
			out[jsSliceTo(c, jsLen(c)-1)] = c
			continue
		}
		out[c[:i]] = c[i+1:]
	}
	return out
}

func (p *Preview) hostOf(r *http.Request) string { return strings.ToLower(r.Host) }

func (p *Preview) originOfReq(r *http.Request) string {
	if o, ok := p.origins[p.hostOf(r)]; ok {
		return o
	}
	return p.ORIGIN
}

func (p *Preview) is(r *http.Request) bool {
	_, ok := p.origins[p.hostOf(r)]
	return ok
}

func (p *Preview) handle(req *Req, res *Res) {
	r := req.r
	here := p.originOfReq(r)
	host := hostOfURL(here)
	u := r.URL
	m := previewTokenPath.FindStringSubmatch(u.EscapedPath())
	search := ""
	if u.RawQuery != "" {
		search = "?" + u.RawQuery
	}
	if m == nil {
		token := ""
		if ref, err := url.Parse(req.H("referer")); err == nil && req.H("referer") != "" && strings.ToLower(ref.Host) == host {
			if mm := previewRefPath.FindStringSubmatch(ref.Path); mm != nil {
				token = mm[1]
			}
		}
		if token == "" {
			token = previewCookies(req.H("cookie"))["lp_t"]
		}
		if u.EscapedPath() == "/robots.txt" {
			n := u.Query().Get("n")
			h := M{"Content-Type": "text/plain"}
			if n != "" && hex24.MatchString(n) {
				h["x-bridge-preview"] = p.probeAnswer(host, n)
			}
			res.WriteHead(200, h).EndS("User-agent: *\nDisallow: /\n")
			return
		}
		if token == "" || p.open(token, host) == nil {
			previewPage(res, 404, "미리보기 주소가 아니에요", "세션 화면의 컴퓨터 버튼으로 다시 열어 주세요.")
			return
		}
		res.WriteHead(307, M{"Location": "/t/" + token + u.EscapedPath() + search, "Cache-Control": "no-store"}).End()
		return
	}
	token := m[1]
	t := p.open(token, host)
	if t == nil {
		previewPage(res, 403, "미리보기 주소가 만료됐어요", "세션 화면의 컴퓨터 버튼으로 다시 열어 주세요.")
		return
	}
	if m[2] == "" {
		res.WriteHead(308, M{"Location": "/t/" + token + "/" + search}).End()
		return
	}
	if why := p.canUse(jsString(t["u"]), jsString(t["h"]), jsString(t["s"])); why != "" {
		previewPage(res, 503, "맥에 닿지 않아요", why)
		return
	}
	var data []byte
	tooBig := false
	await(func() {
		b, _ := io.ReadAll(io.LimitReader(r.Body, PREVIEW_BODY_MAX+1))
		if len(b) > PREVIEW_BODY_MAX {
			tooBig = true
		}
		data = b
	})
	if tooBig {
		previewPage(res, 413, "요청이 너무 커요", "16MB 까지 보낼 수 있어요.")
		return
	}
	port := t["p"]
	local := "http://localhost:" + jsStringU(port)
	headers := M{}
	for k := range r.Header {
		lk := strings.ToLower(k)
		if previewHop.MatchString(lk) {
			continue
		}
		v := req.H(lk)
		switch lk {
		case "origin":
			headers[lk] = local
		case "referer":
			headers[lk] = previewRefStrip.ReplaceAllString(v, local)
		case "cookie":
			keep := []string{}
			for _, c := range regexp.MustCompile(`;\s*`).Split(v, -1) {
				if c != "" && !strings.HasPrefix(c, "lp_t=") {
					keep = append(keep, c)
				}
			}
			if len(keep) > 0 {
				headers[lk] = strings.Join(keep, "; ")
			}
		default:
			headers[lk] = v
		}
	}
	path := m[2]
	b64 := ""
	if len(data) > 0 {
		b64 = base64.StdEncoding.EncodeToString(data)
	}
	a := p.ask(jsString(t["h"]), M{"t": "http", "port": port, "method": r.Method, "path": path + search, "headers": headers, "body": b64}, 70_000)
	if !truthy(a["ok"]) {
		status := int(numOrNaN0(a["status"]))
		if status == 0 {
			status = 502
		}
		e := ""
		if a["error"] != nil {
			e = jsString(a["error"])
		}
		previewPage(res, status, "로컬 서버가 답하지 않아요", strings.NewReplacer("<", "", ">", "", "&", "").Replace(e))
		return
	}
	out := M{}
	isHTML := false
	for _, h := range asArr(a["headers"]) {
		pair := asArr(h)
		if len(pair) >= 2 && strings.ToLower(jsString(pair[0])) == "content-type" && htmlRe.MatchString(jsString(pair[1])) {
			isHTML = true
		}
	}
	for _, h := range asArr(a["headers"]) {
		pair := asArr(h)
		if len(pair) < 2 {
			continue
		}
		k := strings.ToLower(jsString(pair[0]))
		v := pair[1]
		switch k {
		case "x-frame-options":
			continue
		case "content-security-policy":
			keep := []string{}
			for _, d := range strings.Split(jsString(v), ";") {
				if !frameAncestors.MatchString(d) {
					keep = append(keep, d)
				}
			}
			csp := strings.Join(keep, ";")
			if jsTrim(csp) != "" {
				out[k] = csp
			}
			continue
		case "location":
			loc := previewLocStrip.ReplaceAllString(jsString(v), "")
			if strings.HasPrefix(loc, "/") && !strings.HasPrefix(loc, "//") {
				out[k] = "/t/" + token + loc
			} else {
				out[k] = v
			}
			continue
		}
		out[k] = v
	}
	set := []string{}
	for _, c := range asArr(a["cookies"]) {
		set = append(set, previewDomain.ReplaceAllString(jsString(c), ""))
	}
	if isHTML {
		sec := ""
		if strings.HasPrefix(p.ORIGIN, "https:") {
			sec = "; Secure"
		}
		set = append(set, "lp_t="+token+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+itoa(PREVIEW_TTL_MS/1000)+sec)
	}
	if len(set) > 0 {
		out["set-cookie"] = set
	}
	out["x-robots-tag"] = "noindex"
	out["referrer-policy"] = "same-origin"
	bytes := decodeB64(strField(a, "body"))
	status := int(numOrNaN0(a["status"]))
	if status == 0 {
		status = 200
	}
	res.WriteHead(status, out)
	if r.Method == "HEAD" {
		res.End()
	} else {
		res.End(bytes)
	}
}

// ---------- WebSockets (a dev server's live reload, HMR) ----------

func wsFrame(opcode byte, payload []byte) []byte {
	n := len(payload)
	var head []byte
	switch {
	case n < 126:
		head = []byte{0x80 | opcode, byte(n)}
	case n < 65536:
		head = []byte{0x80 | opcode, 126, byte(n >> 8), byte(n & 255)}
	default:
		head = make([]byte, 10)
		head[0], head[1] = 0x80|opcode, 127
		binary.BigEndian.PutUint64(head[2:], uint64(n))
	}
	return append(head, payload...)
}

func wsCloseFrame(code int, reason string) []byte {
	r := []byte(jsSliceTo(reason, 100))
	b := make([]byte, 2+len(r))
	binary.BigEndian.PutUint16(b, uint16(code))
	copy(b[2:], r)
	return wsFrame(0x8, b)
}

func (c *wsConn) send(b []byte) {
	defer func() { _ = recover() }()
	select {
	case c.out <- b:
	default:
	}
}

// finish: with the lock.
func (p *Preview) finish(id string, code int, reason string, tellMac bool) {
	c, ok := p.sockets[id]
	if !ok || c.closed {
		return
	}
	c.closed = true
	delete(p.sockets, id)
	if tellMac {
		c.seq++
		toHost(c.hostID, M{"t": "ws", "op": "close", "id": id, "seq": c.seq, "code": code, "reason": reason})
	}
	if c.opened {
		c.send(wsCloseFrame(code, reason))
	}
	c.send(nil)
	conn := c.conn
	time.AfterFunc(time.Second, func() { _ = conn.Close() })
}

// upgrade: a WebSocket to the preview origin. Takes the connection over; called without the lock.
func (p *Preview) upgrade(w http.ResponseWriter, r *http.Request) {
	conn, rw, err := hijack(w)
	if err != nil {
		return
	}
	refuseWS := func(status int, text string) {
		_, _ = conn.Write([]byte("HTTP/1.1 " + itoa(status) + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"))
		_ = conn.Close()
	}
	if strings.ToLower(r.Header.Get("Upgrade")) != "websocket" || r.Header.Get("Sec-WebSocket-Key") == "" {
		refuseWS(400, "Bad Request")
		return
	}
	here := p.originOfReq(r)
	if r.Header.Get("Origin") != here {
		refuseWS(403, "Forbidden")
		return
	}
	m := previewTokenPath.FindStringSubmatch(r.URL.EscapedPath())
	token := ""
	if m != nil {
		token = m[1]
	} else {
		token = previewCookies(strings.Join(r.Header.Values("Cookie"), "; "))["lp_t"]
	}
	mu.Lock()
	var t M
	if token != "" {
		t = p.open(token, hostOfURL(here))
	}
	if t == nil {
		mu.Unlock()
		refuseWS(403, "Forbidden")
		return
	}
	if p.canUse(jsString(t["u"]), jsString(t["h"]), jsString(t["s"])) != "" {
		mu.Unlock()
		refuseWS(503, "Service Unavailable")
		return
	}
	id := uuidv4()
	c := &wsConn{conn: conn, out: make(chan []byte, 1024), hostID: jsString(t["h"]), resolve: make(chan M, 1)}
	p.sockets[id] = c
	protocols := []any{}
	for _, s := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			protocols = append(protocols, s)
		}
	}
	path := r.URL.EscapedPath()
	if m != nil {
		path = m[2]
		if path == "" {
			path = "/"
		}
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	if !toHost(c.hostID, M{"t": "ws", "op": "open", "id": id, "seq": 0, "port": t["p"], "path": path, "protocols": protocols}) {
		c.resolve <- M{"op": "error", "error": "offline"}
	}
	resolveCh := c.resolve
	mu.Unlock()
	// The browser going away while the Mac opens its end.
	gone := make(chan struct{})
	var answer M
	select {
	case answer = <-resolveCh:
	case <-time.After(15 * time.Second):
		answer = M{"op": "error", "error": "timeout"}
	}
	mu.Lock()
	c.resolve = nil
	if answer["op"] != "open" || c.closed {
		delete(p.sockets, id)
		if answer["op"] == "open" {
			c.seq++
			toHost(c.hostID, M{"t": "ws", "op": "close", "id": id, "seq": c.seq, "code": 1001, "reason": ""})
		}
		mu.Unlock()
		refuseWS(502, "Bad Gateway")
		return
	}
	c.opened = true
	mu.Unlock()
	h := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	lines := []string{"HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(h[:])}
	if s, ok := answer["protocol"].(string); ok && s != "" {
		lines = append(lines, "Sec-WebSocket-Protocol: "+s)
	}
	if _, err := conn.Write([]byte(strings.Join(append(lines, "", ""), "\r\n"))); err != nil {
		locked("ws", func() { p.finish(id, 1001, "browser went away", true) })
		return
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	// Writer: frames for the browser, in order; nil ends it.
	go func() {
		for b := range c.out {
			if b == nil {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := conn.Write(b); err != nil {
				return
			}
		}
	}()
	p.readFrames(id, c, rw.Reader)
	close(gone)
	locked("ws", func() { p.finish(id, 1001, "browser went away", true) })
}

func (p *Preview) readFrames(id string, c *wsConn, rd *bufio.Reader) {
	var parts []byte
	var partOp byte
	for {
		h := make([]byte, 2)
		if _, err := io.ReadFull(rd, h); err != nil {
			return
		}
		fin := h[0]&0x80 != 0
		op := h[0] & 0x0f
		n := uint64(h[1] & 0x7f)
		if n == 126 {
			b := make([]byte, 2)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			n = uint64(binary.BigEndian.Uint16(b))
		} else if n == 127 {
			b := make([]byte, 8)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			n = binary.BigEndian.Uint64(b)
		}
		if n > PREVIEW_BODY_MAX {
			locked("ws", func() { p.finish(id, 1009, "too big", true) })
			return
		}
		masked := h[1]&0x80 != 0
		var mask []byte
		if masked {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(rd, mask); err != nil {
				return
			}
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(rd, data); err != nil {
			return
		}
		if masked {
			for i := range data {
				data[i] ^= mask[i&3]
			}
		}
		switch op {
		case 0x8:
			code := 1000
			reason := ""
			if len(data) >= 2 {
				code = int(binary.BigEndian.Uint16(data))
				reason = string(data[2:])
			}
			locked("ws", func() { p.finish(id, code, reason, true) })
			return
		case 0x9:
			c.send(wsFrame(0xa, data))
			continue
		case 0xa:
			continue
		case 0x1, 0x2:
			parts = data
			partOp = op
		case 0x0:
			parts = append(parts, data...)
		}
		if !fin {
			continue
		}
		whole := parts
		parts = nil
		bin := partOp == 0x2
		stop := false
		locked("ws", func() {
			var d any
			if bin {
				d = base64.StdEncoding.EncodeToString(whole)
			} else {
				d = string(validUTF8(string(whole)))
			}
			c.seq++
			if !toHost(c.hostID, M{"t": "ws", "op": "send", "id": id, "seq": c.seq, "binary": bin, "data": d}) {
				p.finish(id, 1011, "mac offline", false)
				stop = true
			}
		})
		if stop {
			return
		}
	}
}

// fromAgent: a `ws` message from a host's agent, with the lock.
func (p *Preview) fromAgent(hostID string, msg M) {
	id := jsStringU(msg["id"])
	c, ok := p.sockets[id]
	if !ok || c.hostID != hostID {
		return
	}
	if c.resolve != nil {
		select {
		case c.resolve <- msg:
		default:
		}
		return
	}
	if msg["op"] == "msg" {
		if truthy(msg["binary"]) {
			c.send(wsFrame(0x2, decodeB64(jsStringU(msg["data"]))))
		} else {
			c.send(wsFrame(0x1, []byte(jsStringU(msg["data"]))))
		}
		return
	}
	if msg["op"] == "close" || msg["op"] == "error" {
		code := jsNumber(msg["code"])
		cc := 1011
		if code >= 1000 && code < 5000 && code != 1005 && code != 1006 && code != 1015 {
			cc = int(code)
		}
		reason := ""
		if msg["reason"] != nil {
			reason = jsString(msg["reason"])
		}
		p.finish(id, cc, reason, false)
	}
}

// hostGone: a host's agent said hello: its sockets it does not still hold are gone.
func (p *Preview) hostGone(hostID string, keep []string) {
	for id, c := range p.sockets {
		if c.hostID == hostID && c.opened && !contains(keep, id) {
			p.finish(id, 1012, "mac restarted", false)
		}
	}
}
