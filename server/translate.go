package main

import "net/url"

// 맥 언어팩 번역 (REQ-F-897): a browser with no on-device translator (Safari, other Chromium browsers, a phone's
// browser) hands the English lines of an answer to one of the person's Macs, which translates them with macOS's own
// language pack (agent/translate.mjs, macOS 26). No translation service is used. A Mac that seals its answers
// (trust seal) is never asked, and the session's own Mac is asked first.
const (
	TRANSLATE_BODY_MAX  = 128 * 1024
	TRANSLATE_LINES_MAX = 200
	TRANSLATE_LINE_MAX  = 4000
	TRANSLATE_PER_MIN   = 120
	TRANSLATE_WAIT_MS   = 30_000
	TRANSLATE_NO_HOST   = "번역할 맥이 없어요. macOS 26 이상인 맥이 연결돼 있어야 해요"
)

// translateHost: the Mac to ask, the preferred one first; "" when none of the person's Macs can.
func translateHost(uid, prefer string) string {
	ok := func(id string) bool {
		h := hosts.Val(id)
		return h != nil && mstr(h, "uid") == uid && online(id) && hostHasCap(id, "translate") && !truthy(mget(mget(h, "trust"), "seal"))
	}
	if prefer != "" && ok(prefer) {
		return prefer
	}
	for _, id := range hosts.Keys() {
		if ok(id) {
			return id
		}
	}
	return ""
}

// apiTranslate: POST /api/translate {texts: [string], host?: hostId} → {ok, status, texts?, host}. status is the
// Mac's: installed, download (the language pack is not on that Mac yet) or unsupported.
func apiTranslate(req *Req, res *Res, u *url.URL, uid string) bool {
	if u.Path != "/api/translate" || req.Method != "POST" {
		return false
	}
	b := body(req, TRANSLATE_BODY_MAX)
	raw, _ := b["texts"].([]any)
	if len(raw) > TRANSLATE_LINES_MAX {
		refuse(400, "번역할 줄이 너무 많아요")
	}
	texts := []any{}
	for _, x := range raw {
		s, ok := x.(string)
		if !ok || jsLen(s) > TRANSLATE_LINE_MAX {
			refuse(400, "번역할 글이 올바르지 않아요")
		}
		texts = append(texts, s)
	}
	if hit("translate|"+uid, TRANSLATE_PER_MIN) {
		refuse(429, "번역 요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요")
	}
	host := translateHost(uid, mstr(b, "host"))
	if host == "" {
		refuseX(409, TRANSLATE_NO_HOST, M{"code": "nohost"})
	}
	r := ask(host, M{"t": "translate", "texts": texts}, TRANSLATE_WAIT_MS)
	if !truthy(r["ok"]) {
		refuseX(502, orStr(r["error"], "맥이 번역하지 못했어요"), M{"code": orStr(r["code"], "error")})
	}
	out := orderedObj{{"ok", true}, {"status", orStr(r["status"], "unsupported")}, {"host", mstr(hosts.Val(host), "name")}}
	if t, ok := r["texts"].([]any); ok && len(t) == len(texts) {
		out = append(out, kv{"texts", t})
	}
	jsonRes(res, 200, out)
	return true
}
