// The event loop the server was written for, kept: one lock holds all state, as one JavaScript thread did. Code
// runs with it held and lets go only where JavaScript awaited (a body arriving, an answer from a Mac, a sleep), so
// what ran between two awaits still runs as one piece. Responses are put together under the lock and written to the
// network after it is let go, so a slow phone holds no one else up.
package main

import (
	"bufio"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

var mu sync.Mutex

// Refuse is the server's own error with an HTTP status (class Refuse).
type Refuse struct {
	Status int
	Msg    string
	Extra  M
}

func (r *Refuse) Error() string { return r.Msg }

func refuse(status int, msg string) { panic(&Refuse{Status: status, Msg: msg}) }

func refuseX(status int, msg string, extra M) {
	panic(&Refuse{Status: status, Msg: msg, Extra: extra})
}

// jsError is a thrown Error that is not a Refuse (throw new Error(…) in a module).
type jsError struct{ msg string }

func (e *jsError) Error() string { return e.msg }

func throw(msg string) { panic(&jsError{msg}) }

// thrownErr: an error of its own class (AppleTokenError, UnsafePath): try keeps it as it is, for instanceof.
type thrownErr interface {
	error
	thrown()
}

// try runs f and returns what it threw: a *Refuse, a *jsError, or another panic re-raised as is.
func try(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			switch x := r.(type) {
			case *Refuse:
				err = x
			case *jsError:
				err = x
			case thrownErr:
				err = x
			case error:
				if errors.Is(x, http.ErrAbortHandler) {
					panic(x)
				}
				err = &jsError{x.Error()}
			default:
				err = &jsError{fmt.Sprint(x)}
			}
		}
	}()
	f()
	return nil
}

func errMsg(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}

// await lets the lock go while f waits on the outside world, as an `await` let other code run.
func await(f func()) {
	mu.Unlock()
	defer mu.Lock()
	f()
}

func sleep(d time.Duration) { await(func() { time.Sleep(d) }) }

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stdout, "%s %s\n", isoTime(nowMs()), fmt.Sprintf(format, a...))
}

// logLine is console.log(new Date().toISOString(), ...a).
func logLine(a ...any) {
	parts := make([]string, len(a))
	for i, x := range a {
		switch v := x.(type) {
		case error:
			parts[i] = v.Error()
		default:
			parts[i] = fmt.Sprint(v)
		}
	}
	fmt.Fprintln(os.Stdout, isoTime(nowMs())+" "+strings.Join(parts, " "))
}

func errorLine(s string) { fmt.Fprintln(os.Stderr, s) }

// locked runs f with the lock, catching what it throws (logged), as a timer callback or a promise that nobody awaits.
func locked(what string, f func()) {
	mu.Lock()
	defer mu.Unlock()
	if err := tryLog(f); err != nil {
		logLine("error", what, err)
	}
}

func tryLog(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
			if _, ok := r.(*Refuse); !ok {
				if _, ok := r.(*jsError); !ok {
					log.Printf("panic: %v\n%s", r, debug.Stack())
				}
			}
		}
	}()
	f()
	return nil
}

// goLocked starts f later with the lock: `void promise()`.
func goLocked(what string, f func()) { go locked(what, f) }

// Timer is a setTimeout handle.
type Timer struct {
	t       *time.Timer
	stopped bool
}

func setTimeout(d time.Duration, f func()) *Timer {
	h := &Timer{}
	h.t = time.AfterFunc(d, func() {
		mu.Lock()
		defer mu.Unlock()
		if h.stopped {
			return
		}
		h.stopped = true
		if err := tryLog(f); err != nil {
			logLine("error", "timer", err)
		}
	})
	return h
}

func clearTimeout(h *Timer) {
	if h != nil {
		h.stopped = true
		h.t.Stop()
	}
}

func setInterval(d time.Duration, f func()) {
	go func() {
		t := time.NewTicker(d)
		for range t.C {
			locked("interval", f)
		}
	}()
}

// parallel runs each f at once (each takes the lock in turn, letting it go where it awaits) and waits for all:
// Promise.all.
func parallel(fs ...func()) {
	var wg sync.WaitGroup
	wg.Add(len(fs))
	for _, f := range fs {
		go func() {
			defer wg.Done()
			locked("parallel", f)
		}()
	}
	await(wg.Wait)
}

// ---------- requests and responses ----------

// Req is an incoming request as the handlers read it (Node's IncomingMessage).
type Req struct {
	Method      string
	URL         *url.URL
	RawURL      string
	Header      http.Header
	internal    bool
	body        io.Reader
	preset      []byte
	hasPreset   bool
	remote      string
	movedCb     *string
	origin      string // this request's origin among the server's (origins.extra, REQ-F-815), "" when only one
	trusted     bool   // the trusted proxy vouched for this request (REQ-F-814)
	headerUid   string // and for this person
	httpVersion string
	r           *http.Request
}

func newReq(r *http.Request) *Req {
	u := *r.URL
	return &Req{Method: r.Method, URL: &u, RawURL: r.RequestURI, Header: r.Header, body: r.Body, remote: r.RemoteAddr, httpVersion: fmt.Sprintf("%d.%d", r.ProtoMajor, r.ProtoMinor), r: r}
}

// internalReq is the request a route makes for another route (sessionOp).
func internalReq(method string, body any) *Req {
	return &Req{Method: method, Header: http.Header{}, internal: true, preset: jsonBytes(body), hasPreset: true}
}

// H is req.headers[name]: several Cookie headers are one, joined by '; ', as Node joins them.
func (q *Req) H(name string) string {
	vals := q.Header.Values(name)
	if len(vals) == 0 {
		return ""
	}
	if strings.EqualFold(name, "cookie") {
		return strings.Join(vals, "; ")
	}
	return strings.Join(vals, ", ")
}

func (q *Req) Has(name string) bool { return len(q.Header.Values(name)) > 0 }

// readAll reads the body up to limit bytes, with the lock let go meanwhile.
func (q *Req) readAll(limit int) []byte {
	if q.hasPreset {
		if len(q.preset) > limit {
			refuse(413, "요청이 너무 큽니다")
		}
		return q.preset
	}
	var out []byte
	var tooBig bool
	await(func() {
		if q.body == nil {
			return
		}
		b, _ := io.ReadAll(io.LimitReader(q.body, int64(limit)+1))
		if len(b) > limit {
			tooBig = true
			return
		}
		out = b
	})
	if tooBig {
		refuse(413, "요청이 너무 큽니다")
	}
	q.preset = out
	q.hasPreset = true
	return out
}

// Res is a response put together under the lock and written out after it (Node's ServerResponse).
type Res struct {
	status      int
	header      http.Header
	setHeaders  http.Header
	body        []byte
	headersSent bool
	ended       bool
	file        *fileSend
	stream      *Stream
	pipe        func(w http.ResponseWriter, r *http.Request)
	req         *Req
}

type fileSend struct {
	path       string
	start, end int64
	ranged     bool
}

func newRes(req *Req) *Res { return &Res{header: http.Header{}, setHeaders: http.Header{}, req: req} }

// SetHeader is res.setHeader: kept unless writeHead names the same header.
func (r *Res) SetHeader(k string, v ...string) { r.setHeaders[http.CanonicalHeaderKey(k)] = v }

// WriteHead is res.writeHead(status, headers). A header's value may be a string, a number or a list.
func (r *Res) WriteHead(status int, h ...M) *Res {
	r.status = status
	r.headersSent = true
	for k, v := range r.setHeaders {
		r.header[k] = v
	}
	for _, m := range h {
		for k, v := range m {
			ck := http.CanonicalHeaderKey(k)
			switch x := v.(type) {
			case string:
				r.header[ck] = []string{x}
			case []string:
				if len(x) == 0 {
					delete(r.header, ck)
				} else {
					r.header[ck] = x
				}
			case int:
				r.header[ck] = []string{strconv.Itoa(x)}
			case int64:
				r.header[ck] = []string{strconv.FormatInt(x, 10)}
			case float64:
				r.header[ck] = []string{numStr(x)}
			case nil:
			default:
				r.header[ck] = []string{fmt.Sprint(x)}
			}
		}
	}
	return r
}

func (r *Res) End(b ...[]byte) {
	if !r.headersSent {
		r.WriteHead(200)
	}
	r.ended = true
	if len(b) > 0 {
		r.body = append(r.body, b[0]...)
	}
}

func (r *Res) EndS(s string) { r.End([]byte(s)) }

// flush writes what was put together to the network. Called without the lock.
func (r *Res) flush(w http.ResponseWriter, hr *http.Request) {
	if r.pipe != nil {
		r.pipe(w, hr)
		return
	}
	if !r.headersSent {
		r.WriteHead(200)
	}
	h := w.Header()
	for k, v := range r.header {
		h[k] = v
	}
	if r.stream != nil {
		r.stream.run(w, hr, r.status)
		return
	}
	if r.file != nil {
		f, err := os.Open(r.file.path)
		if err != nil {
			w.WriteHeader(r.status)
			return
		}
		defer f.Close()
		w.WriteHeader(r.status)
		if r.file.ranged {
			_, _ = f.Seek(r.file.start, io.SeekStart)
			_, _ = io.CopyN(w, f, r.file.end-r.file.start+1)
		} else {
			_, _ = io.Copy(w, f)
		}
		return
	}
	if _, ok := h["Content-Length"]; !ok && hr.Method != "HEAD" {
		h.Set("Content-Length", strconv.Itoa(len(r.body)))
	}
	w.WriteHeader(r.status)
	if hr.Method != "HEAD" {
		_, _ = w.Write(r.body)
	}
}

func gzipBytes(b []byte, level int) []byte {
	var buf strings.Builder
	zw, _ := gzip.NewWriterLevel(&buf, level)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return []byte(buf.String())
}

// ---------- event streams ----------

// Sink is where commands for a Mac go: a bridge tab's event stream, or the demo Mac in its place.
type Sink interface {
	Write(chunk string) bool
	End(chunk string)
	Pending() int
}

// Stream is an open text/event-stream response. Writes queue up (never block the lock) and a goroutine sends them.
type Stream struct {
	smu        sync.Mutex
	cond       *sync.Cond
	queue      []string
	queued     int
	ended      bool
	gone       bool
	onClose    func()
	closedOnce sync.Once
	lastState  *stateSnap
	wantsDelta bool
	pingEvery  time.Duration
	cut        func() // makes a write that is stuck on a client that stopped reading give up
}

// STREAM_BACKLOG_MAX: what may wait for a client that stopped reading (REQ-S-087). Past it the stream is closed and
// the page's EventSource opens a fresh one, which starts from the whole state again.
const STREAM_BACKLOG_MAX = 64 << 20

func newStream(onClose func()) *Stream {
	s := &Stream{onClose: onClose, pingEvery: 20 * time.Second}
	s.cond = sync.NewCond(&s.smu)
	return s
}

func (s *Stream) Write(chunk string) bool {
	s.smu.Lock()
	defer s.smu.Unlock()
	if s.ended || s.gone {
		return false
	}
	if s.queued > 0 && s.queued+len(chunk) > STREAM_BACKLOG_MAX {
		s.queue = nil
		s.queued = 0
		s.gone = true
		if s.cut != nil {
			s.cut()
		}
		s.cond.Signal()
		return false
	}
	s.queue = append(s.queue, chunk)
	s.queued += len(chunk)
	s.cond.Signal()
	return true
}

func (s *Stream) Pending() int {
	s.smu.Lock()
	defer s.smu.Unlock()
	return s.queued
}

// End writes a last chunk and closes the response.
func (s *Stream) End(chunk string) {
	s.smu.Lock()
	defer s.smu.Unlock()
	if s.ended {
		return
	}
	if chunk != "" && !s.gone {
		s.queue = append(s.queue, chunk)
	}
	s.ended = true
	s.cond.Signal()
}

// run sends the stream until it is ended or the client goes, then calls onClose with the lock, as the request's
// 'close' event did.
func (s *Stream) run(w http.ResponseWriter, hr *http.Request, status int) {
	rc := http.NewResponseController(w)
	s.smu.Lock()
	s.cut = func() { _ = rc.SetWriteDeadline(time.Now()) }
	s.smu.Unlock()
	w.WriteHeader(status)
	_ = rc.Flush()
	done := make(chan struct{})
	go func() {
		select {
		case <-hr.Context().Done():
		case <-done:
		}
		s.smu.Lock()
		s.gone = true
		s.cond.Signal()
		s.smu.Unlock()
	}()
	ticker := time.NewTicker(s.pingEvery)
	go func() {
		for {
			select {
			case <-ticker.C:
				s.Write(": ping\n\n")
			case <-done:
				return
			}
		}
	}()
	for {
		s.smu.Lock()
		for len(s.queue) == 0 && !s.ended && !s.gone {
			s.cond.Wait()
		}
		if s.gone {
			s.smu.Unlock()
			break
		}
		q := s.queue
		s.queue = nil
		s.queued = 0
		ended := s.ended
		s.smu.Unlock()
		var err error
		for _, c := range q {
			if _, err = io.WriteString(w, c); err != nil {
				break
			}
		}
		if err == nil {
			err = rc.Flush()
		}
		if err != nil || ended {
			break
		}
	}
	ticker.Stop()
	close(done)
	s.smu.Lock()
	s.gone = true
	s.smu.Unlock()
	s.closedOnce.Do(func() {
		if s.onClose != nil {
			go locked("stream close", s.onClose)
		}
	})
}

// ---------- the raw connection, for the preview's WebSocket ----------

func hijack(w http.ResponseWriter) (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("no hijack")
	}
	return hj.Hijack()
}
