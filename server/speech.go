package main

import "strings"

// 리눅스 세션의 받아쓰기 (REQ-F-908): whisper.cpp is too slow on a small Linux machine, so a session there has its
// recordings written by another of the person's Macs: online, macOS, not sealing. (The voice that reads answers stays on
// the Linux machine itself, agent/talk.mjs.) Never for a machine that seals its own conversations, nor when the page
// says the session's machine is paired with it (`away` false): those stay where they are, and the person is told why.

func hostOS(id string) string { return mstr(hosts.Val(id)["info"], "os") }
func hostSeals(id string) bool {
	return truthy(mget(mget(hosts.Val(id), "trust"), "seal"))
}

func hasTalkVoice(id string) bool { return containsAny(asArr(live(id)["caps"]), "talkVoice") }

// voiceHost (REQ-F-911): the Mac that reads this session's answers in 소희's voice: the session's own when it has her,
// else another online Mac of the same person that has her and does not seal. Not for a machine that seals its own
// conversations, nor one the page says is paired with it (away false): "" then, and the session's machine reads.
func voiceHost(uid string, meta *Sess, away bool) string {
	own := liveHost(meta)
	if hasTalkVoice(own) {
		return own
	}
	if hostSeals(own) || !away {
		return ""
	}
	for _, id := range hosts.Keys() {
		h := hosts.Val(id)
		if id != own && h != nil && mstr(h, "uid") == uid && online(id) && hasTalkVoice(id) && !hostSeals(id) {
			return id
		}
	}
	return ""
}

// speechHost: the machine that writes down what is said in this session: its own unless that is Linux.
func speechHost(uid string, meta *Sess, away bool) string {
	own := liveHost(meta)
	if !strings.HasPrefix(hostOS(own), "Linux") {
		return own
	}
	if hostSeals(own) {
		refuseX(409, "대화를 봉인하는 기계라 음성을 다른 맥에 맡기지 않아요", M{"code": "sealed"})
	}
	if !away {
		refuseX(409, "이 기기와 짝지은 기계라 음성을 다른 맥에 맡기지 않아요", M{"code": "paired"})
	}
	for _, id := range hosts.Keys() {
		h := hosts.Val(id)
		if id != own && h != nil && mstr(h, "uid") == uid && online(id) && strings.HasPrefix(hostOS(id), "Darwin") && !hostSeals(id) {
			return id
		}
	}
	refuseX(409, "리눅스 세션의 음성을 맡을 맥이 없어요. 맥 미니나 맥북을 켜 주세요", M{"code": "nohost"})
	return ""
}
