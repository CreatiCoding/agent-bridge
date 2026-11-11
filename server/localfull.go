package main

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// 로컬 전체 화면 (local --full, SPEC REQ-F-900~902, REQ-S-103~105, docs/LOCAL-UI-DESIGN.md §8). Two halves:
//
//  1. On the site's server: the Mac builds of this same program (darwin-arm64, darwin-amd64), made in the image from
//     the same sources and checked against the maintainer's signed documents in server/localfull.json, handed out at
//     /localfull/<arch>.json (the document and its signature) and /localfull/<arch> (the bytes). The server cannot sign
//     one; each Mac checks the signature and the hash again before running it.
//  2. On a Mac: `bridge-server local …`, started by the agent. It serves the same web screen at 127.0.0.1 only, to one
//     owner who came in through a one-time link from the Mac's terminal, and takes the agent's link with a secret the
//     agent made for this run. Its data is its own folder; nothing is shared with the site's account.

// ---------- the signed Mac builds (the site's half) ----------

const lfSigPrefix = "claude-bridge localfull v1\n"

// lfKeys: who may sign a Mac build, the agent update keys (agent/keys.mjs); a test puts its own here.
var lfKeys = updateKeys

// LF_ARCHES: the builds made and handed out.
var LF_ARCHES = []string{"darwin-arm64", "darwin-amd64"}

type lfBuild struct {
	Doc, Sig, Version string
	Seq               float64
	Size              int
	File              string
	OK                bool
	Why               string
}

// LOCALFULL: the builds this server hands out, read once at start (prepare). Only OK ones are handed out.
var LOCALFULL = map[string]lfBuild{}

type lfDocFields struct {
	Name      string  `json:"name"`
	Version   string  `json:"version"`
	Seq       float64 `json:"seq"`
	API       float64 `json:"api"`
	Integrity string  `json:"integrity"`
	Size      int     `json:"size"`
}

// lfCheck: whether sig is an update key's signature over doc's exact bytes, for this arch, and the bytes are the
// ones it names. The same check every Mac makes (agent/localfull.mjs verify).
func lfCheck(arch, doc, sig string, b []byte) (lfDocFields, error) {
	var d lfDocFields
	if doc == "" || len(doc) > 4096 || json.Unmarshal([]byte(doc), &d) != nil {
		return d, errors.New("문서가 없거나 JSON 이 아님")
	}
	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil || len(raw) == 0 {
		return d, errors.New("서명이 없음")
	}
	signed := false
	for _, k := range lfKeys() {
		if ed25519Verify(k, []byte(lfSigPrefix+doc), raw) {
			signed = true
		}
	}
	if !signed {
		return d, errors.New("관리자 서명이 맞지 않음")
	}
	if d.Name != "localfull-"+arch || !isSafeInteger(d.Seq) || d.Seq < 1 || d.API != 1 {
		return d, errors.New("문서가 이 빌드의 것이 아님")
	}
	h := sha256.Sum256(b)
	if d.Integrity != "sha256:"+base64.StdEncoding.EncodeToString(h[:]) || d.Size != len(b) || d.Version != hex.EncodeToString(h[:])[:12] {
		return d, errors.New("빌드가 서명한 해시와 다름")
	}
	return d, nil
}

// lfDocs reads server/localfull.json: {"src": …, "darwin-arm64": {"doc", "sig"}, …}.
func lfDocs(p string) map[string][2]string {
	out := map[string][2]string{}
	b, err := os.ReadFile(p)
	if err != nil {
		return out
	}
	var v map[string]json.RawMessage
	if json.Unmarshal(b, &v) != nil {
		return out
	}
	for _, a := range LF_ARCHES {
		var e struct{ Doc, Sig string }
		if raw, ok := v[a]; ok && json.Unmarshal(raw, &e) == nil {
			out[a] = [2]string{e.Doc, e.Sig}
		}
	}
	return out
}

// loadLocalFull: the builds in dir checked against the documents in docsFile, one per arch.
func loadLocalFull(dir, docsFile string) map[string]lfBuild {
	docs := lfDocs(docsFile)
	out := map[string]lfBuild{}
	for _, a := range LF_ARCHES {
		e := docs[a]
		lb := lfBuild{Doc: e[0], Sig: e[1], File: filepath.Join(dir, a)}
		b, err := os.ReadFile(lb.File)
		if err != nil {
			lb.Why = "빌드 파일이 없음"
		} else if d, err := lfCheck(a, e[0], e[1], b); err != nil {
			lb.Why = err.Error()
		} else {
			lb.Version, lb.Seq, lb.Size, lb.OK = d.Version, d.Seq, d.Size, true
		}
		out[a] = lb
	}
	return out
}

func localFullDir() string      { return filepath.Join(ROOT, "localfull") }
func localFullDocsPath() string { return filepath.Join(ROOT, "server", "localfull.json") }

var lfPathRe = regexp.MustCompile(`^/localfull/(darwin-(?:arm64|amd64))(\.json)?$`)

// serveLocalFull: GET /localfull/<arch>.json and /localfull/<arch>. Public: what is handed out is signed, and a Mac
// takes it only when the signature and the hash hold (REQ-S-103).
func serveLocalFull(res *Res, p string) bool {
	m := lfPathRe.FindStringSubmatch(p)
	if m == nil {
		return false
	}
	lb, ok := LOCALFULL[m[1]]
	if !ok || !lb.OK {
		jsonRes(res, 404, M{"ok": false, "error": "이 서버에는 서명된 맥용 서버(" + m[1] + ")가 없어요"})
		return true
	}
	if m[2] != "" {
		jsonRes(res, 200, M{"doc": lb.Doc, "sig": lb.Sig})
		return true
	}
	res.WriteHead(200, M{"Content-Type": "application/octet-stream", "Content-Length": itoa(lb.Size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment"})
	res.file = &fileSend{path: lb.File}
	res.ended = true
	return true
}

// localFullVerify: `bridge-server localfull-verify <dir> <localfull.json>`, run while the image is built. Every build
// in dir must be the one signed in localfull.json, or the image is not made (REQ-F-901): a build that came out
// different from the one signed on the maintainer's Mac is a divergence, never something handed out.
func localFullVerify(args []string) int {
	if len(args) != 2 {
		println("사용법: bridge-server localfull-verify <빌드 폴더> <localfull.json>")
		return 2
	}
	bad := 0
	for a, lb := range loadLocalFull(args[0], args[1]) {
		if lb.OK {
			println("localfull " + a + ": " + lb.Version + " · 순번 " + strconv.FormatFloat(lb.Seq, 'f', 0, 64) + " — 서명과 같음")
		} else {
			println("localfull " + a + ": " + lb.Why + " (이 맥에서 node scripts/sign-agent.mjs 로 다시 만들어 서명하세요)")
			bad++
		}
	}
	if bad > 0 {
		return 1
	}
	return 0
}

// ---------- the Mac's own server (`bridge-server local`) ----------

// LOCAL: this server runs as a Mac's local server for its agent (REQ-F-900).
var LOCAL bool

// LOCAL_SECRET: what the agent that started this server proves itself with on /api/bridge/* (REQ-S-104). Read from
// stdin at start, never written anywhere.
var LOCAL_SECRET string

// LOCAL_TICKETS: the file of one-time links (sha256 hex and end), written by `agent.mjs local --full open`.
var LOCAL_TICKETS string

// LOCAL_HOURS: how long a sign-in through a link lasts.
var LOCAL_HOURS = 12

const LOCAL_UID = "local"
const LOCAL_LOGIN = "local"

// LOCAL_CSP: the local screen's policy (agent/localui.mjs FILE_HEADERS), widened only where the web screen needs it:
// inline style attributes, blob: pictures and media, its own frames and manifest. Scripts and connections stay 'self'.
const LOCAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"

// localArgs: `local --port P --data D --tickets F [--hours H] [--root R]`.
func localArgs(args []string) (port int, data, tickets, root string, hours int, err error) {
	hours = 12
	for i := 0; i+1 < len(args); i += 2 {
		v := args[i+1]
		switch args[i] {
		case "--port":
			port, _ = strconv.Atoi(v)
		case "--data":
			data = v
		case "--tickets":
			tickets = v
		case "--root":
			root = v
		case "--hours":
			hours, _ = strconv.Atoi(v)
		default:
			return 0, "", "", "", 0, errors.New("모르는 인자: " + args[i])
		}
	}
	if port < 1024 || port > 65535 || data == "" || tickets == "" {
		return 0, "", "", "", 0, errors.New("사용법: bridge-server local --port <1024~65535> --data <폴더> --tickets <파일> [--hours 1~168] (비밀은 표준 입력 한 줄)")
	}
	if hours < 1 || hours > 168 {
		hours = 12
	}
	return
}

var secretRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// startLocal sets the server up as a Mac's local server: called before configure (main). The environment it
// configures from is replaced by the few values a local server has: no GitHub, no service API, no extensions.
func startLocal(args []string) bool {
	port, data, tickets, root, hours, err := localArgs(args)
	if err != nil {
		errorLine(err.Error())
		return false
	}
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	line = strings.TrimSpace(line)
	if !secretRe.MatchString(line) {
		errorLine("에이전트의 비밀이 표준 입력에 없습니다")
		return false
	}
	LOCAL, LOCAL_SECRET, LOCAL_TICKETS, LOCAL_HOURS = true, line, tickets, hours
	if err := os.MkdirAll(data, 0o700); err != nil {
		errorLine(err.Error())
		return false
	}
	if root == "" {
		// The web screen and the server's own files come inside this build (localfull_embed.go).
		root = filepath.Join(filepath.Dir(data), "root")
		if err := extractRoot(root); err != nil {
			errorLine("화면 파일을 풀지 못했습니다: " + err.Error())
			return false
		}
	}
	vars := map[string]string{"PORT": itoa(port), "BRIDGE_DATA": data, "BRIDGE_ROOT": root, "BRIDGE_ORIGIN": "http://127.0.0.1:" + itoa(port), "GITHUB_ALLOWED_LOGINS": LOCAL_LOGIN}
	env = func(k string) string { return vars[k] }
	return true
}

// extractRoot writes the embedded files to dir, replacing what was there: the build's own copy, checked with it.
func extractRoot(dir string) error {
	if fullRoot == nil {
		return errors.New("이 빌드에는 화면 파일이 들어 있지 않습니다(-tags localfull 로 빌드)")
	}
	_ = os.RemoveAll(dir)
	return fs.WalkDir(fullRoot, "fullroot", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		out := filepath.Join(dir, strings.TrimPrefix(strings.TrimPrefix(p, "fullroot"), "/"))
		if d.IsDir() {
			return os.MkdirAll(out, 0o700)
		}
		b, err := fs.ReadFile(fullRoot, p)
		if err != nil {
			return err
		}
		return os.WriteFile(out, b, 0o600)
	})
}

// localOwner: the one person of a local server, made at start.
func localOwner() {
	if !LOCAL {
		return
	}
	if !users.Has(LOCAL_UID) {
		users.Set(LOCAL_UID, M{"login": LOCAL_LOGIN, "name": "이 맥", "avatar": ""})
		touchGlobals()
	}
}

// localHostOk / localOriginOk: the same rules as the local screen (agent/localui.mjs hostOk, originOk): this
// address only (no DNS rebinding), and an Origin, when there is one, of this address.
func localHostOk(host string) bool {
	return host == "127.0.0.1:"+itoa(PORT) || host == "localhost:"+itoa(PORT)
}
func localOriginOk(h http.Header) bool {
	v, has := h["Origin"]
	if !has {
		return true
	}
	o := ""
	if len(v) > 0 {
		o = v[0]
	}
	return len(v) == 1 && (o == "http://127.0.0.1:"+itoa(PORT) || o == "http://localhost:"+itoa(PORT))
}

// localGate: the first thing a local server does with any request (upgrades included). false: refused here.
func localGate(w http.ResponseWriter, r *http.Request) bool {
	if !LOCAL {
		return true
	}
	if !localHostOk(r.Host) || !localOriginOk(r.Header) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(403)
		_, _ = w.Write([]byte("이 주소로는 열 수 없어요\n"))
		return false
	}
	return true
}

// localClosed: what a local server never answers: other sign-ins, the service API, the agent's files and installer,
// the Mac builds, the skills pages, the developer's routes.
var localClosedRe = regexp.MustCompile(`^/(api/auth/(?:github|apple|qr|dev|demo)|api/service/|api/dev/|install\.sh$|agent\.mjs$|agent/|localfull/|skills|guide/mcp)`)

func localClosed(p string) bool { return LOCAL && localClosedRe.MatchString(p) }

// localBearer: whether the request carries this run's agent secret.
func localBearer(req *Req) bool {
	a := req.H("authorization")
	if !strings.HasPrefix(a, "Bearer ") || LOCAL_SECRET == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a[7:]), []byte(LOCAL_SECRET)) == 1
}

// localBridgeWho: on a local server the bridge routes take the agent's secret only, never a sign-in cookie: a page
// of the owner cannot pass itself off as the agent, and the secret opens nothing else (REQ-S-104).
func localBridgeWho(req *Req) string {
	if localBearer(req) {
		return LOCAL_UID
	}
	return ""
}

var localLoginMu sync.Mutex
var localFails []int64

// localTakeTicket: a ticket from the file, taken once before it ran out (the file is rewritten without it).
func localTakeTicket(t string) bool {
	if !secretRe.MatchString(t) || LOCAL_TICKETS == "" {
		return false
	}
	b, err := os.ReadFile(LOCAL_TICKETS)
	if err != nil {
		return false
	}
	var list []struct {
		H   string  `json:"h"`
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(b, &list) != nil {
		return false
	}
	sum := sha256.Sum256([]byte(t))
	want := hex.EncodeToString(sum[:])
	now := float64(nowMs())
	hit := -1
	keep := []any{}
	for i, x := range list {
		if x.Exp <= now {
			continue
		}
		if hit < 0 && len(x.H) == len(want) && subtle.ConstantTimeCompare([]byte(x.H), []byte(want)) == 1 {
			hit = i
			continue
		}
		keep = append(keep, M{"h": x.H, "exp": x.Exp})
	}
	if hit < 0 {
		return false
	}
	out, _ := json.Marshal(keep)
	tmp := LOCAL_TICKETS + ".tmp"
	if os.WriteFile(tmp, out, 0o600) != nil || os.Rename(tmp, LOCAL_TICKETS) != nil {
		return false
	}
	return true
}

// localLogin: POST /api/local/login {ticket} → the owner's sign-in cookie (HttpOnly, SameSite=Strict, this port's
// own name). Ten failures a minute at most.
func localLogin(req *Req, res *Res) {
	if req.H("x-local-ui") != "1" {
		refuse(403, "로컬 화면의 요청이 아니에요")
	}
	if !strings.HasPrefix(ctype(req), "application/json") {
		refuse(415, "application/json 만 받습니다")
	}
	b := body(req, 4096)
	localLoginMu.Lock()
	now := nowMs()
	recent := localFails[:0]
	for _, t := range localFails {
		if now-t < 60_000 {
			recent = append(recent, t)
		}
	}
	localFails = recent
	if len(localFails) >= 10 {
		localLoginMu.Unlock()
		refuse(429, "잠시 뒤에 다시 해 주세요")
	}
	t, _ := b["ticket"].(string)
	took := localTakeTicket(t)
	if !took {
		localFails = append(localFails, now)
	}
	localLoginMu.Unlock()
	if !took {
		refuse(403, "링크가 맞지 않거나 시간이 지났어요. 맥 터미널에서 다시 받으세요")
	}
	localOwner()
	token := base64.RawURLEncoding.EncodeToString(randBytes(32))
	logins.Set(sha256hexs(token), M{"uid": LOCAL_UID, "exp": float64(nowMs() + int64(LOCAL_HOURS)*3_600_000)})
	touchGlobals()
	logLine("local: 일회용 링크로 로그인함")
	jsonRes(res, 200, M{"ok": true}, M{"Set-Cookie": cookie(req, cname(req, "cb"), token, int64(LOCAL_HOURS)*3600)})
}

// LOCAL_ENTER: what a local server shows before sign-in. Its script takes the link's ticket out of the address and
// trades it for the sign-in.
const LOCAL_ENTER = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>이 맥의 Agent Bridge</title><link rel="stylesheet" href="/local-enter.css"><body><main><h1>이 맥의 Agent Bridge</h1><p id="msg">들어가는 중…</p><p class="muted">이 화면은 이 맥(127.0.0.1)에서만 열려요. 맥 터미널에서 일회용 링크를 받아 여세요:</p><pre>node ~/.claude-bridge/agent.mjs local --full open</pre></main><script src="/local-enter.js"></script></body></html>`

const LOCAL_ENTER_CSS = `body{font:16px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:16px}main{max-width:560px;margin:12vh auto}h1{font-size:20px}.muted{opacity:.7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.15);padding:8px 10px;border-radius:6px}`

const LOCAL_ENTER_JS = `(async () => {
  const msg = document.getElementById('msg')
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash)
  history.replaceState(null, '', location.pathname)
  if (!m) return void (msg.textContent = '로그인이 필요해요.')
  try {
    const r = await fetch('/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1' }, body: JSON.stringify({ ticket: m[1] }) })
    if (r.ok) return void location.replace('/')
    const j = await r.json().catch(() => ({}))
    msg.textContent = j.error || ('들어가지 못했어요 (HTTP ' + r.status + ')')
  } catch (e) {
    msg.textContent = '들어가지 못했어요: ' + e.message
  }
})()
`

// localHeaders: the local screen's headers on every page of a local server.
func localHeaders(h M) M {
	h["Content-Security-Policy"] = LOCAL_CSP
	h["X-Frame-Options"] = "SAMEORIGIN"
	h["X-Content-Type-Options"] = "nosniff"
	h["Referrer-Policy"] = "no-referrer"
	h["Cross-Origin-Opener-Policy"] = "same-origin"
	h["Cross-Origin-Resource-Policy"] = "same-origin"
	return h
}

// localRoute: what only a local server answers. true: answered.
func localRoute(req *Req, res *Res, p string) bool {
	if !LOCAL {
		return false
	}
	if localClosed(p) {
		refuse(404, "없는 주소입니다")
	}
	switch {
	case p == "/api/local/login" && req.Method == "POST":
		localLogin(req, res)
		return true
	case p == "/local-enter.js" && req.Method == "GET":
		res.WriteHead(200, localHeaders(M{"Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store"})).EndS(LOCAL_ENTER_JS)
		return true
	case p == "/local-enter.css" && req.Method == "GET":
		res.WriteHead(200, localHeaders(M{"Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store"})).EndS(LOCAL_ENTER_CSS)
		return true
	case p == "/" && req.Method == "GET" && whoami(req) == "":
		res.WriteHead(200, localHeaders(M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"})).EndS(LOCAL_ENTER)
		return true
	}
	return false
}
