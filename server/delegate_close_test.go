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
