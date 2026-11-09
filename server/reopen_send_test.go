// REQ-F-297 rule 6 (AC-1713): a reopen before a send that fails leaves its reason in the conversation.
package main

import (
	"strings"
	"testing"
)

func TestReopenToSendFailureSaysWhy(t *testing.T) {
	uid := "reopen-send-user"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	defer func() { DATA, hosts = wasData, wasHosts }()
	id := "reopen-send-sess"
	t.Cleanup(func() { sessions.Delete(id) })
	meta := newMeta(uid, id, "no-host", M{})
	var code int
	withLock(func() { code = refused(func() { reopenToSend(meta) }) })
	eq(t, code, 409, "refused as moveSession refused")
	t.Cleanup(func() { tails.Delete(id) })
	evs, _ := tails.Get(id)
	raw := jsonStr(evs)
	if !strings.Contains(raw, `"tone":"warn"`) || !strings.Contains(raw, REOPEN_FAILED+"받는 호스트가 연결돼 있지 않습니다") {
		t.Fatalf("notice with the reason missing: %s", raw)
	}
}
