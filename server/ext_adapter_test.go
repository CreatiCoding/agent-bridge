package main

import (
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
