package main

// 즐겨찾기·제목 넘겨주기 (REQ-F-923): a session's favourite and the name a person gave it go with its Mac between
// the site and the Mac's local server (local --full), as the list's groups do (REQ-F-905). Each server stamps the
// time a session's marks last changed (meta marksAt); it hands them, with that time, to the session's Mac when it
// says it carries them (hello caps "marks"), at hello and at each change. The Mac keeps the newest for each session
// and, when the server it links to has older ones, sends its own up: the one changed last wins. Only a title a person
// gave counts (manualTitle): a name made from the first message is made again by each server.

const (
	MARKS_SYNC_MAX  = 2000
	MARKS_TITLE_MAX = 80
)

func carriesMarks(hostID string) bool { return containsAny(asArr(live(hostID)["caps"]), "marks") }

// marksAt: when this session's marks last changed here. One marked before this was kept counts as changed at 1, so
// a new local server's unmarked copy (0) never wins over it.
func marksAt(meta *Sess) float64 {
	if at, ok := meta.get("marksAt").(float64); ok && at > 0 {
		return at
	}
	if truthy(meta.get("favorite")) || truthy(meta.get("manualTitle")) {
		return 1
	}
	return 0
}

// marksStamp: the session's marks changed now (never before the last time, as groupsStamp).
func marksStamp(meta *Sess) {
	at := float64(nowMs())
	if prev := marksAt(meta); at <= prev {
		at = prev + 1
	}
	meta.set("marksAt", at)
}

func marksOf(meta *Sess) M {
	title := ""
	if truthy(meta.get("manualTitle")) {
		title = meta.str("title")
	}
	return M{"sid": meta.id(), "at": marksAt(meta), "favorite": truthy(meta.get("favorite")), "title": title}
}

// marksCmd: the marks of this person's sessions on that Mac.
func marksCmd(uid, hostID string) M {
	list := []any{}
	for _, meta := range sessions.Values() {
		if meta.uid() == uid && meta.host() == hostID && len(list) < MARKS_SYNC_MAX {
			list = append(list, marksOf(meta))
		}
	}
	return M{"t": "marks", "list": list}
}

// marksToHost: one session's marks changed here; its Mac gets them when it carries them.
func marksToHost(meta *Sess) {
	h := meta.host()
	if h == "" || !online(h) || !carriesMarks(h) {
		return
	}
	toHost(h, M{"t": "marks", "list": []any{marksOf(meta)}})
}

// marksFromAgent: a Mac's marks, newer than this server's, are taken for each of its sessions; older ones are
// answered with this server's, so the Mac keeps those.
func marksFromAgent(uid, hostID string, msg M) {
	if !carriesMarks(hostID) {
		return
	}
	back := []any{}
	late := float64(nowMs() + GROUPS_SYNC_SKEW)
	skewed := false
	for i, x := range asArr(msg["list"]) {
		if i >= MARKS_SYNC_MAX {
			break
		}
		e := asM(x)
		sid, _ := e["sid"].(string)
		at, ok := e["at"].(float64)
		if !safeId(sid) || !ok || at <= 0 {
			continue
		}
		meta := sessOf(M{"sid": sid})
		if !owns(meta, uid, hostID) {
			continue
		}
		if at > late {
			skewed = true
			continue
		}
		if at <= marksAt(meta) {
			back = append(back, marksOf(meta))
			continue
		}
		fav, _ := e["favorite"].(bool)
		if fav {
			meta.set("favorite", true)
			meta.del("tidyStopAt")
		} else {
			meta.del("favorite")
		}
		title, _ := e["title"].(string)
		title = jsSliceTo(jsTrim(wsRun.ReplaceAllString(title, " ")), MARKS_TITLE_MAX)
		if title != "" {
			meta.set("title", title)
			meta.set("manualTitle", true)
		} else if truthy(meta.get("manualTitle")) {
			// Named by hand there no more: named from its first message again here.
			meta.set("manualTitle", false)
			meta.set("title", "")
		}
		meta.set("marksAt", at)
		touch(meta)
	}
	if skewed {
		record(uid, hostID, M{"area": "link", "level": "warn", "text": "맥이 보낸 즐겨찾기·제목의 시각이 서버 시계보다 5분 넘게 앞서 받지 않음(맥 시계를 맞춰 주세요)"})
	}
	if len(back) > 0 {
		toHost(hostID, M{"t": "marks", "list": back})
	}
}
