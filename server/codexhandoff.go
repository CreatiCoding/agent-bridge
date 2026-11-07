package main

import (
	"strings"
	"sync"
)

// Codex 로 이어서 작업 (REQ-F-857): a Claude Code session's work goes on in a new Codex session in the same folder of
// the same Mac. The page writes the summary (asked of the Claude session) and starts the Codex session with it as the
// first message through POST /api/sessions; the server only checks the pair, keeps a double press from starting two,
// and links the two sessions. The summary itself is the first message: sealed like any other when the Mac seals, and
// kept nowhere else.

// HANDOFF_KEEP_MS: how long a hand-over's key answers with the session it made (a press again, a retry after a lost
// answer).
const HANDOFF_KEEP_MS = 3600_000

type handoffEntry struct {
	sid string // "" while it is being made
	at  int64
}

var (
	handoffMu   sync.Mutex
	handoffKeys = map[string]handoffEntry{}
)

// handoffSource is the Claude Code session a hand-over starts from, checked: the person's own, on the Mac the new
// session starts on, run by Claude Code, not locked, and the new one is a Codex session.
func handoffSource(uid, hostID, runner string, b M) *Sess {
	from, _ := b["handoffFrom"].(string)
	if from == "" {
		return nil
	}
	src := ownSession(uid, from)
	if src.host() != hostID {
		refuse(409, "Codex 로 이어서 작업은 같은 맥에서만 할 수 있어요")
	}
	if src.str("runner") != "" {
		refuse(409, "Claude Code 세션만 Codex 로 이어서 작업할 수 있어요")
	}
	if runner != "codex" {
		refuse(400, "이어서 작업할 실행기는 Codex 여야 해요")
	}
	if truthy(src.get("lock")) {
		refuse(409, "잠긴 세션은 이어서 작업할 수 없어요")
	}
	handoffReady(src, handoffCwd(b))
	return src
}

// handoffCwd: the folder the new session asks for, as startSession reads it.
func handoffCwd(b M) string {
	if truthy(b["cwd"]) {
		return jsString(b["cwd"])
	}
	return "~"
}

// handoffReady refuses a hand-over the source session is not safe to give now: Claude is working, asking, starting,
// has messages waiting to go in, or is being moved, or the new session would start in another folder. Called when the
// start is checked and again right before the Mac is told to start Codex: the server's lock is let go while it waits
// (hooks, the Mac), so the source's state may change in between.
func handoffReady(src *Sess, cwd string) {
	st := src.state()
	if truthy(st["alive"]) {
		switch mstr(st, "phase") {
		case "busy", "starting":
			refuse(409, "Claude 가 지금 작업 중이에요. 끝나거나 멈춘 뒤에 Codex 로 이어서 작업해요")
		case "waiting":
			refuse(409, "Claude 가 답을 기다리고 있어요. 세션에서 답한 뒤 Codex 로 이어서 작업해요")
		}
		if len(asArr(st["held"])) > 0 {
			refuse(409, "Claude 세션에 보낼 글이 남아 있어요. 처리된 뒤 Codex 로 이어서 작업해요")
		}
	}
	if truthy(src.get("moving")) {
		refuse(409, "옮기는 중인 세션은 이어서 작업할 수 없어요")
	}
	if d := handoffDir(src.str("cwd")); d == "" || d != handoffDir(cwd) {
		refuse(409, "Codex 는 원래 세션과 같은 폴더에서만 이어서 작업할 수 있어요")
	}
}

// handoffDir: a folder as the two sessions' folders are compared, without a trailing slash.
func handoffDir(p string) string {
	p = jsTrim(p)
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	return p
}

// handoffClaim takes a hand-over's key for this start. It returns the session already made with that key (the
// caller answers with it and makes nothing), or "" when this start may go on; a start with the same key still under
// way is refused. Without a key every start goes on.
func handoffClaim(uid, key string) string {
	return claimStart(uid, key, "이어서 작업 키가 너무 길어요", "이미 Codex 세션을 만드는 중이에요")
}

// claimStart is handoffClaim for any start that carries a key (Codex 로 이어서 작업's handoffKey, 새 세션 화면's
// startKey, REQ-F-875), with the words a too-long key and a start still under way are refused with.
func claimStart(uid, key, long, busy string) string {
	if key == "" {
		return ""
	}
	if len(key) > 80 {
		refuse(400, long)
	}
	handoffMu.Lock()
	defer handoffMu.Unlock()
	now := nowMs()
	for k, e := range handoffKeys {
		if now-e.at > HANDOFF_KEEP_MS {
			delete(handoffKeys, k)
		}
	}
	k := uid + "\x00" + key
	if e, ok := handoffKeys[k]; ok {
		if e.sid == "" {
			refuse(409, busy)
		}
		if _, alive := sessions.Get(e.sid); alive {
			return e.sid
		}
	}
	handoffKeys[k] = handoffEntry{at: now}
	return ""
}

// handoffSettle records what a claimed start came to: the session made, or "" when it failed (the key is free again).
func handoffSettle(uid, key, sid string) {
	if key == "" {
		return
	}
	handoffMu.Lock()
	defer handoffMu.Unlock()
	k := uid + "\x00" + key
	if sid == "" {
		delete(handoffKeys, k)
		return
	}
	handoffKeys[k] = handoffEntry{sid: sid, at: nowMs()}
}

// HANDOFF_TO / HANDOFF_FROM: the notices that link the two sessions (each opens the other).
const HANDOFF_TO = "↪ Codex 세션으로 이어서 작업해요. 같은 폴더의 파일을 두 에이전트가 함께 고치지 않게, Codex 가 일하는 동안 이 세션에는 작업을 시키지 마세요. 이 대화는 그대로 남아요."
const HANDOFF_FROM = "↪ Claude Code 세션에서 이어받은 작업이에요. 첫 메시지가 인계 요약이에요. 미커밋 변경은 Claude 가 남긴 것이니 확인한 뒤 이어서 작업해요."

func handoffNotice(text, open, label string) M {
	return M{"k": "notice", "tone": "info", "icon": "move", "text": text, "open": open, "openLabel": label}
}
