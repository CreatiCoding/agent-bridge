package main

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func pollReq() *Req { return &Req{r: httptest.NewRequest("GET", "/api/classic/poll", nil)} }

func pollMsgs(out M) []string {
	r := []string{}
	for _, m := range asArr(out["msgs"]) {
		r = append(r, m.(string))
	}
	return r
}

// A fetched place keeps what a stream would carry, numbered; what the fetcher has is dropped, and the newest
// terminal picture of a session replaces the one before it (REQ-F-849, AC-1570).
func TestPollBufOrderAckCoalesce(t *testing.T) {
	withLock(func() {
		s := newPoller(false, nil)
		defer delete(pollers, s)
		sse(s, M{"t": "ev", "sid": "a", "n": 1.0})
		s.Write(": ping\n\n")
		sse(s, M{"t": "screen", "sid": "a", "text": "one"})
		sse(s, M{"t": "screen", "sid": "b", "text": "b"})
		sse(s, M{"t": "screen", "sid": "a", "text": "two"})
		out := pollTake(pollReq(), s, 0, 0, false, nil)
		got := pollMsgs(out)
		eq(t, len(got), 3, "comment dropped, older picture of a replaced")
		ok(t, strings.Contains(got[0], `"ev"`), got[0])
		ok(t, strings.Contains(got[2], `"two"`), got[2])
		last := int64(jsNumber(out["last"]))
		eq(t, out["reset"], any(false))
		s.poll.doneAt, s.poll.askAt = 0, 0
		sse(s, M{"t": "ev", "sid": "a", "n": 2.0})
		out = pollTake(pollReq(), s, last, 0, false, nil)
		got = pollMsgs(out)
		eq(t, len(got), 1, "only what came after last")
		eq(t, len(s.poll.items), 1, "acked items dropped")
	})
}

// A fetcher that asks again too soon is refused, an older fetch is stale, and a number never given starts over
// from the whole state (AC-1570).
func TestPollGapAndRate(t *testing.T) {
	withLock(func() {
		s := newPoller(false, nil)
		defer delete(pollers, s)
		for i := 0; i < 5; i++ {
			sse(s, M{"t": "ev", "n": float64(i)})
		}
		pollTake(pollReq(), s, 3, 0, false, nil)
		err := try(func() { pollTake(pollReq(), s, 3, 0, false, nil) })
		r, isRefuse := err.(*Refuse)
		ok(t, isRefuse && r.Status == 429, "too soon refused")
		s.poll.doneAt, s.poll.askAt = 0, 0
		err = try(func() { pollTake(pollReq(), s, 1, 0, false, nil) })
		r, isRefuse = err.(*Refuse)
		ok(t, isRefuse && r.Status == 410, "an older fetch is stale")
		s.poll.doneAt, s.poll.askAt = 0, 0
		restarted := false
		out := pollTake(pollReq(), s, 99, 0, false, func() {
			restarted = true
			s.poll.items = nil
			s.poll.size = 0
			sse(s, M{"t": "state"})
		})
		ok(t, restarted, "a gap starts over")
		eq(t, out["reset"], any(true))
		got := pollMsgs(out)
		eq(t, len(got), 1)
		ok(t, strings.Contains(got[0], `"state"`), got[0])
	})
}

// Over its room a control page's place starts over; a bridge tab's is closed (AC-1570).
func TestPollOverflow(t *testing.T) {
	withLock(func() {
		s := newPoller(false, nil)
		defer delete(pollers, s)
		big := strings.Repeat("x", POLL_BACKLOG_MAX/2)
		for i := 0; i < 3; i++ {
			sse(s, M{"t": "ev", "x": big})
		}
		ok(t, s.poll.over, "over")
		ok(t, s.poll.size <= POLL_BACKLOG_MAX, "bounded")
		b := newPoller(true, nil)
		defer delete(pollers, b)
		big = strings.Repeat("x", BRIDGE_POLL_BACKLOG_MAX/2)
		took := 0
		for i := 0; i < 3; i++ {
			if sse(b, M{"t": "cmd", "x": big}) {
				took++
			}
		}
		ok(t, b.gone, "bridge place closed")
		eq(t, took, 1)
	})
}

// A fetch with nothing waiting holds until something is written, and lets the lock go meanwhile (AC-1570).
func TestPollWaitWakes(t *testing.T) {
	var s *Stream
	withLock(func() { s = newPoller(false, nil) })
	defer withLock(func() { delete(pollers, s) })
	done := make(chan M, 1)
	go withLock(func() { done <- pollTake(pollReq(), s, 0, 5*time.Second, false, nil) })
	time.Sleep(100 * time.Millisecond)
	withLock(func() { sse(s, M{"t": "ev", "n": 1.0}) })
	select {
	case out := <-done:
		eq(t, len(pollMsgs(out)), 1)
	case <-time.After(2 * time.Second):
		t.Fatal("the waiting fetch did not wake")
	}
}

// Ended or idle places are closed and their owner told, as for a dropped stream (AC-1570).
func TestPollSweep(t *testing.T) {
	closed := make(chan struct{}, 2)
	withLock(func() {
		a := newPoller(false, func() { closed <- struct{}{} })
		a.poll.lastAt = nowMs() - POLL_IDLE_MS - 1
		b := newPoller(true, func() { closed <- struct{}{} })
		_ = b
		sweepPollers()
		ok(t, a.ended, "idle place ended")
		_, still := pollers[a]
		ok(t, !still, "idle place forgotten")
		_, kept := pollers[b]
		ok(t, kept, "a recent place stays")
		delete(pollers, b)
	})
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("owner not told")
	}
}
