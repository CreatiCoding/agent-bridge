// What the Node server imported from the agent's folder: agent/scrub.mjs (hidePaths, hideRemotes, cleanFolder),
// agent/stats.mjs (sessionStats, cleanStats, addStats) and agent/guard.mjs (manifestSigned). The agent keeps its own
// copies; these must say the same.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- agent/scrub.mjs ----------

var (
	credHTTP = regexp.MustCompile(`(?i)\b((?:https?|ftps?|git\+https?)://)[^\s/@]*@`)
	credSSH  = regexp.MustCompile(`(?i)\b((?:ssh|git\+ssh)://)([^\s/:@]*):[^\s/@]*@`)
	pathAbs  = regexp.MustCompile("(?:~|file://)?/(?:Users|home|private|var|tmp|Volumes|opt|Library|usr|Applications|etc)/[^\n'\"`)\\]]*")
	pathHome = regexp.MustCompile("(?:~|\\$HOME|\\$\\{HOME\\})/[^\n'\"`)\\]]*")
	linkKey  = regexp.MustCompile(`([#&]key=)[A-Za-z0-9_%-]{16,}`)
	hookKeyH = regexp.MustCompile(`(?i)(x-bridge-key:\s*)[A-Za-z0-9_-]{16,}`)
)

// stripCreds: a remote address without the credentials written into it.
func stripCreds(u any) any {
	s, ok := u.(string)
	if !ok {
		return u
	}
	return credSSH.ReplaceAllString(credHTTP.ReplaceAllString(s, "${1}"), "${1}${2}@")
}

func textOf(v any) string {
	if v == nil {
		return ""
	}
	return jsString(v)
}

// hideRemotes: every remote address in a text without its credentials.
func hideRemotes(text any) string { return stripCreds(textOf(text)).(string) }

// hideKeys: a text without an agent's link key in a link address (`#port=…&key=…`) or a hook header (`x-bridge-key:`).
// The server knows no agent's key, so only these two forms; the agent also hides its own key values before sending.
func hideKeys(s string) string {
	return hookKeyH.ReplaceAllString(linkKey.ReplaceAllString(s, "${1}***"), "${1}***")
}

// hideKeysDeep: every string in a message (maps and arrays walked) through hideKeys.
func hideKeysDeep(v any) any {
	switch x := v.(type) {
	case string:
		return hideKeys(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = hideKeysDeep(e)
		}
		return out
	case M:
		out := make(M, len(x))
		for k, e := range x {
			out[k] = hideKeysDeep(e)
		}
		return out
	}
	return v
}

// hidePaths: a text with home folder paths replaced by "(경로)".
func hidePaths(text any) string {
	return pathHome.ReplaceAllString(pathAbs.ReplaceAllString(textOf(text), "(경로)"), "(경로)")
}

// cleanFolder: a folder snapshot as the server may keep it: remote addresses without credentials, no note contents.
func cleanFolder(folder any) any {
	f, ok := folder.(M)
	if !ok || f == nil {
		return folder
	}
	out := shallow(f)
	if repos, ok := out["repos"].([]any); ok {
		next := make([]any, len(repos))
		for i, r := range repos {
			rm, ok := r.(M)
			if !ok || rm == nil {
				next[i] = r
				continue
			}
			x := shallow(rm)
			if truthy(rm["origin"]) {
				x["origin"] = stripCreds(rm["origin"])
			}
			if p, ok := rm["push"].(string); ok {
				x["push"] = hideRemotes(p)
			}
			if truthy(rm["pushError"]) {
				x["pushError"] = hideRemotes(rm["pushError"])
			}
			next[i] = x
		}
		out["repos"] = next
	}
	if truthy(out["origin"]) {
		out["origin"] = stripCreds(out["origin"])
	}
	if files, ok := out["files"]; ok && files != nil {
		switch files.(type) {
		case M, []any:
			out["files"] = M{}
		}
	}
	return out
}

// ---------- agent/stats.mjs ----------

const (
	statsHour  = 3_600_000.0
	statsDay   = 86_400_000.0
	TURN_CAP   = 30 * 60_000.0
	STATS_DAYS = 90
)

// sessionStats: one session's numbers (spans, open, lastAt, hours).
func sessionStats(events []any, now float64) M {
	from := now - STATS_DAYS*statsDay
	spans := []any{}
	hours := M{}
	var open any
	lastAt := 0.0
	for _, ea := range events {
		e := asM(ea)
		at := jsNumber(e["at"])
		if at != at {
			at = 0
		}
		lastAt = at
		if e["k"] == "status" {
			if open != nil {
				o := open.(float64)
				to := math.Min(at, o+TURN_CAP)
				if to > from {
					spans = append(spans, []any{o, to})
				}
				open = nil
			}
			if e["phase"] == "busy" {
				open = at
			}
		}
		if at < from {
			continue
		}
		key := numStr(at - math.Mod(at, statsHour))
		h, _ := hours[key].(M)
		if h == nil {
			h = M{"a": 1.0}
			hours[key] = h
		}
		if e["k"] == "tool" && truthy(e["name"]) {
			t, _ := h["t"].(M)
			if t == nil {
				t = M{}
				h["t"] = t
			}
			n := jsString(e["name"])
			t[n] = numOr0(t[n]) + 1
		} else if e["k"] == "card" && mget(e["card"], "kind") == "permission" {
			h["p"] = numOr0(h["p"]) + 1
		} else if e["k"] == "user" && !truthy(e["command"]) {
			h["m"] = numOr0(h["m"]) + 1
		}
	}
	return M{"spans": spans, "open": open, "lastAt": lastAt, "hours": hours}
}

var (
	statsHourKey  = regexp.MustCompile(`^\d{10,14}$`)
	statsToolName = regexp.MustCompile(`^[\w.:-]{1,80}$`)
)

// numKeys: an object's keys in the order Object.entries gives them for these keys (big numbers, read back in
// time order).
func numKeys(m M) []string {
	keys := sortedKeys(m)
	sort.SliceStable(keys, func(i, j int) bool {
		a, ea := strconv.ParseFloat(keys[i], 64)
		b, eb := strconv.ParseFloat(keys[j], 64)
		if ea == nil && eb == nil {
			return a < b
		}
		return keys[i] < keys[j]
	})
	return keys
}

// cleanStats: numbers as the server keeps them: only known fields, sane sizes. Nil when it is not that shape.
func cleanStats(v any) M {
	s, ok := v.(M)
	if !ok || s == nil {
		return nil
	}
	num := func(x any) float64 {
		n := jsNumber(x)
		if n != n || math.IsInf(n, 0) {
			return 0
		}
		return n
	}
	spans := []any{}
	src, _ := s["spans"].([]any)
	if len(src) > 20_000 {
		src = src[len(src)-20_000:]
	}
	for _, x := range src {
		if a, ok := x.([]any); ok && len(a) == 2 {
			spans = append(spans, []any{num(a[0]), num(a[1])})
		}
	}
	hours := M{}
	hs, _ := s["hours"].(M)
	keys := numKeys(hs)
	if len(keys) > 24*STATS_DAYS {
		keys = keys[len(keys)-24*STATS_DAYS:]
	}
	for _, k := range keys {
		vv, ok := hs[k].(M)
		if !statsHourKey.MatchString(k) || !ok || vv == nil {
			continue
		}
		t := M{}
		tm, _ := vv["t"].(M)
		names := sortedKeys(tm)
		if len(names) > 100 {
			names = names[:100]
		}
		for _, name := range names {
			if statsToolName.MatchString(name) {
				t[name] = num(tm[name])
			}
		}
		h := M{"a": 1.0}
		if truthy(vv["m"]) {
			h["m"] = num(vv["m"])
		}
		if truthy(vv["p"]) {
			h["p"] = num(vv["p"])
		}
		if len(t) > 0 {
			h["t"] = t
		}
		hours[k] = h
	}
	var open any
	if s["open"] != nil {
		open = num(s["open"])
	}
	return M{"spans": spans, "open": open, "lastAt": num(s["lastAt"]), "hours": hours}
}

func round2(x float64) float64 { return math.Floor(x*100+0.5) / 100 }

// addStats: the statistics page from every session's numbers (list of {stats, cwd, id}), for the last `days` days.
func addStats(list []M, days float64, now float64) M {
	from := now - days*statsDay
	type span struct {
		a, b float64
		cwd  any
		sid  any
	}
	type dayRec struct {
		day      string
		workMs   float64
		mine     float64
		sessions map[string]bool
	}
	spans := []span{}
	tools := newOMap[float64]()
	folders := newOMap[float64]()
	daily := newOMap[*dayRec]()
	heat := make([][]float64, 7)
	for i := range heat {
		heat[i] = make([]float64, 24)
	}
	toolCalls := 0.0
	permissions := 0.0
	dayName := func(t float64) string {
		return time.UnixMilli(int64(t)).Local().Format("2006-01-02")
	}
	dayOf := func(t float64) *dayRec {
		k := dayName(t)
		d, ok := daily.Get(k)
		if !ok {
			d = &dayRec{day: k, sessions: map[string]bool{}}
			daily.Set(k, d)
		}
		return d
	}
	for _, item := range list {
		s := asM(item["stats"])
		if s == nil {
			continue
		}
		cwd, id := item["cwd"], item["id"]
		push := func(a, b float64) {
			if b > from {
				spans = append(spans, span{math.Max(a, from), b, cwd, id})
			}
		}
		for _, x := range asArr(s["spans"]) {
			a := asArr(x)
			if len(a) == 2 {
				push(jsNumber(a[0]), jsNumber(a[1]))
			}
		}
		if s["open"] != nil {
			o, la := jsNumber(s["open"]), jsNumber(s["lastAt"])
			if now-la < TURN_CAP {
				push(o, math.Min(now, o+TURN_CAP))
			} else {
				push(o, math.Min(la+60_000, o+TURN_CAP))
			}
		}
		hs := asM(s["hours"])
		for _, k := range numKeys(hs) {
			h := asM(hs[k])
			at := jsNumber(k)
			if at+statsHour <= from {
				continue
			}
			tm := asM(h["t"])
			for _, name := range sortedKeys(tm) {
				n := jsNumber(tm[name])
				toolCalls += n
				tools.Set(name, tools.Val(name)+n)
			}
			permissions += numOr0(h["p"])
			if truthy(h["m"]) {
				m := jsNumber(h["m"])
				dayOf(at).mine += m
				d := time.UnixMilli(int64(at)).Local()
				heat[int(d.Weekday())][d.Hour()] += m
			}
			dayOf(at).sessions[jsString(id)] = true
		}
	}
	for _, s := range spans {
		k := jsString(s.cwd)
		if s.cwd == nil {
			k = "undefined"
		}
		folders.Set(k, folders.Val(k)+(s.b-s.a))
		for a := s.a; a < s.b; {
			t := time.UnixMilli(int64(a)).Local()
			mid := float64(time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, time.Local).UnixMilli())
			next := math.Min(s.b, mid)
			dayOf(a).workMs += next - a
			a = next
		}
	}
	type edge struct{ t, d float64 }
	edges := []edge{}
	for _, s := range spans {
		edges = append(edges, edge{s.a, 1}, edge{s.b, -1})
	}
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].t != edges[j].t {
			return edges[i].t < edges[j].t
		}
		return edges[i].d < edges[j].d
	})
	level, peak, busy, prev := 0.0, 0.0, 0.0, 0.0
	for _, e := range edges {
		if level > 0 {
			busy += e.t - prev
		}
		level += e.d
		peak = math.Max(peak, level)
		prev = e.t
	}
	work := 0.0
	lens := []float64{}
	for _, s := range spans {
		work += s.b - s.a
		lens = append(lens, s.b-s.a)
	}
	sort.Float64s(lens)
	q := func(p float64) any {
		if len(lens) == 0 {
			return nil
		}
		return lens[int(math.Min(float64(len(lens)-1), math.Floor(p*float64(len(lens)))))]
	}
	bucket := 3 * statsHour
	if days == 1 {
		bucket = 15 * 60_000
	} else if days <= 7 {
		bucket = statsHour
	}
	series := []any{}
	for t := from; t < now; t += bucket {
		n := 0.0
		for _, s := range spans {
			n += math.Max(0, math.Min(s.b, t+bucket)-math.Max(s.a, t))
		}
		series = append(series, round2(n/bucket))
	}
	top := func(o *OMap[float64], key, val string) []any {
		keys := o.Keys()
		sort.SliceStable(keys, func(i, j int) bool { return o.Val(keys[i]) > o.Val(keys[j]) })
		if len(keys) > 10 {
			keys = keys[:10]
		}
		out := []any{}
		for _, k := range keys {
			out = append(out, orderedObj{{key, k}, {val, o.Val(k)}})
		}
		return out
	}
	days2 := daily.Values()
	sort.SliceStable(days2, func(i, j int) bool { return days2[i].day < days2[j].day })
	dl := []any{}
	for _, d := range days2 {
		dl = append(dl, orderedObj{{"day", d.day}, {"workMs", d.workMs}, {"mine", d.mine}, {"sessions", float64(len(d.sessions))}})
	}
	heatOut := make([]any, 7)
	for i := range heat {
		heatOut[i] = anyList(heat[i])
	}
	avg := 0.0
	if busy != 0 {
		avg = round2(work / busy)
	}
	return M{
		"days":        days,
		"totals":      orderedObj{{"work", work}, {"busy", busy}, {"avgConcurrency", avg}, {"peakConcurrency", peak}},
		"turns":       orderedObj{{"count", float64(len(lens))}, {"medianMs", q(0.5)}, {"p90Ms", q(0.9)}},
		"tools":       toolCalls,
		"permissions": permissions,
		"series":      series,
		"heat":        heatOut,
		"daily":       dl,
		"topFolders":  top(folders, "cwd", "workMs"),
		"topTools":    top(tools, "name", "count"),
	}
}

// ---------- agent/guard.mjs (what the server checks: the signature over the agent's files) ----------

var (
	agentFileName = regexp.MustCompile(`^[a-z]+\.mjs$`)
	keysListRe    = regexp.MustCompile(`UPDATE_KEYS\s*=\s*\[([^\]]*)\]`)
	keyStrRe      = regexp.MustCompile(`'([A-Za-z0-9+/=]+)'|"([A-Za-z0-9+/=]+)"`)
)

// updateKeys: who may sign an agent update, from agent/keys.mjs (itself a signed agent file).
func updateKeys() []string {
	b, err := os.ReadFile(filepath.Join(ROOT, "agent", "keys.mjs"))
	if err != nil {
		return nil
	}
	m := keysListRe.FindSubmatch(b)
	if m == nil {
		return nil
	}
	out := []string{}
	for _, k := range keyStrRe.FindAllStringSubmatch(string(m[1]), -1) {
		out = append(out, k[1]+k[2])
	}
	return out
}

// manifestOf: every file's name, length and full SHA-256, in the order they are sent, after a number that only grows.
func manifestOf(names []string, files map[string]string, seq float64) (string, bool) {
	lines := []string{}
	for _, name := range names {
		if !agentFileName.MatchString(name) {
			return "", false
		}
		text := files[name]
		h := sha256.Sum256([]byte(text))
		lines = append(lines, name+"\x00"+itoa(len(text))+"\x00"+hex.EncodeToString(h[:]))
	}
	return "claude-bridge-agent-manifest\nseq:" + numStr(seq) + "\n" + strings.Join(lines, "\n") + "\n", true
}

func ed25519Verify(keyB64 string, msg, sig []byte) bool {
	der, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return false
	}
	pk, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return false
	}
	k, ok := pk.(ed25519.PublicKey)
	return ok && ed25519.Verify(k, msg, sig)
}

// manifestSigned: whether msig (base64) is one of the update keys' signature of these files' manifest under seq.
// The files are in AGENT_FILES order (the order they are sent).
func manifestSigned(files map[string]string, seq any, msig any) bool {
	n, ok := seq.(float64)
	sig, ok2 := msig.(string)
	if files == nil || !ok || !isSafeInteger(n) || n < 1 || !ok2 || sig == "" {
		return false
	}
	names := []string{}
	for _, f := range AGENT_FILES {
		if _, has := files[f]; has {
			names = append(names, f)
		}
	}
	text, good := manifestOf(names, files, n)
	if !good {
		return false
	}
	bytes, err := base64.StdEncoding.DecodeString(strings.TrimRight(sig, "="))
	if err != nil {
		bytes, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(sig, "="))
		if err != nil {
			return false
		}
	}
	for _, k := range updateKeys() {
		if ed25519Verify(k, []byte(text), bytes) {
			return true
		}
	}
	return false
}
