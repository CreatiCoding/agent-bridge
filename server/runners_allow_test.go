package main

import "testing"

// REQ-F-856 (AC-1604): a runner that can do 전부 허용 takes `:mode autoAllow|allowAll` and `:auto`, never Claude
// Code's other permission modes; one that cannot is refused all of them.
func TestRunnerGateAllowModes(t *testing.T) {
	was := hosts
	defer func() { hosts = was }()
	gate := func(caps []any, op string, b M) (code int) {
		hosts = newOMap[M]()
		hosts.Set("hR", M{"uid": "gh1", "runners": []any{M{"id": "codex", "caps": caps}}})
		defer func() {
			if r, ok := recover().(*Refuse); ok {
				code = r.Status
			}
		}()
		runnerGate(&Sess{m: M{"hostId": "hR", "runner": "codex"}}, op, b)
		return 0
	}
	can := []any{"cards", "autoAllow"}
	for _, arg := range []string{"autoAllow", "allowAll"} {
		if c := gate(can, "do", M{"cmd": "mode", "arg": arg}); c != 0 {
			t.Fatalf("%s 거절됨: %d", arg, c)
		}
		if c := gate([]any{"cards"}, "do", M{"cmd": "mode", "arg": arg}); c != 409 {
			t.Fatalf("autoAllow 없는 실행기의 %s: %d", arg, c)
		}
	}
	if c := gate(can, "do", M{"cmd": "mode", "arg": "plan"}); c != 409 {
		t.Fatalf("plan 은 codex 의 모드가 아님: %d", c)
	}
	if c := gate(can, "do", M{"cmd": "auto", "arg": "off"}); c != 0 {
		t.Fatalf("전부 허용 끄기: %d", c)
	}
	if c := gate(can, "settings", M{"autoAllow": true, "allowAll": true}); c != 0 {
		t.Fatalf("settings 로 켜기: %d", c)
	}
}
