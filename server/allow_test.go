// 전부 허용 that asks nothing (REQ-F-796): how a launch mode turns into the two flags, and what a copy keeps.
package main

import "testing"

func TestStartModeAllowAll(t *testing.T) {
	for _, c := range []struct {
		in, mode string
		auto     bool
	}{{"allowAll", "default", true}, {"autoAllow", "default", true}, {"plan", "plan", false}, {"", "", false}} {
		m, a := startMode(c.in)
		eq(t, m, c.mode, c.in)
		eq(t, a, c.auto, c.in)
	}
	ok(t, contains(LAUNCH_MODES, "allowAll"), "allowAll is a launch mode")
}

func TestInheritAllow(t *testing.T) {
	uid := "allow-test-user"
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]()
	defer delete(prefsCache, uid)
	orig := newMeta(uid, "allow-orig", "no-host", M{})
	defer sessions.Delete("allow-orig")
	mk := func(id string) *Sess {
		t.Cleanup(func() { sessions.Delete(id) })
		return newMeta(uid, id, "no-host", M{})
	}

	// The original's 전부 허용 goes with the copy as it is.
	orig.set("autoAllow", true)
	orig.set("allowAll", true)
	cp := mk("allow-cp1")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "allowAll", "copy of 전부 허용")

	orig.set("allowAll", false)
	cp = mk("allow-cp2")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "autoAllow", "copy of 안전한 전부 허용")

	// An original that asks: the person's defaults.
	orig.set("autoAllow", false)
	prefsOf(uid)["launch"] = M{"mode": "allowAll"}
	cp = mk("allow-cp3")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "allowAll", "default 전부 허용")

	prefsOf(uid)["launch"] = M{"mode": "plan"}
	cp = mk("allow-cp4")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "", "asks")

	// allowAll alone (no autoAllow) is not 전부 허용.
	cp.set("allowAll", true)
	eq(t, allowModeOf(cp), "", "allowAll without autoAllow")
}

// 제보 고치기 세션의 모드 (REQ-F-738 rule 2, AC-1205): only the operator's own report under 자동 대응 is 전부 허용.
func TestReportMode(t *testing.T) {
	eq(t, reportMode(true, true), "allowAll", "operator's own report, 자동 대응")
	eq(t, reportMode(true, false), "", "operator's own report, manual: their defaults")
	eq(t, reportMode(false, true), "default", "someone else's report, 자동 대응")
	eq(t, reportMode(false, false), "default", "someone else's report, manual")
}

// A Mac that signs (trust warn·enforce) and takes 전부 허용 with new (REQ-F-860, AC-1616): a copy keeps only the
// original's, which the Mac keeps itself, and the person's defaults are not turned on by an unsigned set.
func TestInheritAllowSigningHost(t *testing.T) {
	uid := "allow-sign-user"
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]()
	host := "allow-sign-host"
	hosts.Set(host, M{"uid": uid, "trust": M{"mode": "enforce"}})
	defer delete(liveStatus, host)
	live(host)["caps"] = []any{"store", "newAllow"}
	defer delete(prefsCache, uid)
	ok(t, hostSigns(host), "enforce signs")
	ok(t, hostHasCap(host, "newAllow"), "cap")
	orig := newMeta(uid, "allow-sorig", host, M{})
	defer sessions.Delete("allow-sorig")
	mk := func(id string) *Sess {
		t.Cleanup(func() { sessions.Delete(id) })
		return newMeta(uid, id, host, M{})
	}
	orig.set("autoAllow", true)
	orig.set("allowAll", true)
	cp := mk("allow-scp1")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "allowAll", "the original's, kept by the Mac")

	orig.set("autoAllow", false)
	prefsOf(uid)["launch"] = M{"mode": "allowAll"}
	cp = mk("allow-scp2")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "", "defaults are not turned on unsigned")

	hosts.Val(host)["trust"] = M{"mode": "off"}
	ok(t, !hostSigns(host), "off does not sign")
	cp = mk("allow-scp3")
	inheritAllow(cp, orig, uid)
	eq(t, allowModeOf(cp), "allowAll", "trust off: defaults as before")
}
