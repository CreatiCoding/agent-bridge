// Small modules of the Node server: login-pin.mjs, folder.mjs, models.mjs, prview.mjs, drop-root.mjs.
package main

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// ---------- login-pin.mjs ----------

func loadPins(saved any, usersRaw M) M {
	pins := M{}
	if s, ok := saved.(M); ok {
		for l, uid := range s {
			if _, isS := uid.(string); isS {
				pins[l] = uid
			}
		}
		return pins
	}
	if _, isArr := saved.([]any); isArr {
		return pins
	}
	// In the file's order, as Object.entries read it (users is loaded from the same file just before).
	keys := []string{}
	if users != nil {
		for _, id := range users.Keys() {
			if _, ok := usersRaw[id]; ok {
				keys = append(keys, id)
			}
		}
	}
	if len(keys) != len(usersRaw) {
		keys = sortedKeys(usersRaw)
	}
	for _, id := range keys {
		u := asM(usersRaw[id])
		l := ""
		if u["login"] != nil {
			l = strings.ToLower(jsString(u["login"]))
		}
		if _, has := pins[l]; strings.HasPrefix(id, "gh") && l != "" && !strings.HasSuffix(l, "#released") && !has {
			pins[l] = id
		}
	}
	return pins
}

func heldBy(pins M, uid, login string) string {
	l := strings.ToLower(login)
	if v, ok := pins[l].(string); ok && v != uid {
		return v
	}
	return ""
}

func claimLogin(pins M, uid, login string) string {
	if other := heldBy(pins, uid, login); other != "" {
		return other
	}
	pins[strings.ToLower(login)] = uid
	return ""
}

// ---------- folder.mjs ----------

const (
	FOLDER_BASE     = "~/bridge/works"
	FOLDER_NO_GROUP = "기타"
)

var (
	folderTrail   = regexp.MustCompile(`(.)/+$`)
	folderStart   = regexp.MustCompile(`^(~|/)`)
	folderDotDot  = regexp.MustCompile(`(^|/)\.\.(/|$)`)
	folderBad     = regexp.MustCompile(`[\x00\n\r]`)
	partSep       = regexp.MustCompile(`[/\\:\x00\n\r\t]+`)
	partLead      = regexp.MustCompile(`^[.-]+`)
	partDashes    = regexp.MustCompile(`-{2,}`)
	partTrailDash = regexp.MustCompile(`-+$`)
)

func cleanFolderBase(v any) string {
	s := ""
	if v != nil {
		s = jsString(v)
	}
	s = folderTrail.ReplaceAllString(jsTrim(s), "$1")
	if jsLen(s) <= 200 && folderStart.MatchString(s) && !folderDotDot.MatchString(s) && !folderBad.MatchString(s) {
		return s
	}
	return ""
}

func folderPart(name any) string {
	s := ""
	if name != nil {
		s = jsString(name)
	}
	s = partSep.ReplaceAllString(s, "-")
	s = wsRun.ReplaceAllString(s, "-")
	s = partLead.ReplaceAllString(s, "")
	s = partDashes.ReplaceAllString(s, "-")
	s = jsSliceTo(s, 40)
	return partTrailDash.ReplaceAllString(s, "")
}

func defaultFolder(base, noGroup, group any) string {
	return defaultFolderAt(base, noGroup, group, time.Now(), randHex(3))
}

// defaultFolderAt is defaultFolder with the day and the id given (tests).
func defaultFolderAt(base, noGroup, group any, now time.Time, id string) string {
	day := padStart(itoa(int(now.Month())), 2, "0") + padStart(itoa(now.Day()), 2, "0")
	b := cleanFolderBase(base)
	if b == "" {
		b = FOLDER_BASE
	}
	b = strings.TrimSuffix(b, "/")
	part := folderPart(group)
	if part == "" {
		part = folderPart(noGroup)
	}
	if part == "" {
		part = FOLDER_NO_GROUP
	}
	return b + "/" + part + "/" + day + "-" + id
}

// ---------- models.mjs ----------

var claudePrefix = regexp.MustCompile(`^claude-`)

func modelsFromCatalog(catalog []any, prev []any) []any {
	out := []any{}
	has := func(list []any, v string) bool {
		for _, x := range list {
			if mget(x, "value") == v {
				return true
			}
		}
		return false
	}
	push := func(label, value string) {
		if !has(out, value) {
			out = append(out, orderedObj{{"label", label}, {"value", value}})
		}
	}
	var def M
	for _, c := range catalog {
		m := asM(c)
		if m["value"] == "default" {
			if def == nil {
				def = m
			}
			continue
		}
		id := jsStringU(m["value"])
		if claudePrefix.MatchString(jsStringU(m["resolved"])) {
			id = jsStringU(m["resolved"])
		}
		if has(prev, id+"[1m]") {
			push(jsStringU(m["name"])+" (1M)", id+"[1m]")
		}
		push(jsStringU(m["name"]), id)
	}
	if has(prev, "opusplan") {
		push("Opus plan / Sonnet work", "opusplan")
	}
	stands := ""
	if def != nil {
		stands = strings.Split(jsStringU(def["description"]), " · ")[0]
		if stands == "" {
			stands = jsStringU(def["resolved"])
		}
	}
	if stands != "" {
		push("Default · "+stands, "default")
	} else {
		push("Default", "default")
	}
	return asArr(jsonRound(out))
}

// ---------- prview.mjs ----------

func prSummary(prs []any, now float64, days float64) M {
	from := now - days*86_400_000
	inWin := func(t any) bool {
		s, ok := t.(string)
		if !ok || s == "" {
			return false
		}
		d := parseDate(s)
		return d >= from && d <= now
	}
	merged := []M{}
	created := []M{}
	for _, p := range prs {
		m := asM(p)
		if inWin(m["mergedAt"]) {
			merged = append(merged, m)
		}
		if inWin(m["createdAt"]) {
			created = append(created, m)
		}
	}
	times := []float64{}
	for _, p := range merged {
		x := parseDate(jsStringU(p["mergedAt"])) - parseDate(jsStringU(p["createdAt"]))
		if x >= 0 {
			times = append(times, x)
		}
	}
	sort.Float64s(times)
	quantile := func(q float64) any {
		if len(times) == 0 {
			return nil
		}
		return times[int(math.Min(float64(len(times)-1), math.Floor(q*float64(len(times)))))]
	}
	sum := func(xs []M, k string) float64 {
		t := 0.0
		for _, p := range xs {
			if v, ok := p[k].(float64); ok {
				t += v
			} else if p[k] != nil {
				t += jsNumber(p[k])
			}
		}
		return t
	}
	sorted := append([]M{}, created...)
	sort.SliceStable(sorted, func(i, j int) bool { return jsStringU(sorted[i]["createdAt"]) > jsStringU(sorted[j]["createdAt"]) })
	if len(sorted) > 20 {
		sorted = sorted[:20]
	}
	recent := []any{}
	for _, p := range sorted {
		recent = append(recent, orderedObj{{"url", p["url"]}, {"createdAt", p["createdAt"]}, {"mergedAt", p["mergedAt"]}}.dropNil())
	}
	out := M{"merged": float64(len(merged)), "created": float64(len(created)), "additions": sum(merged, "additions"), "deletions": sum(merged, "deletions"), "linked": 0.0, "recent": recent}
	if v := quantile(0.5); v != nil {
		out["medianMergeMs"] = v
	}
	if v := quantile(0.9); v != nil {
		out["p90MergeMs"] = v
	}
	return out
}

// ---------- drop-root.mjs ----------

const (
	NODE_UID = 1000
	NODE_GID = 1000
)

func chownTree(dir string, uid, gid int) int { return chownTreeWith(dir, uid, gid, os.Lchown) }

// chownTreeWith is chownTree with the chown given (tests).
func chownTreeWith(dir string, uid, gid int, chown func(string, int, int) error) int {
	failed := 0
	var walk func(p string)
	walk = func(p string) {
		st, err := os.Lstat(p)
		if err != nil {
			return
		}
		if s, ok := st.Sys().(*syscall.Stat_t); ok && (int(s.Uid) != uid || int(s.Gid) != gid) {
			if chown(p, uid, gid) != nil {
				failed++
			}
		}
		if st.IsDir() {
			ents, _ := os.ReadDir(p)
			for _, e := range ents {
				walk(filepath.Join(p, e.Name()))
			}
		}
	}
	walk(dir)
	return failed
}

// procOps: what dropRoot asks of the process (the real one, or a pretend one in tests).
type procOps struct {
	getuid    func() int
	setgroups func([]int) error
	setgid    func(int) error
	setuid    func(int) error
}

var realProc = procOps{getuid: os.Getuid, setgroups: syscall.Setgroups, setgid: syscall.Setgid, setuid: syscall.Setuid}

func dropRoot(dir string) string { return dropRootWith(dir, os.Getenv, realProc) }

func dropRootWith(dir string, getenv func(string) string, proc procOps) string {
	if proc.getuid() != 0 {
		return "root 아님"
	}
	if getenv("BRIDGE_RUN_AS_ROOT") == "1" {
		return "BRIDGE_RUN_AS_ROOT=1 이라 root 로 둠"
	}
	if failed := chownTree(dir, NODE_UID, NODE_GID); failed > 0 {
		return itoa(failed) + "개를 node 에게 넘기지 못해 root 로 둠"
	}
	if err := proc.setgroups([]int{NODE_GID}); err != nil {
		return "node 사용자로 바꾸지 못해 root 로 둠 (" + err.Error() + ")"
	}
	if err := proc.setgid(NODE_GID); err != nil {
		return "node 사용자로 바꾸지 못해 root 로 둠 (" + err.Error() + ")"
	}
	if err := proc.setuid(NODE_UID); err != nil {
		return "node 사용자로 바꾸지 못해 root 로 둠 (" + err.Error() + ")"
	}
	return "node(" + itoa(NODE_UID) + ") 사용자로 바꿈"
}

func tightenTree(dir string) int {
	changed := 0
	var walk func(p string)
	walk = func(p string) {
		st, err := os.Lstat(p)
		if err != nil {
			return
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return
		}
		want := os.FileMode(0o600)
		if st.IsDir() {
			want = 0o700
		}
		if st.Mode().Perm() != want {
			if os.Chmod(p, want) == nil {
				changed++
			}
		}
		if st.IsDir() {
			ents, err := os.ReadDir(p)
			if err != nil {
				return
			}
			for _, e := range ents {
				walk(filepath.Join(p, e.Name()))
			}
		}
	}
	walk(dir)
	return changed
}
