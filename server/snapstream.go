package main

// 스냅샷 조각 (REQ-F-906, REQ-S-110, 1.526): a Mac that says `snapParts` sends a snapshot as pieces of about 128 K characters,
// each sealed on its own for the person's devices (a Mac without a paired device: plain pieces), first the drawing it
// kept on its disk and then the one drawn now. The server opens none of them and keeps none for long: a piece waits
// here only until the page takes it (GET …/snapshot/<reqId>?from=n), then it is let go. Limits on a piece, on the
// pieces, on what waits and on the time cut a request off.

import (
	"regexp"
	"strconv"
	"time"
)

const (
	SNAP_PART_MAX    = 1 << 20  // one piece as it comes (the agent's 128 K characters, sealed: at most about 700 KB)
	SNAP_PARTS_MAX   = 600      // pieces of one request (the agent sends 240 at most per drawing, two drawings)
	SNAP_TOTAL_MAX   = 64 << 20 // all the pieces of one request
	SNAP_WAITING_MAX = 32 << 20 // pieces not yet taken by the page
	SNAP_STREAM_MS   = 120_000  // from the request to the Mac's last word
	SNAP_POLL_MS     = 25_000   // how long a GET waits for a piece
	SNAP_KEEP_MS     = 60_000   // how long an ended request waits for the page to take what is left
	SNAP_TAKE_MAX    = 8 << 20  // pieces in one answer
	SNAP_STREAMS_MAX = 6        // requests of one person at once
)

var snapRidRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
var snapStreamRouteRe = regexp.MustCompile(`^/api/sessions/([a-zA-Z0-9-]+)/snapshot/([0-9a-f-]{36})$`)

type snapStream struct {
	id, uid, sid, host string
	base               int      // the number of parts[0]
	parts              []string // the pieces not yet taken, in the order they came
	waiting, total     int      // bytes waiting, bytes in all
	count              int
	done               bool
	end                M // the Mac's last word: ok, parts or error (sealed as it came)
	wake               chan struct{}
	gone               *Timer
}

var snapStreams = map[string]*snapStream{}

// poke wakes the GETs waiting on st.
func (st *snapStream) poke() {
	close(st.wake)
	st.wake = make(chan struct{})
}

// finish ends st with the Mac's last word (or the server's), then lets it go SNAP_KEEP_MS later.
func (st *snapStream) finish(end M) {
	if st.done {
		return
	}
	st.done = true
	st.end = end
	st.poke()
	clearTimeout(st.gone)
	st.gone = setTimeout(SNAP_KEEP_MS*time.Millisecond, func() { delete(snapStreams, st.id) })
}

// cut ends st for going past a limit: what waits is let go at once.
func (st *snapStream) cut(why string) {
	st.parts = nil
	st.waiting = 0
	if p := pending[st.id]; p != nil {
		clearTimeout(p.timer)
		clearTimeout(p.gotTimer)
		delete(pending, st.id)
	}
	record(st.uid, st.host, M{"level": "warn", "area": "snapshot", "sid": st.sid, "text": why})
	st.finish(M{"ok": false, "error": why})
}

// snapshotStream starts a request in pieces: the Mac gets the command, the page gets the request's id at once.
func snapshotStream(meta *Sess, hostID, target, rid string) M {
	uid := meta.uid()
	n := 0
	for _, st := range snapStreams {
		// An ended one still holding pieces counts too: what waits here is bounded per person.
		if st.uid == uid && (!st.done || st.waiting > 0) {
			n++
		}
	}
	if n >= SNAP_STREAMS_MAX {
		refuse(429, "스냅샷을 이미 여러 개 받는 중이에요. 잠시 뒤에 다시 해 주세요")
	}
	reqID := uuidv4()
	st := &snapStream{id: reqID, uid: uid, sid: meta.id(), host: hostID, wake: make(chan struct{})}
	snapStreams[reqID] = st
	// The Mac's last word comes as an answer to the command (reply): it ends the request.
	entry := &pendingEntry{hostID: hostID, resolve: func(v M) {
		end := M{"ok": truthy(v["ok"])}
		if e, has := v["error"]; has {
			end["error"] = e
		}
		st.finish(end)
	}}
	give := func(e string) {
		clearTimeout(entry.timer)
		clearTimeout(entry.gotTimer)
		delete(pending, reqID)
		record(uid, hostID, M{"level": "error", "area": "snapshot", "sid": st.sid, "text": e})
		st.finish(M{"ok": false, "error": e})
	}
	entry.gotTimer = setTimeout(GOT_MS*time.Millisecond, func() {
		give("그 맥의 연동 탭이 스냅샷 요청을 받지 못했어요. 그 맥에서 연동 탭을 앞으로 가져오거나 새로고침해 주세요")
	})
	entry.timer = setTimeout(SNAP_STREAM_MS*time.Millisecond, func() { give("맥이 스냅샷을 제때 다 보내지 않았어요") })
	pending[reqID] = entry
	if !toHost(hostID, M{"t": "snapshot", "sid": meta.id(), "url": target, "parts": 1, "rid": rid, "reqId": reqID}) {
		clearTimeout(entry.gotTimer)
		clearTimeout(entry.timer)
		delete(pending, reqID)
		delete(snapStreams, reqID)
		refuse(409, "세션의 맥이 연결돼 있지 않아서 스냅샷을 만들 수 없어요")
	}
	return M{"ok": true, "stream": reqID}
}

// snapPartFrom: a piece from the Mac (t "snappart", snap = the request's id), kept until the page takes it.
func snapPartFrom(uid, hostID string, msg M) {
	st := snapStreams[jsStringU(msg["snap"])]
	if st == nil || st.done || st.host != hostID || st.uid != uid || jsStringU(msg["sid"]) != st.sid {
		return
	}
	var piece string
	if s, isStr := msg["sealed"].(string); isStr {
		// Sealed: exactly one piece, nothing the server can read around it.
		if !adapterSealRe.MatchString(s) {
			st.cut("맥이 보낸 스냅샷 조각이 봉인된 모양이 아니에요")
			return
		}
		piece = s
	} else if s, isStr := msg["plain"].(string); isStr {
		piece = "p" + s
	} else {
		return
	}
	switch {
	case len(piece) > SNAP_PART_MAX:
		st.cut("스냅샷 조각 하나가 너무 커요")
	case st.count+1 > SNAP_PARTS_MAX:
		st.cut("스냅샷 조각이 너무 많아요")
	case st.total+len(piece) > SNAP_TOTAL_MAX:
		st.cut("스냅샷이 너무 커요")
	case st.waiting+len(piece) > SNAP_WAITING_MAX:
		st.cut("화면이 스냅샷 조각을 제때 받아 가지 않아 끊었어요")
	default:
		st.parts = append(st.parts, piece)
		st.count++
		st.total += len(piece)
		st.waiting += len(piece)
		st.poke()
	}
}

// GET /api/sessions/<id>/snapshot/<reqId>?from=n (IF-288): the pieces from number n on (those before n are let go),
// waiting up to SNAP_POLL_MS for one; `done` with the Mac's last word once it came and nothing is left.
func snapshotTake(res *Res, meta *Sess, uid, reqID, from string) {
	st := snapStreams[reqID]
	if st == nil || st.uid != uid || st.sid != meta.id() {
		refuse(404, "스냅샷 요청이 없거나 끝났어요")
	}
	n, err := strconv.Atoi(from)
	if from == "" {
		n, err = 0, nil
	}
	if err != nil || n < st.base || n > st.base+len(st.parts) {
		refuse(400, "조각 번호가 맞지 않아요")
	}
	// Taken: let go.
	for i := 0; i < n-st.base; i++ {
		st.waiting -= len(st.parts[i])
	}
	st.parts = append([]string(nil), st.parts[n-st.base:]...)
	st.base = n
	until := time.Now().Add(SNAP_POLL_MS * time.Millisecond)
	for len(st.parts) == 0 && !st.done {
		left := time.Until(until)
		if left <= 0 {
			break
		}
		w := st.wake
		await(func() {
			select {
			case <-w:
			case <-time.After(left):
			}
		})
		if snapStreams[reqID] != st {
			break
		}
	}
	out := []any{}
	size := 0
	for _, p := range st.parts {
		if len(out) > 0 && size+len(p) > SNAP_TAKE_MAX {
			break
		}
		size += len(p)
		if p[0] == 'p' {
			out = append(out, M{"plain": p[1:]})
		} else {
			out = append(out, p)
		}
	}
	r := M{"ok": true, "from": st.base, "parts": out}
	if st.done && len(out) == len(st.parts) {
		r["done"] = true
		r["end"] = st.end
	}
	jsonRes(res, 200, r)
}

func init() {
	fromAgent["snappart"] = snapPartFrom
}
