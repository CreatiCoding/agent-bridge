// From test/unit/models, login-pin, prview, folder and drop-root (the module parts).
package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
	"time"
)

// ---------- models ----------

var testCatalog = js(`[
  { "value": "default", "resolved": "claude-opus-5-5", "name": "Default (recommended)", "description": "Opus 5.5 · Best for everyday, complex tasks" },
  { "value": "opus", "resolved": "claude-opus-5-5", "name": "Opus 5.5", "description": "For complex work and everyday tasks" },
  { "value": "fable", "resolved": "claude-fable-5-1", "name": "Fable 5.1", "description": "For your toughest challenges" },
  { "value": "sonnet", "resolved": "claude-sonnet-5-5", "name": "Sonnet 5.5", "description": "Most efficient for simpler tasks" },
  { "value": "haiku", "resolved": "claude-haiku-5-5", "name": "Haiku 5.5", "description": "Fastest for quick answers" },
  { "value": "claude-haiku-4-5-20251001", "resolved": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "description": "" },
  { "value": "claude-opus-5", "resolved": "claude-opus-5", "name": "Opus 5", "description": "" }
]`).([]any)

var testPrev = js(`[
  { "label": "Fable 5.1 (1M)", "value": "claude-fable-5-1[1m]" },
  { "label": "Opus 5.5 (1M)", "value": "claude-opus-5-5[1m]" },
  { "label": "Opus plan / Sonnet work", "value": "opusplan" },
  { "label": "Default", "value": "default" }
]`).([]any)

func TestModelsFromCatalog(t *testing.T) {
	jeq(t, modelsFromCatalog(testCatalog, testPrev), `[
    { "label": "Opus 5.5 (1M)", "value": "claude-opus-5-5[1m]" },
    { "label": "Opus 5.5", "value": "claude-opus-5-5" },
    { "label": "Fable 5.1 (1M)", "value": "claude-fable-5-1[1m]" },
    { "label": "Fable 5.1", "value": "claude-fable-5-1" },
    { "label": "Sonnet 5.5", "value": "claude-sonnet-5-5" },
    { "label": "Haiku 5.5", "value": "claude-haiku-5-5" },
    { "label": "Haiku 4.5", "value": "claude-haiku-4-5-20251001" },
    { "label": "Opus 5", "value": "claude-opus-5" },
    { "label": "Opus plan / Sonnet work", "value": "opusplan" },
    { "label": "Default · Opus 5.5", "value": "default" }
  ]`)
}

func TestModelsNewAndDropped(t *testing.T) {
	cat := append([]any{testCatalog[0], js(`{ "value": "opus", "resolved": "claude-opus-6", "name": "Opus 6", "description": "" }`)}, testCatalog[2:]...)
	next := modelsFromCatalog(cat, testPrev)
	eq(t, mget(next[0], "value"), any("claude-opus-6"))
	for _, m := range next {
		ok(t, mget(m, "value") != "claude-opus-5-5[1m]", "목록에서 빠진 모델의 1M 도 빠짐")
	}
	jeq(t, modelsFromCatalog([]any{}, []any{}), `[{ "label": "Default", "value": "default" }]`)
}

// ---------- login-pin ----------

func TestLoginPinAcrossRename(t *testing.T) {
	pins := loadPins(nil, js(`{ "gh1": { "login": "Boss" }, "dev-x": { "login": "x" } }`).(M))
	jeq(t, pins, `{ "boss": "gh1" }`, "dev 로그인은 GitHub 계정이 아님")
	eq(t, claimLogin(pins, "gh1", "boss"), "", "같은 계정은 그대로")
	eq(t, claimLogin(pins, "gh1", "NewBoss"), "")
	eq(t, claimLogin(pins, "gh2", "boss"), "gh1")
	eq(t, pins["boss"], any("gh1"))
}

func TestLoginPinReleasedStaysFree(t *testing.T) {
	u := js(`{ "gh1": { "login": "boss" } }`).(M)
	pins := loadPins(nil, u)
	delete(pins, "boss")
	saved := norm(pins)
	after := loadPins(saved, u)
	eq(t, heldBy(after, "gh2", "boss"), "")
	eq(t, claimLogin(after, "gh2", "boss"), "")
}

func TestLoginPinPropertyNames(t *testing.T) {
	pins := loadPins(M{}, M{})
	for _, name := range []string{"constructor", "toString", "__proto__", "hasOwnProperty"} {
		eq(t, heldBy(pins, "gh9", name), "", name)
	}
	eq(t, claimLogin(pins, "gh9", "constructor"), "")
	eq(t, heldBy(pins, "gh8", "constructor"), "gh9")
}

func TestLoginPinReleasedFromUsers(t *testing.T) {
	pins := loadPins(nil, js(`{ "gh1": { "login": "boss#released" }, "gh2": { "login": "alice" } }`).(M))
	eq(t, heldBy(pins, "gh9", "boss"), "")
	eq(t, heldBy(pins, "gh9", "alice"), "gh2")
}

// ---------- prview ----------

func TestPrSummary(t *testing.T) {
	now := parseDate("2026-10-05T00:00:00Z")
	prs := js(`[
    { "url": "u1", "createdAt": "2026-10-01T00:00:00Z", "mergedAt": "2026-10-01T02:00:00Z", "additions": 10, "deletions": 2 },
    { "url": "u2", "createdAt": "2026-10-03T00:00:00Z", "mergedAt": "2026-10-04T00:00:00Z", "additions": 5, "deletions": 1 },
    { "url": "u3", "createdAt": "2026-10-04T12:00:00Z" },
    { "url": "old", "createdAt": "2026-08-01T00:00:00Z", "mergedAt": "2026-08-02T00:00:00Z", "additions": 99, "deletions": 99 }
  ]`).([]any)
	s := prSummary(prs, now, 7)
	jeq(t, []any{s["merged"], s["created"], s["additions"], s["deletions"]}, `[2, 3, 15, 3]`)
	eq(t, s["medianMergeMs"], any(24*3600_000.0))
	eq(t, oget(asArr(s["recent"])[0], "url"), any("u3"))
	eq(t, prSummary(prs, now, 1)["merged"], any(1.0))
}

// ---------- folder ----------

func TestDefaultFolder(t *testing.T) {
	at := time.Date(2026, 9+1, 7, 0, 0, 0, 0, time.Local)
	eq(t, defaultFolderAt("~/bridge/works", "기타", "개발", at, "a3f9c2"), "~/bridge/works/개발/1007-a3f9c2")
	eq(t, defaultFolderAt("", "", "", at, "a3f9c2"), "~/bridge/works/기타/1007-a3f9c2")
	eq(t, defaultFolderAt("/Users/x/w/", "잡일", nil, at, "000000"), "/Users/x/w/잡일/1007-000000")
	ok(t, regexp.MustCompile(`^~/bridge/works/기타/\d{4}-[0-9a-f]{6}$`).MatchString(defaultFolder(nil, nil, nil)))
	eq(t, folderPart("앱 / 웹:서버"), "앱-웹-서버")
	eq(t, folderPart("../.."), "")
	eq(t, folderPart(".숨김"), "숨김")
	eq(t, cleanFolderBase("~/a/"), "~/a")
	long := "~/"
	for i := 0; i < 200; i++ {
		long += "a"
	}
	for _, bad := range []string{"a/b", "~/../etc", "../x", "~/a\nb", long} {
		eq(t, cleanFolderBase(bad), "", bad)
	}
}

// ---------- drop-root ----------

func TestChownTree(t *testing.T) {
	d := t.TempDir()
	_ = os.MkdirAll(filepath.Join(d, "u/a"), 0o755)
	_ = os.WriteFile(filepath.Join(d, "u/a/x.json"), []byte("{}"), 0o644)
	seen := []string{}
	eq(t, chownTreeWith(d, 4242, 4242, func(p string, _, _ int) error {
		r, _ := filepath.Rel(d, p)
		if r == "." {
			r = ""
		}
		seen = append(seen, r)
		return nil
	}), 0)
	sort.Strings(seen)
	jeq(t, seen, `["", "u", "u/a", "u/a/x.json"]`)
	eq(t, chownTreeWith(d, 4242, 4242, func(string, int, int) error { return errors.New("EPERM") }), 4)
}

func TestDropRoot(t *testing.T) {
	calls := []any{}
	proc := func(uid int) procOps {
		return procOps{
			getuid:    func() int { return uid },
			setgroups: func(g []int) error { calls = append(calls, []any{"groups", g}); return nil },
			setgid:    func(g int) error { calls = append(calls, []any{"gid", g}); return nil },
			setuid:    func(u int) error { calls = append(calls, []any{"uid", u}); return nil },
		}
	}
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	eq(t, dropRootWith("/nope", env(nil), proc(501)), "root 아님")
	eq(t, dropRootWith("/nope", env(map[string]string{"BRIDGE_RUN_AS_ROOT": "1"}), proc(0)), "BRIDGE_RUN_AS_ROOT=1 이라 root 로 둠")
	jeq(t, calls, `[]`)
	// A folder that does not exist has nothing to hand over: root is dropped.
	ok(t, regexp.MustCompile(`node\(1000\)`).MatchString(dropRootWith(filepath.Join(os.TempDir(), "cb-none-xyz"), env(nil), proc(0))))
	jeq(t, calls, `[["groups", [1000]], ["gid", 1000], ["uid", 1000]]`)
}

func TestTightenTree(t *testing.T) {
	d := t.TempDir()
	_ = os.MkdirAll(filepath.Join(d, "u/a"), 0o755)
	_ = os.WriteFile(filepath.Join(d, "u/a/events.jsonl"), []byte("{}\n"), 0o644)
	_ = os.Symlink("/etc/hosts", filepath.Join(d, "u/link"))
	before, _ := os.Stat("/etc/hosts")
	ok(t, tightenTree(d) >= 3)
	st, _ := os.Stat(filepath.Join(d, "u/a/events.jsonl"))
	eq(t, st.Mode().Perm(), os.FileMode(0o600))
	st, _ = os.Stat(filepath.Join(d, "u/a"))
	eq(t, st.Mode().Perm(), os.FileMode(0o700))
	l, _ := os.Lstat(filepath.Join(d, "u/link"))
	ok(t, l.Mode()&os.ModeSymlink != 0)
	after, _ := os.Stat("/etc/hosts")
	eq(t, after.Mode().Perm(), before.Mode().Perm(), "링크가 가리키는 파일은 그대로")
	eq(t, tightenTree(d), 0)
}
