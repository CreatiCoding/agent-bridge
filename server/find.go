package main

// 세션 찾기 (REQ-F-895, IF-282): a search typed in the session list, asked of every Mac of the person at once. Each
// Mac reads its own sessions' transcripts (1단계, `text`) or has `claude -p` pick from a digest of them (2단계, `ai`)
// (agent convfind, agent/mcp.mjs findSessions). The server keeps no transcripts, so it only fans the search out,
// waits for each Mac up to its own limit, and leaves out what the person may not see here: another person's session
// and a locked one. A sealing Mac's findings come as pieces bound to the session and the words searched, which the
// server passes on unread (agent/trust.mjs sealOut convfind, docs/TRUST-DESIGN.md §6.2).

import (
	"net/url"
	"sort"
	"strings"
)

const (
	FIND_Q_MIN     = 2
	FIND_Q_MAX     = 500
	FIND_BODY_MAX  = 64 * 1024
	FIND_PIECE_MAX = 4096
	// How long one Mac is waited for: its own limit (agent FIND_TIME_MS 10 s, FIND_AI_TIMEOUT_MS 90 s) and some.
	FIND_TEXT_WAIT_MS = 20_000
	FIND_AI_WAIT_MS   = 120_000
	FIND_TEXT_PER_MIN = 20
	FIND_AI_PER_MIN   = 4
	FIND_CLOSED_MAX   = 300
	FIND_SKIP_MAX     = 2000
	FIND_HITS_MAX     = 50
	FIND_SNIPS_MAX    = 3
	FIND_SNIP_MAX     = 400
	FIND_WHY_MAX      = 300
	FIND_SEALED_MAX   = 8192
	FIND_ERROR_MAX    = 300
)

const (
	FIND_Q_ERR       = "찾는 글은 2~500자예요"
	FIND_MODE_ERR    = "찾는 방식은 text 또는 ai 예요"
	FIND_RATE_ERR    = "찾기를 너무 자주 했어요. 1분쯤 뒤에 다시 해 주세요"
	FIND_AI_BUSY_ERR = "이미 AI 로 찾는 중이에요. 끝난 뒤 다시 해 주세요"
	FIND_PIECE_ERR   = "이 맥에 보낼 봉인된 찾는 글이 올바르지 않아요"
	FIND_MIX_ERR     = "평문 찾는 글과 봉인된 찾는 글은 한 요청에 같이 보내지 않아요"
	FIND_HOSTS_MAX   = 64
	FIND_FN_MAX      = 64
)

// findAiBusy: one 2단계 at a time per person (each one runs claude on every Mac).
var findAiBusy = map[string]bool{}

// findNoAnswer: the errors ask() makes up itself when a Mac did not answer (live.go), as against the Mac's own.
func findNoAnswer(e string) bool {
	return strings.HasPrefix(e, "에이전트가 명령을 받았지만 제때 답하지 않았습니다") || strings.HasPrefix(e, "그 맥의 연동 탭이 명령을 받지 못했습니다") || strings.HasPrefix(e, "호스트가 연결돼 있지 않습니다")
}

// findVisible: a session of this person on that Mac that is not locked (REQ-F-895 rule 6).
func findVisible(uid, hostID, sid string) (*Sess, bool) {
	c, ok := sessions.Get(sid)
	if !ok || c.uid() != uid || c.host() != hostID || truthy(c.get("lock")) {
		return nil, false
	}
	return c, true
}

// findLists: what a Mac is told with a search: the closed sessions of it the server still knows (newest first) and
// the locked ones it leaves out.
func findLists(uid, hostID string) ([]any, []any) {
	closedS := []*Sess{}
	skip := []any{}
	for _, c := range sessions.Values() {
		if c.uid() != uid || c.host() != hostID {
			continue
		}
		if truthy(c.get("lock")) {
			if len(skip) < FIND_SKIP_MAX {
				skip = append(skip, c.id())
			}
			continue
		}
		if truthy(c.get("closed")) {
			closedS = append(closedS, c)
		}
	}
	sort.SliceStable(closedS, func(a, b int) bool { return numOr0(closedS[a].get("lastAt")) > numOr0(closedS[b].get("lastAt")) })
	closed := []any{}
	for i, c := range closedS {
		if i >= FIND_CLOSED_MAX {
			break
		}
		conv := c.get("conv")
		if conv == nil {
			conv = c.id()
		}
		closed = append(closed, M{"sid": c.id(), "conv": conv})
	}
	return closed, skip
}

// findText: a short text from a Mac, cut where a sealed piece would not be (a piece too long becomes 🔒).
func findText(v any, max int) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	if hasSeal(s) {
		if len(s) > FIND_SEALED_MAX {
			return "🔒"
		}
		return s
	}
	return jsSliceTo(s, max)
}

// findHostResult: one Mac's answer as the page gets it: its state, and its hits for sessions the person may see.
func findHostResult(uid, hostID string, base M, r M) M {
	if r == nil {
		base["state"] = "error"
		base["error"] = "답을 처리하지 못했어요"
		return base
	}
	if !truthy(r["ok"]) {
		e := jsStringU(r["error"])
		switch {
		case mstr(r, "code") == "trust-refused":
			base["state"] = "refused"
		case r["t"] == "convfind":
			base["state"] = "error"
		case findNoAnswer(e):
			base["state"] = "noanswer"
		default:
			base["state"] = "error"
		}
		base["error"] = findText(r["error"], FIND_ERROR_MAX)
		return base
	}
	base["state"] = "ok"
	for _, k := range []string{"searched", "total", "shown", "ms"} {
		if n, ok := r[k].(float64); ok {
			base[k] = n
		}
	}
	base["partial"] = r["partial"] == true
	if qh, ok := r["qh"].(string); ok && len(qh) <= 64 {
		base["qh"] = qh
	}
	list := r["hits"]
	if r["picks"] != nil {
		list = r["picks"]
	}
	hits := []any{}
	seen := map[string]bool{}
	for _, x := range asArr(list) {
		if len(hits) >= FIND_HITS_MAX {
			break
		}
		h := asM(x)
		sid := mstr(h, "sid")
		if sid == "" || seen[sid] {
			continue
		}
		c, ok := findVisible(uid, hostID, sid)
		if !ok {
			continue
		}
		seen[sid] = true
		out := M{"sid": sid, "closed": truthy(c.get("closed"))}
		if at, ok := h["at"].(float64); ok {
			out["at"] = at
		}
		if s, ok := h["sealed"].(string); ok {
			// A sealing Mac's finding: passed on whole or not at all (a cut piece opens to nothing).
			if !hasSeal(s) || len(s) > FIND_SEALED_MAX {
				continue
			}
			out["sealed"] = s
		} else {
			if n, ok := h["n"].(float64); ok {
				out["n"] = n
			}
			snips := []any{}
			for _, sn := range asArr(h["snips"]) {
				if len(snips) >= FIND_SNIPS_MAX {
					break
				}
				if t := findText(sn, FIND_SNIP_MAX); t != nil {
					snips = append(snips, t)
				}
			}
			if len(snips) > 0 {
				out["snips"] = snips
			}
			if w := findText(h["why"], FIND_WHY_MAX); w != nil {
				out["why"] = w
			}
		}
		hits = append(hits, out)
	}
	base["hits"] = hits
	return base
}

// apiFind: POST /api/find {mode: text|ai, q? | qh?: {hostId: sealed q}, hosts?: [hostId], fn?} — the person's Macs
// (those in hosts when given) are asked at once. A request is either plain (q, for the Macs the page is not paired
// with) or sealed (qh, one piece per paired Mac, each signed with qH and fn), never both: the plain words and what
// a sealing Mac found must not reach the server together (REQ-S-102). fn is the page's number for the search, which
// the Mac binds into its sealed findings.
func apiFind(req *Req, res *Res, u *url.URL, uid string) bool {
	if u.Path != "/api/find" || req.Method != "POST" {
		return false
	}
	b := body(req, FIND_BODY_MAX)
	mode := mstr(b, "mode")
	if mode != "text" && mode != "ai" {
		refuse(400, FIND_MODE_ERR)
	}
	q := jsTrim(strOr(b["q"], ""))
	if q != "" && (jsLen(q) < FIND_Q_MIN || jsLen(q) > FIND_Q_MAX) {
		refuse(400, FIND_Q_ERR)
	}
	qh := asM(b["qh"])
	if q == "" && len(qh) == 0 {
		refuse(400, FIND_Q_ERR)
	}
	if q != "" && len(qh) > 0 {
		refuse(400, FIND_MIX_ERR)
	}
	var only map[string]bool
	if hs, ok := b["hosts"].([]any); ok {
		only = map[string]bool{}
		for _, x := range hs {
			if s, ok := x.(string); ok && len(only) < FIND_HOSTS_MAX {
				only[s] = true
			}
		}
	}
	fn := ""
	if s, ok := b["fn"].(string); ok && len(s) <= FIND_FN_MAX {
		fn = s
	}
	kind, max, wait := "find", FIND_TEXT_PER_MIN, int64(FIND_TEXT_WAIT_MS)
	if mode == "ai" {
		kind, max, wait = "findai", FIND_AI_PER_MIN, FIND_AI_WAIT_MS
	}
	if hit(kind+"|"+uid, max) {
		refuse(429, FIND_RATE_ERR)
	}
	if mode == "ai" {
		if findAiBusy[uid] {
			refuse(409, FIND_AI_BUSY_ERR)
		}
		findAiBusy[uid] = true
		defer delete(findAiBusy, uid)
	}
	own := []string{}
	for _, id := range hosts.Keys() {
		if mstr(hosts.Val(id), "uid") == uid && (only == nil || only[id]) {
			own = append(own, id)
		}
	}
	results := make([]M, len(own))
	done := make(chan struct{}, len(own))
	asked := 0
	for i, h := range own {
		base := M{"id": h, "name": hosts.Val(h)["name"]}
		results[i] = base
		hq := q
		if p, ok := qh[h].(string); ok && p != "" {
			if len(p) > FIND_PIECE_MAX || !hasSeal(p) {
				base["state"] = "error"
				base["error"] = FIND_PIECE_ERR
				continue
			}
			hq = p
		}
		if hq == "" {
			base["state"] = "skipped"
			continue
		}
		if !online(h) {
			base["state"] = "offline"
			continue
		}
		closed, skip := findLists(uid, h)
		asked++
		i, h, hq := i, h, hq
		goLocked("find", func() {
			defer func() { done <- struct{}{} }()
			cmd := M{"t": "convfind", "op": mode, "q": hq, "closed": closed, "skip": skip}
			if fn != "" {
				cmd["fn"] = fn
			}
			r := ask(h, cmd, wait)
			results[i] = findHostResult(uid, h, base, r)
		})
	}
	await(func() {
		for k := 0; k < asked; k++ {
			<-done
		}
	})
	out := []any{}
	for _, r := range results {
		if r["state"] == nil {
			r["state"] = "error"
			r["error"] = "답을 처리하지 못했어요"
		}
		out = append(out, r)
	}
	jsonRes(res, 200, M{"ok": true, "mode": mode, "hosts": out})
	return true
}
