package main

// Events and the webhooks that hear of them (REQ-F-817, REQ-F-818). An event is one body that server hooks, notify
// and the page's after-hooks will share; this version raises the four below and sends them to the notify webhooks
// of bridge.yaml, signed, outside the lock, retried three times. Without notify nothing leaves the server.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// NOTIFY_EVENTS: the events this version raises: every action the server hooks know (REQ-F-819) and the events of
// the Mac. A notify entry naming one this version never raises is refused rather than left silent.
var NOTIFY_EVENTS = append(append([]string{}, HOOK_ACTIONS...), HOOK_EVENTS...)

// notifyTarget: one entry of notify. URLText is the url as written (before ${ENV}), for screens.
type notifyTarget struct {
	URL     string
	URLText string
	Secret  string
	Events  []string
}

const NOTIFY_MAX = 10

// readNotify: notify, a list of {type: webhook, url, secret, events}. secret is at least 16 letters.
func readNotify(k cfgKey, n *yNode, getenv func(string) string) (cfgVal, bool, error) {
	if n.kind != yList {
		return cfgVal{}, false, &yamlErr{n.line, "notify 는 목록이어야 합니다(- type: webhook ...)"}
	}
	fields := []string{"type", "url", "secret", "events"}
	out := []notifyTarget{}
	for _, it := range n.items {
		if it.kind != yMap {
			return cfgVal{}, false, &yamlErr{it.line, "notify 의 항목은 \"키: 값\" 이어야 합니다"}
		}
		for _, kv := range it.pairs {
			if !contains(fields, kv.key) {
				return cfgVal{}, false, &yamlErr{kv.line, "모르는 키 notify[]." + kv.key + " (받는 키: " + strings.Join(fields, ", ") + ")"}
			}
		}
		one := func(name string) (string, string, int, error) {
			f := it.get(name)
			if f == nil || f.null {
				return "", "", it.line, &yamlErr{it.line, "notify 의 항목에 " + name + " 가 없습니다"}
			}
			if f.kind != yScalar {
				return "", "", f.line, &yamlErr{f.line, "notify[]." + name + " 는 값 하나여야 합니다"}
			}
			v, soft, err := substEnv(f.raw, f.line, getenv)
			if err == nil && (soft || strings.TrimSpace(v) == "") {
				err = &yamlErr{f.line, "notify[]." + name + " 가 비어 있습니다"}
			}
			return strings.TrimSpace(v), f.raw, f.line, err
		}
		typ, _, line, err := one("type")
		if err != nil {
			return cfgVal{}, false, err
		}
		if typ != "webhook" {
			return cfgVal{}, false, &yamlErr{line, "notify[].type 의 " + typ + " 는 모르는 수신처입니다(받는 값: webhook)"}
		}
		t := notifyTarget{}
		u, raw, line, err := one("url")
		if err != nil {
			return cfgVal{}, false, err
		}
		pu, perr := url.Parse(u)
		if perr != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" || pu.User != nil || pu.Fragment != "" {
			return cfgVal{}, false, &yamlErr{line, "notify[].url 은 http(s)://호스트/경로 모양이어야 합니다: " + rawOrigin(raw)}
		}
		t.URL, t.URLText = u, raw
		sec, _, line, err := one("secret")
		if err != nil {
			return cfgVal{}, false, err
		}
		if len(sec) < 16 {
			return cfgVal{}, false, &yamlErr{line, "notify[].secret 은 16자 이상이어야 합니다"}
		}
		t.Secret = sec
		ev := it.get("events")
		if ev == nil || ev.null {
			return cfgVal{}, false, &yamlErr{it.line, "notify 의 항목에 events 가 없습니다(받는 이벤트: " + strings.Join(NOTIFY_EVENTS, ", ") + ")"}
		}
		names, err := plainList(cfgKey{key: "notify[].events"}, ev, getenv)
		if err != nil {
			return cfgVal{}, false, err
		}
		if len(names) == 0 {
			return cfgVal{}, false, &yamlErr{ev.line, "notify[].events 가 비어 있습니다"}
		}
		for _, e := range names {
			if !contains(NOTIFY_EVENTS, e) {
				return cfgVal{}, false, &yamlErr{ev.line, "notify[].events 의 " + e + " 는 이 서버(" + VERSION + ")가 내지 않는 이벤트입니다(받는 이벤트: " + strings.Join(NOTIFY_EVENTS, ", ") + ")"}
			}
			if !contains(t.Events, e) {
				t.Events = append(t.Events, e)
			}
		}
		out = append(out, t)
		if len(out) > NOTIFY_MAX {
			return cfgVal{}, false, &yamlErr{it.line, "notify 는 " + itoa(NOTIFY_MAX) + "개까지입니다"}
		}
	}
	return cfgVal{out, false}, true, nil
}

var rawOriginRe = regexp.MustCompile(`^(https?://)(?:[^/?#@\s]*@)?([^/?#@\s]+)`)

// rawOrigin: what a screen may say of a url: its scheme and host as written. A url whose host is itself a
// reference shows the reference, never the value (a webhook's path or host can be the secret, REQ-F-818).
func rawOrigin(raw string) string {
	if m := rawOriginRe.FindStringSubmatch(raw); m != nil {
		return strings.ToLower(m[1] + m[2]) // user:password@ never shown
	}
	if i := strings.Index(raw, "}"); strings.HasPrefix(raw, "${") && i > 0 {
		return raw[:i+1]
	}
	return "(주소)"
}

func notifyTargets() []notifyTarget {
	t, _ := cfgGet("notify").([]notifyTarget)
	return t
}

// recipients: where this server sends what, as people may see it: origins and event names only.
func recipients() []any {
	out := []any{}
	for _, t := range notifyTargets() {
		ev := []any{}
		for _, e := range t.Events {
			ev = append(ev, e)
		}
		out = append(out, orderedObj{{"origin", rawOrigin(t.URLText)}, {"events", ev}})
	}
	// The hooks' webhooks get the same events (REQ-F-819), and a command may send them on wherever it likes.
	hooks, _ := cfgGet("hooks").(map[string][]hookTarget)
	at := map[string]int{}
	for _, name := range sortedKeysOf(hooks) {
		for _, t := range hooks[name] {
			where := "(이 서버 안의 명령)"
			if t.Type == "webhook" {
				where = rawOrigin(t.URLText)
			}
			i, ok := at[where]
			if !ok {
				i = len(out)
				at[where] = i
				out = append(out, orderedObj{{"origin", where}, {"events", []any{}}})
			}
			row := out[i].(orderedObj)
			if !containsAny(row[1].V.([]any), name) {
				row[1].V = append(row[1].V.([]any), name)
			}
		}
	}
	return out
}

// sessionOfEvent: {id, host, hostId, cwd, title} of a session for an event.
func sessionOfEvent(meta *Sess) orderedObj {
	host := ""
	if h, ok := hosts.Get(meta.host()); ok {
		host = mstr(h, "name")
	}
	return orderedObj{{"id", meta.id()}, {"host", host}, {"hostId", meta.host()}, {"cwd", meta.get("cwd")}, {"title", meta.get("title")}}
}

// emitEvent raises one event to notify and the after hooks. It is called under the lock; the sending happens in
// goroutines with copies only.
func emitEvent(name, uid string, more orderedObj) {
	targets := []notifyTarget{}
	for _, t := range notifyTargets() {
		if contains(t.Events, name) {
			targets = append(targets, t)
		}
	}
	hooks := hooksOf(name + ".after")
	if len(targets) == 0 && len(hooks) == 0 {
		return
	}
	ev, login := eventOf(name, uid, more)
	body := jsonBytes(ev)
	for _, t := range targets {
		go deliverEvent(t, body, uid, login)
	}
	if len(hooks) > 0 {
		hb := jsonBytes(append(append(orderedObj{}, ev...), kv{"hook", name + ".after"}))
		for _, t := range hooks {
			go afterHook(name, t, hb, uid, login)
		}
	}
}

// NOTIFY_RETRY: the waits before the second, third and fourth try; then the event is dropped.
var NOTIFY_RETRY = []time.Duration{time.Second, 10 * time.Second, 60 * time.Second}

var notifyClient = &http.Client{Timeout: 10 * time.Second}

// signedHeaders: the signature every request the server sends out carries (REQ-F-818 rule 3). The receiver
// rebuilds the canonical text, compares the HMAC, refuses a timestamp more than five minutes off and a nonce seen
// in the last five minutes, and drops a repeated event id.
func signedHeaders(secret, method, pathQuery, user, login string, body []byte, now time.Time) map[string]string {
	ts := strconv.FormatInt(now.Unix(), 10)
	nonce := randHex(16)
	sum := sha256.Sum256(body)
	canon := strings.Join([]string{"v1", ts, nonce, method, pathQuery, user, login, hex.EncodeToString(sum[:])}, "\n")
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(canon))
	return map[string]string{"X-Bridge-Timestamp": ts, "X-Bridge-Nonce": nonce, "X-Bridge-User": user, "X-Bridge-Login": login,
		"X-Bridge-Signature": "v1=" + hex.EncodeToString(m.Sum(nil))}
}

// signedPost: body POSTed to u, signed (REQ-F-818 rule 3), by the one client every outgoing request uses.
func signedPost(ctx context.Context, u, pathQuery, secret string, body []byte, uid, login string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "claude-bridge/"+VERSION)
	for k, v := range signedHeaders(secret, "POST", pathQuery, uid, login, body, time.Now()) {
		req.Header.Set(k, v)
	}
	return notifyClient.Do(req)
}

// deliverEvent: one event to one webhook, off the lock. A try that fails (no answer, not 2xx) is tried again after
// 1 s, 10 s and 60 s, each time freshly signed; then it is dropped with one line in the log (origin only).
func deliverEvent(t notifyTarget, body []byte, uid, login string) {
	pu, err := url.Parse(t.URL)
	if err != nil {
		return
	}
	pq := pu.EscapedPath()
	if pq == "" {
		pq = "/"
	}
	if pu.RawQuery != "" {
		pq += "?" + pu.RawQuery
	}
	last := ""
	for i := 0; i <= len(NOTIFY_RETRY); i++ {
		if i > 0 {
			time.Sleep(NOTIFY_RETRY[i-1])
		}
		r, err := signedPost(context.Background(), t.URL, pq, t.Secret, body, uid, login)
		if err == nil {
			r.Body.Close()
			if r.StatusCode >= 200 && r.StatusCode < 300 {
				return
			}
			last = "HTTP " + itoa(r.StatusCode)
		} else {
			last = "연결 실패"
		}
	}
	logLine("notify: " + rawOrigin(t.URLText) + " 에 이벤트를 보내지 못해 버림 (" + last + ")")
}

// privacyWithRecipients: the policy this project ships, with the operator's destinations added where it says
// nothing leaves the server (Korean articles 5 and 6, the English summary). With no destination it is unchanged.
func privacyWithRecipients(html string) string {
	rs := recipients()
	if len(rs) == 0 {
		return html
	}
	items, itemsEn := "", ""
	for _, r := range rs {
		o := r.(orderedObj)
		names := []string{}
		for _, e := range o[1].V.([]any) {
			names = append(names, jsString(e))
		}
		items += "<li>" + escPage(jsString(o[0].V)) + " — " + escPage(strings.Join(names, ", ")) + "</li>"
		itemsEn += "<li>" + escPage(jsString(o[0].V)) + " (" + escPage(strings.Join(names, ", ")) + ")</li>"
	}
	slack := "이 전송은 제7조에 적습니다.</p>"
	html = strings.Replace(html, slack, slack+"\n<p>③ 이 서버의 운영자가 정한 수신처로 아래 이벤트를 보냅니다. 이벤트에는 계정(uid·로그인 이름), 세션의 맥 이름·작업 폴더·제목, 권한·질문 카드의 제목과 선택지가 들어갑니다. 이 목록은 서버 설정(bridge.yaml 의 notify)에서 자동으로 만듭니다.</p>\n<ul>"+items+"</ul>", 1)
	html = strings.Replace(html, "<p>① 운영자는 개인정보 처리 업무를 위탁하지 않습니다.</p>", "<p>① 운영자는 운영자가 지정한 수신처(제5조 ③의 목록) 외에는 개인정보 처리 업무를 위탁하지 않습니다.</p>", 1)
	html = strings.Replace(html, "<li>No data is given to third parties, and no processing is outsourced.</li>", "<li>Data is sent only to the destinations the operator of this server set, with the events listed: <ul>"+itemsEn+"</ul></li>", 1)
	return html
}

// cardAnswers: how the open card of a session was answered through this server (card id -> {n, via, by}), until the
// Mac says it closed (decision.answered). In memory: a card answered across a restart reads as answered at the Mac.
var cardAnswers = map[string]M{}

// noteAnswer keeps one answer; a card the Mac never closes (it went away) is forgotten with the rest past 1,000.
func noteAnswer(cid string, a M) {
	if len(cardAnswers) >= 1000 {
		cardAnswers = map[string]M{}
	}
	cardAnswers[cid] = a
}

func cardEvent(c M) orderedObj {
	out := orderedObj{{"id", c["id"]}, {"kind", c["kind"]}, {"title", c["title"]}}
	if tn := mget(c["tool"], "name"); truthy(tn) {
		out = append(out, kv{"tool", tn})
	}
	opts := []any{}
	for _, o := range asArr(c["options"]) {
		opts = append(opts, orderedObj{{"n", mget(o, "n")}, {"label", mget(o, "label")}, {"kind", mget(o, "kind")}})
	}
	return append(out, kv{"options", opts})
}
