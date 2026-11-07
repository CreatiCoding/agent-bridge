package main

// 정비 재부팅 (REQ-F-884): a Mac restarted on purpose. The agent decides and does it; the server checks what the page
// sends (IF-279), passes the agent's health `reboot` on (cleanReboot) and pushes its failure to the phone.

import "strings"

// REBOOT_COUNT_MAX: the largest minClones / minFreeGB taken (a bigger one is a typo, not a rule).
const REBOOT_COUNT_MAX = 100_000

// rebootPolicyCmd: the agent command for a policy the page sends, or why it is refused.
func rebootPolicyCmd(p M) (M, string) {
	whole := func(k string, lo, hi float64) (float64, bool) {
		f, ok := p[k].(float64)
		return f, ok && isInteger(f) && f >= lo && f <= hi
	}
	on, okOn := p["on"].(bool)
	day, okDay := whole("day", 0, 6)
	from, okFrom := whole("from", 0, 23)
	to, okTo := whole("to", 0, 23)
	clones, okClones := whole("minClones", 0, REBOOT_COUNT_MAX)
	free, okFree := whole("minFreeGB", 0, REBOOT_COUNT_MAX)
	if !okOn || !okDay || !okFrom || !okTo || from == to || !okClones || !okFree {
		return nil, "on 은 참·거짓, day 는 0~6, from·to 는 서로 다른 0~23 시, minClones·minFreeGB 는 0 이상의 정수예요"
	}
	cmd := M{"t": "rebootPolicy", "on": on, "day": day, "from": from, "to": to, "minClones": clones, "minFreeGB": free}
	if _, has := p["failMin"]; has {
		f, okFail := whole("failMin", 2, 60)
		if !okFail {
			return nil, "failMin 은 2~60분이에요"
		}
		cmd["failMin"] = f
	}
	return cmd, ""
}

// cleanReboot: health's `reboot` with only the fields the page reads. `masked` (an operator on someone else's Mac):
// the blockers lose their session names.
func cleanReboot(v any, masked bool) any {
	u, ok := v.(M)
	if !ok {
		return nil
	}
	if _, ok := u["on"].(bool); !ok {
		return nil
	}
	lines := func(k string) []any {
		out := []any{}
		for _, x := range asArr(u[k]) {
			s := jsSliceTo(jsString(x), 300)
			if masked && k == "blockers" {
				if i := strings.Index(s, ": "); i >= 0 {
					s = "세션: " + s[i+2:]
				}
			}
			out = append(out, s)
			if len(out) == 20 {
				break
			}
		}
		return out
	}
	var facts, last, due any
	if f, ok := u["facts"].(M); ok {
		var docker any
		if d, _ := f["docker"].(string); d == "running" || d == "stopped" {
			docker = d
		}
		facts = M{"clones": numOrNull(f["clones"]), "freeGB": numOrNull(f["freeGB"]), "docker": docker}
	}
	if l, ok := u["last"].(M); ok {
		last = M{"id": jsSliceTo(jsString(l["id"]), 64), "phase": jsSliceTo(jsString(l["phase"]), 20), "reason": jsSliceTo(jsString(l["reason"]), 200), "requestedAt": numOrNull(l["requestedAt"]), "backAt": numOrNull(l["backAt"]), "failedAt": numOrNull(l["failedAt"]), "error": nil}
		if e, ok := l["error"].(string); ok && e != "" {
			last.(M)["error"] = jsSliceTo(e, 300)
		}
	}
	if d, ok := u["due"].(string); ok && d != "" {
		due = jsSliceTo(d, 300)
	}
	return M{"on": u["on"], "day": numOrNull(u["day"]), "from": numOrNull(u["from"]), "to": numOrNull(u["to"]), "minClones": numOrNull(u["minClones"]), "minFreeGB": numOrNull(u["minFreeGB"]), "failMin": numOrNull(u["failMin"]),
		"supported": u["supported"] != false, "facts": facts, "preflight": lines("preflight"), "blockers": lines("blockers"), "due": due, "last": last}
}

// rebootFailedNotice: the phone's notice when a restart asked for did not happen within failMin minutes.
func rebootFailedNotice(hostID string, msg M) M {
	hn := ""
	if h, ok := hosts.Get(hostID); ok && h["name"] != nil {
		hn = jsString(h["name"]) + " · "
	}
	min := "몇"
	if f, ok := msg["min"].(float64); ok && isInteger(f) && f > 0 && f <= 60 {
		min = numStr(f)
	}
	return M{"key": "reboot-" + hostID + "-" + jsSliceTo(jsString(msg["id"]), 64), "title": "정비 재부팅이 되지 않았어요", "text": hn + "정비 재부팅이 " + min + "분 안에 되지 않았어요 (저장하지 않은 문서 창 등)", "tone": "warn", "push": "always"}
}
