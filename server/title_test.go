// REQ-F-467 (1.451): a session keeps its name through rest, end, wake (--resume), an agent restart and a server
// restart.
package main

import (
	"path/filepath"
	"testing"
)

func titleTestSession(t *testing.T, id string, fields M) *Sess {
	t.Helper()
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	t.Cleanup(func() { DATA, hosts = wasData, wasHosts; sessions.Delete(id) })
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
