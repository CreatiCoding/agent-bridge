package main

import (
	"regexp"
	"strings"
)

// Fetch metadata (Sec-Fetch-Dest, Sec-Fetch-Site) as a second line under the pages this site draws inside itself (a
// snapshot in a shadow root, REQ-F-881) and under other sites (REQ-S-109, 1.524). A browser sends them; the Mac's
// agent, the iOS app's own requests and older browsers send none, and those go on as before.

// What a page asks for when its markup or styles name an address: never how this site's screens call /api/.
var subresourceDest = map[string]bool{"image": true, "style": true, "font": true, "script": true, "audio": true, "video": true, "track": true, "object": true, "embed": true, "iframe": true, "frame": true}

// The routes this site's own screens load as a picture or a video (<img src>, <video src>), from this site only:
// the reader's pictures (in-app readerImg, imageUrl) and a report's videos (report-sheet, admin). All only read.
var mediaRouteRe = regexp.MustCompile(`^/api/(?:read/img|(?:admin/)?reports/[a-zA-Z0-9-]+/video/[0-9a-f]{40}\.(?:mp4|mov|webm|m4v))$`)

// GET routes that change something: a page's stream or poll (a new one pushes out the oldest, CONTROLS_MAX), a
// bridge tab's, and the pieces of a snapshot (taking them lets the earlier ones go, 1.526).
var stateGetRe = regexp.MustCompile(`^/api/(classic/stream|classic/poll|bridge/stream|bridge/poll|sessions/[a-zA-Z0-9-]+/snapshot/[0-9a-f-]{36})$`)

const NOT_A_SUBRESOURCE = "페이지 안의 그림·스타일·글꼴·틀로는 이 주소를 부를 수 없습니다"

// fetchMetaRefusal says why a request to path is refused by its fetch metadata, or "" when it is not.
func fetchMetaRefusal(method, path, dest, site string) string {
	if !strings.HasPrefix(path, "/api/") {
		return ""
	}
	dest = strings.ToLower(strings.TrimSpace(dest))
	site = strings.ToLower(strings.TrimSpace(site))
	if subresourceDest[dest] {
		media := dest == "image" || dest == "video" || dest == "audio"
		if !(media && site == "same-origin" && mediaRouteRe.MatchString(path)) {
			return NOT_A_SUBRESOURCE
		}
	}
	// Same-site is not enough: a preview (lp.…) is same-site with this site and runs whatever the Mac serves.
	if method == "GET" && site != "" && site != "same-origin" && stateGetRe.MatchString(path) {
		return "다른 출처의 요청입니다"
	}
	return ""
}

func fetchMetaGuard(req *Req, p string) {
	if why := fetchMetaRefusal(req.Method, p, req.H("sec-fetch-dest"), req.H("sec-fetch-site")); why != "" {
		refuse(403, why)
	}
}
