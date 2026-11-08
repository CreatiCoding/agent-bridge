package main

// 실행기 전환 (REQ-F-891): the same session goes on in the other runner (Claude Code ↔ Codex) on its own Mac, in its
// own folder, under its own id: no second session. The page asks the session for a hand-over summary first and sends
// it as an ordinary message once the switch is done; the server only checks the switch and tells the Mac. The Mac
// keeps each runner's conversation, so switching back resumes it, and says so with `conv` (its lines start over in
// the server's copy, the ones shown before are not drawn again).

// SWITCH_MS: how long the Mac may take to stop one runner and start the other (claude waits up to 90 s to start).
const SWITCH_MS = 150_000

// switchReady refuses a switch that is not safe now: the session works, waits, starts or has messages held (two
// agents must never write the same files), is moved, locked or driven from Slack. Checked before the Mac is told and
// again by the Mac itself, which knows its own state best.
func switchReady(meta *Sess) {
	if truthy(meta.get("lock")) {
		refuse(409, "잠긴 세션은 실행기를 바꿀 수 없어요")
	}
	if seatOf(meta) == "slack" {
		refuse(409, "Slack 에서 작업 중인 세션이에요. 브릿지로 가져온 뒤 바꿔 주세요")
	}
	st := meta.state()
	if !truthy(st["alive"]) {
		refuse(409, "세션을 먼저 열어야 해요")
	}
	switch mstr(st, "phase") {
	case "busy", "starting":
		refuse(409, "세션이 지금 작업 중이에요. 끝나거나 멈춘 뒤에 바꿔 주세요")
	case "waiting":
		refuse(409, "세션이 답을 기다리고 있어요. 답한 뒤에 바꿔 주세요")
	}
	if len(asArr(st["held"])) > 0 {
		refuse(409, "세션에 보낼 글이 남아 있어요. 전달되거나 지운 뒤에 바꿔 주세요")
	}
}

// switchOp: POST /api/sessions/<id>/switch {runner: "claude"|"codex", codexMode?, mode?: "autoAllow"|"allowAll"}.
func switchOp(res *Res, uid string, meta *Sess, b M) {
	to := strField(b, "runner")
	if to != "claude" && to != "codex" {
		refuse(400, "바꿀 실행기는 claude 나 codex 여야 해요")
	}
	from := runnerOf(meta)
	if from == "" {
		from = "claude"
	}
	if to == from {
		refuse(409, "이미 그 실행기로 도는 세션이에요")
	}
	hostID := liveHost(meta)
	if to == "codex" && hostRunner(hostID, "codex") == nil {
		refuse(409, "이 맥에 Codex 가 없어요 (codex·tmux 필요)")
	}
	codexM := ""
	if to == "codex" {
		codexM = mustCodexMode(b["codexMode"])
	}
	switchReady(meta)
	cmd := M{"t": "switch", "sid": meta.id(), "runner": to}
	if codexM != "" {
		cmd["codexMode"] = codexM
	}
	// 전부 허용 for the runner it goes to, when that runner can do it (REQ-F-856).
	if m := strField(b, "mode"); (m == "autoAllow" || m == "allowAll") && (to == "claude" || capOf(hostRunner(hostID, to), "autoAllow")) {
		cmd["autoAllow"] = true
		cmd["allowAll"] = m == "allowAll"
	}
	// The operator's policy (session.do.before) decides like for every other session action; the lock is let go
	// while the hooks run, so the session may have started working since and is checked again.
	sessBefore("session.do", meta, kv{"do", "switch"}, kv{"runner", to})
	switchReady(meta)
	r := ask(hostID, cmd, SWITCH_MS)
	if !truthy(r["ok"]) {
		broadcastState(uid)
		refuse(409, orStr(r["error"], "실행기를 바꾸지 못했어요"))
	}
	setRunner(meta, to)
	if to == "codex" {
		if codexM != "" {
			meta.set("codexMode", codexM)
		} else {
			meta.del("codexMode")
		}
	}
	if safeId(r["conv"]) {
		meta.set("conv", r["conv"])
	}
	touch(meta)
	broadcastState(uid)
	sessAfter("session.do", meta, kv{"do", "switch"}, kv{"runner", to})
	jsonRes(res, 200, M{"ok": true, "runner": to, "resumed": truthy(r["resumed"])})
}

// setRunner: a session's runner on record, "" kept for Claude Code (every session before runners had none).
func setRunner(meta *Sess, id string) {
	if id == "claude" || id == "" {
		meta.del("runner")
		return
	}
	if runnerIDRe.MatchString(id) {
		meta.set("runner", id)
	}
}

// capOf: whether a host's runner entry says it can do `cap`.
func capOf(r M, cap string) bool {
	if r == nil {
		return false
	}
	for _, c := range asArr(r["caps"]) {
		if c == cap {
			return true
		}
	}
	return false
}
