// REQ-F-742 and REQ-F-738 rule 6: which ended sessions sweepEnded takes off the list.
package main

import "testing"

func TestSweepEndedTakesDeployedAutoFix(t *testing.T) {
	uid := "ended-test-user"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	defer func() { DATA, hosts = wasData, wasHosts }()
	defer delete(prefsCache, uid)
	now := float64(nowMs())
	day := 86_400_000.0
	mk := func(id string, fields M) {
		t.Cleanup(func() { sessions.Delete(id) })
		newMeta(uid, id, "no-host", fields).set("lastAt", fields["lastAt"])
	}
	mk("ended-recent", M{"closed": true, "closedAt": now - day, "lastAt": now - day})
	mk("ended-old", M{"closed": true, "closedAt": now - 8*day, "lastAt": now - 8*day})
	mk("ended-auto", M{"closed": true, "closedAt": now - day, "lastAt": now - day, "reportAuto": "r1", "reportDeployed": true})
	mk("ended-auto-undeployed", M{"closed": true, "closedAt": now - day, "lastAt": now - day, "reportAuto": "r2"})
	mk("open-auto", M{"lastAt": now, "reportAuto": "r3", "reportDeployed": true})
	mk("ended-service", M{"closed": true, "closedAt": now - day, "lastAt": now - day, "service": true})
	mk("open-service", M{"lastAt": now, "service": true})

	var n int
	withLock(func() { n = sweepEnded(now) })
	eq(t, n, 3, "removed")
	for id, kept := range map[string]bool{"ended-recent": true, "ended-old": false, "ended-auto": false, "ended-auto-undeployed": true, "open-auto": true, "ended-service": false, "open-service": true} {
		_, has := sessions.Get(id)
		eq(t, has, kept, id)
	}
}
