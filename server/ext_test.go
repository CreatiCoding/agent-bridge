package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const extYaml = `id: sample
name: 예시 연동
version: 0.1.0
extensionApi: 1
entry: ./index.js
uses:
  actions: [link.open, composer.submit, session.done]
  slots: [composer.actions]
server:
  routes:
    - path: /docs/
      upstream: https://api.example.com/v1
      signingSecret: ${EXAMPLE_SIGNING}
      headers:
        Authorization: "Bearer ${user.apiToken}"
        X-Team: ${TEAM}
  hooks:
    session.done.after:
      - type: webhook
        url: https://notify.example/done
        secret: ${EXAMPLE_SIGNING}
`

// extDir makes an extension folder under dir with extension.yaml and the files given.
func extDir(t *testing.T, dir, yaml string, files map[string]string) string {
	t.Helper()
	_ = os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(filepath.Join(dir, "extension.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	for n, c := range files {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, n)), 0o755)
		_ = os.WriteFile(filepath.Join(dir, n), []byte(c), 0o644)
	}
	return dir
}

var extEnv = envMap(map[string]string{"EXAMPLE_SIGNING": "0123456789abcdef-signing", "TEAM": "core", "GITHUB_CLIENT_SECRET": "never"})

// AC-1492: bridge.yaml's extensions and extension.yaml: what is read, what is refused and why.
func TestExtLoad(t *testing.T) {
	root := t.TempDir()
	good := extDir(t, filepath.Join(root, "sample"), extYaml, map[string]string{"index.js": "export default () => {}", "a/b.css": "x{}", "page.html": "<p>"})
	c, err := parseBridgeConfig(filepath.Join(root, "bridge.yaml"), []byte("extensionConsent: false\nextensions:\n  - path: ./sample\n    env: [EXAMPLE_SIGNING, TEAM]\n"), extEnv)
	ok(t, err == nil, "parse", errS(err))
	es := c.set["extensions"].v.([]extEntry)
	eq(t, es[0].Path, good)
	ok(t, c.set["extensionConsent"].v == false)
	_, err = parseBridgeConfig("/x/bridge.yaml", []byte("extensions:\n  - path: ./a\n    secret: x\n"), extEnv)
	ok(t, err != nil && strings.Contains(err.Error(), "모르는 키 extensions[].secret"), errS(err))
	_, err = parseBridgeConfig("/x/bridge.yaml", []byte("extensions:\n  - path: ./a\n    env: [not-a-name]\n"), extEnv)
	ok(t, err != nil && strings.Contains(err.Error(), "환경변수 이름이 아닙니다"), errS(err))

	ds := loadExtensions(es, extEnv)
	d := ds[0]
	eq(t, d.Err, "")
	eq(t, d.ID, "sample")
	eq(t, d.Entry, "index.js")
	eq(t, len(d.Hash), 16)
	jeq(t, d.Actions, `["link.open","composer.submit","session.done"]`)
	eq(t, d.Routes[0].Upstream, "https://api.example.com/v1/")
	eq(t, d.Routes[0].Secret, "0123456789abcdef-signing")
	// ${user.KEY} waits for each request; the allowed ${TEAM} is read now.
	jeq(t, d.Routes[0].Headers, `[["Authorization","Bearer ${user.apiToken}"],["X-Team","core"]]`)
	eq(t, len(d.Hooks["session.done.after"]), 1)
	// The hash covers every file: one byte more is another hash.
	_ = os.WriteFile(filepath.Join(good, "a/b.css"), []byte("x{ }"), 0o644)
	ok(t, loadExtensions(es, extEnv)[0].Hash != d.Hash, "hash changes")

	bad := func(name, yaml, want string, env ...string) {
		t.Helper()
		dir := extDir(t, filepath.Join(root, name), yaml, map[string]string{"index.js": "x"})
		x := loadExtensions([]extEntry{{Path: dir, Env: env}}, extEnv)[0]
		ok(t, strings.Contains(x.Err, want), name+": "+x.Err)
		ok(t, extByID(x.ID) == nil || extByID(x.ID) != x)
	}
	base := "id: x-ext\nname: x\nversion: 1\nextensionApi: 1\nentry: index.js\n"
	bad("unknown", base+"color: red\n", "모르는 키 color")
	bad("env", extYaml, "허락하지 않은 환경변수를 읽습니다: EXAMPLE_SIGNING, TEAM", "OTHER")
	bad("envsecret", base+"server:\n  routes:\n    - path: /a/\n      upstream: https://a.example\n      signingSecret: ${GITHUB_CLIENT_SECRET}\n", "GITHUB_CLIENT_SECRET")
	// REQ-S-088: a `$` the YAML unescapes is a reference too, refused as the plain one is, and its value never read.
	esc := base + "server:\n  routes:\n    - path: /a/\n      upstream: \"https://a.example/\\u0024{GITHUB_CLIENT_SECRET}/\"\n      signingSecret: 0123456789abcdef-signing\n      headers:\n        X-T: \"\\u0024{TEAM:-}\"\n"
	bad("envescape", esc, "허락하지 않은 환경변수를 읽습니다: GITHUB_CLIENT_SECRET")
	bad("envescape2", esc, "GITHUB_CLIENT_SECRET", "TEAM")
	if x := loadExtensions([]extEntry{{Path: filepath.Join(root, "envescape")}}, extEnv)[0]; len(x.Routes) > 0 && strings.Contains(x.Routes[0].Upstream, "never") {
		t.Error("허락하지 않은 값이 읽혔음: " + x.Routes[0].Upstream)
	}
	bad("api", strings.Replace(base, "extensionApi: 1", "extensionApi: 2", 1), "extensionApi 2 를 요구")
	bad("entry", strings.Replace(base, "index.js", "nope.js", 1), "entry nope.js")
	bad("id", strings.Replace(base, "x-ext", "errors", 1), "쓸 수 없습니다")
	bad("exec", base+"server:\n  hooks:\n    session.done.after:\n      - type: exec\n        run: /bin/true\n", "webhook 만")
	bad("before", base+"server:\n  hooks:\n    message.send.before:\n      - type: webhook\n        url: https://a.example\n        secret: 0123456789abcdef\n", "<액션·이벤트>.after 만")
	bad("slot", base+"uses:\n  slots: [timeline]\n", "모르는 이름")
	bad("header", base+"server:\n  routes:\n    - path: /a/\n      upstream: https://a.example\n      signingSecret: 0123456789abcdef\n      headers:\n        Cookie: x\n", "Cookie 는 쓸 수 없습니다")
	bad("overlap", base+"server:\n  routes:\n    - path: /a/\n      upstream: https://a.example\n      signingSecret: 0123456789abcdef\n    - path: /a/b/\n      upstream: https://b.example\n      signingSecret: 0123456789abcdef\n", "겹칩니다")
	two := loadExtensions([]extEntry{es[0], es[0]}, extEnv)
	eq(t, two[1].Err, "같은 id 의 익스텐션이 앞에 있습니다")
	eq(t, loadExtensions([]extEntry{{Path: filepath.Join(root, "none")}}, extEnv)[0].Err, "폴더가 없습니다: "+filepath.Join(root, "none"))
}

// withExt: a server with the good extension loaded (consent asked unless off).
func withExt(t *testing.T, consent bool) *extDef {
	t.Helper()
	_ = withConfigServer(t)
	keep := EXTS
	t.Cleanup(func() { EXTS = keep })
	dir := extDir(t, filepath.Join(t.TempDir(), "sample"), extYaml, map[string]string{"index.js": "export default () => {}", "page.html": "<p>", "img/a.webp": "w"})
	withCfg(t, map[bool]string{true: "", false: "extensionConsent: false\n"}[consent])
	EXTS = loadExtensions([]extEntry{{Path: dir, Env: []string{"EXAMPLE_SIGNING", "TEAM"}}}, extEnv)
	return EXTS[0]
}

func extCall(t *testing.T, method, path, body string, hdr map[string]string, uid string) (int, string) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	req := newReq(r)
	res := newRes(req)
	code := 0
	func() {
		defer func() {
			if x := recover(); x != nil {
				rf, isRefuse := x.(*Refuse)
				if !isRefuse {
					panic(x)
				}
				code = rf.Status
			}
		}()
		withLock(func() { api(req, res, r.URL, uid) })
	}()
	if code != 0 {
		return code, ""
	}
	return res.status, string(res.body)
}

var extH = map[string]string{"X-Bridge-Ext": "1"}

// AC-1492: /ext/ serves an agreed hash only, scripts and data only; consent by hash; the list and /api/me.
func TestExtGateConsent(t *testing.T) {
	d := withExt(t, true)
	file := func(p, uid string) (int, *Res) {
		r := httptest.NewRequest("GET", p, nil)
		res := newRes(newReq(r))
		serveExtAs(res, p, uid)
		return res.status, res
	}
	at := "/ext/sample/" + d.Hash + "/"
	code, _ := file(at+"index.js", "")
	eq(t, code, 401)
	code, _ = file(at+"index.js", "gh1")
	eq(t, code, 403) // not agreed yet
	code, _ = extCall(t, "GET", "/api/ext", "", nil, "gh1")
	eq(t, code, 403) // no X-Bridge-Ext
	code, body := extCall(t, "GET", "/api/ext", "", extH, "gh1")
	eq(t, code, 200)
	ok(t, strings.Contains(body, `"entry":"/ext/sample/`+d.Hash+`/index.js"`) && strings.Contains(body, `"consented":false`) && strings.Contains(body, `"upstream":"https://api.example.com"`) && !strings.Contains(body, "signing"), body)
	code, _ = extCall(t, "POST", "/api/ext/sample/consent", `{"hash":"0000000000000000"}`, extH, "gh1")
	eq(t, code, 409)
	code, _ = extCall(t, "POST", "/api/ext/sample/consent", `{"hash":"`+d.Hash+`"}`, extH, "gh1")
	eq(t, code, 200)
	code, res := file(at+"index.js", "gh1")
	eq(t, code, 200)
	eq(t, res.header.Get("X-Content-Type-Options"), "nosniff")
	eq(t, res.header.Get("Cache-Control"), "private, max-age=31536000, immutable")
	ok(t, strings.HasPrefix(res.header.Get("Content-Type"), "text/javascript"))
	code, res = file(at+"img/a.webp", "gh1")
	eq(t, code, 200)
	eq(t, res.header.Get("Content-Type"), "image/webp")
	for _, p := range []string{at + "page.html", at + "extension.yaml", at + "../sample/index.js", "/ext/sample/0000000000000000/index.js", "/ext/other/" + d.Hash + "/index.js"} {
		code, _ = file(p, "gh1")
		eq(t, code, 404, p)
	}
	code, _ = file(at+"index.js", "gh2")
	eq(t, code, 403) // consent is the person's own
	_, body = callAPI(t, "GET", "/api/me", "")
	ok(t, strings.Contains(body, `"consented":true`), body)
	code, _ = extCall(t, "DELETE", "/api/ext/sample/consent", "", extH, "gh1")
	eq(t, code, 200)
	code, _ = file(at+"index.js", "gh1")
	eq(t, code, 403)
	// The demo account never gets one.
	_, body = extCall(t, "GET", "/api/me", "", nil, "demo-000000000000")
	ok(t, !strings.Contains(body, `"id":"sample"`), body)
	// The privacy page's list names where the extension sends (origins only).
	rs := jsonStr(recipients())
	ok(t, strings.Contains(rs, `"origin":"https://api.example.com","events":["익스텐션 sample 의 요청"]`) && strings.Contains(rs, `"origin":"https://notify.example","events":["session.done.after (익스텐션 sample)"]`), rs)
}

// AC-1492: extensionConsent: false runs it for everyone without asking; page errors are kept, ten a minute.
func TestExtNoConsentAndErrors(t *testing.T) {
	d := withExt(t, false)
	r := httptest.NewRequest("GET", "/", nil)
	res := newRes(newReq(r))
	serveExtAs(res, "/ext/sample/"+d.Hash+"/index.js", "gh2")
	eq(t, res.status, 200)
	extErrors = map[string][]orderedObj{}
	for i := 0; i < 10; i++ {
		code, _ := extCall(t, "POST", "/api/ext/errors", `{"id":"sample","message":"boom","stack":"`+strings.Repeat("s", 3000)+`"}`, extH, "gh2")
		eq(t, code, 200)
	}
	code, _ := extCall(t, "POST", "/api/ext/errors", `{"id":"sample","message":"boom"}`, extH, "gh2")
	eq(t, code, 429)
	eq(t, len(extErrors["sample"]), 10)
	eq(t, len(extErrors["sample"][0][3].V.(string)), 1024)
	_, body := extCall(t, "GET", "/api/ext", "", extH, "gh1") // gh1 is an admin
	ok(t, strings.Contains(body, `"errors":[{"at":`), body)
	_, body = extCall(t, "GET", "/api/ext", "", extH, "gh2")
	ok(t, !strings.Contains(body, `"errors"`), body)
	code, _ = extCall(t, "POST", "/api/ext/errors", `{"id":"nope","message":"x"}`, extH, "gh1")
	eq(t, code, 404)
}

func errS(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}
