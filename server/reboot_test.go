// REQ-F-884 정비 재부팅: what the page may send (IF-279), what health's `reboot` shows, and the failure notice.
package main

import (
	"strings"
	"testing"
)

func TestRebootPolicyCmd(t *testing.T) {
	good := M{"on": true, "day": 0.0, "from": 4.0, "to": 6.0, "minClones": 40.0, "minFreeGB": 30.0}
	cmd, bad := rebootPolicyCmd(good)
	eq(t, bad, "")
	eq(t, jsonStr(cmd), `{"t":"rebootPolicy","day":0,"from":4,"minClones":40,"minFreeGB":30,"on":true,"to":6}`)
	with := func(k string, v any) M {
		m := shallow(good)
		m[k] = v
		return m
	}
	for _, p := range []M{nil, with("on", "yes"), with("day", 7.0), with("day", 1.5), with("from", 24.0), with("to", 4.0), with("minClones", -1.0), with("minFreeGB", 2.5), with("failMin", 1.0), with("failMin", 61.0)} {
		_, bad := rebootPolicyCmd(p)
		ok(t, bad != "", "거절해야 함: "+jsonStr(p))
	}
	cmd, bad = rebootPolicyCmd(with("failMin", 15.0))
	eq(t, bad, "")
	eq(t, cmd["failMin"], any(15.0))
}

func TestCleanReboot(t *testing.T) {
	eq(t, cleanReboot(nil, false) == nil, true)
	eq(t, cleanReboot(M{"on": "x"}, false) == nil, true)
	h := M{"on": false, "day": 0.0, "from": 4.0, "to": 6.0, "minClones": 40.0, "minFreeGB": 30.0, "failMin": 10.0, "supported": true,
		"facts":     M{"clones": 111.0, "freeGB": 12.0, "docker": "running", "services": M{"x": 1.0}},
		"preflight": []any{"자동 로그인이 creco 로 켜져 있지 않아요"}, "blockers": []any{"my-repo: 턴이 도는 중"},
		"due": "Chrome 복제본 111개(기준 40개)", "last": M{"id": "r1", "phase": "failed", "requestedAt": 5.0, "error": "10분 안에 재부팅되지 않음", "resume": []any{1.0}}, "extra": 1.0}
	s := jsonStr(cleanReboot(h, false))
	ok(t, strings.Contains(s, `"facts":{"clones":111,"docker":"running","freeGB":12}`), s)
	ok(t, strings.Contains(s, `"blockers":["my-repo: 턴이 도는 중"]`), s)
	ok(t, strings.Contains(s, `"phase":"failed"`) && strings.Contains(s, `"error":"10분 안에 재부팅되지 않음"`), s)
	ok(t, !strings.Contains(s, "services") && !strings.Contains(s, "resume") && !strings.Contains(s, "extra"), "모르는 칸은 빠짐: "+s)
	// An operator on someone else's Mac: no session names.
	m := jsonStr(cleanReboot(h, true))
	ok(t, strings.Contains(m, `"blockers":["세션: 턴이 도는 중"]`) && !strings.Contains(m, "my-repo"), m)
	// Linux: no facts.
	eq(t, jsonStr(cleanReboot(M{"on": false, "supported": false}, false).(M)["supported"]), "false")
}

func TestRebootFailedNotice(t *testing.T) {
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]()
	hosts.Set("h1", M{"name": "iMac"})
	n := rebootFailedNotice("h1", M{"id": "r1", "min": 10.0})
	eq(t, n["text"], any("iMac · 정비 재부팅이 10분 안에 되지 않았어요 (저장하지 않은 문서 창 등)"))
	eq(t, n["key"], any("reboot-h1-r1"))
	eq(t, n["push"], any("always"))
	eq(t, rebootFailedNotice("gone", M{"min": "x"})["text"], any("정비 재부팅이 몇분 안에 되지 않았어요 (저장하지 않은 문서 창 등)"))
}
