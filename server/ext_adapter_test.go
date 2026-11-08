package main

import (
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

const adapterYaml = `id: slackish
name: 어댑터 시험
version: 0.1.0
extensionApi: 1
entry: ./index.js
uses:
  slots: [session.panel]
adapters:
  thread.read: read
  thread.reply: write
`

// adapterSink: a Mac that answers each adapter command with what answer returns (nil: no answer at all).
type adapterSink struct {
	sent   []M
	answer func(cmd M) M
}

func (a *adapterSink) Write(chunk string) bool {
	var cmd M
	_ = json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(chunk, "data: "), "\n\n")), &cmd)
	a.sent = append(a.sent, cmd)
	if r := a.answer(cmd); r != nil {
		r["reqId"] = cmd["reqId"]
		go withLock(func() { reply(r, "h1") })
	}
	return true
}
func (a *adapterSink) End(string)   {}
func (a *adapterSink) Pending() int { return 0 }

func withAdapterExt(t *testing.T, answer func(cmd M) M) *adapterSink {
	t.Helper()
	_ = withConfigServer(t)
	keep := EXTS
	t.Cleanup(func() { EXTS = keep })
	dir := extDir(t, filepath.Join(t.TempDir(), "slackish"), adapterYaml, map[string]string{"index.js": "export default () => {}"})
	withCfg(t, "extensionConsent: false\n")
	EXTS = loadExtensions([]extEntry{{Path: dir}}, extEnv)
	ok(t, EXTS[0].Err == "", EXTS[0].Err)
	s := &adapterSink{answer: answer}
	wasH, wasS, wasB := hosts, sessions, bridges
	t.Cleanup(func() { withLock(func() { hosts, sessions, bridges = wasH, wasS, wasB }) })
	withLock(func() {
		hosts, sessions, bridges = newOMap[M](), newOMap[*Sess](), newOMap[Sink]()
		hosts.Set("h1", M{"uid": "u1", "name": "맥"})
		sessions.Set("sa", &Sess{m: M{"id": "sa", "uid": "u1", "hostId": "h1", "cwd": "/w/app"}})
		sessions.Set("sb", &Sess{m: M{"id": "sb", "uid": "u2", "hostId": "h1"}})
		bridges.Set("h1", s)
		live("h1")["caps"] = []any{"store", "adapters"}
	})
	return s
}

func adapterPost(t *testing.T, sub, body string) (int, M) {
	t.Helper()
	code, out := extCall(t, "POST", "/api/ext/slackish/adapter"+sub, body, map[string]string{"X-Bridge-Ext": "1", "Origin": "http://localhost"}, "u1")
	var m M
	_ = json.Unmarshal([]byte(out), &m)
	return code, m
}

// AC-1702: extension.yaml adapters: — each action read or write, nothing else.
func TestExtAdapterYaml(t *testing.T) {
	root := t.TempDir()
	base := "id: x-ext\nname: x\nversion: 1\nextensionApi: 1\nentry: index.js\n"
	load := func(name, y string) *extDef {
		dir := extDir(t, filepath.Join(root, name), base+y, map[string]string{"index.js": "x"})
		return loadExtensions([]extEntry{{Path: dir}}, extEnv)[0]
	}
	d := load("good", "adapters:\n  thread.read: read\n  thread.reply: write\n")
	eq(t, d.Err, "")
	eq(t, d.adapterAccess("thread.reply"), "write")
	eq(t, d.adapterAccess("thread.read"), "read")
	eq(t, d.adapterAccess("other"), "")
	ok(t, strings.Contains(load("exec", "adapters:\n  thread.read: exec\n").Err, "read 또는 write"))
	ok(t, strings.Contains(load("name", "adapters:\n  Thread..read: read\n").Err, "쓸 수 없는 이름"))
	ok(t, strings.Contains(load("list", "adapters: [a]\n").Err, "adapters 아래는"))
}

// AC-1703: who may call what, and every outcome as a state (offline, unsupported, done, unknown, failed).
func TestExtAdapterCall(t *testing.T) {
	var mode string
	s := withAdapterExt(t, func(cmd M) M {
		switch mode {
		case "done":
			if cmd["op"] == "list" {
				return M{"t": "adapter", "ok": true, "actions": M{"thread.read": "read", "thread.reply": "read", "secret.dump": "read"}, "problems": []any{M{"name": "bad", "error": "adapter.json 이 없어요"}}}
			}
			if cmd["op"] == "status" {
				return M{"t": "adapter", "ok": true, "state": "none"}
			}
			return M{"t": "adapter", "ok": true, "state": "done", "result": M{"messages": 3}, "replayed": true, "extra": "x"}
		case "error":
			return M{"t": "error", "message": "에이전트가 명령을 받았지만 제때 답하지 않았습니다"}
		}
		return nil
	})
	mode = "done"
	code, r := adapterPost(t, "", `{"sid":"sa","action":"thread.read","input":{"ts":"1"},"requestId":"req-00000001"}`)
	eq(t, code, 200)
	eq(t, r["state"], "done")
	jeq(t, r["result"], `{"messages":3}`)
	eq(t, r["replayed"], true)
	ok(t, r["extra"] == nil, "모르는 필드는 버림")
	cmd := s.sent[len(s.sent)-1]
	eq(t, cmd["t"], "adapter")
	eq(t, cmd["ext"], "slackish")
	eq(t, cmd["access"], "read", "접근은 서버가 extension.yaml 에서 정함")
	eq(t, cmd["requestId"], "req-00000001")
	eq(t, cmd["sid"], "sa")

	// What the extension did not declare, a wrong access, another person's session, a bad id: refused, not sent.
	n := len(s.sent)
	code, _ = adapterPost(t, "", `{"sid":"sa","action":"shell.exec","requestId":"req-00000002"}`)
	eq(t, code, 403)
	code, _ = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","access":"read","requestId":"req-00000002"}`)
	eq(t, code, 403)
	code, _ = adapterPost(t, "", `{"sid":"sb","action":"thread.read","requestId":"req-00000002"}`)
	eq(t, code, 404)
	code, _ = adapterPost(t, "", `{"sid":"sa","action":"thread.read","requestId":"short"}`)
	eq(t, code, 400)
	code, _ = adapterPost(t, "", `{"sid":"sa","action":"thread.read","requestId":"req-00000002","input":"`+strings.Repeat("x", ADAPTER_IN_MAX)+`"}`)
	eq(t, code, 413)
	eq(t, len(s.sent), n, "거절한 것은 맥에 보내지 않음")

	// list: only what the extension declared, with the access it declared.
	_, r = adapterPost(t, "/list", `{"sid":"sa"}`)
	jeq(t, r["actions"], `{"thread.read":"read"}`)
	eq(t, len(asArr(r["problems"])), 1)
	_, r = adapterPost(t, "/status", `{"sid":"sa","requestId":"req-00000001"}`)
	eq(t, r["state"], "none")

	// No answer from the Mac: a write is unknown (it may have run), a read failed.
	mode = "error"
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","input":{"text":"hi"},"requestId":"req-00000003"}`)
	eq(t, r["state"], "unknown")
	eq(t, r["requestId"], "req-00000003")
	ok(t, strings.Contains(mstr(r, "error"), "실행됐는지 알 수 없어요"), mstr(r, "error"))
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.read","requestId":"req-00000004"}`)
	eq(t, r["state"], "failed")

	// An agent that does not know adapters, and a Mac not connected: nothing sent.
	withLock(func() { live("h1")["caps"] = []any{"store"} })
	n = len(s.sent)
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","requestId":"req-00000005"}`)
	eq(t, r["state"], "unsupported")
	withLock(func() { bridges.Delete("h1") })
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","requestId":"req-00000005"}`)
	eq(t, r["state"], "offline")
	eq(t, len(s.sent), n)
}

// AC-1709 (REQ-S-101): a Mac that checks signatures gets a signed call as the page made it — op call, inputJ as it
// came (never the plain input), the page's signature for that very call — and its sealed outcome whole; an agent
// that does not know signed calls gets nothing.
func TestExtAdapterSigned(t *testing.T) {
	piece := "⟦bt1:0123abcd:" + strings.Repeat("A", 2000) + "⟧"
	var answer M
	s := withAdapterExt(t, func(cmd M) M { return answer })
	withLock(func() { hosts.Val("h1")["trust"] = M{"mode": "enforce", "seal": true} })

	// enforce and an agent without adapterSign: unsupported, nothing sent (the protection is never lowered).
	n := len(s.sent)
	_, r := adapterPost(t, "", `{"sid":"sa","action":"thread.reply","inputJ":"{}","requestId":"req-00000011"}`)
	eq(t, r["state"], "unsupported")
	ok(t, strings.Contains(mstr(r, "error"), "보호를 낮추지 않고"), mstr(r, "error"))
	eq(t, len(s.sent), n)

	withLock(func() { live("h1")["caps"] = []any{"store", "adapters", "adapterSign"} })
	tok := `{"v":1,"h":"h1","d":"dev","ts":1,"n":1,"t":"adapter","i":{"op":"call","sid":"sa","requestId":"req-00000012"}}`
	hdr, _ := json.Marshal([]M{{"p": tok, "s": "sig"}})
	withLock(func() { queueTrustAuth("u1", base64.RawURLEncoding.EncodeToString(hdr)) })
	answer = M{"t": "adapter", "ok": true, "state": "done", "result": M{"plain": "leak"}, "sealed": piece, "error": "x " + piece, "at": float64(5)}
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","input":{"no":1},"inputJ":"`+piece+`","requestId":"req-00000012"}`)
	cmd := s.sent[len(s.sent)-1]
	eq(t, cmd["op"], "call")
	eq(t, mstr(cmd, "inputJ"), piece, "inputJ 는 받은 그대로")
	ok(t, cmd["input"] == nil, "inputJ 가 있으면 평문 input 은 보내지 않음")
	eq(t, mstr(asM(cmd["auth"]), "p"), tok, "그 호출의 서명이 붙음")
	eq(t, mstr(r, "sealed"), piece, "봉인 조각은 자르지 않고 그대로")
	ok(t, r["result"] == nil, "봉인 조각이 있으면 평문 result 는 버림")
	eq(t, mstr(r, "error"), "x "+piece, "봉인 조각이 든 오류는 500 바이트에서 자르지 않음")
	eq(t, jsNumber(r["at"]), float64(5))

	// The Mac refused it before running (no or a wrong signature): refused, not unknown.
	answer = M{"t": "error", "code": "trust-refused", "message": "🔒 거부"}
	_, r = adapterPost(t, "", `{"sid":"sa","action":"thread.reply","inputJ":"{}","requestId":"req-00000013"}`)
	eq(t, r["state"], "refused")
	eq(t, r["code"], "trust")

	// list says whether the Mac checks signatures and whether its agent knows signed calls.
	answer = M{"t": "adapter", "ok": true, "actions": M{"thread.read": "read"}, "problems": []any{}}
	_, r = adapterPost(t, "/list", `{"sid":"sa"}`)
	eq(t, r["signs"], true)
	eq(t, r["signed"], true)
}
