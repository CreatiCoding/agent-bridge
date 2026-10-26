// Service API token check (REQ-F-799).
package main

import (
	"net/http/httptest"
	"testing"
)

func TestServiceAuth(t *testing.T) {
	keepT, keepU := SERVICE_TOKEN, SERVICE_UID
	defer func() { SERVICE_TOKEN, SERVICE_UID = keepT, keepU }()
	req := func(auth string) *Req {
		r := httptest.NewRequest("GET", "/api/service/sessions/x", nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		return newReq(r)
	}
	tok := "0123456789abcdef0123456789abcdef"

	SERVICE_TOKEN, SERVICE_UID = "", ""
	ok(t, !serviceAuthOk(req("Bearer ")), "off when no token is set: an empty bearer must not pass")
	SERVICE_TOKEN = tok
	ok(t, !serviceAuthOk(req("Bearer "+tok)), "off without BRIDGE_SERVICE_UID")
	SERVICE_UID = "gh1"
	ok(t, serviceAuthOk(req("Bearer "+tok)), "right token")
	ok(t, !serviceAuthOk(req("Bearer "+tok+"x")), "longer token")
	ok(t, !serviceAuthOk(req("bearer "+tok)), "scheme is case-sensitive as written")
	ok(t, !serviceAuthOk(req(tok)), "no scheme")
	ok(t, !serviceAuthOk(req("")), "no header")

	status := func(r *Req) int {
		defer func() {
			if x := recover(); x != nil {
				if rf, isRefuse := x.(*Refuse); isRefuse {
					panic(rf.Status)
				}
				panic(x)
			}
		}()
		serviceAPI(r, nil, r.URL.Path)
		return 0
	}
	got := func(r *Req) (code int) {
		defer func() {
			if x := recover(); x != nil {
				code = x.(int)
			}
		}()
		return status(r)
	}
	eq(t, got(req("Bearer nope")), 401, "wrong token")
	keepA, keepUsers, keepAccess := ALLOWED, users, access
	defer func() { ALLOWED, users, access = keepA, keepUsers, keepAccess }()
	users, access = newOMap[M](), newOMap[M]()
	withLock(func() {
		ALLOWED = []string{"svc-one"}
		eq(t, got(req("Bearer "+tok)), 403, "right token, but its account does not exist")
		users.Set("gh1", M{"login": "svc-one", "name": "svc-one", "avatar": ""})
		eq(t, got(req("Bearer "+tok)), 404, "a session it did not start is not found")
		ALLOWED = nil
		eq(t, got(req("Bearer "+tok)), 403, "its account taken off the allow-list")
	})
}

// The token acts as BRIDGE_SERVICE_UID only while that account exists and is allowed (REQ-S-085).
func TestServiceUidActive(t *testing.T) {
	keepA, keepAd, keepUsers, keepAccess := ALLOWED, ADMINS, users, access
	defer func() { ALLOWED, ADMINS, users, access = keepA, keepAd, keepUsers, keepAccess }()
	users, access = newOMap[M](), newOMap[M]()
	withLock(func() {
		ADMINS = nil
		ALLOWED = []string{"svc-user"}
		uid := "gh-svc-test-1"
		ok(t, !serviceUidActive(uid), "no such account")
		users.Set(uid, M{"login": "svc-user", "name": "svc-user", "avatar": ""})
		ok(t, serviceUidActive(uid), "allowed account")
		ALLOWED = []string{"someone-else"}
		ok(t, !serviceUidActive(uid), "taken off the allow-list")
		ALLOWED = []string{"*"}
		access.Set("svc-user", M{"login": "svc-user", "status": "denied"})
		ok(t, !serviceUidActive(uid), "denied by an operator")
	})
}
