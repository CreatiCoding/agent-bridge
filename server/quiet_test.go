package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The cases the server, the Mac (test/unit/quiet.test.mjs) and the page share (REQ-F-850).
type quietCases struct {
	Rules []quietRule `json:"rules"`
	Cases []struct {
		Text string `json:"text"`
		Want string `json:"want"`
	} `json:"cases"`
	Valid []struct {
		Suffix string `json:"suffix"`
		OK     bool   `json:"ok"`
	} `json:"valid"`
}

func readQuietCases(t *testing.T) quietCases {
	b, err := os.ReadFile("testdata/quiet-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c quietCases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestQuietOf(t *testing.T) {
	c := readQuietCases(t)
	for _, k := range c.Cases {
		got := ""
		if r := quietOf(k.Text, c.Rules); r != nil {
			got = r.Ext + "|" + r.Suffix
		}
		if got != k.Want {
			t.Errorf("quietOf(%q) = %q, want %q", k.Text, got, k.Want)
		}
	}
	for _, v := range c.Valid {
		if quietSuffixOk(v.Suffix) != v.OK {
			t.Errorf("quietSuffixOk(%q) = %v", v.Suffix, !v.OK)
		}
	}
	if quietLabel("  가\u0007나 ") != "가나" {
		t.Errorf("label: %q", quietLabel("  가\u0007나 "))
	}
}

const quietYaml = `id: hush
name: 조용히
version: 0.1.0
extensionApi: 1
entry: ./index.js
uses:
  actions: [message.render]
messages:
  quiet:
    - suffix: "[조용히]"
      label: 할 일 없음
`

func answerLine(text, model string) string {
	return jsonStr(M{"type": "assistant", "uuid": randHex(8), "message": M{"role": "assistant", "model": model, "content": []any{M{"type": "text", "text": text}}}})
}

// AC-1574: extension.yaml's messages.quiet: read, listed, refused when out of its limits.
func TestQuietYaml(t *testing.T) {
	root := t.TempDir()
	d := &extDef{Dir: extDir(t, filepath.Join(root, "hush"), quietYaml, map[string]string{"index.js": "x"})}
	ok(t, d.load(extEnv) == nil)
	jeq(t, d.Quiet, `[{"ext":"hush","suffix":"[조용히]","label":"할 일 없음"}]`)
	jeq(t, d.Actions, `["message.render"]`)
	bad := func(yaml, want string) {
		t.Helper()
		x := &extDef{Dir: extDir(t, filepath.Join(t.TempDir(), "x"), yaml, map[string]string{"index.js": "x"})}
		err := x.load(extEnv)
		ok(t, err != nil && strings.Contains(err.Error(), want), errS(err))
	}
	base := strings.SplitN(quietYaml, "messages:", 2)[0]
	bad(base+"messages:\n  quiet:\n    - suffix: \" [조용히]\"\n", "앞뒤에 공백")
	bad(base+"messages:\n  quiet:\n    - suffix: \"\"\n", "suffix")
	bad(base+"messages:\n  loud: []\n", "모르는 키 messages.loud")
	bad(base+"messages:\n  quiet:\n    - suffix: a\n      color: red\n", "모르는 키 messages.quiet[].color")
	bad(base+"messages:\n  quiet:\n"+strings.Repeat("    - suffix: a\n", 6), "5개까지")
}

// AC-1575~AC-1577: an answer that ends with an agreed rule's end is marked quiet; the "새 답" dot and the notify
// webhooks skip it; a sealed answer goes by its own Mac's mark; consent off, an API error and a turn with a warning
// stay loud.
func TestQuietFlow(t *testing.T) {
	hs := newHookServer(t)
	withSlotServer(t, "notify:\n  - type: webhook\n    url: "+hs.srv.URL+"\n    secret: "+HOOK_SECRET+"\n    events: [session.done]\n")
	keepE, keepS := EXTS, sessions
	t.Cleanup(func() { EXTS, sessions = keepE, keepS })
	sessions = newOMap[*Sess]()
	EXTS = loadExtensions([]extEntry{{Path: extDir(t, filepath.Join(t.TempDir(), "hush"), quietYaml, map[string]string{"index.js": "x"})}}, extEnv)
	d := EXTS[0]
	eq(t, d.Err, "")
	users.Set("u1", M{"login": "me"})
	hosts.Set("h1", M{"uid": "u1", "name": "내 맥"})
	meta := newMeta("u1", "s-quiet", "h1", M{"cwd": "/w", "title": "일"})
	turn := func(lines ...string) []any {
		var evs []any
		withLock(func() {
			statusFromAgent("u1", "h1", M{"sid": meta.id(), "phase": "busy", "alive": true})
			evs = convert(meta, lines)
			logEvents(meta, evs)
			statusFromAgent("u1", "h1", M{"sid": meta.id(), "phase": "idle", "alive": true})
		})
		return evs
	}
	quietOfEv := func(evs []any) any {
		for _, e := range evs {
			if mget(e, "k") == "text" {
				return mget(e, "quiet")
			}
		}
		return "none"
	}

	// Not agreed yet: loud, and the webhook hears of it.
	ok(t, quietOfEv(turn(answerLine("할 일 없어요 [조용히]", "claude-x"))) == nil, "동의 전")
	hs.wait(t, 1)
	// Agreed: quiet; no dot (loudSeq stays), no preview, and no webhook.
	writeJson(consentPath("u1"), M{"hush": d.Hash})
	jeq(t, extList("u1")[0].(orderedObj)[9], `{"K":"quiet","V":[{"suffix":"[조용히]","label":"할 일 없음"}]}`)
	before := numOr0(meta.get("loudSeq"))
	last := meta.get("last")
	evs := turn(answerLine("확인해 볼게요", "claude-x"), answerLine("오늘은 할 일이 없어요. [조용히]\n", "claude-x"))
	eq(t, quietOfEv(evs[1:]), "hush")
	ok(t, mget(evs[0], "quiet") == nil, "앞선 글은 표시 없음")
	ok(t, meta.get("lastQuiet") == true && numOr0(meta.get("loudSeq")) == before, "같은 턴의 앞선 글도 새 답 점을 띄우지 않음", jsonStr(meta.get("loudSeq")))
	ok(t, meta.get("last") == "확인해 볼게요" || meta.get("last") == last, "미리보기는 조용한 답으로 안 바뀜")
	// An API error in the answer's place, or a warning in the turn: loud.
	ok(t, quietOfEv(turn(answerLine("API Error: 500 [조용히]", "<synthetic>"))) == nil, "synthetic")
	hs.wait(t, 2)
	turn(answerLine("거부됨 [조용히]", "claude-x"))
	time.Sleep(100 * time.Millisecond)
	hs.mu.Lock()
	eq(t, len(hs.got), 2, "조용한 턴은 웹훅에 안 감")
	hs.mu.Unlock()
	withLock(func() {
		statusFromAgent("u1", "h1", M{"sid": meta.id(), "phase": "busy", "alive": true})
		logEvents(meta, []any{M{"k": "notice", "text": "가짜 알림을 숨겼어요", "tone": "warn"}})
		logEvents(meta, convert(meta, []string{answerLine("끝 [조용히]", "claude-x")}))
		statusFromAgent("u1", "h1", M{"sid": meta.id(), "phase": "idle", "alive": true})
	})
	hs.wait(t, 3)
	ok(t, numOr0(meta.get("loudSeq")) == numOr0(meta.get("alarmSeq")), "경고가 새 답 점을 띄움")
	// Sealed: the words cannot be read here; only the Mac's own mark counts, and only on sealed words.
	sealed := `{"type":"assistant","uuid":"u-s","bridgeQuiet":"mac","message":{"role":"assistant","model":"claude-x","content":[{"type":"text","text":"⟦bt1:0a1b2c3d:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn⟧"}]}}`
	eq(t, quietOfEv(turn(sealed)), "mac")
	plain := strings.Replace(answerLine("평문", "claude-x"), `"type":"assistant"`, `"bridgeQuiet":"mac","type":"assistant"`, 1)
	ok(t, quietOfEv(turn(plain)) == nil, "평문에 붙은 표지는 안 믿음")
	// extensionConsent off: an operator's rule does not fold anyone's answers.
	withCfg(t, "extensionConsent: false\n")
	ok(t, quietOfEv(turn(answerLine("끝 [조용히]", "claude-x"))) == nil, "동의 끔")
	ok(t, !quietAgreed("u1", d))
}
