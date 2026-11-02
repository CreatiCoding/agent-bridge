package main

// 스트림이 막힌 네트워크 (REQ-F-849): a page or a bridge tab whose event stream a proxy cuts or holds back fetches the
// same messages with short requests instead. Its place on the server is a *Stream in poll mode: everything that
// writes to streams (toControls, sendState, toHost) writes to it unchanged, so what it fetches is what the stream
// would have carried, in the same order.

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// POLL_WAIT_MAX: the longest a fetch waits for news (s). Short enough for proxies that cut long answers.
	POLL_WAIT_MAX = 20
	// POLL_GAP_MS: a fetch that does not wait, sooner than this after the last answer, is refused (429). A fetch
	// that waits may come right after an answer (that is how news flows), but never sooner than POLL_MIN_MS after
	// the fetch before it began.
	POLL_GAP_MS = 500
	POLL_MIN_MS = 200
	// A control page's place: kept this long without a fetch (a hidden tab fetches every 30 s, slower when its
	// browser throttles it), and this much may pile up before the page starts over from the whole state.
	POLL_IDLE_MS        = 5 * 60_000
	POLL_BACKLOG_MAX    = 1 << 20
	BRIDGE_POLL_IDLE_MS = 30_000
	// A bridge tab's commands carry an update's file list: more room, and past it the link starts over.
	BRIDGE_POLL_BACKLOG_MAX = 4 << 20
)

type pollItem struct {
	seq  int64
	data string
	t    string
	sid  string
}

// pollBuf: what waits for the next fetch. Guarded by the stream's smu.
type pollBuf struct {
	bridge bool
	conn   string // a bridge tab's: the conn it was opened with
	items  []pollItem
	seq    int64
	size   int
	max    int
	idleMs int64
	over   bool  // more piled up than max: the next fetch starts over
	acked  int64 // the since of the newest fetch: what the fetcher has
	lastAt int64 // when it was last fetched or made (for expiry)
	askAt  int64 // when the last fetch began
	doneAt int64
	wake   chan struct{}
	waiter chan struct{}
}

var pollers = map[*Stream]struct{}{}

func newPoller(bridge bool, onClose func()) *Stream {
	s := newStream(onClose)
	s.poll = &pollBuf{bridge: bridge, max: POLL_BACKLOG_MAX, idleMs: POLL_IDLE_MS, wake: make(chan struct{}, 1), lastAt: nowMs()}
	if bridge {
		s.poll.max = BRIDGE_POLL_BACKLOG_MAX
		s.poll.idleMs = BRIDGE_POLL_IDLE_MS
	}
	pollers[s] = struct{}{}
	return s
}

var pollHead struct {
	T   string `json:"t"`
	Sid string `json:"sid"`
}

// pollAdd keeps one SSE chunk ("data: …\n\n"; comments and retry lines mean nothing here). With s.smu held.
func (s *Stream) pollAdd(chunk string) bool {
	if !strings.HasPrefix(chunk, "data: ") {
		return true
	}
	p := s.poll
	data := strings.TrimSuffix(chunk[6:], "\n\n")
	it := pollItem{data: data}
	// A terminal's text and screen are pictures of now: only the newest of each waits.
	if strings.Contains(data, `"preview"`) || strings.Contains(data, `"screen"`) {
		pollHead.T, pollHead.Sid = "", ""
		if json.Unmarshal([]byte(data), &pollHead) == nil && (pollHead.T == "preview" || pollHead.T == "screen") {
			it.t, it.sid = pollHead.T, pollHead.Sid
			for i, o := range p.items {
				if o.t == it.t && o.sid == it.sid {
					p.size -= len(o.data)
					p.items = append(p.items[:i], p.items[i+1:]...)
					break
				}
			}
		}
	}
	if p.size+len(data) > p.max {
		p.items = nil
		p.size = 0
		if p.bridge {
			return false
		}
		p.over = true
		s.pollWake()
		return true
	}
	p.seq++
	it.seq = p.seq
	p.items = append(p.items, it)
	p.size += len(data)
	s.pollWake()
	return true
}

func (s *Stream) pollWake() {
	select {
	case s.poll.wake <- struct{}{}:
	default:
	}
}

// pollClosed: the place is gone (ended, replaced, expired, or over its room): its owner hears it as a closed stream.
func (s *Stream) pollClosed() {
	delete(pollers, s)
	s.closedOnce.Do(func() {
		if s.onClose != nil {
			go locked("poll close", s.onClose)
		}
	})
}

// sweepPollers: a place nobody has fetched for a while is closed like a dropped stream.
func sweepPollers() {
	now := nowMs()
	for s := range pollers {
		s.smu.Lock()
		ended := s.ended || s.gone
		idle := s.poll.waiter == nil && now-s.poll.lastAt > s.poll.idleMs
		if idle {
			s.ended = true
		}
		s.smu.Unlock()
		if ended || idle {
			s.pollWakeWaiter()
			s.pollClosed()
		}
	}
}

func (s *Stream) pollWakeWaiter() {
	s.smu.Lock()
	defer s.smu.Unlock()
	if s.poll.waiter != nil {
		close(s.poll.waiter)
		s.poll.waiter = nil
	}
	s.pollWake()
}

func startPollSweep() { setInterval(5*time.Second, sweepPollers) }

var pollIdRe = regexp.MustCompile(`^[0-9a-f]{16,64}$`)

// pollArgs: since (the last number the fetcher has) and wait (s).
func pollArgs(u *url.URL) (int64, time.Duration) {
	since, err := strconv.ParseInt(qstr(u, "since"), 10, 64)
	if err != nil || since < 0 {
		since = 0
	}
	w, _ := strconv.Atoi(qstr(u, "wait"))
	w = max(0, min(w, POLL_WAIT_MAX))
	return since, time.Duration(w) * time.Second
}

// pollTake answers one fetch: drops what the fetcher has (seq ≤ since), waits up to `wait` for news, and gives the
// rest. reset: the fetcher's place could not carry on from since (too much piled up, a number it was never given),
// so it starts over from the whole state. A fetch older than one already answered (a retried or late request) is
// stale (410) and changes nothing.
func pollTake(req *Req, s *Stream, since int64, wait time.Duration, fresh bool, restart func()) M {
	p := s.poll
	asked := since
	now := nowMs()
	s.smu.Lock()
	if !fresh && since < p.acked {
		s.smu.Unlock()
		pollStale()
	}
	if !fresh && ((wait == 0 && p.doneAt > 0 && now-p.doneAt < POLL_GAP_MS) || now-p.askAt < POLL_MIN_MS) {
		s.smu.Unlock()
		res429()
	}
	p.lastAt = now
	p.askAt = now
	reset := fresh || p.over || since > p.seq
	s.smu.Unlock()
	if reset && !fresh && restart != nil {
		restart()
	}
	s.smu.Lock()
	if reset {
		p.over = false
		// What the fetcher has is no longer a base: everything from the place's start (the whole state first).
		since = 0
		if len(p.items) > 0 {
			since = p.items[0].seq - 1
		}
	}
	p.acked = since
	keep := p.items[:0]
	for _, it := range p.items {
		if it.seq > since {
			keep = append(keep, it)
		} else {
			p.size -= len(it.data)
		}
	}
	p.items = keep
	if len(p.items) == 0 && wait > 0 && !s.ended && !s.gone {
		if p.waiter != nil {
			close(p.waiter)
		}
		mine := make(chan struct{})
		p.waiter = mine
		select {
		case <-p.wake:
		default:
		}
		s.smu.Unlock()
		ctx := req.r.Context()
		await(func() {
			t := time.NewTimer(wait)
			defer t.Stop()
			select {
			case <-p.wake:
			case <-mine:
			case <-t.C:
			case <-ctx.Done():
			}
		})
		s.smu.Lock()
		if p.waiter != nil && p.waiter != mine {
			// A newer fetch for the same place came: that one answers.
			s.smu.Unlock()
			pollStale()
		}
		if p.waiter == mine {
			p.waiter = nil
		}
	}
	msgs := []any{}
	if !p.over {
		for _, it := range p.items {
			if it.seq > since {
				msgs = append(msgs, it.data)
			}
		}
	}
	last := since
	if len(msgs) > 0 {
		last = p.seq
	}
	p.doneAt = nowMs()
	ended := s.ended || s.gone
	s.smu.Unlock()
	out := M{"since": float64(asked), "last": float64(last), "msgs": msgs, "reset": reset}
	if ended {
		out["ended"] = true
	}
	return out
}

// pollStale: a fetch that is not the newest for its place.
func pollStale() {
	refuseX(410, "더 새 요청이 있어 이 요청은 버렸어요", M{"stale": true})
}

func res429() {
	refuseX(429, "너무 자주 확인했어요. 잠시 뒤 다시 확인해요", M{"retry": 1000.0})
}

// classicPoll: GET /api/classic/poll — what /api/classic/stream?delta=1 carries, fetched (IF-271).
func classicPoll(req *Req, res *Res, u *url.URL, uid string) {
	pid := qstr(u, "pid")
	if !pollIdRe.MatchString(pid) {
		refuse(400, "pid 가 올바르지 않습니다")
	}
	since, wait := pollArgs(u)
	key := "poll-" + pid
	var s *Stream
	if c := controls[uid]; c != nil {
		s, _ = c.Get(key)
	}
	fresh := false
	if s == nil || s.poll == nil || s.ended || s.gone {
		pollMadeCheck(uid)
		var n *Stream
		n = newPoller(false, func() {
			if c := controls[uid]; c != nil {
				if cur, ok := c.Get(key); ok && cur == n {
					c.Delete(key)
				}
			}
		})
		n.wantsDelta = true
		addControl(uid, key, n)
		s = n
		fresh = true
	}
	if fresh {
		sendState(s, stateOf(uid))
	} else if c := controls[uid]; c != nil {
		// Fetched now: the newest of this person's pages, the last to make room when one more opens (CONTROLS_MAX).
		c.Delete(key)
		c.Set(key, s)
	}
	out := pollTake(req, s, since, wait, fresh, func() {
		s.smu.Lock()
		s.poll.items = nil
		s.poll.size = 0
		s.smu.Unlock()
		s.lastState = nil
		sendState(s, stateOf(uid))
	})
	out["pid"] = pid
	jsonRes(res, 200, out, M{"Cache-Control": "no-store"})
}

// bridgePoll: GET /api/bridge/poll — a bridge tab's commands, fetched (IF-272). A place that cannot carry on is a
// new link (fresh): the tab introduces its agent again, as after a dropped stream.
func bridgePoll(req *Req, res *Res, u *url.URL, uid string) {
	hostID := qstr(u, "hostId")
	conn := qstr(u, "conn")
	if ownHost(uid, qnil(u, "hostId"))["conn"] != qnil(u, "conn") {
		refuse(409, NOT_BRIDGE_TAB)
	}
	since, wait := pollArgs(u)
	gen := bridgeGen(u)
	cur, _ := bridges.Get(hostID)
	s, _ := cur.(*Stream)
	fresh := s == nil || s.poll == nil || !s.poll.bridge || s.bconn != conn || s.gen != gen || s.ended || s.gone
	if !fresh {
		s.smu.Lock()
		p := s.poll
		stale := since < p.acked
		fresh = p.over || since > p.seq
		s.smu.Unlock()
		if stale {
			pollStale()
		}
	}
	if fresh {
		pollMadeCheck(uid)
		s = openBridge(uid, hostID, conn, gen, req, func(onClose func()) *Stream { return newPoller(true, onClose) })
	}
	out := pollTake(req, s, since, wait, fresh, nil)
	if fresh {
		out["fresh"] = true
	}
	jsonRes(res, 200, out, M{"Cache-Control": "no-store"})
}

// bridgeGen: which attempt of its tab a bridge request belongs to (the tab counts up each time it switches between
// streaming and fetching). A late request of an older attempt must not replace a newer one.
func bridgeGen(u *url.URL) int64 {
	g, _ := strconv.ParseInt(qstr(u, "gen"), 10, 64)
	return max(g, 0)
}

// POLL_MADE_MAX: new fetched places one person may open per minute; past it 429 (a page makes one per load).
const POLL_MADE_MAX = 30

var pollMade = map[string][]int64{}

func pollMadeCheck(uid string) {
	now := nowMs()
	keep := pollMade[uid][:0]
	for _, t := range pollMade[uid] {
		if now-t < 60_000 {
			keep = append(keep, t)
		}
	}
	if len(keep) >= POLL_MADE_MAX {
		pollMade[uid] = keep
		res429()
	}
	pollMade[uid] = append(keep, now)
}

// probeStream: /api/classic/stream?probe=1 — a short event stream that says whether streams get through now: five
// numbered messages a second apart, then the end. A page that fetches instead of streaming tries it now and then.
// The same address as the real stream, so a proxy that sorts by address treats both alike.
func probeStream(req *Req, res *Res) {
	s := openStream(req, res, nil)
	var tick func(n int)
	tick = func(n int) {
		sse(s, M{"t": "probe", "n": float64(n)})
		if n >= 4 {
			s.End("")
			return
		}
		setTimeout(time.Second, func() { tick(n + 1) })
	}
	tick(0)
}
