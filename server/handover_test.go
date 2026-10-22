// From test/unit/handover: two servers over one data folder; the state changes hands, and requests to the old one
// reach the new one.
package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type hoLog struct {
	mu sync.Mutex
	ev []string
}

func (l *hoLog) add(s string) { l.mu.Lock(); l.ev = append(l.ev, s); l.mu.Unlock() }
func (l *hoLog) list() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.ev...)
}
func (l *hoLog) has(s string) bool { return contains(l.list(), s) }

type hoServer struct {
	h    *Handover
	srv  *http.Server
	port int
}

func hoStart(t *testing.T, dir, name string, log *hoLog) *hoServer {
	h := createHandover(dir)
	took := h.takeOver()
	if took {
		log.add(name + ":tookOver=true")
	} else {
		log.add(name + ":tookOver=false")
	}
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	s := &hoServer{h: h, port: ln.Addr().(*net.TCPAddr).Port}
	s.srv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			_, _ = w.Write(jsonBytes(M{"instance": h.id}))
			return
		}
		if h.intercept(w, r) {
			return
		}
		_, _ = w.Write([]byte(name))
	})}
	go s.srv.Serve(ln)
	h.serve(hoHooks{port: s.port, drain: func() M { log.add(name + ":drain"); return M{"note": "carried"} }, resume: func() { log.add(name + ":resume") }, cut: func() { log.add(name + ":cut") }})
	return s
}

func hoGet(t *testing.T, port int, headers map[string]string) string {
	t.Helper()
	rq, _ := http.NewRequest("GET", "http://127.0.0.1:"+itoa(port)+"/x", nil)
	for k, v := range headers {
		rq.Header.Set(k, v)
	}
	c := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	r, err := c.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return string(b)
}

func TestHandoverColdStart(t *testing.T) {
	dir := t.TempDir()
	log := &hoLog{}
	t0 := time.Now()
	a := hoStart(t, dir, "a", log)
	defer a.srv.Close()
	ok(t, time.Since(t0) < 500*time.Millisecond)
	jeq(t, log.list(), `["a:tookOver=false"]`)
	eq(t, hoGet(t, a.port, nil), "a")
}

func TestHandoverTakesState(t *testing.T) {
	dir := t.TempDir()
	log := &hoLog{}
	a := hoStart(t, dir, "a", log)
	defer a.srv.Close()
	b := hoStart(t, dir, "b", log)
	defer b.srv.Close()
	ev := log.list()
	eq(t, ev[1], "a:drain", "the old server writes its state before the new one reads it")
	eq(t, ev[2], "b:tookOver=true")
	jeq(t, b.h.carried(), `{"note": "carried"}`)
	// the old server finds the new one and switches to passing requests on
	for i := 0; i < 60 && a.h.getState() != "proxy"; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	eq(t, a.h.getState(), "proxy")
	ok(t, log.has("a:cut"))
	eq(t, hoGet(t, a.port, nil), "b", "a request to the old server is answered by the new one")
	// R1-L4 (리포트 #1): a request that only claims to be passed on is passed on all the same.
	eq(t, hoGet(t, a.port, map[string]string{"x-bridge-handover": "anything"}), "b")
	eq(t, hoGet(t, b.port, nil), "b")
	eq(t, a.h.linger(), 8000)
	eq(t, b.h.linger(), 0)
}

func TestHandoverStoppedServer(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "instance.json"), jsonBytes(M{"id": "gone", "at": float64(nowMs() - 60_000)}), 0o600)
	log := &hoLog{}
	t0 := time.Now()
	b := hoStart(t, dir, "b", log)
	defer b.srv.Close()
	ok(t, time.Since(t0) < 500*time.Millisecond, "no wait for a server that is not alive")
	jeq(t, log.list(), `["b:tookOver=false"]`)
}
