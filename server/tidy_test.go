// 세션 정리 (REQ-F-835~840): the policy a Mac runs with, the settings, and how a report lands on the sessions.
package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const tday = 86_400_000.0

// AC-1516: observe days, someone else's Mac, a mode someone chose, and the Mac over the account over the file.
func TestTidyPolicyOf(t *testing.T) {
	yaml := M{"mode": "auto", "observeDays": 7.0, "idleStopDays": 3.0, "restDays": 7.0, "closeSuggestDays": 30.0, "folderTrashDays": 14.0, "transcriptDays": 30.0, "transcriptMB": 10.0}
	now := 1_800_000_000_000.0
	p := tidyPolicyOf(yaml, M{}, M{}, true, now-6*tday, now)
	eq(t, p["mode"].(string), "suggest")
	eq(t, p["why"].(string), "observe")
	eq(t, p["observeUntil"].(float64), now+tday)
	eq(t, p["idleStopDays"].(float64), 3.0)
	eq(t, tidyPolicyOf(yaml, M{}, M{}, true, now-7*tday, now)["mode"].(string), "auto", "정확히 7일 뒤 자동")
	eq(t, tidyPolicyOf(yaml, M{}, M{}, true, 0, now)["mode"].(string), "suggest", "아직 묻지 않은 맥")
	o := tidyPolicyOf(yaml, M{}, M{}, false, now-30*tday, now)
	eq(t, o["mode"].(string), "suggest")
	eq(t, o["why"].(string), "owner")
	eq(t, tidyPolicyOf(yaml, M{"mode": "auto"}, M{}, false, now, now)["mode"].(string), "auto", "주인이 켜면 자동, 관찰 없음")
	eq(t, tidyPolicyOf(yaml, M{"mode": "auto"}, M{"mode": "off"}, true, 0, now)["mode"].(string), "off", "기기가 계정보다 먼저")
	eq(t, tidyPolicyOf(yaml, M{"idleStopDays": 2.0}, M{"idleStopDays": 5.0}, true, 0, now)["idleStopDays"].(float64), 5.0)
	eq(t, tidyPolicyOf(yaml, M{"idleStopDays": 2.0}, M{}, true, 0, now)["idleStopDays"].(float64), 2.0)
	eq(t, tidyPolicyOf(M{"mode": "suggest", "observeDays": 7.0}, M{}, M{}, true, now-30*tday, now)["mode"].(string), "suggest", "파일이 suggest")
}

func TestTidySettings(t *testing.T) {
	refused := func(b M) (msg string) {
		defer func() {
			if r, ok := recover().(*Refuse); ok {
				msg = r.Msg
			}
		}()
		tidySettings(M{}, b)
		return ""
	}
	eq(t, refused(M{"mode": "x"}), TIDY_BAD)
	eq(t, refused(M{"idleStopDays": -1.0}), TIDY_BAD)
	eq(t, refused(M{"idleStopDays": 1.5}), TIDY_BAD)
	eq(t, refused(M{"transcriptMB": 0.0}), TIDY_BAD)
	got := tidySettings(M{"mode": "off", "idleStopDays": 2.0}, M{"mode": nil, "idleStopDays": 5.0, "folderTrashDays": 0.0})
	jeq(t, got, `{"idleStopDays":5,"folderTrashDays":0}`)
	eq(t, tidySettingsText(M{}), "기본값 따름")
}

// AC-1519: bridge.yaml's tidy.* with their kinds and refusals.
func TestTidyYamlKeys(t *testing.T) {
	withCfg(t, "")
	eq(t, cfgGet("tidy.mode").(string), "auto")
	eq(t, cfgGet("tidy.idleStopDays").(int), 3)
	eq(t, cfgGet("tidy.transcriptMB").(int), 10)
	withCfg(t, "tidy:\n  mode: suggest\n  idleStopDays: 5\n  folderTrashDays: 0\n")
	eq(t, cfgGet("tidy.mode").(string), "suggest")
	eq(t, cfgGet("tidy.idleStopDays").(int), 5)
	eq(t, cfgGet("tidy.folderTrashDays").(int), 0)
	eq(t, cfgGet("tidy.restDays").(int), 7)
	for _, c := range []struct{ src, has string }{
		{"tidy:\n  mode: maybe\n", "tidy.mode 는 auto·suggest·off 중 하나여야 합니다"},
		{"tidy:\n  idleStopDays: -1\n", "0 부터 3650 까지의 정수(일)"},
		{"tidy:\n  transcriptMB: 0\n", "1 부터 1000000"},
		{"tidy:\n  nope: 1\n", "모르는 키 tidy.nope"},
	} {
		_, err := parseBridgeConfig("/x/bridge.yaml", []byte(c.src), envMap(nil))
		if err == nil || !strings.Contains(err.Error(), c.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", c.src, c.has, err)
		}
	}
}

func TestTidySummaryText(t *testing.T) {
	eq(t, tidySummaryText("맥", "auto", 2, 3, 5e6, 0, 0, 0, 0), "맥: 세션 2개 내림, 폴더 3개(5 MB) 휴지통")
	eq(t, tidySummaryText("맥", "auto", 0, 0, 0, 0, 4, 0, 0), "", "auto 에서 한 일이 없으면 없음")
	eq(t, tidySummaryText("맥", "suggest", 0, 0, 0, 7, 17, 2, 2.5e9), "맥: 제안만 모드 · 자동이었다면 세션 17개 내림, 폴더 2개(2.5 GB) 휴지통 · 정리 제안 7개")
}

// AC-1517: a notice puts the coming stop on the session once; a person's message takes it off; a stop is written
// down; a rest only in auto; the day's summary once, after 9.
func TestApplyTidyReport(t *testing.T) {
	uid, hostID := "tidy-test-user", "tidy-host"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	needUsers()
	defer func() { DATA, hosts = wasData, wasHosts }()
	defer delete(prefsCache, uid)
	defer delete(noticeCache, uid)
	defer delete(tidyReports, hostID)
	hosts.Set(hostID, M{"uid": uid, "name": "맥 미니"})
	now := float64(nowMs())
	for _, id := range []string{"tidy-s1", "tidy-s2", "tidy-s3"} {
		id := id
		t.Cleanup(func() { sessions.Delete(id) })
		newMeta(uid, id, hostID, M{"title": "세션 " + id, "lastAt": now})
	}
	s1, _ := sessions.Get("tidy-s1")
	s2, _ := sessions.Get("tidy-s2")
	s3, _ := sessions.Get("tidy-s3")
	s3.set("tidyStopAt", now) // a stop from an earlier report, no longer listed
	notices := func() []string {
		out := []string{}
		for _, n := range noticesOf(uid, nil) {
			out = append(out, jsString(mget(n, "key")))
		}
		return out
	}
	report := func(hour float64, extra M) M {
		r := M{"at": now, "mode": "auto", "local": M{"date": "2026-11-02", "hour": hour}, "sessions": []any{
			M{"sid": "tidy-s1", "act": "notice", "stopAt": now + tday, "idleDays": 2.0},
			M{"sid": "tidy-s2", "act": nil, "rest": true, "idleDays": 8.0},
		}, "folders": []any{}, "transcripts": []any{}, "done": M{}, "would": M{}}
		for k, v := range extra {
			r[k] = v
		}
		return r
	}
	withLock(func() { applyTidyReport(uid, hostID, report(8, nil)) })
	eq(t, numOr0(s1.get("tidyStopAt")), now+tday)
	ok(t, s3.get("tidyStopAt") == nil, "목록에 없는 세션의 예고는 지움")
	ok(t, truthy(s2.get("resting")), "auto 면 휴면")
	eq(t, len(notices()), 1, "예고 알림 하나, 8시라 요약 없음")
	ok(t, strings.HasPrefix(notices()[0], "tidy|tidy-s1|"))

	withLock(func() { markHuman(s1) })
	ok(t, s1.get("tidyStopAt") == nil && numOr0(s1.get("humanAt")) > 0, "사람 입력이 예고를 지움")

	s2.set("resting", false)
	withLock(func() {
		applyTidyReport(uid, hostID, report(9, M{"mode": "suggest", "done": M{}, "would": M{"stop": 4.0, "trash": 0.0, "bytes": 0.0}}))
	})
	ok(t, !truthy(s2.get("resting")), "suggest 면 휴면으로 두지 않음")
	n := 0
	for _, k := range notices() {
		if strings.HasPrefix(k, "tidy-day|") {
			n++
		}
	}
	eq(t, n, 1, "9시 첫 보고에 요약")
	withLock(func() {
		applyTidyReport(uid, hostID, report(10, M{"done": M{"stopped": []any{M{"sid": "tidy-s1", "idleDays": 3.0}}}}))
	})
	n = 0
	for _, k := range notices() {
		if strings.HasPrefix(k, "tidy-day|") {
			n++
		}
	}
	eq(t, n, 1, "같은 날 두 번째 요약 없음")
	found := false
	for _, l := range readHostLog(uid, hostID, "", "") {
		if strings.Contains(jsString(mget(l, "text")), "세션 정리: claude 내림 세션 tidy-s1") && mget(l, "area") == "tidy" {
			found = true
		}
	}
	ok(t, found, "내림이 기기 기록에 area tidy 로")
	ok(t, tidyView(hostID) != nil)
}

// AC-1524: the host line counts by the same rule as the page's lists (test/fixtures/tidy-groups.json, also read by
// test/unit/tidy-groups.test.mjs), and an ended session leaves it at once.
func TestTidyGroups(t *testing.T) {
	raw, err := os.ReadFile("../test/fixtures/tidy-groups.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Rows []any    `json:"rows"`
		Stop []string `json:"stop"`
		Rest []string `json:"rest"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	rows := []any{}
	for _, r := range fx.Rows {
		rows = append(rows, M(r.(map[string]any)))
	}
	stop, rest := tidyGroups(rows)
	want, _ := json.Marshal(fx.Stop)
	jeq(t, stop, string(want))
	want, _ = json.Marshal(fx.Rest)
	jeq(t, rest, string(want))
}

func TestTidyBriefDropsEnded(t *testing.T) {
	uid, hostID := "tidy-brief-user", "tidy-brief-host"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	needUsers() // tidyBrief → tidyPolicyFor → isAdmin reads it
	defer func() { DATA, hosts = wasData, wasHosts }()
	defer delete(prefsCache, uid)
	defer delete(tidyReports, hostID)
	hosts.Set(hostID, M{"uid": uid, "name": "맥"})
	now := float64(nowMs())
	for _, id := range []string{"tidy-b1", "tidy-b2", "tidy-b3"} {
		id := id
		t.Cleanup(func() { sessions.Delete(id) })
		newMeta(uid, id, hostID, M{"title": id, "lastAt": now})
	}
	tidyReports[hostID] = M{"at": now, "sessions": []any{
		M{"sid": "tidy-b1", "alive": true, "act": "suggest"},
		M{"sid": "tidy-b2", "alive": false, "rest": true, "close": true},
		M{"sid": "tidy-b3", "alive": false, "close": true},
	}, "folders": []any{M{"path": "~/a"}}, "transcripts": []any{M{"path": "~/b"}}}
	b := asM(tidyBrief(hostID))
	eq(t, b["stop"].(float64), 1.0)
	eq(t, b["rest"].(float64), 2.0)
	eq(t, b["files"].(float64), 2.0)
	s3, _ := sessions.Get("tidy-b3")
	s3.set("closed", true)
	eq(t, asM(tidyBrief(hostID))["rest"].(float64), 1.0, "끝낸 세션은 다음 보고를 기다리지 않고 빠진다")
}

// AC-1544: a favourite is out of every automatic step. Making one takes a coming stop off at once; the batch is told
// (holds, ended); a report from before it does not put a stop or a rest on it; the page shows it held; letting go
// keeps no mark, so the next batch judges it as before.
func TestTidyFavorite(t *testing.T) {
	meta := hookSession(t, "")
	defer delete(tidyReports, "h1")
	withLock(func() { meta.set("tidyStopAt", float64(nowMs())+tday) })
	code, _ := pageCall(t, "POST", "/api/sessions/s1/settings", `{"favorite":true}`)
	eq(t, code, 200)
	withLock(func() {
		ok(t, meta.get("tidyStopAt") == nil, "즐겨찾기하면 예고를 지움")
		ok(t, meta.get("humanAt") == nil, "즐겨찾기는 사람 입력이 아님")
		eq(t, mget(tidyHolds("h1")["s1"], "favorite"), any(true))
		now := float64(nowMs())
		applyTidyReport("gh1", "h1", M{"at": now, "mode": "auto", "local": M{"date": "2026-11-02", "hour": 8.0}, "sessions": []any{
			M{"sid": "s1", "alive": true, "act": "wait", "stopAt": now + tday, "idleDays": 3.0, "rest": true, "close": true},
		}, "folders": []any{}, "transcripts": []any{}, "done": M{}, "would": M{}})
		ok(t, meta.get("tidyStopAt") == nil, "즐겨찾기 전 보고도 예고를 두지 않음")
		ok(t, !truthy(meta.get("resting")), "즐겨찾기는 휴면으로 두지 않음")
		row := asM(asArr(asM(tidyView("h1"))["sessions"])[0])
		ok(t, row["act"] == nil && row["why"] == TIDY_FAVORITE_WHY && row["rest"] == false && row["close"] == false, "화면에는 즐겨찾기라 정리하지 않음")
		stop, rest := tidyGroups([]any{row})
		eq(t, len(stop)+len(rest), 0, "기기 줄 숫자에도 세지 않음")
		meta.set("closed", true) // ended (closeSession also tells the pages, which this test has none of)
		ended := asArr(tidyRunFor("h1")["ended"])
		eq(t, len(ended), 1)
		eq(t, mget(ended[0], "favorite"), any(true), "끝난 즐겨찾기 세션의 폴더를 에이전트에 알림")
		meta.set("closed", false)
	})
	code, _ = pageCall(t, "POST", "/api/sessions/s1/settings", `{"favorite":false}`)
	eq(t, code, 200)
	withLock(func() {
		ok(t, meta.get("favorite") == nil, "빼면 필드가 없음")
		eq(t, mget(tidyHolds("h1")["s1"], "favorite"), any(false))
		ok(t, meta.get("humanAt") == nil, "빼도 쉰 기간은 마지막 사람 입력부터")
	})
}

// AC-1634: the 세션 정리 page names every row by its session: a session row carries its folder, a folder row the name
// of the newest session that worked there, a transcript row the session whose conversation it is. Rows no session
// on this host matches keep no name (the page falls back to the folder's name).
func TestTidyViewNames(t *testing.T) {
	hostID, uid := "tidy-host-n", "tidy-name-user"
	wasData, wasHosts := DATA, hosts
	DATA, hosts = t.TempDir(), newOMap[M]()
	defer func() { DATA, hosts = wasData, wasHosts }()
	defer delete(tidyReports, hostID)
	hosts.Set(hostID, M{"uid": uid, "name": "맥"})
	hosts.Set("other-host", M{"uid": uid, "name": "다른 맥"})
	now := float64(nowMs())
	mk := func(id string, f M) *Sess {
		t.Cleanup(func() { sessions.Delete(id) })
		return newMeta(uid, id, hostID, f)
	}
	mk("tidy-n1", M{"title": "결제 화면 고치기", "cwd": "/Users/u/works/a", "createdAt": now - 1000})
	old := mk("tidy-n2", M{"title": "옛 이름", "cwd": "/Users/u/works/b", "createdAt": now - 9000})
	old.set("closed", true)
	mk("tidy-n3", M{"title": "새 이름", "cwd": "/Users/u/works/b", "createdAt": now - 100})
	mk("tidy-n4", M{"title": "기록 주인", "cwd": "/Users/u/x", "conv": "conv-abc"})
	mk("tidy-n5", M{"title": "다른 기기", "cwd": "/Users/u/works/c"}).set("hostId", "other-host")
	tidyReports[hostID] = M{"at": now, "sessions": []any{M{"sid": "tidy-n1", "alive": true, "act": "suggest"}},
		"folders": []any{
			M{"dir": "/Users/u/works/b", "path": "~/works/b"},
			M{"dir": "/Users/u/works/c", "path": "~/works/c"},
		},
		"transcripts": []any{M{"path": "~/.claude/projects/x/conv-abc.jsonl", "conv": "conv-abc"}}}
	withLock(func() {
		v := asM(tidyView(hostID))
		s := asM(asArr(v["sessions"])[0])
		eq(t, s["title"], any("결제 화면 고치기"))
		eq(t, s["cwd"], any("/Users/u/works/a"))
		f := asArr(v["folders"])
		eq(t, mget(f[0], "name"), any("새 이름"), "그 폴더의 가장 최근 세션 이름")
		eq(t, mget(f[0], "sid"), any("tidy-n3"))
		ok(t, mget(f[1], "name") == nil, "다른 기기의 세션 이름은 붙이지 않음")
		eq(t, mget(asArr(v["transcripts"])[0], "name"), any("기록 주인"))
		mk("tidy-n6", M{"cwd": "/Users/u/works/d"})
		tidyReports[hostID]["sessions"] = []any{M{"sid": "tidy-n6", "alive": true, "act": "suggest"}}
		ok(t, asM(asArr(asM(tidyView(hostID))["sessions"])[0])["title"] == nil, "이름 없는 세션은 id 를 제목으로 주지 않음(화면이 폴더 이름)")
	})
}
