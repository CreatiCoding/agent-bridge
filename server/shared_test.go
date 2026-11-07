// REQ-F-883 공유 디스크: each Mac's path to the shared disk, kept with the person's new-session settings, offered to
// the bridge MCP's hosts and used by delegate's shared.
package main

import (
	"strings"
	"testing"
)

func TestCleanShared(t *testing.T) {
	got := cleanShared(M{"h1": "/Volumes/Archive/bridge/", "h2": "~/../etc", "h3": "", "bad id!": "/x", "h4": 5})
	eq(t, jsonStr(got), `{"h1":"/Volumes/Archive/bridge"}`)
	eq(t, jsonStr(cleanShared(nil)), `{}`)
	many := M{}
	for i := 0; i < SHARED_MAX+5; i++ {
		many["h"+padStart(itoa(i), 2, "0")] = "/s"
	}
	eq(t, len(cleanShared(many)), SHARED_MAX)
	eq(t, jsonStr(cleanLaunch(M{"shared": M{"h1": "/mnt/m1share/bridge"}})["shared"]), `{"h1":"/mnt/m1share/bridge"}`)
}

func TestDelegateShared(t *testing.T) {
	delegateSetup(t)
	withLock(func() {
		prefsOf("gh1")["launch"] = M{"shared": M{"h1": "/Volumes/Archive/bridge"}}
	})
	var out any
	withLock(func() { out = runDelegate("gh1", "h1", M{"sid": "p1", "op": "hosts"}) })
	s := jsonStr(out)
	ok(t, strings.Contains(s, `"sharedFolder":"/Volumes/Archive/bridge"`), "h1 의 공유 폴더: "+s)
	ok(t, strings.Contains(s, `"name":"맥미니"`) && strings.Contains(s, `"sharedFolder":null`), "h2 는 null: "+s)
	refused := func(args M) string {
		var err error
		withLock(func() {
			err = try(func() { runDelegate("gh1", "h1", M{"sid": "p1", "op": "delegate", "args": args}) })
		})
		if err == nil {
			return ""
		}
		return err.Error()
	}
	e := refused(M{"host": "맥미니", "task": "일", "shared": true})
	ok(t, strings.Contains(e, "공유 폴더가 정해져 있지 않아요"), "공유 폴더 없는 맥: "+e)
	e = refused(M{"host": "맥미니", "task": "일", "shared": true, "cwd": "~/x"})
	ok(t, strings.Contains(e, "cwd 와 shared 는 함께 쓸 수 없어요"), "cwd 와 함께: "+e)
}
