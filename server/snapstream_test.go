package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// snapSink: a Mac's bridge tab that answers a snapshot command with what reply(cmd) says, as the agent would: its
// messages go up through fromBridge, in order.
type snapSink struct {
	sent  []M
	reply func(cmd M) []any
}

func (a *snapSink) Write(chunk string) bool {
	var cmd M
	_ = json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(chunk, "data: "), "\n\n")), &cmd)
	a.sent = append(a.sent, cmd)
	if msgs := a.reply(cmd); msgs != nil {
		go withLock(func() { fromBridge("gh1", "h1", msgs, "https://bridge.example") })
	}
	return true
}
func (a *snapSink) End(string)   {}
func (a *snapSink) Pending() int { return 0 }

func withSnapHost(t *testing.T, caps []any, reply func(cmd M) []any) *snapSink {
	t.Helper()
	_ = withConfigServer(t)
	s := &snapSink{reply: reply}
	wasH, wasS, wasB, wasSt := hosts, sessions, bridges, snapStreams
	t.Cleanup(func() { withLock(func() { hosts, sessions, bridges, snapStreams = wasH, wasS, wasB, wasSt }) })
	withLock(func() {
		hosts, sessions, bridges = newOMap[M](), newOMap[*Sess](), newOMap[Sink]()
		snapStreams = map[string]*snapStream{}
		hosts.Set("h1", M{"uid": "gh1", "name": "맥"})
		sessions.Set("sa", &Sess{m: M{"id": "sa", "uid": "gh1", "hostId": "h1", "cwd": "/w/app"}})
		sessions.Set("sb", &Sess{m: M{"id": "sb", "uid": "gh2", "hostId": "h1"}})
		bridges.Set("h1", s)
		live("h1")["caps"] = caps
	})
	return s
}

// A sealed-looking piece of n characters (the server never opens one).
func fakeSealed(n int) string {
	return "⟦bt1:0123abcd:" + strings.Repeat("A", n) + "⟧"
}

// waitParts waits until the request has come to `count` pieces or ended.
func waitParts(t *testing.T, id string, count int) *snapStream {
	t.Helper()
	for i := 0; i < 200; i++ {
		var st *snapStream
		done := false
		withLock(func() {
			st = snapStreams[id]
			done = st != nil && (st.count >= count || st.done)
		})
		if done {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("pieces did not come")
	return nil
}

// AC-1774 (REQ-F-906, REQ-S-110): a Mac that says snapParts gets {parts, rid} and answers in sealed pieces; the page
// gets {stream} at once, then the pieces in order as they came, each let go once taken, then the Mac's last word.
func TestSnapshotStreamRelay(t *testing.T) {
	pieces := []string{fakeSealed(100), fakeSealed(200), fakeSealed(300)}
	s := withSnapHost(t, []any{"store", "snapParts"}, func(cmd M) []any {
		out := []any{}
		for _, p := range pieces {
			out = append(out, M{"t": "snappart", "snap": cmd["reqId"], "sid": "sa", "sealed": p})
		}
		return append(out, M{"t": "snapshot", "reqId": cmd["reqId"], "sid": "sa", "ok": true, "parts": 3.0})
	})
	code, body := callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":"https://example.com/a","parts":true,"rid":"rid-0123456789"}`)
	eq(t, code, 200, body)
	id, _ := js(body).(map[string]any)["stream"].(string)
	ok(t, len(id) == 36, body)
	_, hasHTML := js(body).(map[string]any)["html"]
	ok(t, !hasHTML, "no page in the first answer")
	withLock(func() {
		eq(t, len(s.sent), 1)
		c := s.sent[0]
		ok(t, c["t"] == "snapshot" && c["url"] == "https://example.com/a" && c["parts"] == 1.0 && c["rid"] == "rid-0123456789" && c["reqId"] == id, jsonStr(c))
	})
	st := waitParts(t, id, 3)
	waitParts(t, id, 99) // and its end
	code, body = callAPI(t, "GET", "/api/sessions/sa/snapshot/"+id+"?from=0", "")
	eq(t, code, 200, body)
	r := js(body).(map[string]any)
	jeq(t, r["parts"], `["`+strings.Join(pieces, `","`)+`"]`, body)
	ok(t, r["from"] == 0.0 && r["done"] == true, body)
	jeq(t, r["end"], `{"ok":true}`, body)
	// Taken: let go. Asking from the end again says it ended with nothing more.
	code, body = callAPI(t, "GET", "/api/sessions/sa/snapshot/"+id+"?from=3", "")
	eq(t, code, 200, body)
	jeq(t, js(body).(map[string]any)["parts"], `[]`, body)
	withLock(func() {
		ok(t, len(st.parts) == 0 && st.waiting == 0 && st.base == 3, "nothing kept after it was taken")
	})
	// Earlier pieces are gone for good.
	code, _ = callAPI(t, "GET", "/api/sessions/sa/snapshot/"+id+"?from=1", "")
	eq(t, code, 400)
	// Another person's session, or no such request.
	code, _ = callAPI(t, "GET", "/api/sessions/sb/snapshot/"+id+"?from=3", "")
	eq(t, code, 404)
	code, _ = callAPI(t, "GET", "/api/sessions/sa/snapshot/00000000-0000-4000-8000-000000000000", "")
	eq(t, code, 404)
	code, _ = callAPI(t, "POST", "/api/sessions/sa/snapshot/"+id, "{}")
	eq(t, code, 405)
}

// AC-1775: the server holds no plain page of a sealing Mac: a "sealed" piece that is not one, a piece too big or one too
// many ends the request and lets what waits go; the Mac's sealed failure goes to the page as it came.
func TestSnapshotStreamLimits(t *testing.T) {
	var mode string
	_ = withSnapHost(t, []any{"snapParts"}, func(cmd M) []any {
		part := func(sealed any) M { return M{"t": "snappart", "snap": cmd["reqId"], "sid": "sa", "sealed": sealed} }
		switch mode {
		case "plain-in-sealed":
			return []any{part(fakeSealed(50)), part("<html>secret page https://example.com/a</html>")}
		case "big":
			return []any{part(fakeSealed(SNAP_PART_MAX))}
		case "many":
			out := []any{}
			for i := 0; i <= SNAP_PARTS_MAX; i++ {
				out = append(out, part(fakeSealed(40)))
			}
			return out
		case "other-session":
			return []any{M{"t": "snappart", "snap": cmd["reqId"], "sid": "sb", "sealed": fakeSealed(50)}, M{"t": "snapshot", "reqId": cmd["reqId"], "sid": "sa", "ok": false, "error": "⟦bt1:0123abcd:" + strings.Repeat("E", 40) + "⟧"}}
		}
		return nil
	})
	start := func() string {
		code, body := callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":"https://example.com/a","parts":true,"rid":"rid-0123456789"}`)
		eq(t, code, 200, body)
		return js(body).(map[string]any)["stream"].(string)
	}
	for _, c := range []struct{ mode, why string }{{"plain-in-sealed", "봉인된 모양이 아니에요"}, {"big", "너무 커요"}, {"many", "너무 많아요"}} {
		mode = c.mode
		id := start()
		st := waitParts(t, id, 1<<30)
		withLock(func() {
			ok(t, st.done && len(st.parts) == 0 && st.waiting == 0, c.mode)
			ok(t, strings.Contains(jsStringU(st.end["error"]), c.why), c.mode, jsonStr(st.end))
			_, still := pending[id]
			ok(t, !still, "the Mac's late word is not waited for")
		})
		code, body := callAPI(t, "GET", "/api/sessions/sa/snapshot/"+id, "")
		eq(t, code, 200, body)
		ok(t, !strings.Contains(body, "secret page") && !strings.Contains(body, "<html>"), body)
	}
	mode = "other-session"
	id := start()
	st := waitParts(t, id, 1<<30)
	withLock(func() { ok(t, st.count == 0, "a piece of another session is not taken") })
	code, body := callAPI(t, "GET", "/api/sessions/sa/snapshot/"+id, "")
	eq(t, code, 200, body)
	jeq(t, js(body).(map[string]any)["end"], `{"error":"⟦bt1:0123abcd:`+strings.Repeat("E", 40)+`⟧","ok":false}`, body)
	// Fetch metadata (1.524): only this site's own fetch takes pieces.
	p := "/api/sessions/sa/snapshot/" + id
	eq(t, fetchMetaRefusal("GET", p, "empty", "cross-site"), "다른 출처의 요청입니다")
	eq(t, fetchMetaRefusal("GET", p, "empty", "same-site"), "다른 출처의 요청입니다")
	eq(t, fetchMetaRefusal("GET", p, "image", "same-origin"), NOT_A_SUBRESOURCE)
	eq(t, fetchMetaRefusal("GET", p, "empty", "same-origin"), "")
}

// AC-1776: an address sealed by the device goes to a Mac that can open it (snapParts) and is never read here; to an
// older Mac it is refused with snap-old, so the page asks again plain. An address that is neither is refused.
func TestSnapshotSealedURL(t *testing.T) {
	sealedURL := fakeSealed(60)
	s := withSnapHost(t, []any{"store"}, func(cmd M) []any {
		if cmd["parts"] != nil {
			return []any{M{"t": "snapshot", "reqId": cmd["reqId"], "sid": "sa", "ok": true, "parts": 0.0}}
		}
		return []any{M{"t": "snapshot", "reqId": cmd["reqId"], "sid": "sa", "ok": true, "url": cmd["url"], "html": "<p>old</p>"}}
	})
	code, msg := callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":"`+sealedURL+`","parts":true,"rid":"rid-0123456789"}`)
	eq(t, code, 409, msg)
	// An older Mac (no snapParts) still answers whole, as before.
	code, body := callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":"https://example.com/a","parts":true,"rid":"rid-0123456789"}`)
	eq(t, code, 200, body)
	ok(t, js(body).(map[string]any)["html"] == "<p>old</p>", body)
	withLock(func() { live("h1")["caps"] = []any{"store", "snapParts"} })
	code, body = callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":"`+sealedURL+`","parts":true,"rid":"rid-0123456789"}`)
	eq(t, code, 200, body)
	withLock(func() { ok(t, s.sent[len(s.sent)-1]["url"] == sealedURL, "the sealed address as it came") })
	for _, bad := range []string{`"javascript:alert(1)"`, `"⟦bt1:zz:short⟧"`, `"x⟦bt1:0123abcd:` + strings.Repeat("A", 40) + `⟧"`} {
		code, _ = callAPI(t, "POST", "/api/sessions/sa/snapshot", `{"url":`+bad+`,"parts":true,"rid":"rid-0123456789"}`)
		eq(t, code, 400, bad)
	}
}
