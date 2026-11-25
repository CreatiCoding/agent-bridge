package main

// 맥 기준 세션 목록 (REQ-F-927): the Mac holds which of its sessions are open (sessions.json) and their conversations;
// a server only shows them. A Mac that says its hello lists every session it holds (caps "listed") has the server
// close its copies of that Mac's sessions the list leaves out: ended while this server was not linked (the local
// server was off while the site ended them, or the other way round). A session placed on that Mac a moment ago (made
// or moved here, the Mac not yet answering for it) is left alone. Each listed session's last conversation time moves
// the list's time on when it is later than what this server has (the Mac read lines this server never got).

const (
	// LISTED_GRACE_MS: a session made or moved onto the Mac less than this ago is never closed for not being listed.
	LISTED_GRACE_MS = 10 * 60_000
	// LISTED_AT_SKEW: a conversation time further ahead than this is not believed.
	LISTED_AT_SKEW = 300_000
)

func listsAll(msg M) bool { return containsAny(asArr(msg["caps"]), "listed") }

// lastPlacedAt: when the session was made, or last moved between Macs.
func lastPlacedAt(meta *Sess) float64 {
	at := numOr0(meta.get("createdAt"))
	for _, m := range asArr(meta.get("moves")) {
		if t := mnum(m, "at"); t > at {
			at = t
		}
	}
	return at
}

// closeUnlisted: this person's open sessions on that Mac that its hello did not list are closed here. How many.
func closeUnlisted(uid, hostID string, listed map[string]bool) int {
	now := float64(nowMs())
	n := 0
	for _, meta := range sessions.Values() {
		if meta.uid() != uid || meta.host() != hostID || listed[meta.id()] || truthy(meta.get("closed")) {
			continue
		}
		if now-lastPlacedAt(meta) < LISTED_GRACE_MS || meta.get("moving") != nil {
			continue
		}
		resetVolatile(meta)
		meta.set("closed", true)
		meta.set("closedAt", now)
		logEvents(meta, []any{M{"k": "end", "text": "맥에 이 세션이 없어 닫음(다른 화면에서 끝냄)"}})
		touch(meta)
		n++
	}
	return n
}

// listedAt: the time of the last conversation line the Mac has for a session it lists, taken when it is later.
func listedAt(meta *Sess, at any) {
	t, ok := at.(float64)
	if !ok || t <= 0 || t > float64(nowMs()+LISTED_AT_SKEW) || t <= numOr0(meta.get("lastAt")) {
		return
	}
	meta.set("lastAt", t)
	dirty.Set(meta.id(), true)
}
