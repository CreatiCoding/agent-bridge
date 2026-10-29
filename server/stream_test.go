package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// stuckWriter: a client that stopped reading. Its first write blocks until a write deadline is set.
type stuckWriter struct {
	h        http.Header
	mu       sync.Mutex
	deadline chan struct{}
	once     sync.Once
	writes   int
}

func newStuck() *stuckWriter { return &stuckWriter{h: http.Header{}, deadline: make(chan struct{})} }

func (w *stuckWriter) Header() http.Header { return w.h }
func (w *stuckWriter) WriteHeader(int)     {}
func (w *stuckWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	w.writes++
	n := w.writes
	w.mu.Unlock()
	if n == 1 {
		return len(b), nil // ": ok" goes out, then the client stops reading
	}
	<-w.deadline
	return 0, http.ErrHandlerTimeout
}
func (w *stuckWriter) Flush()            {}
func (w *stuckWriter) FlushError() error { return nil }
func (w *stuckWriter) SetWriteDeadline(t time.Time) error {
	w.once.Do(func() { close(w.deadline) })
	return nil
}

// A stream whose client stopped reading does not pile up what is written to it without end (REQ-S-087).
func TestStreamBacklogCut(t *testing.T) {
	w := newStuck()
	closed := make(chan struct{})
	s := newStream(func() { close(closed) })
	s.Write(": ok\n\n")
	r := httptest.NewRequest("GET", "/api/classic/stream", nil)
	go s.run(w, r, 200)
	time.Sleep(50 * time.Millisecond)
	chunk := "data: " + strings.Repeat("x", 1<<20) + "\n\n"
	took := 0
	for i := 0; i < 200; i++ {
		if s.Write(chunk) {
			took++
		}
	}
	ok(t, s.Pending() <= STREAM_BACKLOG_MAX, "backlog bounded", itoa(s.Pending()))
	ok(t, took < 200, "writes refused once the backlog is too long", itoa(took))
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream was not closed")
	}
}

// A client that keeps reading is never cut, however much goes through.
func TestStreamReaderKept(t *testing.T) {
	rec := httptest.NewRecorder()
	s := newStream(nil)
	r := httptest.NewRequest("GET", "/api/classic/stream", nil)
	done := make(chan struct{})
	go func() { s.run(rec, r, 200); close(done) }()
	chunk := "data: " + strings.Repeat("y", 1<<20) + "\n\n"
	for i := 0; i < 100; i++ {
		ok(t, s.Write(chunk), "write taken", itoa(i))
		for s.Pending() > 4<<20 {
			time.Sleep(time.Millisecond)
		}
	}
	s.End("")
	<-done
	ok(t, rec.Body.Len() >= 100<<20, "everything sent")
}

// One person's open pages are capped: the oldest goes when one more opens (REQ-S-087).
func TestControlStreamsCapped(t *testing.T) {
	withLock(func() {
		uid := "gh-streamcap"
		delete(controls, uid)
		first := []*Stream{}
		for i := 0; i < CONTROLS_MAX+3; i++ {
			s := newStream(nil)
			addControl(uid, randHex(8), s)
			first = append(first, s)
		}
		eq(t, controls[uid].Len(), CONTROLS_MAX)
		for i := 0; i < 3; i++ {
			ok(t, first[i].ended, "oldest ended", itoa(i))
		}
		ok(t, !first[3].ended, "the rest stay")
		delete(controls, uid)
	})
}
