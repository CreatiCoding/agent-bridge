package main

// A permission card's notice names the session, the Mac and the call, and is pushed even with a desk's tab in front
// (REQ-F-795, AC-1429).

import "testing"

func TestPermissionNotice(t *testing.T) {
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]()
	hosts.Set("h1", M{"name": "iMac"})
	meta := newSess(M{"id": "s1", "title": "배포", "cwd": "/w"})
	c := M{"id": "card0001", "kind": "permission", "title": "Do you want to proceed?", "tool": M{"name": "Bash", "input": M{"command": "git push origin main"}}}

	n := permissionNotice(meta, "h1", c, "card|c1", "")
	if n["title"] != "🔐 권한 요청 · 배포" || n["push"] != "always" || n["key"] != "card|c1" {
		t.Fatal(jsonStr(n))
	}
	if n["text"] != "iMac · Bash: git push origin main" {
		t.Fatalf("text %q", n["text"])
	}
	r := permissionNotice(meta, "h1", c, "remind|c1|1", "⏰ 5분째 기다리는 중")
	if r["text"] != "⏰ 5분째 기다리는 중 · iMac · Bash: git push origin main" {
		t.Fatalf("remind %q", r["text"])
	}
	// No options: no buttons. With allow-once and deny among them: their numbers, for the notification's 허용·거부.
	if n["act"] != nil {
		t.Fatal(jsonStr(n))
	}
	c["options"] = []any{M{"n": 1.0, "kind": "allow-once"}, M{"n": 2.0, "kind": "allow-session"}, M{"n": 3.0, "kind": "deny"}}
	if a := permissionNotice(meta, "h1", c, "card|c1", "")["act"]; jsonStr(a) != jsonStr(M{"card": "card0001", "allow": 1.0, "deny": 3.0}) {
		t.Fatal(jsonStr(a))
	}
	// No tool (a dialog Claude Code asks without one): its own question stands in, and an unknown Mac is left out.
	if x := permissionNotice(newSess(M{"id": "s2"}), "gone", M{"id": "c2", "title": "Allow?"}, "card|c2", ""); x["title"] != "🔐 권한 요청 · 세션" || x["text"] != "Allow?" {
		t.Fatal(jsonStr(x))
	}
}
