package main

// Claude 로그인 만료 알림 (REQ-F-910): a Mac's Claude Code sign-in ends on the date `claude auth status` gives
// (loginExpiresAt), and the sessions and whatever runs on them stop with it. Three days before, the owner gets one
// push per account and end date; a new date (a renewal) is warned about again when its turn comes.

const LOGIN_PUSH_MS = 3 * 86_400_000

// loginExpiryNotices: the notices due for a host's accounts now, and marks them sent in h["loginWarned"]
// (account id -> the end date warned about), kept with the host so a restart does not send them again.
func loginExpiryNotices(hostID string, h M, now float64) []M {
	warned, _ := h["loginWarned"].(M)
	if warned == nil {
		warned = M{}
	}
	out := []M{}
	hn := ""
	if h["name"] != nil {
		hn = jsString(h["name"]) + " · "
	}
	for _, a := range asArr(h["accounts"]) {
		exp := jsNumber(mget(a, "expiresAt"))
		if exp != exp || exp <= 0 || mget(a, "loggedIn") != true {
			continue
		}
		id := mstr(asM(a), "id")
		if exp-now > LOGIN_PUSH_MS || jsNumber(warned[id]) == exp {
			continue
		}
		warned[id] = exp
		name := "기본 계정"
		if s, ok := mget(a, "name").(string); ok && s != "" {
			name = s
		}
		days := int((exp - now + 86_400_000 - 1) / 86_400_000)
		text := hn + name + " 의 Claude 로그인이 " + numStr(float64(days)) + "일 뒤 끝나요. 기기 화면의 \"로그인 갱신\" 으로 다시 로그인해 주세요"
		title := "Claude 로그인이 곧 끝나요"
		if exp <= now {
			title = "Claude 로그인이 끝났어요"
			text = hn + name + " 의 Claude 로그인이 끝났어요. 기기 화면의 \"로그인 갱신\" 으로 다시 로그인해 주세요"
		}
		out = append(out, M{"key": "login-exp|" + hostID + "|" + id + "|" + numStr(exp), "title": title, "text": text, "tone": "warn", "push": "always"})
	}
	if len(out) > 0 {
		h["loginWarned"] = warned
	}
	return out
}

// warnLoginExpiry: called whenever a host's accounts change (the Mac reads them on connect and every 6 hours).
func warnLoginExpiry(uid, hostID string) {
	h, ok := hosts.Get(hostID)
	if !ok || isDemoHost(hostID) {
		return
	}
	list := loginExpiryNotices(hostID, h, float64(nowMs()))
	if len(list) == 0 {
		return
	}
	touchGlobals()
	for _, n := range list {
		addNotice(uid, n)
	}
}
