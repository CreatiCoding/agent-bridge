package main

// What an agreed extension may do on the server (REQ-F-826): keep small JSON values (the person's, the server's,
// the person's secrets), call the addresses its routes name, hear events and claim one for the whole person.

import (
	"bytes"
	"context"
	"io"
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
	EXT_VALUE_MAX = 64 << 10 // one value, as JSON
	EXT_SPACE_MAX = 1 << 20  // one extension's values for one person, or for the server
	EXT_REQ_MAX   = 1 << 20  // a route's request body
	EXT_RES_MAX   = 5 << 20  // a route's answer
	EXT_CLAIM_MS  = 10 * 60_000
	EXT_CLAIM_MAX = 1000
)

// ---------- storage ----------

// The files: the person's values and secrets in their own folder (gone with the account), the server's apart.
func extStoreFile(scope, uid, id string) string {
	switch scope {
	case "server":
		return filepath.Join(DATA, "ext-data", id, "data.json")
	case "secrets":
		return filepath.Join(userDir(uid), "ext", id, "secrets.json")
	}
	return filepath.Join(userDir(uid), "ext", id, "data.json")
}

func extStore(scope, uid, id string) M {
	if m, ok := readJSON(extStoreFile(scope, uid, id), M{}).(M); ok {
		return m
	}
	return M{}
}

func extKeys(m M, prefix string) []any {
	keys := []string{}
	for k := range m {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := []any{}
	for _, k := range keys {
		out = append(out, k)
	}
	return out
}

func extKey(k string) string {
	if !extKeyRe.MatchString(k) || strings.Trim(k, ".") == "" {
		refuse(400, "쓸 수 없는 키예요: "+k)
	}
	return k
}

// extStorage: /storage/user|server[/<key>]. Values are {value, version}; a write with ifVersion that is not the
// current version is 409. The server's may be written by admins only.
func extStorage(req *Req, res *Res, u *url.URL, uid string, d *extDef, scope, key string) {
	f := extStoreFile(scope, uid, d.ID)
	m := extStore(scope, uid, d.ID)
	if key == "" {
		if req.Method != "GET" {
			refuse(405, "지원하지 않는 메서드예요")
		}
		jsonRes(res, 200, M{"ok": true, "keys": extKeys(m, u.Query().Get("prefix"))})
		return
	}
	key = extKey(key)
	if req.Method != "GET" && scope == "server" && !isAdmin(uid) {
		refuse(403, "서버 저장소는 관리자만 쓸 수 있어요")
	}
	switch req.Method {
	case "GET":
		jsonRes(res, 200, M{"ok": true, "item": m[key]})
	case "PUT":
		b := body(req, EXT_VALUE_MAX+4096)
		val, has := b["value"]
		if !has {
			refuse(400, "value 가 없어요")
		}
		if len(jsonBytes(val)) > EXT_VALUE_MAX {
			refuse(413, "값은 64KB 까지예요")
		}
		cur, _ := m[key].(M)
		if want, ok := b["ifVersion"]; ok && want != nil && numOr0(want) != numOr0(cur["version"]) {
			refuse(409, "그사이 값이 바뀌었어요")
		}
		v := numOr0(cur["version"]) + 1
		m[key] = M{"value": val, "version": v}
		if len(jsonBytes(m)) > EXT_SPACE_MAX {
			refuse(413, "이 익스텐션의 저장 공간(1MB)이 찼어요")
		}
		writeJson(f, m)
		jsonRes(res, 200, M{"ok": true, "version": v})
	case "DELETE":
		delete(m, key)
		writeJson(f, m)
		jsonRes(res, 200, M{"ok": true})
	default:
		refuse(405, "지원하지 않는 메서드예요")
	}
}

// extSecrets: /secrets[/<key>]. Written and taken away, never read back: a route's ${user.KEY} is the only use.
func extSecrets(req *Req, res *Res, uid string, d *extDef, key string) {
	f := extStoreFile("secrets", uid, d.ID)
	m := extStore("secrets", uid, d.ID)
	if key == "" {
		if req.Method != "GET" {
			refuse(405, "지원하지 않는 메서드예요")
		}
		jsonRes(res, 200, M{"ok": true, "keys": extKeys(m, "")})
		return
	}
	key = extKey(key)
	switch req.Method {
	case "PUT":
		v, ok := body(req, EXT_VALUE_MAX+4096)["value"].(string)
		if !ok || v == "" || len(v) > EXT_VALUE_MAX {
			refuse(400, "value 는 64KB 까지의 글이어야 해요")
		}
		m[key] = v
		if len(jsonBytes(m)) > EXT_SPACE_MAX {
			refuse(413, "이 익스텐션의 저장 공간(1MB)이 찼어요")
		}
	case "DELETE":
		delete(m, key)
	default:
		refuse(405, "지원하지 않는 메서드예요")
	}
	writeJson(f, m)
	jsonRes(res, 200, M{"ok": true})
}

// ---------- routes ----------

// What comes back from an upstream: data and pictures only, so nothing it sends runs as this origin.
var EXT_RES_TYPES = []string{"application/json", "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp"}

// What of the browser's request goes on.
var EXT_FWD = []string{"Accept", "Accept-Language", "If-None-Match", "If-Modified-Since"}

var extClient = &http.Client{
	Timeout:       10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

var extBadPathRe = regexp.MustCompile(`(?i)%2f|%5c|%2e`)

// extProxy: /call/<route path>… goes to that route's upstream with the rest of the path and the query, signed, with
// its headers (the person's secrets put in), off the lock.
func extProxy(req *Req, res *Res, u *url.URL, uid string, d *extDef, raw string) {
	if req.Method != "GET" && req.Method != "POST" {
		refuse(405, "GET·POST 만 받아요")
	}
	if extBadPathRe.MatchString(raw) || strings.Contains(raw, "\\") {
		refuse(400, "주소에 쓸 수 없는 글자가 있어요")
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == ".." || seg == "." {
			refuse(400, "주소에 쓸 수 없는 조각이 있어요")
		}
	}
	var r *extRoute
	rest := ""
	for i := range d.Routes {
		if p := d.Routes[i].Path; strings.HasPrefix(raw, p) || raw+"/" == p {
			r = &d.Routes[i]
			rest = strings.TrimPrefix(raw, p)
			if raw+"/" == p {
				rest = ""
			}
		}
	}
	if r == nil {
		refuse(404, "이 익스텐션에 없는 경로예요")
	}
	target := r.Upstream + rest
	if u.RawQuery != "" {
		target += "?" + u.RawQuery
	}
	tu, err := url.Parse(target)
	if err != nil {
		refuse(400, "주소를 만들 수 없어요")
	}
	var reqBody []byte
	if req.Method == "POST" {
		reqBody = req.readAll(EXT_REQ_MAX + 1)
		if len(reqBody) > EXT_REQ_MAX {
			refuse(413, "요청 본문은 1MB 까지예요")
		}
	}
	login := ""
	if x, ok := users.Get(uid); ok {
		login = mstr(x, "login")
	}
	secrets := extStore("secrets", uid, d.ID)
	headers := [][2]string{}
	for _, h := range r.Headers {
		v, missing := h[1], false
		v = userRefRe.ReplaceAllStringFunc(v, func(ref string) string {
			s, ok := secrets[userRefRe.FindStringSubmatch(ref)[1]].(string)
			if !ok {
				missing = true
			}
			return s
		})
		if !missing { // without the person's secret the header is left out
			headers = append(headers, [2]string{h[0], v})
		}
	}
	for _, name := range EXT_FWD {
		if v := req.H(strings.ToLower(name)); v != "" {
			headers = append(headers, [2]string{name, v})
		}
	}
	pq := tu.EscapedPath()
	if tu.RawQuery != "" {
		pq += "?" + tu.RawQuery
	}
	sig := signedHeaders(r.Secret, req.Method, pq, uid, login, reqBody, time.Now())
	var status int
	var ctype string
	var out []byte
	var keep http.Header
	var fail string
	await(func() {
		hr, err := http.NewRequestWithContext(context.Background(), req.Method, target, bytes.NewReader(reqBody))
		if err != nil {
			fail = err.Error()
			return
		}
		for _, h := range headers {
			hr.Header.Set(h[0], h[1])
		}
		for k, v := range sig {
			hr.Header.Set(k, v)
		}
		hr.Header.Set("User-Agent", "claude-bridge/"+VERSION)
		if req.Method == "POST" {
			hr.Header.Set("Content-Type", "application/json")
		}
		resp, err := extClient.Do(hr)
		if err != nil {
			fail = "응답이 없어요"
			return
		}
		defer resp.Body.Close()
		out, _ = io.ReadAll(io.LimitReader(resp.Body, EXT_RES_MAX+1))
		status, ctype, keep = resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header
	})
	if fail != "" {
		refuse(502, "익스텐션의 서버에 닿지 못했어요: "+fail)
	}
	if len(out) > EXT_RES_MAX {
		refuse(502, "익스텐션의 서버가 준 답이 5MB 를 넘어요")
	}
	base := strings.ToLower(strings.TrimSpace(strings.Split(ctype, ";")[0]))
	if len(out) > 0 && !contains(EXT_RES_TYPES, base) {
		refuse(502, "익스텐션의 서버가 받을 수 없는 형식("+base+")으로 답했어요")
	}
	h := M{"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
	if ctype != "" {
		h["Content-Type"] = ctype
	}
	for _, k := range []string{"ETag", "Last-Modified"} {
		if v := keep.Get(k); v != "" {
			h[k] = v
		}
	}
	if status >= 300 && status < 400 {
		status = 502 // redirects are not followed, nor handed to the page
		out = nil
	}
	res.WriteHead(status, h).End(out)
}

// ---------- events and claims ----------

// extSent: the events each person's pages were sent (ext-event), by id; only those may be claimed. extClaims: who
// took which (person, extension, event) first. Both kept ten minutes, a thousand a person, and carried across a
// handover; a full restart forgets them.
var (
	extSent   = map[string]map[string]int64{}
	extClaims = map[string]map[string]int64{}
)

func keepRecent(m map[string]int64, now int64) {
	for k, at := range m {
		if now-at > EXT_CLAIM_MS {
			delete(m, k)
		}
	}
	for len(m) >= EXT_CLAIM_MAX {
		old, oldAt := "", int64(-1)
		for k, at := range m {
			if oldAt < 0 || at < oldAt {
				old, oldAt = k, at
			}
		}
		delete(m, old)
	}
}

// extHears: this person has an extension running that may hear events.
func extHears(uid string) bool {
	for _, d := range EXTS {
		if agreed(uid, d) {
			return true
		}
	}
	return false
}

// extRaised: an extension's server hook wants this name (someone may have agreed to it).
func extRaised(name string) bool {
	for _, d := range EXTS {
		if d.Err == "" && len(d.Hooks[name+".after"]) > 0 {
			return true
		}
	}
	return false
}

// extEmit: an event to the extensions: their after hooks (for the people who agreed) and, for the events the
// page hears (session.done, decision.*), an ext-event to that person's open pages.
func extEmit(name, uid string, ev orderedObj, login string) {
	for _, d := range EXTS {
		if ts := d.Hooks[name+".after"]; len(ts) > 0 && agreed(uid, d) {
			hb := jsonBytes(append(append(orderedObj{}, ev...), kv{"hook", name + ".after"}, kv{"extension", d.ID}))
			for _, t := range ts {
				go afterHook(name, t, hb, uid, login)
			}
		}
	}
	if !contains(HOOK_EVENTS, name) || !extHears(uid) {
		return
	}
	id := jsString(ev[0].V)
	now := nowMs()
	if extSent[uid] == nil {
		extSent[uid] = map[string]int64{}
	}
	keepRecent(extSent[uid], now)
	extSent[uid][id] = now
	for _, s := range controlsOf(uid) {
		sse(s, M{"t": "ext-event", "event": ev})
	}
}

func extClaim(res *Res, uid string, d *extDef, eventID string) {
	if _, ok := extSent[uid][eventID]; !ok {
		refuse(404, "이 사람에게 보낸 이벤트가 아니에요")
	}
	now := nowMs()
	if extClaims[uid] == nil {
		extClaims[uid] = map[string]int64{}
	}
	keepRecent(extClaims[uid], now)
	k := d.ID + "|" + eventID
	if _, taken := extClaims[uid][k]; taken {
		refuse(409, "이미 다른 화면이 맡았어요")
	}
	extClaims[uid][k] = now
	jsonRes(res, 200, M{"ok": true})
}

// extCarry and extCarried move the claim memory across a handover (the new instance would otherwise let a
// second page claim what the first one already took).
func extCarry() M {
	cp := func(src map[string]map[string]int64) M {
		out := M{}
		for uid, m := range src {
			inner := M{}
			for k, at := range m {
				inner[k] = at
			}
			out[uid] = inner
		}
		return out
	}
	return M{"sent": cp(extSent), "claims": cp(extClaims)}
}

func extCarried(c M) {
	read := func(v any, into map[string]map[string]int64) {
		m, _ := v.(M)
		for uid, x := range m {
			inner, _ := x.(M)
			into[uid] = map[string]int64{}
			for k, at := range inner {
				into[uid][k] = int64(numOr0(at))
			}
		}
	}
	read(c["sent"], extSent)
	read(c["claims"], extClaims)
}

// extForget: an account deleted (its folder, with the extensions' values and secrets, goes with it).
func extForget(uid string) {
	delete(extSent, uid)
	delete(extClaims, uid)
}

// ---------- dispatch ----------

var extRestRe = regexp.MustCompile(`^/(storage/(user|server)|secrets|call|events/([0-9a-f]{8,64})/claim)(?:/(.*))?$`)

func extApiAgreed(req *Req, res *Res, u *url.URL, uid string, d *extDef, rest string) {
	m := extRestRe.FindStringSubmatch(rest)
	if m == nil {
		refuse(404, "없는 주소입니다")
	}
	switch {
	case strings.HasPrefix(m[1], "storage/"):
		extStorage(req, res, u, uid, d, m[2], m[4])
	case m[1] == "secrets":
		extSecrets(req, res, uid, d, m[4])
	case m[1] == "call":
		// The path as sent (escaped), so an encoded / or .. is seen.
		raw := strings.TrimPrefix(u.EscapedPath(), "/api/ext/"+d.ID+"/call")
		if raw == "" {
			raw = "/"
		}
		extProxy(req, res, u, uid, d, raw)
	default:
		if req.Method != "POST" || m[4] != "" {
			refuse(405, "POST 만 받아요")
		}
		extClaim(res, uid, d, m[3])
	}
}

// ---------- leftovers ----------

// extLeftovers: the extension ids that have data here (the server's or anyone's) but are no longer listed in
// bridge.yaml; 운영 탭 offers to clean them up.
func extLeftovers() []string {
	ids := map[string]bool{}
	add := func(dir string) {
		es, _ := os.ReadDir(dir)
		for _, e := range es {
			if e.IsDir() && extIdRe.MatchString(e.Name()) {
				ids[e.Name()] = true
			}
		}
	}
	add(filepath.Join(DATA, "ext-data"))
	us, _ := os.ReadDir(filepath.Join(DATA, "u"))
	for _, u := range us {
		add(filepath.Join(DATA, "u", u.Name(), "ext"))
	}
	for _, d := range EXTS {
		delete(ids, d.ID)
	}
	out := []string{}
	for id := range ids {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// apiExtLeftovers: GET /api/admin/ext-leftovers and POST {id} that removes one's data everywhere (admins only).
func apiExtLeftovers(req *Req, res *Res, u *url.URL, uid string) bool {
	if u.Path != "/api/admin/ext-leftovers" {
		return false
	}
	if !isAdmin(uid) {
		refuse(403, "관리자만 할 수 있어요")
	}
	if req.Method == "GET" {
		jsonRes(res, 200, M{"ok": true, "ids": extLeftovers()})
		return true
	}
	if req.Method != "POST" {
		refuse(405, "지원하지 않는 메서드예요")
	}
	id := mstr(body(req, 4096), "id")
	if !contains(extLeftovers(), id) {
		refuse(404, "정리할 데이터가 없거나 아직 쓰는 익스텐션이에요")
	}
	_ = os.RemoveAll(filepath.Join(DATA, "ext-data", id))
	us, _ := os.ReadDir(filepath.Join(DATA, "u"))
	for _, x := range us {
		_ = os.RemoveAll(filepath.Join(DATA, "u", x.Name(), "ext", id))
	}
	jsonRes(res, 200, M{"ok": true})
	return true
}
