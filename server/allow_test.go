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
