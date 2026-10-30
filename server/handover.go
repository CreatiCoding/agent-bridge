// Replacing the server without a gap (server/handover.mjs). Two copies of the server share one data folder for a
// few seconds while a deploy swaps them. The files and their fields are the ones the Node server wrote, so a Node
// server and this one hand over to each other either way.
package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const (
	HO_ALIVE_MS  = 1500
	HO_GONE_MS   = 5000
	HO_ANSWER_MS = 20_000
	HO_READY_MS  = 25_000
	HO_POLL_MS   = 150
	HO_LINGER_MS = 8000
)

type hoTarget struct {
	host string
	port float64
}

type Handover struct {
	id         string
	dir        string
	aliveFile  string
	talkFile   string
	secret     string
	smu        sync.Mutex
	state      string
	target     *hoTarget
	waiting    chan struct{}
	tookOver   bool
	carriedVal M
}

func hoRead(file string) M {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	v, err := parseJSON(b)
	if err != nil {
		return nil
	}
	m, _ := v.(M)
	return m
}

func hoWrite(file string, v any) {
	tmp := file + "." + strconv.Itoa(os.Getpid()) + "." + randHex(4) + ".tmp"
	if os.WriteFile(tmp, jsonBytes(v), 0o600) == nil {
		_ = os.Rename(tmp, file)
	}
}

func createHandover(dir string) *Handover {
	h := &Handover{id: randHex(6), dir: dir, aliveFile: filepath.Join(dir, "instance.json"), talkFile: filepath.Join(dir, "handover.json"), state: "running"}
	secretFile := filepath.Join(dir, "handover.secret")
	_ = os.MkdirAll(dir, 0o777)
	if f, err := os.OpenFile(secretFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
		_, _ = f.WriteString(randHex(24))
		_ = f.Close()
	}
	if b, err := os.ReadFile(secretFile); err == nil {
		h.secret = jsTrim(string(b))
	} else {
		h.secret = randHex(24)
	}
	return h
}

func (h *Handover) getState() string {
	h.smu.Lock()
	defer h.smu.Unlock()
	return h.state
}

// takeOver: before any state is read. Whether a live server handed its state over.
func (h *Handover) takeOver() bool {
	_ = os.MkdirAll(h.dir, 0o777)
	other := hoRead(h.aliveFile)
	if other == nil || other["id"] == h.id || float64(nowMs())-jsNumber(other["at"]) > HO_GONE_MS {
		return false
	}
	otherID := jsString(other["id"])
	logLine("handover: asking the running server (" + otherID + ") for the state")
	hoWrite(h.talkFile, orderedObj{{"step", "request"}, {"from", h.id}, {"to", otherID}, {"at", nowMs()}})
	until := nowMs() + HO_ANSWER_MS
	for nowMs() < until {
		time.Sleep(HO_POLL_MS * time.Millisecond)
		t := hoRead(h.talkFile)
		if t != nil && t["step"] == "done" && t["to"] == h.id {
			logLine("handover: the running server wrote its state and stopped writing")
			h.carriedVal, _ = t["carry"].(M)
			h.tookOver = true
			return true
		}
		alive := hoRead(h.aliveFile)
		if alive == nil || alive["id"] != otherID || float64(nowMs())-jsNumber(alive["at"]) > HO_GONE_MS {
			logLine("handover: the running server is gone; starting from what is on disk")
			return false
		}
	}
	logLine("handover: no answer from the running server; starting from what is on disk")
	return false
}

func hoAddresses() []any {
	out := []any{}
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil {
				out = append(out, n.IP.To4().String())
			}
		}
	}
	return out
}

func hoProbe(host string, port float64) any {
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get("http://" + net.JoinHostPort(host, numStr(port)) + "/api/health")
	if err != nil {
		return nil
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	v, err := parseJSON(b)
	if err != nil {
		return nil
	}
	return mget(v, "instance")
}

type hoHooks struct {
	port   int
	drain  func() M
	resume func()
	cut    func()
}

// serve: after the server listens. Says "alive", and gives the state away when a newer server asks.
func (h *Handover) serve(hooks hoHooks) {
	beat := func() {
		if h.getState() != "proxy" {
			hoWrite(h.aliveFile, orderedObj{{"id", h.id}, {"at", nowMs()}, {"pid", os.Getpid()}})
		}
	}
	beat()
	go func() {
		for range time.Tick(HO_ALIVE_MS * time.Millisecond) {
			beat()
		}
	}()
	if h.tookOver {
		hoWrite(h.talkFile, orderedObj{{"step", "ready"}, {"from", h.id}, {"addrs", hoAddresses()}, {"port", hooks.port}, {"at", nowMs()}})
	}
	go func() {
		for range time.Tick(HO_POLL_MS * 2 * time.Millisecond) {
			if h.getState() != "running" {
				continue
			}
			t := hoRead(h.talkFile)
			if t == nil || t["step"] != "request" || t["to"] != h.id || float64(nowMs())-jsNumber(t["at"]) > HO_ANSWER_MS {
				continue
			}
			from := jsString(t["from"])
			h.smu.Lock()
			h.state = "draining"
			h.waiting = make(chan struct{})
			h.smu.Unlock()
			logLine("handover: a newer server (" + from + ") asked for the state; finishing and writing it")
			var carry M
			if err := tryLog(func() { carry = hooks.drain() }); err != nil {
				logLine("handover: drain failed", err)
			}
			var c any
			if carry != nil {
				c = carry
			}
			hoWrite(h.talkFile, orderedObj{{"step", "done"}, {"from", h.id}, {"to", from}, {"at", nowMs()}, {"carry", c}})
			until := nowMs() + HO_READY_MS
			moved := false
			for nowMs() < until && !moved {
				time.Sleep(HO_POLL_MS * time.Millisecond)
				r := hoRead(h.talkFile)
				if r == nil || r["step"] != "ready" || r["from"] != from {
					continue
				}
				for _, a := range asArr(r["addrs"]) {
					host := jsString(a)
					port := jsNumber(r["port"])
					if hoProbe(host, port) != from {
						continue
					}
					h.smu.Lock()
					h.target = &hoTarget{host, port}
					h.state = "proxy"
					close(h.waiting)
					h.smu.Unlock()
					logLine("handover: the new server is up at " + host + ":" + numStr(port) + "; passing requests on to it")
					hooks.cut()
					moved = true
					break
				}
			}
			if moved {
				return
			}
			logLine("handover: the new server did not come up; taking the state back")
			hooks.resume()
			h.smu.Lock()
			h.state = "running"
			close(h.waiting)
			h.smu.Unlock()
			beat()
		}
	}()
}

// bye: on exit, the alive file goes unless a newer server owns the folder now.
func (h *Handover) bye() {
	if h.getState() != "proxy" {
		if a := hoRead(h.aliveFile); a != nil && a["id"] == h.id {
			_ = os.Remove(h.aliveFile)
		}
	}
}

var hopHeaders = []string{"Connection", "Keep-Alive", "Proxy-Connection", "Transfer-Encoding", "Upgrade", "Te", "Trailer"}

// intercept: first thing for every request, without the lock. True when the request was passed on to the new server.
func (h *Handover) intercept(w http.ResponseWriter, r *http.Request) bool {
	fromOld := false
	if v := r.Header.Get("x-bridge-handover"); v != "" && v == h.secret {
		r.Header.Del("x-bridge-handover")
		fromOld = true
	}
	acceptPeer(r, fromOld, h.secret, h.carriedVal["peerHeader"] == true)
	if fromOld {
		return false
	}
	h.smu.Lock()
	st, wait := h.state, h.waiting
	h.smu.Unlock()
	if st == "running" {
		return false
	}
	if st == "draining" {
		<-wait
	}
	h.smu.Lock()
	st, target := h.state, h.target
	h.smu.Unlock()
	if st != "proxy" {
		return false
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, "http://"+net.JoinHostPort(target.host, numStr(target.port))+r.RequestURI, r.Body)
	if err != nil {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(502)
		return true
	}
	for k, v := range r.Header {
		out.Header[k] = v
	}
	for _, k := range hopHeaders {
		out.Header.Del(k)
	}
	out.Host = r.Host
	out.ContentLength = r.ContentLength
	out.Header.Set("x-bridge-handover", h.secret)
	peer := r.Header.Get(PEER_OK_HEADER) // passed on once already: keep the first peer
	if peer == "" {
		peer = r.RemoteAddr
	}
	out.Header.Del(PEER_OK_HEADER)
	out.Header.Set(PEER_HEADER, peer)
	out.Header.Set(PEER_SIG_HEADER, peerSig(h.secret, peer))
	tr := &http.Transport{DisableCompression: true, Proxy: nil}
	resp, err := tr.RoundTrip(out)
	if err != nil {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(502)
		return true
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	for _, k := range hopHeaders {
		w.Header().Del(k)
	}
	w.WriteHeader(resp.StatusCode)
	rc := http.NewResponseController(w)
	buf := make([]byte, 32*1024)
	for {
		n, e := resp.Body.Read(buf)
		if n > 0 {
			if _, we := w.Write(buf[:n]); we != nil {
				break
			}
			_ = rc.Flush()
		}
		if e != nil {
			break
		}
	}
	return true
}

func (h *Handover) linger() int {
	if h.getState() == "running" {
		return 0
	}
	return HO_LINGER_MS
}

func (h *Handover) carried() M { return h.carriedVal }
