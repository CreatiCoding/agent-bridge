package main

import (
	"strings"
	"time"
)

// 휴면 (REQ-F-501, 1.396): putting a session to rest also stops its claude, the way the automatic tidy does
// (REQ-F-835 rule 5): the folder, the transcript and the session's record stay, and the session is not closed, so
// it never leaves "이어서 하기" after 7 days (REQ-F-742). Waking it starts claude again on the same conversation.

// REST_TOLD: what a rest says on every surface (REQ-F-570).
const REST_TOLD = "claude 를 내리고 숨겨요. 대화와 폴더는 남고, 열면 이어서 시작해요."

// restRefusal: a hold the agent named, said as why the rest waits.
func restRefusal(why string) string {
	switch why {
	case "작업 중":
		return "작업 중이라 지금은 휴면할 수 없어요. 턴이 끝난 뒤에 해 주세요"
	case "확인을 기다리는 중":
		return "확인 창이 답을 기다리고 있어 지금은 휴면할 수 없어요. 답한 뒤에 해 주세요"
	case "맡긴 일을 기다리는 중":
		return "맡긴 일을 기다리는 중이라 지금은 휴면할 수 없어요"
	case "자동 대응 중":
		return "자동 대응이 진행 중이라 지금은 휴면할 수 없어요"
	case "바뀌는 중":
		return "세션이 뜨거나 바뀌는 중이라 지금은 휴면할 수 없어요. 잠시 뒤에 해 주세요"
	}
	if why == "" {
		why = "알 수 없는 이유"
	}
	return "지금은 휴면할 수 없어요: " + why
}

// restSession puts meta to rest and stops its claude. It answers "" when done, or why it was not done (nothing
// changed then). A session whose claude is already down only gets the mark.
func restSession(meta *Sess) string {
	if truthy(meta.get("resting")) || truthy(meta.get("closed")) {
		meta.set("resting", true)
		return ""
	}
	if truthy(meta.get("moving")) {
		return "세션을 옮기는 중이라 지금은 휴면할 수 없어요"
	}
	// A session handed work closes itself once it has answered (REQ-F-760 rule 13): stopping it first would
	// leave the session that handed it the work waiting on nothing.
	if truthy(meta.get("delegatedBy")) {
		return "맡겨진 일을 하는 세션이라 휴면할 수 없어요. 답을 전하면 저절로 닫혀요"
	}
	if truthy(meta.state()["alive"]) {
		hostID := meta.host()
		if !online(hostID) {
			return "맥이 연결돼 있지 않아 지금은 claude 를 내릴 수 없어요"
		}
		hold := asM(tidyHolds(hostID)[meta.id()])
		if hold == nil {
			hold = M{}
		}
		// Who rests a locked session has its key (REQ-F-010): the lock is no reason here.
		hold["locked"] = false
		r := ask(hostID, M{"t": "tidyStop", "sids": []any{meta.id()}, "holds": M{meta.id(): hold}, "rest": true}, 60_000)
		if !truthy(r["ok"]) {
			return "claude 를 내리지 못했어요: " + orStr(r["error"], TIDY_OLD_AGENT)
		}
		res := asArr(r["results"])
		if len(res) == 0 {
			return "claude 를 내리지 못했어요"
		}
		if why := jsString(mget(res[0], "error")); !truthy(mget(res[0], "ok")) && !strings.HasPrefix(why, "이미 claude 가 내려가") {
			return restRefusal(why)
		}
		// Stopped: the agent's status (alive false) follows on its own.
		record(meta.uid(), hostID, M{"area": "tidy", "sid": meta.id(), "text": "휴면: claude 내림 " + jsStringU(meta.get("title"))})
	}
	meta.set("resting", true)
	meta.del("tidyStopAt")
	return ""
}

// wakeSession takes meta out of rest and, when its claude is down, starts it again on the same conversation in
// the background (the way a message to it does, REQ-F-835 rule 5). A Mac that is away leaves that to the next message.
func wakeSession(meta *Sess) {
	was := truthy(meta.get("resting"))
	meta.set("resting", false)
	if !was || truthy(meta.get("closed")) || truthy(meta.get("moving")) || truthy(meta.state()["alive"]) || !online(meta.host()) {
		return
	}
	done := make(chan struct{})
	waking[meta.id()] = done
	goLocked("wake", func() {
		defer func() {
			if waking[meta.id()] == done {
				delete(waking, meta.id())
			}
			close(done)
		}()
		if truthy(meta.get("closed")) || truthy(meta.get("moving")) || truthy(meta.state()["alive"]) || truthy(meta.get("resting")) || !online(meta.host()) {
			return
		}
		logEvents(meta, []any{M{"k": "line", "text": "🔄 휴면에서 깨워 대화 그대로 이어서 다시 엽니다."}})
		meta.set("bg", []any{})
		if err := try(func() { moveSession(meta, meta.host(), nil, nil) }); err != nil {
			logEvents(meta, []any{M{"k": "line", "text": "❌ claude 를 다시 띄우지 못했어요. " + err.Error() + " 글을 보내면 다시 열어요."}})
		}
	})
}

// waking: sid -> closed once the background wake of that session is over. Memory only.
var waking = map[string]chan struct{}{}

// waitWake: a message or command that comes while its session is being woken waits for claude to be up (at most
// WAKE_WAIT_MS) instead of being refused as "옮기는 중": opening a rested session wakes it, and the person may type
// at once.
func waitWake(meta *Sess) {
	ch := waking[meta.id()]
	if ch == nil {
		return
	}
	await(func() {
		select {
		case <-ch:
		case <-time.After(WAKE_WAIT_MS * time.Millisecond):
		}
	})
}

const WAKE_WAIT_MS = 90_000
