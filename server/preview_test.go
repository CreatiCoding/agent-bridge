// From test/unit/preview (the server part, R1-M6 and after): the local preview proxy, without a server; a pretend Mac
// answers its `http` command.
package main

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

type pvSetup struct {
	p     *Preview
	used  []string
	asked []M
}

func okAnswer(body string) func(string, M, int64) M {
	return func(string, M, int64) M {
		return M{"ok": true, "status": 200.0, "headers": []any{[]any{"content-type", "text/html"}}, "body": body}
	}
}

func newPV(t *testing.T, closed map[string]bool) *pvSetup {
	s := &pvSetup{}
	s.p = createPreview(t.TempDir(), "https://bridge.test", 0, func(uid, hostID, sid string) string {
		s.used = append(s.used, sid)
		if closed[sid] {
			return "세션이 끝났어요"
		}
		return ""
	})
	s.p.askFn = func(h string, cmd M, _ int64) M {
		s.asked = append(s.asked, cmd)
		return okAnswer("PHA+YXBwPC9wPg==")(h, cmd, 0)
	}
	return s
}

// pvGet: GET path on host through p.handle, as the server's handler calls it (with the lock).
func pvGet(p *Preview, host, path string, headers map[string]string) *Res {
	r := httptest.NewRequest("GET", path, nil)
	r.Host = host
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	req := newReq(r)
	res := newRes(req)
	withLock(func() { p.handle(req, res) })
	return res
}

func pvURL(p *Preview, uid, host string, port float64, sid string) *url.URL {
	var s string
	withLock(func() { s = p.url(uid, host, port, sid) })
	u, _ := url.Parse(s)
	return u
}

func pvMint(p *Preview, sid string) string {
	var s string
	withLock(func() { s = p.mint("u1", "h1", 5173, sid) })
	return s
}

func pvProbe(p *Preview) []string {
	withLock(p.probePool)
	return append([]string{}, p.pool...)
}

func TestPreviewNoReferer(t *testing.T) {
	s := newPV(t, nil)
	res := pvGet(s.p, "lp.bridge.test", "/t/"+pvMint(s.p, "s1")+"/", nil)
	eq(t, res.status, 200)
	eq(t, res.header.Get("Referrer-Policy"), "same-origin")
}

func TestPreviewOnlyWhileSessionLives(t *testing.T) {
	s := newPV(t, map[string]bool{"s-gone": true})
	live := pvGet(s.p, "lp.bridge.test", "/t/"+pvMint(s.p, "s1")+"/", nil)
	eq(t, live.status, 200)
	jeq(t, s.used, `["s1"]`)
	gone := pvGet(s.p, "lp.bridge.test", "/t/"+pvMint(s.p, "s-gone")+"/", nil)
	eq(t, gone.status, 503)
}

func TestPreviewWebSocketOrigin(t *testing.T) {
	s := newPV(t, nil)
	token := pvMint(s.p, "s1")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.p.upgrade(w, r) }))
	defer srv.Close()
	first := func(origin string) string {
		c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		o := ""
		if origin != "" {
			o = "Origin: " + origin + "\r\n"
		}
		_, _ = c.Write([]byte("GET /t/" + token + "/ HTTP/1.1\r\nHost: lp.bridge.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n" + o + "\r\n"))
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		line, _ := bufio.NewReader(c).ReadString('\n')
		return line
	}
	ok(t, strings.HasPrefix(first("https://evil.test"), "HTTP/1.1 403"))
	ok(t, strings.HasPrefix(first(""), "HTTP/1.1 403"))
}

// R3-L1 (리포트 #3): the hand-over secret a passed-on request carries must not reach the previewed local app.
func TestPreviewDropsHandoverHeader(t *testing.T) {
	s := newPV(t, nil)
	res := pvGet(s.p, "lp.bridge.test", "/t/"+pvMint(s.p, "s1")+"/", map[string]string{"x-bridge-handover": "secret"})
	eq(t, res.status, 200)
	_, has := asM(s.asked[0]["headers"])["x-bridge-handover"]
	ok(t, !has)
}

// R1-M6: each session's previews on one origin of a pool; a token works only on its own origin.
func TestPreviewPool(t *testing.T) {
	c := poolCandidates("https://bridge.example.com")
	jeq(t, c[:2], `["https://lp1-bridge.example.com", "https://lp2-bridge.example.com"]`)
	eq(t, len(poolCandidates("http://localhost:4300")), 0)
	reach := map[string]bool{"https://lp3-bridge.test": true, "https://lp5-bridge.test": true}
	p := createPreview(t.TempDir(), "https://bridge.test", 0, func(string, string, string) string { return "" })
	p.askFn = okAnswer("")
	p.probeFn = func(o string) bool { return reach[o] }
	// Before the pool is known: the main origin, as before.
	ok(t, regexp.MustCompile(`^https://lp\.bridge\.test/t/`).MatchString(pvURL(p, "u1", "h1", 1, "s-a").String()))
	jeq(t, pvProbe(p), `["https://lp3-bridge.test", "https://lp5-bridge.test"]`)
	hostSet := map[string]bool{}
	for i := 0; i < 20; i++ {
		hostSet[pvURL(p, "u1", "h1", 1, "s-"+itoa(i)).Host] = true
	}
	hosts := []string{}
	for h := range hostSet {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	jeq(t, hosts, `["lp3-bridge.test", "lp5-bridge.test"]`, "세션들이 묶음 안에서 나뉨")
	u := pvURL(p, "u1", "h1", 1, "s-x")
	eq(t, pvURL(p, "u1", "h1", 2, "s-x").Host, u.Host, "같은 세션은 같은 출처")
	on := func(host string) int { return pvGet(p, host, u.EscapedPath(), nil).status }
	eq(t, on(u.Host), 200)
	eq(t, on("lp.bridge.test"), 403, "다른 출처에서는 그 토큰이 통하지 않음")
	other := ""
	for _, h := range hosts {
		if h != u.Host {
			other = h
		}
	}
	eq(t, on(other), 403)
	// R5-L3: the probe's answer is for its one-time number only; nothing without one.
	robots := func(q string) string { return pvGet(p, u.Host, "/robots.txt"+q, nil).header.Get("X-Bridge-Preview") }
	eq(t, robots(""), "")
	a1 := robots("?n=" + strings.Repeat("a", 24))
	a2 := robots("?n=" + strings.Repeat("b", 24))
	ok(t, a1 != "" && a2 != "" && a1 != a2)
}

func clockPV(t *testing.T, dir string, clock *float64) *Preview {
	p := createPreview(dir, "https://bridge.test", 0, func(string, string, string) string { return "" })
	p.askFn = func(string, M, int64) M { return M{"ok": true, "status": 200.0, "headers": []any{}, "body": ""} }
	p.probeFn = func(o string) bool { return regexp.MustCompile(`lp[1-3]-`).MatchString(o) }
	if clock != nil {
		p.nowFn = func() float64 { return *clock }
	}
	return p
}

// R5 의 R1-M6, R7-M2: sessions get origins no other session holds; a token works only while its session holds the
// origin it names; the hold outlives a restart.
func TestPreviewHolds(t *testing.T) {
	dir := t.TempDir()
	clock := 1_000_000.0
	p := clockPV(t, dir, &clock)
	pvProbe(p)
	tick := func() { clock += 120_000 }
	link := func(sid string) *url.URL { tick(); return pvURL(p, "u", "h", 1, sid) }
	status := func(q *Preview, u *url.URL) int { return pvGet(q, u.Host, u.EscapedPath(), nil).status }
	a, b, c := link("a"), link("b"), link("c")
	eq(t, len(map[string]bool{a.Host: true, b.Host: true, c.Host: true}), 3, "세 세션이 세 출처")
	eq(t, link("a").Host, a.Host, "같은 세션은 같은 출처")
	tick()
	eq(t, status(p, c), 200, "c 를 씀")
	d := link("d")
	eq(t, d.Host, b.Host)
	eq(t, status(p, b), 403, "넘겨준 출처에서 옛 토큰은 안 통함")
	eq(t, status(p, d), 200)
	time.Sleep(1200 * time.Millisecond)
	q := clockPV(t, dir, &clock)
	pvProbe(q)
	eq(t, status(q, d), 200, "재시작 뒤에도 d 의 주소")
	eq(t, status(q, b), 403)
	tick()
	eq(t, pvURL(q, "u", "h", 1, "a").Host, a.Host, "재시작 뒤에도 a 는 같은 출처")
}

// R7-L2 (리포트 #7): the probe's answer is bound to the host it was asked as.
func TestPreviewProbePerHost(t *testing.T) {
	p := createPreview(t.TempDir(), "https://bridge.test", 0, func(string, string, string) string { return "" })
	p.probeFn = func(string) bool { return true }
	askH := func(host string) string {
		return pvGet(p, host, "/robots.txt?n="+strings.Repeat("c", 24), nil).header.Get("X-Bridge-Preview")
	}
	main, one := askH("lp.bridge.test"), askH("lp1-bridge.test")
	ok(t, main != "" && one != "" && main != one)
}

// R8-L1 (리포트 #8): two servers over one data folder keep each other's holds.
func TestPreviewTwoServers(t *testing.T) {
	dir := t.TempDir()
	oldOne, newOne := clockPV(t, dir, nil), clockPV(t, dir, nil)
	pvProbe(oldOne)
	pvProbe(newOne)
	a := pvURL(oldOne, "u", "h", 1, "sA")
	time.Sleep(1200 * time.Millisecond)
	pvURL(newOne, "u", "h", 1, "sB")
	time.Sleep(1200 * time.Millisecond)
	b, _ := os.ReadFile(filepath.Join(dir, "preview-given.json"))
	saved := asM(js(string(b)))
	ok(t, saved["sA"] != nil && saved["sB"] != nil, "두 서버의 배정이 모두 남음")
	third := clockPV(t, dir, nil)
	pvProbe(third)
	eq(t, pvGet(third, a.Host, a.EscapedPath(), nil).status, 200, "옛 서버가 준 주소가 다음 서버에서도 통함")
}

// R9-M1 (리포트 #9): an evicted session's address stays dead after the holds are saved again.
func TestPreviewEvictedStaysDead(t *testing.T) {
	clock := 1_000_000.0
	p := clockPV(t, t.TempDir(), &clock)
	pvProbe(p)
	link := func(sid string) *url.URL { clock += 120_000; return pvURL(p, "u", "h", 1, sid) }
	status := func(u *url.URL) int { return pvGet(p, u.Host, u.EscapedPath(), nil).status }
	link("a")
	b := link("b")
	link("c")
	time.Sleep(1300 * time.Millisecond)
	link("a")
	link("c")
	d := link("d")
	eq(t, d.Host, b.Host)
	eq(t, status(b), 403)
	time.Sleep(1300 * time.Millisecond)
	eq(t, status(b), 403, "다음 저장 뒤에도 쫓겨난 주소는 안 통함")
	eq(t, status(d), 200)
}

// R10-L2 (리포트 #10): a tombstone is undone only by giving the session an origin again, not by a use elsewhere.
func TestPreviewTombstone(t *testing.T) {
	dir := t.TempDir()
	clock := 1_000_000.0
	one := clockPV(t, dir, &clock)
	pvProbe(one)
	link := func(q *Preview, sid string) *url.URL { clock += 120_000; return pvURL(q, "u", "h", 1, sid) }
	status := func(q *Preview, u *url.URL) int { return pvGet(q, u.Host, u.EscapedPath(), nil).status }
	link(one, "a")
	b := link(one, "b")
	link(one, "c")
	time.Sleep(1300 * time.Millisecond)
	two := clockPV(t, dir, &clock)
	pvProbe(two)
	link(one, "a")
	link(one, "c")
	link(one, "d")
	time.Sleep(1300 * time.Millisecond)
	clock += 120_000
	eq(t, status(two, b), 200)
	time.Sleep(1300 * time.Millisecond)
	three := clockPV(t, dir, &clock)
	pvProbe(three)
	eq(t, status(three, b), 403, "사용만으로는 묘비가 되살아나지 않음")
}
