package main

import (
	"net/url"
	"strings"
	"testing"
)

// AC-1659 (REQ-F-881): the rules keep valid hosts and modes only, one per host; 미리보기 is for a Mac's own address.
func TestCleanLinkRules(t *testing.T) {
	got := cleanLinkRules([]any{
		M{"host": "Example.COM.", "mode": "snapshot"},
		M{"host": "localhost", "mode": "preview"},
		M{"host": "example.com", "mode": "browser"},
		M{"host": "a.example.com", "mode": "preview"},
		M{"host": "https://x.com/", "mode": "read"},
		M{"host": "x.com", "mode": "fly"},
		M{"host": "", "mode": "read"},
	})
	jeq(t, got, `[{"host":"example.com","mode":"browser"},{"host":"localhost","mode":"preview"}]`)
}

// AC-1659: saving replaces the account's rules; /api/me hands them over; a wrong rule refuses the whole save.
func TestLinkRulesAPI(t *testing.T) {
	_ = withConfigServer(t)
	code, body := callAPI(t, "POST", "/api/prefs/linkrules", `{"rules":[{"host":"x.com","mode":"snapshot"},{"host":"localhost","mode":"preview"}]}`)
	eq(t, code, 200, body)
	code, body = callAPI(t, "GET", "/api/prefs/linkrules", "")
	eq(t, code, 200)
	jeq(t, oget(js(body), "rules"), `[{"host":"localhost","mode":"preview"},{"host":"x.com","mode":"snapshot"}]`, body)
	code, body = callAPI(t, "GET", "/api/me", "")
	eq(t, code, 200)
	jeq(t, oget(js(body), "linkRules"), `[{"host":"localhost","mode":"preview"},{"host":"x.com","mode":"snapshot"}]`, body)
	code, msg := callAPI(t, "POST", "/api/prefs/linkrules", `{"rules":[{"host":"x.com","mode":"preview"}]}`)
	eq(t, code, 400, msg)
	ok(t, strings.Contains(msg, "미리보기는 localhost"), msg)
	code, _ = callAPI(t, "POST", "/api/prefs/linkrules", `{}`)
	eq(t, code, 400)
	code, body = callAPI(t, "POST", "/api/prefs/linkrules", `{"rules":[]}`)
	eq(t, code, 200, body)
	jeq(t, oget(js(body), "rules"), `[]`, body)
}

// AC-1660: a snapshot is read as the reader reads a page; the agent's pictures of the page's origin go in as data:,
// anything else it hands over is dropped.
func TestSnapshotPage(t *testing.T) {
	base, _ := url.Parse("http://localhost:3000/app/")
	png := "data:image/png;base64,iVBORw0KGgo="
	html := `<html><head><title>앱</title><script>x()</script></head><body><div id="app"><main><h1>앱</h1><p>스크립트가 그린 본문</p><img src="/a.png"><img src="b.png"><img src="https://cdn.example/c.png"></main></div></body></html>`
	pg := snapshotPage(html, base, M{"http://localhost:3000/a.png": png, "http://localhost:3000/app/b.png": "data:text/html;base64,PHA+"})
	eq(t, pg.Title, "앱")
	got := []string{}
	for _, b := range pg.Blocks {
		got = append(got, b.T+":"+b.Text+b.Src)
	}
	eq(t, strings.Join(got, "|"), "h1:앱|p:스크립트가 그린 본문|img:"+png+"|img:http://localhost:3000/app/b.png|img:https://cdn.example/c.png")
}
