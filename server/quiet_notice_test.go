package main

import "testing"

// AC-1626 (1.441): a finished background job leaves nothing in the notice list.
func TestNoNoticeForFinishedJob(t *testing.T) {
	uid, hostID := "qn-user", "qn-host"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	needUsers()
	defer func() { DATA, hosts = wasData, wasHosts }()
	hosts.Set(hostID, M{"uid": uid, "name": "맥"})
	defer delete(noticeCache, uid)
	t.Cleanup(func() { sessions.Delete("qn-s1") })
	var meta *Sess
	withLock(func() {
		meta = newMeta(uid, "qn-s1", hostID, M{"title": "일"})
		meta.set("seq", 1.0)
		meta.set("bg", []any{M{"toolUseId": "tu1", "kind": "bash"}})
		line := `{"type":"user","message":{"content":"<task-notification><tool-use-id>tu1</tool-use-id><status>failed</status><summary>npm test failed</summary></task-notification>"}}`
		trackBackgroundLine(meta, line)
	})
	eq(t, len(asArr(meta.get("bg"))), 0, "끝난 작업은 bg 에서 빠짐")
	eq(t, len(noticesOf(uid, nil)), 0, "알림 목록에 남기지 않음")
}
