package main

import (
	"strings"
	"testing"
)

// AC-1768: /api/ asked for as a picture, a sheet, a font, a script, a medium or a frame is 403 (the reader's pictures
// and a report's videos from this site excepted), a stream or poll from another site is 403, and a request without
// fetch metadata (the Mac's agent, the iOS app's own requests) or a fetch from this site goes on as before.
func TestFetchMetaGuard(t *testing.T) {
	for _, d := range []string{"image", "style", "font", "script", "audio", "video", "track", "object", "embed", "iframe", "frame", "IMAGE"} {
		for _, s := range []string{"same-origin", "same-site", "cross-site", "none", ""} {
			eq(t, fetchMetaRefusal("GET", "/api/fn", d, s), NOT_A_SUBRESOURCE, d+" "+s)
		}
	}
	// The routes this site's own screens draw as <img>/<video>, from this site only.
	vid := "/api/reports/r1/video/" + strings.Repeat("a", 40) + ".mp4"
	adminVid := "/api/admin/reports/r1/video/" + strings.Repeat("b", 40) + ".webm"
	for _, c := range [][2]string{{"/api/read/img", "image"}, {vid, "video"}, {adminVid, "video"}} {
		eq(t, fetchMetaRefusal("GET", c[0], c[1], "same-origin"), "", c[0])
		eq(t, fetchMetaRefusal("GET", c[0], c[1], "cross-site"), NOT_A_SUBRESOURCE, c[0])
		eq(t, fetchMetaRefusal("GET", c[0], "style", "same-origin"), NOT_A_SUBRESOURCE, c[0])
	}
	eq(t, fetchMetaRefusal("GET", "/api/reports/r1/img/x.png", "image", "same-origin"), NOT_A_SUBRESOURCE)
	// What this site's screens do: fetch() and EventSource (empty), a link or a sign-in (document), a worker.
	for _, d := range []string{"empty", "document", "", "worker"} {
		eq(t, fetchMetaRefusal("GET", "/api/me", d, "same-origin"), "", d)
		eq(t, fetchMetaRefusal("POST", "/api/sessions", d, "same-origin"), "", d)
	}
	eq(t, fetchMetaRefusal("GET", "/api/auth/github", "document", "cross-site"), "")
	// Not /api/: the pages, scripts and pictures of the site itself.
	eq(t, fetchMetaRefusal("GET", "/assets/a.js", "script", "same-origin"), "")
	eq(t, fetchMetaRefusal("GET", "/icon.svg", "image", "cross-site"), "")
	// A GET that changes something: from this site, or without metadata, only.
	for _, p := range []string{"/api/classic/stream", "/api/classic/poll", "/api/bridge/stream", "/api/bridge/poll"} {
		eq(t, fetchMetaRefusal("GET", p, "empty", "same-origin"), "", p)
		eq(t, fetchMetaRefusal("GET", p, "", ""), "", p)
		for _, s := range []string{"same-site", "cross-site", "none"} {
			eq(t, fetchMetaRefusal("GET", p, "empty", s), "다른 출처의 요청입니다", p+" "+s)
		}
	}
	eq(t, fetchMetaRefusal("GET", "/api/me", "empty", "cross-site"), "")

	// Through route(): before anything else of /api/.
	withSlotServer(t, "")
	code, _, body := routeAt(t, "GET", "/api/health", "127.0.0.1:1", map[string]string{"Sec-Fetch-Dest": "image", "Sec-Fetch-Site": "same-origin"})
	eq(t, code, 403, body)
	ok(t, strings.Contains(body, NOT_A_SUBRESOURCE), body)
	code, _, body = routeAt(t, "GET", "/api/health", "127.0.0.1:1", map[string]string{"Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "same-origin"})
	eq(t, code, 200, body)
	code, _, body = routeAt(t, "GET", "/api/health", "127.0.0.1:1", nil)
	eq(t, code, 200, body)
	code, _, body = routeAt(t, "GET", "/api/classic/poll?pid=abc", "127.0.0.1:1", map[string]string{"Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "cross-site"})
	eq(t, code, 403, body)
	// Without metadata it reaches the sign-in check as before.
	code, _, body = routeAt(t, "GET", "/api/classic/poll?pid=abc", "127.0.0.1:1", nil)
	eq(t, code, 401, body)
	code, _, body = routeAt(t, "GET", "/api/read/img?u=https%3A%2F%2Fe.example%2Fa.png", "127.0.0.1:1", map[string]string{"Sec-Fetch-Dest": "image", "Sec-Fetch-Site": "same-origin"})
	eq(t, code, 401, body)
}

// AC-1765: /api/me names the previews' origins, so a snapshot keeps no link to them.
func TestMePreviewOrigins(t *testing.T) {
	_ = withConfigServer(t)
	keep := preview
	t.Cleanup(func() { preview = keep })
	preview = &Preview{ORIGINS: []string{"https://lp.example.com", "https://lp1-bridge.example.com"}}
	code, body := callAPI(t, "GET", "/api/me", "")
	eq(t, code, 200, body)
	jeq(t, oget(js(body), "previewOrigins"), `["https://lp.example.com","https://lp1-bridge.example.com"]`, body)
}
