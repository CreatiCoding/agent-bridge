package main

// /skills (from skills.test.mjs): front matter, upstream entries, loading through a stand-in GitHub, the App's token,
// and paths from marketplace.json that never take the token out of the repo.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFrontMatter(t *testing.T) {
	meta, body := frontMatter("---\nname: 'submit-pr'\ndescription: >\n  Use when user asks to \"PR 생성\",\n  or needs a pull request.\nargument-hint: '[PR번호]'\nallowed-tools: Bash(git diff:*), Read\n---\n# 본문\n")
	eq(t, meta["name"], "submit-pr")
	eq(t, meta["description"], `Use when user asks to "PR 생성", or needs a pull request.`)
	eq(t, meta["argument-hint"], "[PR번호]")
	eq(t, meta["allowed-tools"], "Bash(git diff:*), Read")
	eq(t, body, "# 본문\n")
	m2, _ := frontMatter("---\nname: a11y-react\ndescription: \"React 접근성: (1) 버튼\"\n---\nx")
	eq(t, m2["description"], "React 접근성: (1) 버튼")
	m3, b3 := frontMatter("# just markdown")
	eq(t, len(m3), 0)
	eq(t, b3, "# just markdown")
}

func TestUpstreamOf(t *testing.T) {
	u := upstreamOf(M{"source": "git-subdir", "url": "https://github.com/obra/superpowers.git", "path": "skills/verify/"})
	ok(t, u != nil && *u == upstream{"obra/superpowers", "skills/verify", "HEAD"}, "https")
	u = upstreamOf(M{"source": "git-subdir", "url": "git@github.com:a/b", "path": "./x", "sha": "f00"})
	ok(t, u != nil && *u == upstream{"a/b", "x", "f00"}, "scp")
	ok(t, upstreamOf("review") == nil)
	ok(t, upstreamOf(M{"source": "github", "repo": "a/b"}) == nil)
	ok(t, upstreamOf(M{"source": "git-subdir", "url": "https://gitlab.com/a/b.git", "path": "x"}) == nil)
}

// fakeGitHub answers by the full URL, as the Node test's fetch mock did. `answer` may replace it.
type ghAsk struct {
	url, method, auth, body string
	follow                  bool
}

type fakeGH struct {
	mu     sync.Mutex
	files  map[string]string
	asked  []ghAsk
	answer func(a ghAsk) (int, string, http.Header)
}

type ghRT struct {
	f      *fakeGH
	follow bool
}

func (r ghRT) RoundTrip(q *http.Request) (*http.Response, error) {
	var b []byte
	if q.Body != nil {
		b, _ = io.ReadAll(q.Body)
	}
	a := ghAsk{q.URL.String(), q.Method, q.Header.Get("Authorization"), string(b), r.follow}
	r.f.mu.Lock()
	defer r.f.mu.Unlock()
	r.f.asked = append(r.f.asked, a)
	status, text, h := 404, "", http.Header{}
	if r.f.answer != nil {
		status, text, h = r.f.answer(a)
	} else if v, ok := r.f.files[a.url]; ok {
		status, text = 200, v
	}
	if h == nil {
		h = http.Header{}
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(text)), Request: q}, nil
}

func useFakeGH(t *testing.T, f *fakeGH) {
	a, b := ghNoRedirect.Transport, ghFollow.Transport
	ghNoRedirect.Transport, ghFollow.Transport = ghRT{f, false}, ghRT{f, true}
	t.Cleanup(func() { ghNoRedirect.Transport, ghFollow.Transport = a, b })
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func currentOf(s *Skills) (M, error) {
	var c M
	var err error
	withLock(func() { err = try(func() { c = s.current() }) })
	return c, err
}

func newTestSkills(token string, app *skillsApp, api string) *Skills {
	s := createSkills(token, app, "me/skills", api)
	s.raw = "https://raw.test"
	return s
}

func TestSkillsOwnAndLinked(t *testing.T) {
	market := map[string]any{
		"name":     "m",
		"metadata": map[string]any{"pluginRoot": "./plugins"},
		"plugins": []any{
			map[string]any{"name": "review", "source": "review", "category": "coding"},
			map[string]any{"name": "verify", "source": map[string]any{"source": "git-subdir", "url": "https://github.com/o/r.git", "path": "skills/verify", "sha": "p1n"}, "strict": false, "skills": []any{"./"}},
			map[string]any{"name": "calm", "source": map[string]any{"source": "git-subdir", "url": "https://github.com/o/r.git", "path": "styles", "sha": "p1n"}, "strict": false, "outputStyles": []any{"./a.md", "./b.md"}},
		},
	}
	f := &fakeGH{files: map[string]string{
		"https://api.test/repos/me/skills/commits/HEAD":                                           jsonText(map[string]any{"sha": "abc"}),
		"https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc":       jsonText(market),
		"https://api.test/repos/me/skills/contents/plugins/review/skills/review/SKILL.md?ref=abc": "---\nname: review\n---\nmine",
		"https://api.test/repos/me/skills/contents/install.sh?ref=abc":                            "#!/bin/sh",
		"https://api.test/repos/me/skills/contents/status.json?ref=upstream-status":               `{"checkedAt":"2026-10-11T04:25:58Z","ok":true,"run":"r"}`,
		"https://raw.test/o/r/p1n/skills/verify/SKILL.md":                                         "---\nname: verify\nlicense: MIT\n---\ntheirs",
		"https://raw.test/o/r/p1n/styles/a.md":                                                    "---\nname: Calm\ndescription: short\n---\nbe brief",
		"https://raw.test/o/r/p1n/styles/b.md":                                                    "---\nname: Plain\ndescription: plain\n---\nbe plain",
	}}
	useFakeGH(t, f)
	c, err := currentOf(newTestSkills("t", nil, "https://api.test"))
	if err != nil {
		t.Fatal(err)
	}
	jeq(t, c["check"], `{"checkedAt":"2026-10-11T04:25:58Z","ok":true,"run":"r"}`)
	sk := asArr(c["skills"])
	own, linked, style := asM(sk[0]), asM(sk[1]), asM(sk[2])
	eq(t, own["body"], any("mine"))
	ok(t, own["upstream"] == nil, "own upstream null")
	eq(t, linked["body"], any("theirs"))
	eq(t, linked["license"], any("MIT"))
	jeq(t, linked["upstream"], `{"repo":"o/r","sha":"p1n","url":"https://github.com/o/r/tree/p1n/skills/verify"}`)
	jeq(t, linked["outputStyles"], `[]`)
	jeq(t, style["outputStyles"], `["calm:Calm","calm:Plain"]`)
	eq(t, style["description"], any("Calm: short / Plain: plain"))
	eq(t, style["body"], any("## Calm\n\nbe brief\n\n## Plain\n\nbe plain\n"))
}

func TestSkillsCodeHash(t *testing.T) {
	files := map[string]string{}
	for _, f := range SKILLS_FILES {
		files[f] = "contents of " + f
	}
	a := codeHash(func(f string) string { return files[f] })
	ok(t, regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(a))
	eq(t, codeHash(func(f string) string { return files[f] }), a)
	files["web/skills.css"] += " "
	ok(t, codeHash(func(f string) string { return files[f] }) != a)
}

func TestSkillsNoCheckYet(t *testing.T) {
	f := &fakeGH{files: map[string]string{
		"https://api.test/repos/me/skills/commits/HEAD":                                     jsonText(map[string]any{"sha": "abc"}),
		"https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc": jsonText(map[string]any{"name": "m", "plugins": []any{}}),
		"https://api.test/repos/me/skills/contents/install.sh?ref=abc":                      "#!/bin/sh",
	}}
	useFakeGH(t, f)
	c, err := currentOf(newTestSkills("t", nil, "https://api.test"))
	if err != nil {
		t.Fatal(err)
	}
	ok(t, c["check"] == nil, "check null")
}

func rsaPEM(k *rsa.PrivateKey) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)}))
}

func jwtVerifies(t *testing.T, pub *rsa.PublicKey, tok string) (map[string]any, bool) {
	p := strings.Split(tok, ".")
	if len(p) != 3 {
		return nil, false
	}
	var claims map[string]any
	cb, _ := base64.RawURLEncoding.DecodeString(p[1])
	json.Unmarshal(cb, &claims)
	sig, _ := base64.RawURLEncoding.DecodeString(p[2])
	h := sha256.Sum256([]byte(p[0] + "." + p[1]))
	return claims, rsa.VerifyPKCS1v15(pub, crypto.SHA256, h[:], sig) == nil
}

func TestSkillsGitHubApp(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	p := rsaPEM(priv)
	// The variable may hold the PEM with escaped newlines, or the PEM in base64.
	for _, v := range []string{p, strings.ReplaceAll(p, "\n", `\n`), base64.StdEncoding.EncodeToString([]byte(p))} {
		var k *rsa.PrivateKey
		ok(t, try(func() { k = appKey(v) }) == nil && k != nil, "rsa key")
	}
	ok(t, try(func() { appKey("not a key") }) != nil, "not a key throws")

	jwtOk := func(h string) bool {
		c, good := jwtVerifies(t, &priv.PublicKey, strings.TrimPrefix(h, "Bearer "))
		return good && c["iss"] == "42" && numOr0(c["exp"])-numOr0(c["iat"]) == 600
	}
	var asked []any
	minted := 0
	files := map[string]string{
		"https://api.test/repos/me/skills/commits/HEAD":                                     jsonText(map[string]any{"sha": "abc"}),
		"https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc": jsonText(map[string]any{"name": "m", "plugins": []any{}}),
		"https://api.test/repos/me/skills/contents/install.sh?ref=abc":                      "#!/bin/sh",
	}
	f := &fakeGH{}
	f.answer = func(a ghAsk) (int, string, http.Header) {
		if a.url == "https://api.test/repos/me/skills/installation" {
			if jwtOk(a.auth) {
				return 200, `{"id":7}`, nil
			}
			return 401, "", nil
		}
		if a.url == "https://api.test/app/installations/7/access_tokens" {
			if a.method != "POST" || !jwtOk(a.auth) {
				return 401, "", nil
			}
			v, _ := parseJSON([]byte(a.body))
			asked = append(asked, v)
			minted++
			return 201, jsonText(map[string]any{"token": "inst-" + itoa(minted), "expires_at": time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")}), nil
		}
		if a.auth != "Bearer inst-1" {
			return 401, "", nil
		}
		if v, ok := files[a.url]; ok {
			return 200, v, nil
		}
		return 404, "", nil
	}
	useFakeGH(t, f)
	s := newTestSkills("", &skillsApp{id: "42", key: appKey(p)}, "https://api.test")
	eq(t, s.auth, "app")
	c, err := currentOf(s)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, c["sha"], any("abc"))
	// Every read of that load shared one token, asked for this repo and Contents read only.
	eq(t, minted, 1)
	jeq(t, asked, `[{"repositories":["skills"],"permissions":{"contents":"read","metadata":"read"}}]`)
	eq(t, createSkills("t", nil, "me/skills", "").auth, "token")
}

func TestSkillsAppJwt(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	tok := appJwtAt("123", priv, 1_000_000_000_000)
	p := strings.Split(tok, ".")
	hb, _ := base64.RawURLEncoding.DecodeString(p[0])
	jeq(t, js(string(hb)), `{"alg":"RS256","typ":"JWT"}`)
	claims, good := jwtVerifies(t, &priv.PublicKey, tok)
	jeq(t, claims, `{"iat":999999940,"exp":1000000540,"iss":"123"}`)
	ok(t, good, "서명")
}

func TestSkillsUnsafePaths(t *testing.T) {
	evil := []any{"../../../victim/private/contents/x#", "..", "%2e%2e/x", "a/../../b", "x#", "x?ref=main", "/abs/path", `a\..\b`, "./", "."}
	plugins := []any{map[string]any{"name": "ok", "source": "ok"}}
	for _, s := range evil {
		plugins = append(plugins, map[string]any{"name": "n", "source": s})
	}
	for _, s := range evil {
		plugins = append(plugins, map[string]any{"name": s, "source": "fine"})
	}
	plugins = append(plugins,
		map[string]any{"name": "up", "source": map[string]any{"source": "git-subdir", "url": "https://github.com/o/r.git", "path": "../../victim/x", "sha": "p1n"}},
		map[string]any{"name": "up2", "source": map[string]any{"source": "git-subdir", "url": "https://github.com/o/r.git", "path": "x", "sha": "../../a"}},
	)
	f := &fakeGH{files: map[string]string{
		"https://api.test/repos/me/skills/commits/HEAD":                                     jsonText(map[string]any{"sha": "abc"}),
		"https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc": jsonText(map[string]any{"name": "m", "plugins": plugins}),
		"https://api.test/repos/me/skills/contents/ok/skills/ok/SKILL.md?ref=abc":           "---\nname: ok\n---\nmine",
		"https://api.test/repos/me/skills/contents/install.sh?ref=abc":                      "#!/bin/sh",
	}}
	useFakeGH(t, f)
	var logs []string
	var lmu sync.Mutex
	s := newTestSkills("t", nil, "https://api.test")
	s.log = func(a ...any) {
		parts := []string{}
		for _, x := range a {
			parts = append(parts, jsString(x))
		}
		lmu.Lock()
		logs = append(logs, strings.Join(parts, " "))
		lmu.Unlock()
	}
	c, err := currentOf(s)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, x := range asArr(c["skills"]) {
		names = append(names, mstr(x, "name"))
	}
	ok(t, reflect.DeepEqual(names, []string{"ok"}), strings.Join(names, ","))
	for _, a := range f.asked {
		if a.auth != "" {
			u, _ := url.Parse(a.url)
			ok(t, strings.HasPrefix(u.Path, "/repos/me/skills/"), a.url)
		}
		ok(t, !strings.Contains(a.url, "victim"), a.url)
	}
	// The skip is logged without the repo's name.
	skips := 0
	for _, l := range logs {
		if strings.Contains(l, "건너뜀") {
			skips++
			ok(t, !strings.Contains(l, "me/skills"), l)
		}
	}
	ok(t, skips > 0, "건너뜀 로그")
}

func TestSkillsBadPluginRoot(t *testing.T) {
	for _, root := range []string{"../../victim", "a/#", "%2e%2e"} {
		f := &fakeGH{files: map[string]string{
			"https://api.test/repos/me/skills/commits/HEAD":                                     jsonText(map[string]any{"sha": "abc"}),
			"https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc": jsonText(map[string]any{"name": "m", "metadata": map[string]any{"pluginRoot": root}, "plugins": []any{map[string]any{"name": "x", "source": "x"}}}),
		}}
		useFakeGH(t, f)
		_, err := currentOf(newTestSkills("t", nil, "https://api.test"))
		ok(t, err != nil, root)
		for _, a := range f.asked {
			u, _ := url.Parse(a.url)
			ok(t, strings.HasPrefix(u.Path, "/repos/me/skills/"), a.url)
		}
	}
}

func TestSkillsMovedRepo(t *testing.T) {
	f := &fakeGH{}
	f.answer = func(a ghAsk) (int, string, http.Header) {
		return 301, "", http.Header{"Location": {"https://api.test/repositories/99"}}
	}
	useFakeGH(t, f)
	_, err := currentOf(newTestSkills("t", nil, "https://api.test"))
	ok(t, err != nil && strings.Contains(err.Error(), "저장소를 찾을 수 없어요"), errMsg(err))
	ok(t, len(f.asked) > 0, "asked")
	for _, a := range f.asked {
		ok(t, !a.follow, "redirect manual: "+a.url)
	}
}

func TestSafePath(t *testing.T) {
	s, good := safePath("plugins/a.b_c-d", false)
	ok(t, good && s == "plugins/a.b_c-d")
	s, good = safePath("", true)
	ok(t, good && s == "")
	for _, v := range []any{"", "..", ".", "a/..", "%2e", "a#", "a?b", "/a", "a/", `a\b`, "a//b", nil, 3.0} {
		_, good := safePath(v, false)
		ok(t, !good, jsStringU(v))
	}
}
