package main

// A Mac that does not trust the server (REQ-S-090~, docs/TRUST-DESIGN.md). The server only carries: the page's
// signatures (X-Bridge-Auth) ride on the commands they are for, and pairing goes to the Mac and back. Nothing here
// is relied on by the Mac: a token put on the wrong command is refused there.

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"sync"
)

const (
	AUTH_TOKENS_MAX = 8
	AUTH_TOKEN_MAX  = 2048
	AUTH_KEEP_MS    = 30_000
)

type authTok struct {
	tok   M
	t     string
	sid   string
	op    string
	until int64
}

var (
	authMu      sync.Mutex
	authQ       = map[string][]authTok{}
	hostTrustRe = regexp.MustCompile(`^/api/hosts/([a-zA-Z0-9-]+)/trust$`)
	trustModes  = []string{"off", "warn", "enforce"}
	trustOps    = []string{"info", "pair1", "pair3", "pair4", "keys", "remove"}
)

// queueTrustAuth: the signed tokens a page sent with a request, kept a moment for the commands it causes.
func queueTrustAuth(uid, header string) {
	if header == "" || len(header) > AUTH_TOKENS_MAX*AUTH_TOKEN_MAX*2 {
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(header)
	if err != nil {
		return
	}
	var list []map[string]any
	if json.Unmarshal(raw, &list) != nil || len(list) > AUTH_TOKENS_MAX {
		return
	}
	now := nowMs()
	authMu.Lock()
	defer authMu.Unlock()
	for _, x := range list {
		p, _ := x["p"].(string)
		s, _ := x["s"].(string)
		if p == "" || s == "" || len(p)+len(s) > AUTH_TOKEN_MAX {
			continue
		}
		var pm map[string]any
		if json.Unmarshal([]byte(p), &pm) != nil {
			continue
		}
		h, _ := pm["h"].(string)
		t, _ := pm["t"].(string)
		// Only for a Mac of the person who sent it.
		if hh, ok := hosts.Get(h); !ok || mstr(hh, "uid") != uid || t == "" {
			continue
		}
		i, _ := pm["i"].(map[string]any)
		sid, _ := i["sid"].(string)
		op, _ := i["op"].(string)
		q := authQ[h][:0:0]
		for _, a := range authQ[h] {
			if a.until > now {
				q = append(q, a)
			}
		}
		authQ[h] = append(q, authTok{tok: M{"p": p, "s": s}, t: t, sid: sid, op: op, until: now + AUTH_KEEP_MS})
		if len(authQ[h]) > 32 {
			authQ[h] = authQ[h][len(authQ[h])-32:]
		}
	}
}

// attachTrustAuth: the first waiting token for this command (its kind, its session, its op) goes with it.
func attachTrustAuth(hostID string, cmd M) {
	if _, has := cmd["auth"]; has {
		return
	}
	t, _ := cmd["t"].(string)
	sid, _ := cmd["sid"].(string)
	op, _ := cmd["op"].(string)
	now := nowMs()
	authMu.Lock()
	defer authMu.Unlock()
	q := authQ[hostID]
	for k, a := range q {
		if a.until <= now || a.t != t || (a.sid != "" && a.sid != sid) || (a.op != "" && a.op != op) {
			continue
		}
		cmd["auth"] = a.tok
		authQ[hostID] = append(q[:k:k], q[k+1:]...)
		return
	}
}

// cleanTrust: what a Mac says of its trust mode and paired devices, kept with the host for the page.
func cleanTrust(v any) any {
	o, ok := v.(M)
	if !ok {
		return nil
	}
	mode := mstr(o, "mode")
	if !contains(trustModes, mode) {
		return nil
	}
	devs := []any{}
	for _, d := range asArr(o["devices"]) {
		if len(devs) >= 16 {
			break
		}
		id := mstr(d, "id")
		if id == "" || len(id) > 32 {
			continue
		}
		devs = append(devs, M{"id": id, "name": jsSliceTo(mstr(d, "name"), 64), "at": jsNumber(mget(d, "at")), "used": jsNumber(mget(d, "used"))})
	}
	return M{"mode": mode, "version": jsNumber(o["version"]), "seal": o["seal"] == true, "fp": jsSliceTo(mstr(o, "fp"), 32), "devices": devs, "window": truthy(o["window"])}
}

// hostTrustAPI: POST /api/hosts/:id/trust — pairing and the device list, carried to the Mac (owner only).
func hostTrustAPI(req *Req, res *Res, p, uid string) bool {
	m := hostTrustRe.FindStringSubmatch(p)
	if m == nil || req.Method != "POST" {
		return false
	}
	b := body(req, 8192)
	ownHost(uid, m[1])
	if !online(m[1]) {
		refuse(409, NOT_CONNECTED)
	}
	op := mstr(b, "op")
	if !contains(trustOps, op) {
		refuse(400, "모르는 요청이에요")
	}
	cmd := M{"t": "trust", "op": op}
	for _, k := range []string{"id", "c", "pid", "spub", "dpub", "nb", "name", "d"} {
		if v, ok := b[k].(string); ok && len(v) <= 512 {
			cmd[k] = v
		}
	}
	r := ask(m[1], cmd, 15_000)
	if !truthy(r["ok"]) {
		refuse(409, orStr(r["error"], "맥이 답하지 않았어요"))
	}
	if op == "remove" || op == "pair4" {
		if info := cleanTrust(r["info"]); info != nil {
			hosts.Val(m[1])["trust"] = info
		}
		broadcastState(uid)
	}
	delete(r, "reqId")
	delete(r, "t")
	jsonRes(res, 200, r)
	return true
}
