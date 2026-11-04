package main

import "regexp"

// Session runners (REQ-F-851, docs/RUNNER-DESIGN.md): which CLI a session runs. The agent says which ones its Mac has
// (hello `runners`), a new session may name one (`runner`), and the session keeps it in its meta. A session with no
// runner is a Claude Code session, as every session before was. The server reads every runner's conversation the
// same way: the agent turns another program's record into Claude Code's transcript lines.

var runnerIDRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,15}$`)

// RUNNER_CAPS: what a runner may say it can do; anything else it sends is dropped (agent/runners.mjs CAPS).
var RUNNER_CAPS = []string{"hooks", "cards", "bridgeTools", "model", "effort", "mode", "autoAllow", "fork", "move", "account", "compact", "trim", "skills", "btw", "todos", "preview", "adopt", "routing", "chrome", "sessionMd", "zeropty"}

// cleanRunners: the runners a Mac said it has, as kept on its host: at most 8, ids and caps from the known shapes.
func cleanRunners(v any) any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []any{}
	seen := map[string]bool{}
	for _, x := range list {
		if len(out) >= 8 {
			break
		}
		id := mstr(x, "id")
		if !runnerIDRe.MatchString(id) || seen[id] {
			continue
		}
		seen[id] = true
		caps := []any{}
		for _, c := range asArr(mget(x, "caps")) {
			if s, ok := c.(string); ok && contains(RUNNER_CAPS, s) && !containsAny(caps, s) {
				caps = append(caps, s)
			}
		}
		r := M{"id": id, "name": jsSliceTo(mstr(x, "name"), 40), "caps": caps}
		if v := mstr(x, "version"); v != "" {
			r["version"] = jsSliceTo(v, 40)
		}
		out = append(out, r)
	}
	return out
}

// runnerOf: a session's runner other than Claude Code, or "" for Claude Code.
func runnerOf(meta *Sess) string {
	r := meta.str("runner")
	if r == "claude" {
		return ""
	}
	return r
}

// hostRunner: the runner a host said it has, or nil.
func hostRunner(hostID, id string) M {
	for _, r := range asArr(hosts.Val(hostID)["runners"]) {
		if mstr(r, "id") == id {
			return asM(r)
		}
	}
	return nil
}

// runnerCan: whether a session's runner can do `cap`. Claude Code can do everything; a runner the host no longer
// lists can do nothing beyond seeing and typing.
func runnerCan(meta *Sess, cap string) bool {
	id := runnerOf(meta)
	if id == "" {
		return true
	}
	r := hostRunner(meta.host(), id)
	return r != nil && containsAny(asArr(r["caps"]), cap)
}

// pickRunner: the runner a new session asks for, checked against the host. "" means Claude Code.
func pickRunner(hostID string, v any) string {
	id, _ := v.(string)
	if id == "" || id == "claude" {
		return ""
	}
	if !runnerIDRe.MatchString(id) || hostRunner(hostID, id) == nil {
		refuse(400, "이 맥에 그 실행기가 없어요")
	}
	return id
}

// Codex sessions' sandbox and approval (REQ-F-854, agent/codex.mjs parseCodexMode): one string
// `<sandbox>:<approval>[:net]`, either part empty for codex's own default, "" for both. danger-full-access is never one.
var CODEX_SANDBOXES = []string{"read-only", "workspace-write"}
var CODEX_APPROVALS = []string{"on-request", "never"}
var codexModeRe = regexp.MustCompile(`^([a-z-]*):([a-z-]*)(:net)?$`)

// codexMode checks a requested mode: the kept string, or an error status and text. Shape errors are 400; a value
// bridge.yaml (features.codexSandboxes·codexApprovals·codexNetwork) leaves out is 403. Codex's default is always allowed.
func codexMode(v any) (string, int, string) {
	s, ok := v.(string)
	if v == nil || (ok && s == "") {
		return "", 0, ""
	}
	m := codexModeRe.FindStringSubmatch(s)
	if !ok || m == nil || (m[1] != "" && !contains(CODEX_SANDBOXES, m[1])) || (m[2] != "" && !contains(CODEX_APPROVALS, m[2])) || (m[3] != "" && m[1] != "workspace-write") {
		return "", 400, "codex 샌드박스·승인 모드가 올바르지 않아요"
	}
	if (m[1] != "" && !contains(cfgGet("features.codexSandboxes").([]string), m[1])) || (m[2] != "" && !contains(cfgGet("features.codexApprovals").([]string), m[2])) || (m[3] != "" && !cfgOn("features.codexNetwork")) {
		return "", 403, FEATURE_OFF
	}
	if m[1] == "" && m[2] == "" {
		return "", 0, ""
	}
	return s, 0, ""
}

// mustCodexMode: codexMode, refusing the request when it is not one.
func mustCodexMode(v any) string {
	s, code, why := codexMode(v)
	if code != 0 {
		refuse(code, why)
	}
	return s
}

// runnerOps: what a session's page may ask that needs one of a runner's caps (sessionPost op → cap).
var runnerOps = map[string]string{"setting": "model", "trimlog": "trim", "lightfork": "fork", "fork": "fork", "btw": "btw", "cwd": "move"}

// runnerDoCaps: the bridge commands (`:compact`, `:model` …) and the cap each needs.
var runnerDoCaps = map[string]string{"compact": "compact", "model": "model", "effort": "effort", "mode": "mode", "auto": "autoAllow", "lightfork": "fork", "fork": "fork", "btw": "btw", "trimlog": "trim", "todos": "todos"}

// runnerGate refuses what a session's runner cannot do (the page hides it; this is for every other way in).
func runnerGate(meta *Sess, op string, b M) {
	id := runnerOf(meta)
	if id == "" {
		return
	}
	no := func() { refuse(409, id+" 세션에서는 쓸 수 없는 기능이에요") }
	cap := runnerOps[op]
	if op == "setting" {
		cap = strField(b, "kind")
		if cap == "codexMode" {
			if id != "codex" {
				no()
			}
			cap = ""
		}
	}
	if op == "do" {
		cap = runnerDoCaps[strField(b, "cmd")]
	}
	if op == "move" {
		h, _ := b["hostId"].(string)
		if (h != "" && h != meta.host()) || b["account"] != nil {
			cap = "move"
		}
	}
	if op == "settings" && b["autoAllow"] == true {
		cap = "autoAllow"
	}
	if cap != "" && !runnerCan(meta, cap) {
		no()
	}
}
