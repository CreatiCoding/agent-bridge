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

// REQ-F-888: the disk info command carries the Mac's shared-disk path from its owner's prefs, and only info does.
func TestDiskCmdShared(t *testing.T) {
	delegateSetup(t)
	withLock(func() {
		prefsOf("gh1")["launch"] = M{"shared": M{"h1": "/Volumes/M3/bridge/works"}}
	})
	var info, scan, other M
	withLock(func() {
		info = diskCmd("gh1", "h1", "info", M{})
		scan = diskCmd("gh1", "h1", "scan", M{"path": "~"})
		other = diskCmd("gh1", "h2", "info", M{})
	})
	eq(t, jsonStr(info), `{"t":"disk","op":"info","shared":"/Volumes/M3/bridge/works"}`)
	eq(t, jsonStr(scan), `{"t":"disk","op":"scan","path":"~"}`)
	eq(t, jsonStr(other), `{"t":"disk","op":"info"}`)
	// 1.485: the light op shared carries the same path, and nothing else of the body.
	var sh M
	withLock(func() { sh = diskCmd("gh1", "h1", "shared", M{"path": "~", "id": "x"}) })
	eq(t, jsonStr(sh), `{"t":"disk","id":"x","op":"shared","path":"~","shared":"/Volumes/M3/bridge/works"}`)
}

// REQ-F-888 (1.485): op shared is a known disk op with the info's access rules. A Mac with no shared disk set is not
// asked at all; disk_look may ask for it, disk_clean may not; someone who may not see the host is refused like info.
func TestDiskRunShared(t *testing.T) {
	parent, r := delegateSetup(t)
	ok(t, DISK_WAITS["shared"] > 0 && DISK_WAITS["shared"] < DISK_WAITS["info"], "shared 는 info 보다 짧게 기다려요")
	ok(t, contains(DISK_TOOL_OPS["disk_look"], "shared") && !contains(DISK_TOOL_OPS["disk_clean"], "shared"), "disk_look 만 shared")
	var out any
	var err error
	withLock(func() { err = try(func() { out = diskRun("gh1", "h2", M{"op": "shared"}) }) })
	ok(t, err == nil, "주인은 받아요")
	eq(t, jsonStr(out), `{"shared":null}`)
	eq(t, len(r.sent), 0)
	withLock(func() {
		err = try(func() {
			out = runDiskTool("gh1", parent.host(), M{"sid": "p1", "op": "disk_look", "args": M{"host": "h2", "op": "shared"}})
		})
	})
	ok(t, err == nil, "disk_look shared")
	eq(t, jsonStr(out), `{"shared":null}`)
	withLock(func() {
		err = try(func() {
			runDiskTool("gh1", parent.host(), M{"sid": "p1", "op": "disk_clean", "args": M{"host": "h2", "op": "shared"}})
		})
	})
	ok(t, err != nil && strings.Contains(err.Error(), "disk_clean 로는 shared 를 할 수 없어요"), "disk_clean 은 못 해요")
	withLock(func() { err = try(func() { diskRun("gh9", "h2", M{"op": "shared"}) }) })
	ok(t, err != nil && strings.Contains(err.Error(), "호스트가 없습니다"), "남의 기기는 info 처럼 막혀요")
	eq(t, len(r.sent), 0)
}
