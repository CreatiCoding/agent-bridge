package main

import "testing"

// 메시지 앞에 붙일 글 (REQ-F-869, AC-1628): put before what a person sends, except commands, empty texts and a Mac
// that signs.
func TestWithMsgPrefix(t *testing.T) {
	uid := "prefix-user"
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]()
	hosts.Set("pfx-off", M{"uid": uid, "trust": M{"mode": "off"}})
	hosts.Set("pfx-none", M{"uid": uid})
	hosts.Set("pfx-sign", M{"uid": uid, "trust": M{"mode": "enforce"}})
	defer delete(prefsCache, uid)

	eq(t, withMsgPrefix(uid, "pfx-off", "안녕"), "안녕", "no prefix saved")
	prefsOf(uid)["msgPrefix"] = "  한국어로 답해.  "
	eq(t, msgPrefixOf(uid), "한국어로 답해.")
	eq(t, withMsgPrefix(uid, "pfx-off", "fix it"), "한국어로 답해.\n\nfix it")
	eq(t, withMsgPrefix(uid, "pfx-none", "fix it"), "한국어로 답해.\n\nfix it", "a Mac that sent no trust state")
	eq(t, withMsgPrefix(uid, "pfx-sign", "fix it"), "fix it", "a signing Mac gets the signed text")
	eq(t, withMsgPrefix(uid, "pfx-off", " /compact"), " /compact", "slash command")
	eq(t, withMsgPrefix(uid, "pfx-off", ":model"), ":model", "codex-style command")
	eq(t, withMsgPrefix(uid, "pfx-off", "!ls"), "!ls", "shell command")
	eq(t, withMsgPrefix(uid, "pfx-off", "  "), "  ", "empty text")
}
