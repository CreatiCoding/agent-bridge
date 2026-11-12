package main

import (
	"os"
	"regexp"
)

// 세션 그룹 넘겨주기 (REQ-F-905): the groups of the session list (groups, loose, collapsed and nothing else of prefs)
// go with a Mac between the site and its local server (local --full). Each server stamps the time its groups last
// changed (prefs groupsSync {at, h}); it hands them, with that time, to its owner's Macs that say they carry them
// (hello caps "groups"), at hello and at each change. A Mac keeps the newest it was given and, when the server it
// links to has older ones, sends its own up: the one changed last wins. Session ids the server does not know are
// kept as they are (the screen shows only the ones it has), so a group holding other Macs' sessions loses none.

const (
	GROUPS_SYNC_MAX_ITEMS = 2000
	// GROUPS_SYNC_SKEW: a time this far ahead of this server's clock is no time a change was made.
	GROUPS_SYNC_SKEW = 5 * 60_000
)

var groupIdRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// groupsSnap: the part of prefs that goes with a Mac, as the screen reads it.
func groupsSnap(pf M) M {
	col := pf["collapsed"]
	if col == nil {
		col = []any{}
	}
	g := pf["groups"]
	if g == nil {
		g = []any{}
	}
	l := pf["loose"]
	if l == nil {
		l = []any{}
	}
	return M{"groups": g, "loose": l, "collapsed": col}
}

func groupsEmpty(pf M) bool {
	return len(asArr(pf["groups"])) == 0 && len(asArr(pf["loose"])) == 0 && len(asArr(pf["collapsed"])) == 0
}

// groupsStamp: the time this server's groups last changed, kept in prefs. The first time it is read, groups that are
// there count as changed when prefs.json was last written (none: 0, so a new local server's empty list never wins).
// A change since (another hash) is now. true: they changed since the last stamp.
func groupsStamp(uid string, pf M) bool {
	h := sha256hexs(jsonStr(groupsSnap(pf)))
	gs := asM(pf["groupsSync"])
	if _, had := gs["h"].(string); !had {
		at := 0.0
		if !groupsEmpty(pf) {
			at = float64(nowMs())
			if st, err := os.Stat(prefsFile(uid)); err == nil {
				at = float64(st.ModTime().UnixMilli())
			}
		}
		pf["groupsSync"] = M{"at": at, "h": h}
		return false
	}
	if gs["h"] == h {
		return false
	}
	// Never before the last time: one taken from a Mac whose clock runs ahead must not make this change lose.
	at := float64(nowMs())
	if prev := numOr0(gs["at"]); at <= prev {
		at = prev + 1
	}
	pf["groupsSync"] = M{"at": at, "h": h}
	return true
}

func groupsAt(pf M) float64 { return numOr0(asM(pf["groupsSync"])["at"]) }

// groupsCmd: what a Mac is handed.
func groupsCmd(uid string) M {
	pf := prefsOf(uid)
	groupsStamp(uid, pf)
	c := groupsSnap(pf)
	c["t"] = "groups"
	c["at"] = groupsAt(pf)
	return c
}

func carriesGroups(hostID string) bool { return containsAny(asArr(live(hostID)["caps"]), "groups") }

// groupsToHosts: the owner's linked Macs that carry groups get them, but the one they came from.
func groupsToHosts(uid, except string) {
	var cmd M
	for _, id := range hosts.Keys() {
		if id == except || mstr(hosts.Val(id), "uid") != uid || !online(id) || !carriesGroups(id) {
			continue
		}
		if cmd == nil {
			cmd = groupsCmd(uid)
		}
		toHost(id, cmd)
	}
}

// cleanGroupsIn: groups from a Mac, held to what the screen could have made: at most 50 groups of a 40-character
// name, a parent only when it is another group here and three levels at most, items and loose as session ids.
func cleanGroupsIn(msg M) (M, bool) {
	ids := func(v any, seen map[string]bool) []any {
		out := []any{}
		for _, x := range asArr(v) {
			if s, ok := x.(string); ok && safeId(s) && !seen[s] && len(seen) < GROUPS_SYNC_MAX_ITEMS {
				seen[s] = true
				out = append(out, s)
			}
		}
		return out
	}
	seen := map[string]bool{}
	list := []M{}
	byId := map[string]M{}
	for _, x := range asArr(msg["groups"]) {
		g := asM(x)
		id, _ := g["id"].(string)
		if !groupIdRe.MatchString(id) || id == "loose" || byId[id] != nil || len(list) >= 50 {
			continue
		}
		name := jsSliceTo(jsTrim(strOr(g["name"], "")), 40)
		if name == "" {
			continue
		}
		ng := M{"id": id, "name": name, "items": ids(g["items"], seen)}
		if p, ok := g["parent"].(string); ok && p != "" {
			ng["parent"] = p
		}
		list = append(list, ng)
		byId[id] = ng
	}
	if len(list) == 0 && msg["groups"] != nil && len(asArr(msg["groups"])) > 0 {
		return nil, false
	}
	depth := func(g M) int {
		n := 1
		for cur := g; cur != nil && n <= GROUP_DEPTH+1; n++ {
			p, _ := cur["parent"].(string)
			if p == "" {
				return n
			}
			cur = byId[p]
			if cur == nil {
				return n
			}
		}
		return GROUP_DEPTH + 1
	}
	for _, g := range list {
		p, _ := g["parent"].(string)
		if p != "" && (byId[p] == nil || p == g["id"] || depth(g) > GROUP_DEPTH) {
			delete(g, "parent")
		}
	}
	// Taking parents away can make another chain valid or still too deep: once more, so none stays over the limit.
	for _, g := range list {
		if depth(g) > GROUP_DEPTH {
			delete(g, "parent")
		}
	}
	col := []any{}
	for _, x := range asArr(msg["collapsed"]) {
		if s, ok := x.(string); ok && (s == "loose" || byId[s] != nil) && !containsAny(col, s) {
			col = append(col, s)
		}
	}
	return M{"groups": anyList(list), "loose": ids(msg["loose"], seen), "collapsed": col}, true
}

// groupsFromAgent: a Mac's groups, newer than this server's, are taken whole; older ones are answered with this
// server's, so the Mac keeps those.
func groupsFromAgent(uid, hostID string, msg M) {
	at, ok := msg["at"].(float64)
	if !ok || at <= 0 || !carriesGroups(hostID) {
		return
	}
	if at > float64(nowMs()+GROUPS_SYNC_SKEW) {
		record(uid, hostID, M{"area": "link", "level": "warn", "text": "맥이 보낸 세션 그룹의 시각이 서버 시계보다 5분 넘게 앞서 받지 않음(맥 시계를 맞춰 주세요)"})
		return
	}
	pf := prefsOf(uid)
	groupsStamp(uid, pf)
	if at <= groupsAt(pf) {
		toHost(hostID, groupsCmd(uid))
		return
	}
	in, ok := cleanGroupsIn(msg)
	if !ok {
		return
	}
	pf["groups"], pf["loose"], pf["collapsed"] = in["groups"], in["loose"], in["collapsed"]
	pf["groupsSync"] = M{"at": at, "h": sha256hexs(jsonStr(groupsSnap(pf)))}
	savePrefs(uid)
	record(uid, hostID, M{"area": "link", "text": "세션 그룹을 맥에서 받음(그룹 " + itoa(len(asArr(in["groups"]))) + "개)"})
	groupsToHosts(uid, hostID)
}
