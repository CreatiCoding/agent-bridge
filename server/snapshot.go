package main

// 링크 열기 규칙과 스냅샷 (REQ-F-881): the in-app browser sheet of a touch device (REQ-F-879) opens a link one of
// four ways, chosen per host in the account's rules. 스냅샷 is the reading mode drawn from what the session's Mac
// rendered: its agent opens the address in a headless Chrome of a throwaway profile, lets the page's scripts run,
// and hands back the rendered DOM. The same reader (readerParse) turns it into title, text and pictures, so a page
// a script draws (an SPA, an app on the Mac's localhost) reads as well as a plain one, and still no HTML of the
// page reaches the screen.

import (
	"net/url"
	"regexp"
	"sort"
	"strings"
)

const (
	LINK_RULES_MAX  = 50
	SNAPSHOT_MS     = 45_000 // the agent gives Chrome 30 s
	SNAPSHOT_IMGMAX = 8 << 20
)

var LINK_MODES = []string{"read", "snapshot", "preview", "browser"}

// A host name as a rule names it: lowercase labels, no scheme, port or path. A rule covers its subdomains too.
var linkHostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// 미리보기 is the session's local preview (REQ-F-727): only a Mac's own address can open that way.
var linkLocalHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "0.0.0.0": true}

// cleanLinkRules keeps the valid rules, one per host (the last one given), sorted by host.
func cleanLinkRules(v any) []any {
	by := map[string]string{}
	for _, x := range asArr(v) {
		host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(mstr(x, "host"))), ".")
		mode := mstr(x, "mode")
		if len(host) > 253 || !linkHostRe.MatchString(host) || !containsStr(LINK_MODES, mode) {
			continue
		}
		if mode == "preview" && !linkLocalHosts[host] {
			continue
		}
		by[host] = mode
	}
	hosts := make([]string, 0, len(by))
	for h := range by {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	if len(hosts) > LINK_RULES_MAX {
		hosts = hosts[:LINK_RULES_MAX]
	}
	out := []any{}
	for _, h := range hosts {
		out = append(out, M{"host": h, "mode": by[h]})
	}
	return out
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// GET·POST /api/prefs/linkrules (IF-277): the account's rules, replaced whole on a save.
func apiLinkRules(req *Req, res *Res, uid string, get, post bool) bool {
	if get {
		jsonRes(res, 200, M{"rules": cleanLinkRules(prefsOf(uid)["linkRules"])})
		return true
	}
	if !post {
		refuse(405, "지원하지 않는 요청입니다")
	}
	b := body(req, 16*1024)
	given := asArr(b["rules"])
	if b["rules"] == nil || len(given) > LINK_RULES_MAX {
		refuse(400, "규칙은 50개까지예요")
	}
	clean := cleanLinkRules(given)
	if len(clean) != len(given) {
		refuse(400, "주소(호스트 이름)나 여는 방식이 올바르지 않아요. 미리보기는 localhost·127.0.0.1·0.0.0.0 만 고를 수 있어요")
	}
	prefsOf(uid)["linkRules"] = clean
	savePrefs(uid)
	jsonRes(res, 200, M{"ok": true, "rules": clean})
	return true
}

// GET /api/sessions/<id>/snapshot?u= (IF-278): the page as the session's Mac rendered it, in the reader's shape.
func sessionSnapshot(req *Req, res *Res, u *url.URL, meta *Sess) {
	target := qstr(u, "u")
	if len(target) > 4096 {
		refuse(400, "주소가 너무 길어요")
	}
	pu, err := url.Parse(target)
	if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
		refuse(400, "http(s) 주소만 스냅샷으로 열 수 있어요")
	}
	if limited(req, 20, "snapshot") {
		refuse(429, "너무 자주 열었어요. 잠시 뒤에 다시 해 주세요")
	}
	hostID := liveHost(meta)
	if !online(hostID) {
		refuse(409, "세션의 맥이 연결돼 있지 않아서 스냅샷을 만들 수 없어요")
	}
	r := ask(hostID, M{"t": "snapshot", "sid": meta.id(), "url": pu.String()}, SNAPSHOT_MS)
	if !truthy(r["ok"]) {
		refuse(502, orStr(r["error"], "맥에서 페이지를 그리지 못했어요"))
	}
	html := jsStringU(r["html"])
	if len(html) > READER_MAX_HTML {
		refuse(502, "페이지가 너무 커서 스냅샷으로 못 열어요")
	}
	base := pu
	if f, err := url.Parse(jsStringU(r["url"])); err == nil && (f.Scheme == "http" || f.Scheme == "https") && f.Host != "" {
		base = f
	}
	pg := snapshotPage(html, base, asM(r["images"]))
	jsonRes(res, 200, M{"ok": true, "url": base.String(), "title": pg.Title, "site": pg.Site, "blocks": pg.Blocks, "snapshot": true})
}

// snapshotPage reads the rendered DOM as the reader does. Pictures of the page's own origin the agent read on the
// Mac (an app on localhost cannot be fetched from here) take a data: address in place of theirs, only for a real
// picture type and up to SNAPSHOT_IMGMAX in all.
func snapshotPage(html string, base *url.URL, imgs M) readerPage {
	pg := readerParse(strings.ToValidUTF8(html, ""), base)
	total := 0
	for i, b := range pg.Blocks {
		if b.T != "img" {
			continue
		}
		d := jsStringU(imgs[b.Src])
		if d == "" || !snapshotDataRe.MatchString(d) || total+len(d) > SNAPSHOT_IMGMAX {
			continue
		}
		total += len(d)
		pg.Blocks[i].Src = d
	}
	return pg
}

var snapshotDataRe = regexp.MustCompile(`^data:image/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$`)
