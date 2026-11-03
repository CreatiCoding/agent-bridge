// Service API token check (REQ-F-799).
package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
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
		_, has := sessions.Get("svc")
		ok(t, !has, "closed and off the list after the call (1.376)")
	})
	eq(t, post("svc"), 404, "closing again: already gone")
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

// AC-1503 (IF-259): the token lists only that person's Macs, with versions and whether each is connected.
func TestServiceHosts(t *testing.T) {
	keepT, keepU, keepA, keepUsers, keepAccess, keepH, keepB := SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, hosts, bridges
	defer func() {
		SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, hosts, bridges = keepT, keepU, keepA, keepUsers, keepAccess, keepH, keepB
	}()
	tok := "0123456789abcdef0123456789abcdef"
	SERVICE_TOKEN, SERVICE_UID = tok, "gh1"
	users, access, hosts, bridges = newOMap[M](), newOMap[M](), newOMap[M](), newOMap[Sink]()
	call := func(method string) (int, string) {
		r := httptest.NewRequest(method, "/api/service/hosts", nil)
		r.Header.Set("Authorization", "Bearer "+tok)
		req := newReq(r)
		res := newRes(req)
		status := 0
		withLock(func() {
			defer func() {
				if e, isRefuse := recover().(*Refuse); isRefuse {
					status = e.Status
				}
			}()
			serviceAPI(req, res, r.URL.Path)
			status = res.status
		})
		return status, string(res.body)
	}
	withLock(func() {
		ALLOWED = []string{"svc-one"}
		users.Set("gh1", M{"login": "svc-one", "name": "svc-one", "avatar": ""})
		hosts.Set("h1", M{"uid": "gh1", "name": "맥 미니", "kind": "mac", "lastSeen": float64(1000), "home": "/Users/me", "info": M{"version": "1.2", "build": "b9", "node": "v22", "os": "darwin 24.6.0"}})
		hosts.Set("h2", M{"uid": "gh1", "name": "맥북", "lastSeen": float64(2000)})
		hosts.Set("h3", M{"uid": "gh2", "name": "남의 맥"})
		bridges.Set("h1", newStream(nil))
	})
	code, body := call("GET")
	eq(t, code, 200, body)
	var out struct {
		Hosts []map[string]any `json:"hosts"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err, body)
	}
	eq(t, len(out.Hosts), 2, body)
	by := map[string]map[string]any{}
	for _, h := range out.Hosts {
		by[h["id"].(string)] = h
	}
	eq(t, by["h1"]["online"], true)
	eq(t, by["h1"]["os"], "darwin 24.6.0")
	eq(t, by["h1"]["version"], "1.2")
	eq(t, by["h2"]["online"], false)
	_, hasHome := by["h1"]["home"]
	ok(t, !hasHome, "no home folder")
	code, _ = call("POST")
	eq(t, code, 404, "only GET")
}

// 1.410: a retry with the same key gets the session the first try opened (its answer lost to a 502 while a deploy
// swapped the server), never someone else's, a closed one or the person's own.
func TestServiceStartKey(t *testing.T) {
	keepT, keepU, keepA, keepUsers, keepAccess, keepS, keepData, keepH := SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, sessions, DATA, hosts
	defer func() {
		SERVICE_TOKEN, SERVICE_UID, ALLOWED, users, access, sessions, DATA, hosts = keepT, keepU, keepA, keepUsers, keepAccess, keepS, keepData, keepH
	}()
	tok := "0123456789abcdef0123456789abcdef"
	SERVICE_TOKEN, SERVICE_UID, DATA = tok, "gh1", t.TempDir()
	users, access, sessions, hosts = newOMap[M](), newOMap[M](), newOMap[*Sess](), newOMap[M]()
	post := func(key string) (status int, out M) {
		r := httptest.NewRequest("POST", "/api/service/sessions", strings.NewReader(string(jsonBytes(M{"prompt": "hi", "host": "nope", "key": key}))))
		r.Header.Set("Authorization", "Bearer "+tok)
		r.Header.Set("Content-Type", "application/json")
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
		if status == 200 {
			v, _ := parseJSON(res.body)
			out, _ = v.(M)
		}
		return
	}
	withLock(func() {
		ALLOWED = []string{"svc-one"}
		users.Set("gh1", M{"login": "svc-one", "name": "svc-one", "avatar": ""})
		sessions.Set("svc", newSess(M{"id": "svc", "uid": "gh1", "host": "h1", "service": true, "serviceKey": "run-1"}))
		sessions.Set("gone", newSess(M{"id": "gone", "uid": "gh1", "host": "h1", "service": true, "serviceKey": "run-2", "closed": true}))
		sessions.Set("own", newSess(M{"id": "own", "uid": "gh1", "host": "h1", "serviceKey": "run-3"}))
		sessions.Set("other", newSess(M{"id": "other", "uid": "gh2", "host": "h2", "service": true, "serviceKey": "run-4"}))
	})
	st, out := post("run-1")
	eq(t, st, 200, "same key: the session already opened")
	eq(t, out["id"], "svc", "its id")
	eq(t, out["reused"], true, "marked reused")
	for _, k := range []string{"run-2", "run-3", "run-4", "run-5"} {
		st, _ = post(k)
		eq(t, st, 404, k+": not reused, goes on to open one (no such Mac here)")
	}
	st, _ = post("bad key!")
	eq(t, st, 400, "a key outside [A-Za-z0-9._:-]{1,128}")
}
