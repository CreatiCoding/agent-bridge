// /skills (server/skills.mjs): a read-only view of the private Claude Code skill marketplace (a GitHub repo).
// The server reads the repo with a read-only token and shows it to signed-in users. Installing still goes through
// GitHub, so only people with access to the repo can install; this page grants nothing.
package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	SKILLS_API_DEFAULT = "https://api.github.com"
	SKILLS_RAW         = "https://raw.githubusercontent.com"
	SKILLS_CHECK_MS    = 60_000
	TOKEN_EARLY_MS     = 5 * 60_000
)

// SKILLS_FILES: the files of the /skills feature. Their hash (codeHash) says which version of it is deployed.
var SKILLS_FILES = []string{"server/skills.go", "web/skills.html", "web/skills.css", "web/skills.js"}

// codeHash: sha256 over SKILLS_FILES, first 12 hex. read(file) returns the file's contents.
func codeHash(read func(string) string) string {
	h := sha256.New()
	for _, f := range SKILLS_FILES {
		h.Write([]byte(f + "\x00" + read(f) + "\x00"))
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

type upstream struct{ repo, path, ref string }

var (
	upstreamRe   = regexp.MustCompile(`github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?/?$`)
	upEdgeSlash  = regexp.MustCompile(`^\.?/+|/+$`)
	fmBlock      = regexp.MustCompile(`^---\r?\n((?s).*?)\r?\n---\r?\n?`)
	fmLineSplit  = regexp.MustCompile(`\r?\n`)
	fmKV         = regexp.MustCompile(`^([a-zA-Z][\w-]*):\s*(.*)$`)
	fmFold       = regexp.MustCompile(`^[>|]-?$`)
	fmIndented   = regexp.MustCompile(`^\s+\S`)
	safePathRe   = regexp.MustCompile(`^[\w.-]+(/[\w.-]+)*$`)
	plainSegRe   = regexp.MustCompile(`^[\w.-]+$`)
	dotSlashLead = regexp.MustCompile(`^\./`)
	rootLead     = regexp.MustCompile(`^\./?`)
	rootTrail    = regexp.MustCompile(`/+$`)
)

// upstreamOf: {repo, path, ref} for an entry linked to a folder of a GitHub repo, else nil.
func upstreamOf(source any) *upstream {
	s, ok := source.(M)
	if !ok || s["source"] != "git-subdir" {
		return nil
	}
	m := upstreamRe.FindStringSubmatch(orStr(s["url"]))
	if m == nil {
		return nil
	}
	ref := orStr(s["sha"])
	if ref == "" {
		ref = "HEAD"
	}
	return &upstream{repo: m[1], path: upEdgeSlash.ReplaceAllString(orStr(s["path"]), ""), ref: ref}
}

// frontMatter reads the `key: value` and folded (`key: >`) fields of a SKILL.md front matter.
func frontMatter(text string) (map[string]string, string) {
	meta := map[string]string{}
	loc := fmBlock.FindStringSubmatchIndex(text)
	if loc == nil {
		return meta, text
	}
	lines := fmLineSplit.Split(text[loc[2]:loc[3]], -1)
	for i := 0; i < len(lines); i++ {
		kv := fmKV.FindStringSubmatch(lines[i])
		if kv == nil {
			continue
		}
		v := jsTrim(kv[2])
		if fmFold.MatchString(v) {
			block := []string{}
			for i+1 < len(lines) && fmIndented.MatchString(lines[i+1]) {
				i++
				block = append(block, jsTrim(lines[i]))
			}
			sep := "\n"
			if strings.HasPrefix(v, ">") {
				sep = " "
			}
			v = strings.Join(block, sep)
		} else if len(v) >= 2 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		meta[kv[1]] = v
	}
	return meta, text[loc[1]:]
}

func metaOr(m map[string]string, k string) string { return m[k] }

func metaU(m map[string]string, k string) string {
	if v, ok := m[k]; ok {
		return v
	}
	return "undefined"
}

type skillsApp struct {
	id  string
	key *rsa.PrivateKey
}

// appKey: a GitHub App's private key from an environment variable: PEM with real or `\n` newlines, or base64 of it.
func appKey(text string) *rsa.PrivateKey {
	s := strings.TrimSpace(text)
	var p string
	if strings.Contains(s, "BEGIN") {
		p = strings.ReplaceAll(s, `\n`, "\n")
	} else {
		b, _ := base64.StdEncoding.DecodeString(s)
		p = string(b)
	}
	blk, _ := pem.Decode([]byte(p))
	if blk == nil {
		throw("error:1E08010C:DECODER routines::unsupported")
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		throw(err.Error())
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		throw("not an RSA key")
	}
	return rk
}

// appJwt: the App's own JWT (RS256), issued a minute back for clock skew, good for 9 minutes.
func appJwt(appID string, key *rsa.PrivateKey) string { return appJwtAt(appID, key, nowMs()) }

func appJwtAt(appID string, key *rsa.PrivateKey, now int64) string {
	iat := float64(now/1000 - 60)
	body := base64.RawURLEncoding.EncodeToString(jsonBytes(orderedObj{{"alg", "RS256"}, {"typ", "JWT"}})) + "." + base64.RawURLEncoding.EncodeToString(jsonBytes(orderedObj{{"iat", iat}, {"exp", iat + 600}, {"iss", appID}}))
	h := sha256.Sum256([]byte(body))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:])
	return body + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// safePath: a path from the repo's marketplace.json, made safe to put in a GitHub API address, else ok=false.
func safePath(v any, allowEmpty bool) (string, bool) {
	s, isS := v.(string)
	if isS && s == "" && allowEmpty {
		return "", true
	}
	if !isS || !safePathRe.MatchString(s) {
		return "", false
	}
	parts := strings.Split(s, "/")
	for i, x := range parts {
		if x == "." || x == ".." {
			return "", false
		}
		parts[i] = encodeURIComponent(x)
	}
	return strings.Join(parts, "/"), true
}

// UnsafePath: what a skill with an unsafe path throws; that skill is left out, the rest load.
type UnsafePath struct{ msg string }

func (e *UnsafePath) Error() string { return e.msg }
func (e *UnsafePath) thrown()       {}

// The repo answered with a redirect (renamed or moved): shown to the person as "not found".
const repoGoneMsg = "저장소를 찾을 수 없어요 (이름이 바뀌었거나 옮겨졌어요). 설정 → 더 보기 → 스킬 저장소를 확인해 주세요"

func isRepoGone(e *jsError) bool { return e != nil && e.msg == repoGoneMsg }

// flight: one load (or one mint) at a time; whoever asks meanwhile waits for it.
type flight struct {
	done chan struct{}
	val  any
	err  error
}

type Skills struct {
	token     string
	app       *skillsApp
	repo, api string
	raw       string
	log       func(...any)
	auth      string
	cache     M
	checkedAt int64
	loading   *flight
	minted    *struct {
		token string
		until float64
	}
	minting *flight
}

func createSkills(token string, app *skillsApp, repo string, api string) *Skills {
	if api == "" {
		api = SKILLS_API_DEFAULT
	}
	auth := "token"
	if app != nil {
		auth = "app"
	}
	return &Skills{token: token, app: app, repo: repo, api: api, raw: SKILLS_RAW, log: logLine, auth: auth}
}

var ghNoRedirect = &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
var ghFollow = &http.Client{Timeout: 60 * time.Second}

type ghRes struct {
	status int
	body   []byte
}

func (r ghRes) ok() bool { return r.status >= 200 && r.status < 300 }

// gh: redirect 'manual', so a renamed or moved repo answers 301 and its token never reads the repo it points at.
func gh(method, u, auth string, headers map[string]string, body []byte) ghRes {
	var out ghRes
	var ferr error
	await(func() {
		var rd io.Reader
		if body != nil {
			rd = strings.NewReader(string(body))
		}
		rq, err := http.NewRequest(method, u, rd)
		if err != nil {
			ferr = err
			return
		}
		rq.Header.Set("Authorization", "Bearer "+auth)
		rq.Header.Set("User-Agent", "claude-bridge")
		rq.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		rq.Header.Set("Accept", "application/vnd.github+json")
		for k, v := range headers {
			rq.Header.Set(k, v)
		}
		r, err := ghNoRedirect.Do(rq)
		if err != nil {
			ferr = err
			return
		}
		defer r.Body.Close()
		out.status = r.StatusCode
		out.body, _ = io.ReadAll(r.Body)
	})
	if ferr != nil {
		throw("fetch failed")
	}
	return out
}

func (s *Skills) mint() (string, float64) {
	jwt := appJwt(s.app.id, s.app.key)
	inst := gh("GET", s.api+"/repos/"+s.repo+"/installation", jwt, nil, nil)
	if !inst.ok() {
		throw("GitHub App 이 " + s.repo + " 에 설치되지 않았어요: GitHub " + itoa(inst.status))
	}
	iv, _ := parseJSON(inst.body)
	name := s.repo[strings.Index(s.repo, "/")+1:]
	r := gh("POST", s.api+"/app/installations/"+jsStringU(mget(iv, "id"))+"/access_tokens", jwt, map[string]string{"Content-Type": "application/json"}, jsonBytes(orderedObj{{"repositories", []any{name}}, {"permissions", orderedObj{{"contents", "read"}, {"metadata", "read"}}}}))
	if !r.ok() {
		throw("설치 토큰을 받지 못했어요: GitHub " + itoa(r.status))
	}
	tv, _ := parseJSON(r.body)
	s.log("skills: GitHub App 설치 토큰 받음 (" + jsStringU(mget(tv, "expires_at")) + " 까지)")
	return jsStringU(mget(tv, "token")), parseDate(mstr(tv, "expires_at")) - TOKEN_EARLY_MS
}

func (s *Skills) authToken() string {
	if s.app == nil {
		return s.token
	}
	if s.minted != nil && float64(nowMs()) < s.minted.until {
		return s.minted.token
	}
	if s.minting == nil {
		f := &flight{done: make(chan struct{})}
		s.minting = f
		goLocked("skills mint", func() {
			defer func() { s.minting = nil; close(f.done) }()
			f.err = try(func() {
				t, until := s.mint()
				s.minted = &struct {
					token string
					until float64
				}{t, until}
				f.val = t
			})
		})
	}
	f := s.minting
	await(func() { <-f.done })
	if f.err != nil {
		panic(f.err)
	}
	return f.val.(string)
}

func normURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		return nil
	}
	return u.ResolveReference(u)
}

// get: every address the token goes to must stay under this repo, whatever was put together before.
func (s *Skills) get(p string, raw bool) any {
	u := s.api + "/repos/" + s.repo + p
	base := normURL(s.api + "/repos/" + s.repo + "/")
	at := normURL(u)
	if base == nil || at == nil || at.Scheme != base.Scheme || at.Host != base.Host || !strings.HasPrefix(at.EscapedPath(), base.EscapedPath()) {
		panic(&UnsafePath{"leaves the repo"})
	}
	h := map[string]string{}
	if raw {
		h["Accept"] = "application/vnd.github.raw+json"
	}
	r := gh("GET", u, s.authToken(), h, nil)
	if r.status == 401 {
		s.minted = nil // revoked or expired early: the next read makes a new one
	}
	if r.status >= 300 && r.status < 400 {
		throw(repoGoneMsg)
	}
	if !r.ok() {
		throw(p + ": GitHub " + itoa(r.status))
	}
	if raw {
		return string(r.body)
	}
	v, err := parseJSON(r.body)
	if err != nil {
		throw(err.Error())
	}
	return v
}

func (s *Skills) file(ref, p string) string {
	sp, ok := safePath(p, false)
	if !ok || !plainSegRe.MatchString(ref) {
		panic(&UnsafePath{"bad path"})
	}
	return s.get("/contents/"+sp+"?ref="+encodeURIComponent(ref), true).(string)
}

// rawFile: a SKILL.md of someone else's public GitHub repo, at the pinned commit.
func (s *Skills) rawFile(up *upstream, name string) string {
	f, ok1 := safePath(up.repo, false)
	p, ok2 := safePath(up.path, true)
	n, ok3 := safePath(name, false)
	if !ok1 || len(strings.Split(f, "/")) != 2 || !ok2 || !ok3 || !plainSegRe.MatchString(up.ref) {
		panic(&UnsafePath{"bad upstream"})
	}
	dir := ""
	if p != "" {
		dir = p + "/"
	}
	u := s.raw + "/" + f + "/" + encodeURIComponent(up.ref) + "/" + dir + n
	a, b := normURL(u), normURL(s.raw+"/"+f+"/")
	if a == nil || b == nil || !strings.HasPrefix(a.EscapedPath(), b.EscapedPath()) {
		panic(&UnsafePath{"leaves the upstream"})
	}
	var status int
	var body []byte
	var ferr error
	await(func() {
		rq, _ := http.NewRequest("GET", u, nil)
		rq.Header.Set("User-Agent", "claude-bridge")
		r, err := ghFollow.Do(rq)
		if err != nil {
			ferr = err
			return
		}
		defer r.Body.Close()
		status = r.StatusCode
		body, _ = io.ReadAll(r.Body)
	})
	if ferr != nil {
		throw("fetch failed")
	}
	if status < 200 || status >= 300 {
		throw(u + ": " + itoa(status))
	}
	return string(body)
}

func (s *Skills) skill(sha, root string, pm M) M {
	up := upstreamOf(pm["source"])
	name, isS := pm["name"].(string)
	if !isS || !plainSegRe.MatchString(name) || name == "." || name == ".." {
		panic(&UnsafePath{"bad name"})
	}
	src := name
	if ss, ok := pm["source"].(string); ok {
		src = dotSlashLead.ReplaceAllString(ss, "")
	}
	parts := []string{}
	for _, x := range []string{root, src} {
		if x != "" {
			parts = append(parts, x)
		}
	}
	dir := strings.Join(parts, "/")
	var meta map[string]string
	var body string
	outputStyles := []any{}
	styles := asArr(pm["outputStyles"])
	if up != nil && len(styles) > 0 {
		type part struct {
			meta map[string]string
			body string
		}
		ps := make([]part, len(styles))
		fs := []func(){}
		var firstErr error
		for i, f := range styles {
			fs = append(fs, func() {
				if err := try(func() {
					m, b := frontMatter(s.rawFile(up, dotSlashLead.ReplaceAllString(jsString(f), "")))
					ps[i] = part{m, b}
				}); err != nil && firstErr == nil {
					firstErr = err
				}
			})
		}
		parallel(fs...)
		if firstErr != nil {
			panic(firstErr)
		}
		descs, bodies := []string{}, []string{}
		for _, x := range ps {
			descs = append(descs, metaU(x.meta, "name")+": "+metaU(x.meta, "description"))
			bodies = append(bodies, "## "+metaU(x.meta, "name")+"\n\n"+jsTrim(x.body)+"\n")
			outputStyles = append(outputStyles, name+":"+metaU(x.meta, "name"))
		}
		meta = map[string]string{"description": strings.Join(descs, " / ")}
		body = strings.Join(bodies, "\n")
	} else if up != nil {
		meta, body = frontMatter(s.rawFile(up, "SKILL.md"))
	} else {
		meta, body = frontMatter(s.file(sha, dir+"/skills/"+name+"/SKILL.md"))
	}
	var upOut any
	if up != nil {
		upOut = orderedObj{{"repo", up.repo}, {"sha", up.ref}, {"url", "https://github.com/" + up.repo + "/tree/" + up.ref + "/" + up.path}}
	}
	or := func(v any, d any) any {
		if truthy(v) {
			return v
		}
		return d
	}
	return M{
		"outputStyles": outputStyles,
		"name":         name,
		"category":     or(pm["category"], ""),
		"keywords":     or(pm["keywords"], []any{}),
		"summary":      or(pm["description"], ""),
		"description":  metaOr(meta, "description"),
		"argumentHint": metaOr(meta, "argument-hint"),
		"allowedTools": metaOr(meta, "allowed-tools"),
		"license":      metaOr(meta, "license"),
		"upstream":     upOut,
		"body":         body,
	}
}

func (s *Skills) load() M {
	var head any
	var check any
	var headErr error
	parallel(func() {
		headErr = try(func() { head = s.get("/commits/HEAD", false) })
	}, func() {
		// The marketplace's daily upstream security check writes its last result here; nil when it never ran.
		_ = try(func() {
			v, err := parseJSON([]byte(s.file("upstream-status", "status.json")))
			if err == nil {
				check = v
			}
		})
	})
	if headErr != nil {
		panic(headErr)
	}
	sha := mstr(head, "sha")
	if s.cache != nil && s.cache["sha"] == sha {
		c := shallow(s.cache)
		c["check"] = check
		s.cache = c
		return c
	}
	mv, err := parseJSON([]byte(s.file(sha, ".claude-plugin/marketplace.json")))
	if err != nil {
		throw(err.Error())
	}
	market := asM(mv)
	rootV := mget(market["metadata"], "pluginRoot")
	root := "."
	if truthy(rootV) {
		root = jsString(rootV)
	}
	root = rootTrail.ReplaceAllString(rootLead.ReplaceAllString(root, ""), "")
	if _, ok := safePath(root, true); !ok {
		throw("marketplace.json 의 metadata.pluginRoot 가 올바르지 않아요")
	}
	plugins := asArr(market["plugins"])
	got := make([]M, len(plugins))
	var firstErr error
	fs := []func(){}
	for i, p := range plugins {
		fs = append(fs, func() {
			err := try(func() { got[i] = s.skill(sha, root, asM(p)) })
			if err == nil {
				return
			}
			if _, unsafe := err.(*UnsafePath); unsafe {
				s.log("skills: plugins[" + itoa(i) + "] 건너뜀 (경로가 올바르지 않음)")
				return
			}
			if firstErr == nil {
				firstErr = err
			}
		})
	}
	parallel(fs...)
	if firstErr != nil {
		panic(firstErr)
	}
	skills := []any{}
	for _, x := range got {
		if x != nil {
			skills = append(skills, x)
		}
	}
	install := s.file(sha, "install.sh")
	s.log("skills: loaded " + itoa(len(skills)) + " from " + s.repo + "@" + jsSliceTo(sha, 7))
	date := mget(mget(mget(head, "commit"), "committer"), "date")
	s.cache = M{"sha": sha, "date": date, "market": market["name"], "repo": s.repo, "skills": skills, "install": install, "check": check}
	return s.cache
}

// current: the repo at most SKILLS_CHECK_MS old; a failed check keeps serving the last good copy.
func (s *Skills) current() M {
	if s.cache != nil && nowMs()-s.checkedAt < SKILLS_CHECK_MS {
		return s.cache
	}
	if s.loading == nil {
		f := &flight{done: make(chan struct{})}
		s.loading = f
		goLocked("skills load", func() {
			defer func() { s.loading = nil; close(f.done) }()
			err := try(func() { f.val = s.load() })
			if err == nil {
				s.checkedAt = nowMs()
				return
			}
			s.log("skills: load failed", err.Error())
			if s.cache != nil {
				s.checkedAt = nowMs()
				f.val = s.cache
				return
			}
			f.err = err
		})
	}
	f := s.loading
	await(func() { <-f.done })
	if f.err != nil {
		panic(f.err)
	}
	return f.val.(M)
}
