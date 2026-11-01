// REQ-F-760 (1.390): a delegated session closes once its answer is handed over, leaves the list at once, and the
// Mac is asked to delete the folder bridge made for it only when nothing else uses it.
package main

import (
	"strings"
	"testing"
)

// recSink: a Mac's connection that keeps what the server sent it.
type recSink struct{ sent []string }

func (r *recSink) Write(chunk string) bool { r.sent = append(r.sent, chunk); return true }
func (r *recSink) End(string)              {}
func (r *recSink) Pending() int            { return 0 }

// closeCmd: the close command the Mac got for sid ("" when none).
func (r *recSink) closeCmd(sid string) string {
	for _, c := range r.sent {
		if strings.Contains(c, `"t":"close"`) && strings.Contains(c, `"sid":"`+sid+`"`) {
			return c
		}
	}
	return ""
}

// delegateSetup: the person gh1, a Mac h1 (the one asking, session p1) and a Mac h2 that took work.
func delegateSetup(t *testing.T) (*Sess, *recSink) {
	t.Helper()
	parent := hookSession(t, "")
	r := &recSink{}
	withLock(func() {
		parent.set("id", "p1")
		sessions.Delete("s1")
		sessions.Set("p1", parent)
		hosts.Set("h2", M{"uid": "gh1", "name": "맥미니"})
		bridges.Set("h2", r)
	})
	return parent, r
}

// child: a delegated session on h2 with a finished turn ("답") in folder cwd; made says bridge made the folder.
func child(t *testing.T, parent *Sess, id, cwd string, made bool, phase string) *Sess {
	t.Helper()
	var c *Sess
	withLock(func() {
		c = newMeta("gh1", id, "h2", M{"cwd": cwd, "title": "↪ 일", "delegatedBy": parent.id()})
		if made {
			c.set("madeDir", true)
			c.set("madeHost", "h2")
		}
		c.set("state", M{"alive": true, "phase": phase})
		logEvents(c, []any{M{"k": "text", "text": "답 " + id}})
		parent.set("delegates", append(asArr(parent.get("delegates")), id))
	})
	return c
}

func TestDelegateDoneClosesAndDropsFolder(t *testing.T) {
	parent, r := delegateSetup(t)
	c := child(t, parent, "c1", "/Users/me/bridge/works/기타/1102-aaa", true, "idle")
	withLock(func() {
		eq(t, len(delegatesOf(parent)), 1)
		closeAnswered(c, delegateState(c, 0))
	})
	ok(t, truthy(c.get("closed")), "답을 전하면 닫힘")
	cmd := r.closeCmd("c1")
	ok(t, strings.Contains(cmd, `"dropDir":"/Users/me/bridge/works/기타/1102-aaa"`), "폴더 삭제를 맡김: "+cmd)
	withLock(func() {
		eq(t, len(delegatesOf(parent)), 0, "3개 한도가 풀림")
		// The Mac answers; the session that asked hears it once.
		fromAgent["dirdrop"]("gh1", "h2", M{"sid": "c1", "ok": true})
		forgetClosedDelegate("c1", c)
	})
	_, has := sessions.Get("c1")
	ok(t, !has, "목록에서 바로 지움")
	last := ""
	for _, e := range readEvents(parent, true) {
		if mstr(e, "k") == "notice" {
			last = mstr(e, "text")
		}
	}
	ok(t, strings.Contains(last, "자동으로 닫았어요") && strings.Contains(last, "폴더를 지웠어요"), last)
	// delegate_status still answers from what the session that asked kept; delegate_send says it is closed.
	var st any
	withLock(func() {
		st = runDelegate("gh1", "h1", M{"sid": "p1", "op": "delegate_status", "args": M{"id": "c1"}})
	})
	eq(t, mstr(st.(M), "state"), "closed")
	eq(t, mstr(st.(M), "answer"), "답 c1")
	var err error
	withLock(func() {
		err = try(func() {
			runDelegate("gh1", "h1", M{"sid": "p1", "op": "delegate_send", "args": M{"id": "c1", "text": "더"}})
		})
	})
	ok(t, err != nil && strings.Contains(err.Error(), "닫힌 세션이에요"), "닫힌 뒤 send")
}

func TestDelegateWaitingOrWorkingStaysOpen(t *testing.T) {
	parent, r := delegateSetup(t)
	w := child(t, parent, "c2", "/w/a", true, "waiting")
	b := child(t, parent, "c3", "/w/b", true, "busy")
	e := child(t, parent, "c4", "/w/c", true, "ended")
	withLock(func() {
		for _, c := range []*Sess{w, b, e} {
			closeAnswered(c, delegateState(c, 0))
		}
	})
	for _, c := range []*Sess{w, b, e} {
		ok(t, !truthy(c.get("closed")), c.id()+" 은 열린 채")
		eq(t, r.closeCmd(c.id()), "", c.id())
	}
}

func TestDelegateFolderKept(t *testing.T) {
	parent, r := delegateSetup(t)
	given := child(t, parent, "c5", "/Users/me/proj", false, "idle")
	shared := child(t, parent, "c6", "/Users/me/bridge/works/기타/1102-bbb", true, "idle")
	withLock(func() {
		// Another session (closed, in 이어서 하기) works under the same folder on the same Mac.
		o := newMeta("gh1", "o1", "h2", M{"cwd": "/Users/me/bridge/works/기타/1102-bbb/sub", "closed": true})
		_ = o
		closeAnswered(given, delegateState(given, 0))
		closeAnswered(shared, delegateState(shared, 0))
	})
	for _, id := range []string{"c5", "c6"} {
		cmd := r.closeCmd(id)
		ok(t, cmd != "" && !strings.Contains(cmd, "dropDir"), id+" 폴더 유지: "+cmd)
	}
	notes := ""
	for _, e := range readEvents(parent, true) {
		notes += mstr(e, "text") + "\n"
	}
	ok(t, strings.Contains(notes, "폴더는 남겼어요(폴더를 정해 맡긴 일)"), notes)
	ok(t, strings.Contains(notes, "폴더는 남겼어요(다른 세션도 이 폴더를 써요)"), notes)
}

// Closed by the person, or with the session that handed it: the same rules (list, folder, kept answer).
func TestDelegateClosedWithParent(t *testing.T) {
	parent, r := delegateSetup(t)
	c := child(t, parent, "c7", "/Users/me/bridge/works/기타/1102-ccc", true, "busy")
	withLock(func() { closeSession(parent, "") })
	ok(t, truthy(c.get("closed")), "같이 닫힘")
	ok(t, strings.Contains(r.closeCmd("c7"), "dropDir"), "폴더도")
	eq(t, mstr(keptDelegate(parent, "c7"), "answer"), "답 c7")
	withLock(func() { eq(t, sweepEnded(float64(nowMs())), 1, "닫힌 맡긴 세션은 7일을 기다리지 않음") })
}

// line: one transcript line as Claude Code writes it.
func line(v M) string { return jsonStr(v) }

// toolPair: a tool call and its result (the result's text first), fed to the background tracking.
func toolPair(meta *Sess, id, name string, input M, result string) {
	trackBackground(meta, line(M{"type": "assistant", "message": M{"content": []any{M{"type": "tool_use", "id": id, "name": name, "input": input}}}}))
	trackBackground(meta, line(M{"type": "user", "message": M{"content": []any{M{"type": "tool_result", "tool_use_id": id, "content": []any{M{"type": "text", "text": result}}}}}}))
}

func bgKinds(meta *Sess) []string {
	out := []string{}
	for _, t := range asArr(meta.get("bg")) {
		out = append(out, mstr(t, "kind"))
	}
	return out
}

// 1.391: what a session left running in the background, each kind as Claude Code says it.
func TestBackgroundKindsTracked(t *testing.T) {
	parent, _ := delegateSetup(t)
	c := child(t, parent, "k1", "/w/k", true, "idle")
	withLock(func() {
		toolPair(c, "t1", "Bash", M{"command": "sleep 100", "run_in_background": true}, "Command running in background with ID: b1x. Output is being written to: /tmp/x")
		toolPair(c, "t2", "Bash", M{"command": "make"}, "Command did not complete within its 120s timeout and was moved to the background (ID: b2x). Output is being written to: /tmp/y")
		toolPair(c, "t3", "mcp__bridge__delegate", M{"task": "x"}, `MCP tool "bridge/delegate" is still running after 120s. It was moved to the background as task kc8xnsimv and keeps running; you'll receive a notification`)
		toolPair(c, "t4", "Agent", M{"prompt": "x", "run_in_background": true}, "Async agent launched successfully.\nagentId: a123 (internal ID)")
		toolPair(c, "t5", "Monitor", M{"command": "x", "timeout_ms": 600000}, "Monitor started (task m1x, timeout 600000ms).")
		toolPair(c, "t6", "ScheduleWakeup", M{"delaySeconds": 1200, "reason": "CI 기다림"}, "Next wakeup scheduled for 00:20:00 (in 1224s). If you owe the user a status update")
	})
	eq(t, strings.Join(bgKinds(c), ","), "bash,bash,mcp,agent,monitor,wakeup")
	withLock(func() {
		// The MCP call ends with its task notification; a stopped loop drops its wakeup; a new wakeup replaces the old.
		trackBackground(c, line(M{"type": "user", "message": M{"content": "<task-notification><task-id>kc8xnsimv</task-id><status>completed</status></task-notification>"}}))
		toolPair(c, "t7", "ScheduleWakeup", M{"delaySeconds": 60}, "Next wakeup scheduled for 00:21:00 (in 60s).")
	})
	eq(t, strings.Join(bgKinds(c), ","), "bash,bash,agent,monitor,wakeup")
	for _, x := range asArr(c.get("bg")) {
		if mstr(x, "kind") == "wakeup" {
			eq(t, jsNumber(mget(x, "timeout")), 60_000.0, "깨우는 시각까지")
		}
	}
	withLock(func() { toolPair(c, "t8", "ScheduleWakeup", M{"stop": true}, "Loop stopped.") })
	eq(t, strings.Join(bgKinds(c), ","), "bash,bash,agent,monitor")
	// The Mac counts no shells left: commands and monitors go, the agent stays (it lives inside Claude).
	withLock(func() {
		for _, x := range asArr(c.get("bg")) {
			asM(x)["at"] = float64(nowMs() - 60_000)
		}
		statusFromAgent("gh1", "h2", M{"sid": "k1", "alive": true, "phase": "idle", "shells": 0.0})
	})
	eq(t, strings.Join(bgKinds(c), ","), "agent")
}

// 1.391: a turn that ended with background work still running is not the end: it closes after the next answer.
func TestDelegateBackgroundHeldThenClosed(t *testing.T) {
	parent, r := delegateSetup(t)
	c := child(t, parent, "c7", "/Users/me/bridge/works/기타/1102-ccc", true, "idle")
	withLock(func() {
		toolPair(c, "u1", "Bash", M{"command": "gh run watch", "run_in_background": true}, "Command running in background with ID: bz1. Output is being written to: /tmp/z")
		st := delegateState(c, 0)
		eq(t, mstr(st, "note"), DELEGATE_BG_HELD)
		closeAnswered(c, st)
		closeAnswered(c, delegateState(c, 0))
	})
	ok(t, !truthy(c.get("closed")), "백그라운드 작업이 남으면 닫지 않음")
	eq(t, r.closeCmd("c7"), "")
	held := 0
	for _, e := range readEvents(c, true) {
		if mstr(e, "k") == "notice" && strings.Contains(mstr(e, "text"), DELEGATE_BG_HELD) {
			held++
		}
	}
	eq(t, held, 1, "한 번만 알림")
	// The command finishes, Claude wakes for it and answers again: now it closes.
	withLock(func() {
		trackBackground(c, line(M{"type": "user", "message": M{"content": "<task-notification><task-id>bz1</task-id><tool-use-id>u1</tool-use-id><status>completed</status></task-notification>"}}))
		eq(t, len(asArr(c.get("bg"))), 0)
		logEvents(c, []any{M{"k": "text", "text": "CI 통과, 배포했어요"}})
		st := delegateState(c, 0)
		_, has := st["note"]
		ok(t, !has, "note 없음")
		closeAnswered(c, st)
	})
	ok(t, truthy(c.get("closed")), "다음 답에서 닫힘")
	ok(t, r.closeCmd("c7") != "", "맥에 닫기")
}
