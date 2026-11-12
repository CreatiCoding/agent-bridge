package main

import (
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

// AC-1661 (1.469): a snapshot is asked for with POST; a GET is not a route, a wrong address is refused before the Mac.
func TestSnapshotRoute(t *testing.T) {
	_ = withConfigServer(t)
	code, _ := callAPI(t, "POST", "/api/sessions/nope/snapshot", `{"url":"https://example.com/"}`)
	ok(t, code == 404, "no such session")
}

// AC-1686: a Mac that does not seal answers with the page, not a "sealed" piece of the word "undefined" (1.487).
func TestSnapshotAnswer(t *testing.T) {
	plain := snapshotAnswer(M{"ok": true, "url": "https://www.coupang.com/", "html": "<title>쿠팡</title>", "images": M{"a": "data:image/png;base64,AAAA", "b": "https://x/y.png"}, "via": "ego"}, "https://www.coupang.com/")
	_, has := plain["sealed"]
	ok(t, !has, "no sealed key for a plain answer")
	ok(t, plain["html"] == "<title>쿠팡</title>" && plain["via"] == "ego", "the page passed on")
	ok(t, len(asM(plain["images"])) == 1, "only data: pictures")
	sealed := snapshotAnswer(M{"ok": true, "sealed": "⟦bt1:abcd0123:xyz⟧"}, "https://a/")
	ok(t, sealed["sealed"] == "⟦bt1:abcd0123:xyz⟧" && sealed["html"] == nil, "a sealed piece as it came")
}

// AC-1687: the page's style sheets (text, http(s) addresses) and its width go with the page (1.488).
func TestSnapshotAnswerCSS(t *testing.T) {
	a := snapshotAnswer(M{"ok": true, "html": "<p>a</p>", "css": M{"https://cdn/a.css": ".a{}", "javascript:x": ".b{}", "https://cdn/n.css": 3.0}, "width": 1280.0}, "https://a/")
	css := asM(a["css"])
	ok(t, len(css) == 1 && css["https://cdn/a.css"] == ".a{}", "only text sheets by http(s) address")
	ok(t, a["width"] == 1280, "the page's width")
	b := snapshotAnswer(M{"ok": true, "html": "<p>a</p>", "width": 99999.0}, "https://a/")
	ok(t, b["width"] == 0 && len(asM(b["css"])) == 0, "a width out of range is 0; no sheets is empty")
}

// AC-1770: the sizes of the big pictures the Mac did not send go with the page, only as [width, height] (1.525).
func TestSnapshotAnswerBig(t *testing.T) {
	a := snapshotAnswer(M{"ok": true, "html": "<p>a</p>", "big": M{
		"https://a/x.png":   []any{640.0, 480.0},
		"javascript:alert":  []any{1.0, 1.0},
		"https://a/y.png":   []any{0.0, 10.0},
		"https://a/z.png":   []any{1.5, 10.0},
		"https://a/w.png":   "640x480",
		"https://a/big.png": []any{100001.0, 1.0},
	}}, "https://a/")
	big := asM(a["big"])
	ok(t, len(big) == 1, "only http(s) addresses with two whole sizes 1–100000")
	wh, _ := big["https://a/x.png"].([]any)
	ok(t, len(wh) == 2 && wh[0] == 640 && wh[1] == 480, "the size as it came")
	b := snapshotAnswer(M{"ok": true, "html": "<p>a</p>"}, "https://a/")
	ok(t, len(asM(b["big"])) == 0, "none is empty")
}
