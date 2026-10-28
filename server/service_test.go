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

// IF-253: the token closes only the sessions it opened for that person, and closing twice is fine.
func TestServiceClose(t *testing.T) {
	keepT, keepU, keepA, keepUsers, keepAccess, keepS, keepData := SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, sessions, DATA
	defer func() {
		SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, sessions, DATA = keepT, keepU, keepA, keepUsers, keepAccess, keepS, keepData
	}()
	tok := "0123456789abcdef0123456789abcdef"
	SERVICE_TOKEN, SERVICE_UID, DATA = tok, "gh1", t.TempDir()
	users, access, sessions = newOMap[M](), newOMap[M](), newOMap[*Sess]()
	post := func(sid string) (status int) {
		r := httptest.NewRequest("POST", "/api/service/sessions/"+sid+"/close", nil)
		r.Header.Set("Authorization", "Bearer "+tok)
		req := newReq(r)
		res := newRes(req)
		withLock(func() {
			defer func() {
				if e, isRefuse := recover().(*Refuse); isRefuse {
					status = e.Status
				}
			}()
			serviceAPI(req, res, r.URL.Path)
			status = res.status
		})
		return status
	}
	withLock(func() {
		ALLOWED = []string{"svc-one"}
		users.Set("gh1", M{"login": "svc-one", "name": "svc-one", "avatar": ""})
		sessions.Set("svc", newSess(M{"id": "svc", "uid": "gh1", "host": "h1", "service": true}))
		sessions.Set("own", newSess(M{"id": "own", "uid": "gh1", "host": "h1"}))
		sessions.Set("other", newSess(M{"id": "other", "uid": "gh2", "host": "h2", "service": true}))
	})
	eq(t, post("svc"), 200, "a session it opened")
	withLock(func() {
		c, _ := sessions.Get("svc")
		ok(t, truthy(c.get("closed")), "closed after the call")
	})
	eq(t, post("svc"), 200, "closing again")
	eq(t, post("own"), 404, "the person's own session")
	eq(t, post("other"), 404, "someone else's session")
	eq(t, post("nope"), 404, "no such session")
	withLock(func() {
		for _, sid := range []string{"own", "other"} {
			c, _ := sessions.Get(sid)
			ok(t, !truthy(c.get("closed")), sid+" left open")
		}
	})
}
