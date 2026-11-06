// REQ-F-467 (1.451): a session keeps its name through rest, end, wake (--resume), an agent restart and a server
// restart.
package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func titleTestSession(t *testing.T, id string, fields M) *Sess {
	t.Helper()
	wasData, wasHosts, wasPlug := DATA, hosts, plug
	// No plugin runs for this person: an empty set, whatever another test left in ALL_PLUGINS.
	DATA, hosts, plug = t.TempDir(), newOMap[M](), &Plugins{running: newOMap[PluginInst]()}
	t.Cleanup(func() { DATA, hosts, plug = wasData, wasHosts, wasPlug; sessions.Delete(id) })
	return newMeta("title-test-user", id, "title-host", fields)
}

// aiTitle: the line Claude Code writes, as the Mac sends it.
func aiTitle(meta *Sess, title string) {
	withLock(func() {
		convert(meta, []string{jsonStr(M{"type": "ai-title", "aiTitle": title, "sessionId": meta.str("conv")})})
	})
}

func TestAutoNameKeptThroughRestEndWake(t *testing.T) {
	meta := titleTestSession(t, "title-rest", M{"title": "사과와 배의 차이를 한 문장으로"})
	aiTitle(meta, "사과와 배의 차이")
	eq(t, meta.str("title"), "사과와 배의 차이", "ai-title 이 첫 글 이름을 바꾼다")
	// Rest, end and wake on the same conversation: the agent's own lines carry the same ai-title again.
	meta.set("resting", true)
	closeLike := func() { meta.set("closed", true); meta.set("closed", false); meta.set("resting", false) }
	closeLike()
	aiTitle(meta, "사과와 배의 차이")
	eq(t, meta.str("title"), "사과와 배의 차이", "같은 대화")

	// Woken under a new id (a resumed copy): Claude Code names the copy again from its newest words.
	withLock(func() {
		fromAgent["conv"]("title-test-user", "title-host", M{"sid": meta.id(), "conv": "11111111-2222-4333-8444-000000000001", "replay": true})
	})
	aiTitle(meta, "고양이가 가르랑거리는 이유")
	eq(t, meta.str("title"), "사과와 배의 차이", "이어 연 사본의 ai-title 은 이름을 덮지 않는다")

	// /clear: a new conversation may be named anew.
	withLock(func() {
		fromAgent["conv"]("title-test-user", "title-host", M{"sid": meta.id(), "conv": "11111111-2222-4333-8444-000000000002", "replay": false})
	})
	aiTitle(meta, "새 주제")
	eq(t, meta.str("title"), "새 주제", "/clear 뒤 새 대화의 이름")
}

// A session named before 1.451 (no titleConv) woken under a new id keeps its name too.
func TestOlderSessionResumedCopyKeepsName(t *testing.T) {
	meta := titleTestSession(t, "title-old", M{"title": "예전 자동 이름"})
	withLock(func() {
		fromAgent["conv"]("title-test-user", "title-host", M{"sid": meta.id(), "conv": "11111111-2222-4333-8444-000000000003", "replay": true})
	})
	aiTitle(meta, "최근 글로 지은 이름")
	eq(t, meta.str("title"), "예전 자동 이름")
}

func TestLockOnlyNeverReplacesAName(t *testing.T) {
	meta := titleTestSession(t, "title-lock", M{"title": "읽을 수 있는 이름"})
	aiTitle(meta, "🔒")
	eq(t, meta.str("title"), "읽을 수 있는 이름")
}

func TestManualNameKept(t *testing.T) {
	meta := titleTestSession(t, "title-manual", M{"title": "시험 B 직접 이름", "manualTitle": true})
	aiTitle(meta, "바다가 파란 이유")
	withLock(func() {
		fromAgent["conv"]("title-test-user", "title-host", M{"sid": meta.id(), "conv": "11111111-2222-4333-8444-000000000004", "replay": false})
	})
	aiTitle(meta, "다른 이름")
	eq(t, meta.str("title"), "시험 B 직접 이름")
}

// A server restart reads meta.json: the name and where it came from are there.
func TestNameSurvivesServerRestart(t *testing.T) {
	meta := titleTestSession(t, "title-reload", M{"title": "첫 글"})
	aiTitle(meta, "자동 이름")
	meta.set("resting", true)
	file := filepath.Join(sessionDir(meta), "meta.json")
	writeJson(file, savedMeta(meta))
	back := newSess(readJSON(file, nil).(M))
	eq(t, back.str("title"), "자동 이름")
	eq(t, back.str("titleConv"), "title-reload")
	eq(t, truthy(back.get("resting")), true)
}

// REQ-S-099 (1.452): a session a paired device starts on a sealing Mac sends its first words as a sealed piece; the
// name keeps the piece whole (the paired device opens it), as a session started on the Mac's own page has its words.
func TestPairedDeviceSessionIsNamed(t *testing.T) {
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", 200) + "⟧"
	eq(t, startTitle("", piece, "/Users/x/w/0101-a"), piece, "봉인한 첫 글")
	eq(t, startTitle("", "평문 첫 글", ""), "평문 첫 글", "자기 기기")
	eq(t, startTitle("직접 이름", piece, ""), "직접 이름", "요청한 이름")
	big := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", SEAL_KEEP_MAX) + "⟧"
	eq(t, startTitle("", big, "/Users/x/w/0101-a"), "🔒 0101-a", "너무 큰 조각")

	// Claude Code's ai-title arrives sealed too: it names the session, kept whole.
	meta := titleTestSession(t, "title-paired", M{"title": piece})
	named := "⟦bt1:0a1b2c3d:" + strings.Repeat("B", 120) + "⟧"
	aiTitle(meta, named)
	eq(t, meta.str("title"), named, "봉인한 ai-title")
}

// A session named 🔒 before 1.452 gets its name from the next ai-title or first words.
func TestLockOnlyNameIsFilledLater(t *testing.T) {
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("C", 120) + "⟧"
	meta := titleTestSession(t, "title-lockold", M{"title": "🔒"})
	aiTitle(meta, piece)
	eq(t, meta.str("title"), piece, "ai-title")

	meta2 := titleTestSession(t, "title-lockold2", M{"title": "🔒", "lines": 0.0})
	user := jsonStr(M{"type": "user", "uuid": "u1", "message": M{"role": "user", "content": "첫 글 " + piece}})
	withLock(func() {
		fromAgent["lines"]("title-test-user", "title-host", M{"sid": meta2.id(), "from": 0.0, "lines": []any{user}})
	})
	eq(t, meta2.str("title"), "첫 글 "+piece, "첫 글")
}
