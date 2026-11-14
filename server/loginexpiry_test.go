package main

// Claude 로그인 만료 알림 (REQ-F-910): one push three days before each account's end date, once per date.

import (
	"strings"
	"testing"
)

func TestLoginExpiryNotices(t *testing.T) {
	day := float64(86_400_000)
	now := float64(1_800_000_000_000)
	h := M{"name": "맥미니", "accounts": cleanAccounts([]any{
		M{"id": "", "name": "기본 계정", "loggedIn": true, "expiresAt": now + 2.5*day},
		M{"id": "a0123abcd", "name": "회사", "loggedIn": true, "expiresAt": now + 6*day},
		M{"id": "a0123abce", "name": "나간 계정", "loggedIn": false, "expiresAt": now + 1*day},
	})}
	got := loginExpiryNotices("h1", h, now)
	if len(got) != 1 {
		t.Fatalf("want one notice (the main account, 3 days or less), got %v", got)
	}
	if !strings.Contains(jsString(got[0]["text"]), "맥미니 · 기본 계정 의 Claude 로그인이 3일 뒤 끝나요") || got[0]["push"] != "always" {
		t.Fatalf("notice: %v", got[0])
	}
	if again := loginExpiryNotices("h1", h, now+day); len(again) != 0 {
		t.Fatalf("the same end date is warned once, got %v", again)
	}
	// Renewed, then near its new end: warned again.
	asM(asArr(h["accounts"])[0])["expiresAt"] = now + 30*day
	// Day 4: 회사 (6 days) is 2 days off; the main one's new date is far.
	if n := loginExpiryNotices("h1", h, now+4*day); len(n) != 1 || !strings.Contains(jsString(n[0]["text"]), "회사 의 Claude 로그인이 2일 뒤") {
		t.Fatalf("day 4: %v", n)
	}
	// Day 28: the main one's new date; 회사 has ended, but that date was warned about already.
	if n := loginExpiryNotices("h1", h, now+28*day); len(n) != 1 || !strings.HasPrefix(jsString(n[0]["key"]), "login-exp|h1||") {
		t.Fatalf("a new end date is warned when its turn comes: %v", n)
	}
	// First seen after it ended.
	fresh := M{"accounts": cleanAccounts([]any{M{"id": "", "loggedIn": true, "expiresAt": now - day}})}
	if n := loginExpiryNotices("h2", fresh, now); len(n) != 1 || n[0]["title"] != "Claude 로그인이 끝났어요" {
		t.Fatalf("ended: %v", n)
	}
}

func TestCleanAccountsExpiry(t *testing.T) {
	out := cleanAccounts([]any{M{"id": "", "loggedIn": true, "expiresAt": float64(1_800_000_000_000), "renewedAt": float64(1_700_000_000_000), "sameAccount": false, "email": "x@y.z"}, M{"id": "a0123abcd", "expiresAt": "soon"}})
	a, b := asM(out[0]), asM(out[1])
	if a["expiresAt"] != float64(1_800_000_000_000) || a["sameAccount"] != false || a["renewedAt"] == nil {
		t.Fatalf("kept: %v", a)
	}
	if _, ok := b["expiresAt"]; ok {
		t.Fatalf("a date that is not a number is dropped: %v", b)
	}
	if _, ok := b["sameAccount"]; ok {
		t.Fatalf("no renewal, no sameAccount: %v", b)
	}
}
