package main

import (
	"net"
	"os"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// AC-1657 (REQ-S-100): only public unicast addresses are fetched.
func TestReaderIPGuard(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "224.0.0.1", "198.18.0.1"} {
		if readerIPOk(net.ParseIP(s)) {
			t.Errorf("%s allowed", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700::1111"} {
		if !readerIPOk(net.ParseIP(s)) {
			t.Errorf("%s refused", s)
		}
	}
	for _, s := range []string{"file:///etc/passwd", "gopher://x/", "http://user:pw@example.com/", "http:///x"} {
		u, _ := url.Parse(s)
		if readerURLOk(u) == nil {
			t.Errorf("%s allowed", s)
		}
	}
}

// AC-1657: a server on this machine is not reached, even when it answers.
func TestReaderRefusesLoopback(t *testing.T) {
	_ = withConfigServer(t)
	hit := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true; w.Write([]byte("<p>secret</p>")) }))
	defer ts.Close()
	code, msg := callAPI(t, "GET", "/api/read?u="+url.QueryEscape(ts.URL+"/"), "")
	if code != 502 || !strings.Contains(msg, "내부망") || hit {
		t.Fatalf("code %d msg %q hit %v", code, msg, hit)
	}
	code, _ = callAPI(t, "GET", "/api/read/img?u="+url.QueryEscape(ts.URL+"/a.png"), "")
	if code != 404 || hit {
		t.Fatalf("img code %d hit %v", code, hit)
	}
	code, _ = callAPI(t, "POST", "/api/read?u=x", "")
	if code != 405 {
		t.Fatalf("post code %d", code)
	}
}

// AC-1656: the page as title and blocks; scripts, styles and the page's chrome dropped; <article> preferred.
func TestReaderParse(t *testing.T) {
	base, _ := url.Parse("https://ex.com/post/1")
	src := `<!doctype html><html><head><title>Old &amp; title</title><meta property="og:site_name" content="Ex"><style>p{}</style><script>alert(1)</script></head>
<body><nav><a href="/">홈</a><p>menu</p></nav><p>outside</p>
<article><h1>제목 <b>하나</b></h1><p>첫  문단<br>둘째 줄 &lt;b&gt;</p><!-- c <p>x</p> -->
<ul><li>하나</li><li>둘</li></ul><img src="/i.png" alt="그림"><img src="data:image/gif;base64,R0" data-src="//cdn.ex.com/l.jpg">
<pre>a  b
  c</pre><blockquote>인용</blockquote><script>evil()</script><p onclick="x()">끝</p><img src="javascript:alert(1)"></article>
<footer><p>footer</p></footer></body></html>`
	pg := readerParse(src, base)
	if pg.Title != "Old & title" || pg.Site != "Ex" {
		t.Fatalf("title %q site %q", pg.Title, pg.Site)
	}
	var got []string
	for _, b := range pg.Blocks {
		got = append(got, b.T+":"+b.Text+":"+b.Src)
	}
	want := []string{"h1:제목 하나:", "p:첫 문단 둘째 줄 <b>:", "li:하나:", "li:둘:", "img:그림:https://ex.com/i.png", "img::https://cdn.ex.com/l.jpg", "pre:a  b\n  c:", "quote:인용:", "p:끝:"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "|"), strings.Join(want, "|"))
	}
}

// A real page, by hand: READER_LIVE_URL=https://… go test -run TestReaderLive -v
func TestReaderLive(t *testing.T) {
	raw := os.Getenv("READER_LIVE_URL")
	if raw == "" {
		t.Skip("READER_LIVE_URL not set")
	}
	_ = withConfigServer(t)
	code, body := callAPI(t, "GET", "/api/read?u="+url.QueryEscape(raw), "")
	if len(body) > 700 {
		body = body[:700]
	}
	t.Logf("%d %s", code, body)
}
