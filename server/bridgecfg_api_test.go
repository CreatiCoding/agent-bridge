package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// callConfig runs apiConfig and gives the status, the body and the refusal's extra fields.
func callConfig(t *testing.T, method, path, body string) (int, string, M) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	req := newReq(r)
	res := newRes(req)
	code, extra := 0, M(nil)
	func() {
		defer func() {
			if x := recover(); x != nil {
				rf, isRefuse := x.(*Refuse)
				if !isRefuse {
					panic(x)
				}
				code, extra = rf.Status, rf.Extra
			}
		}()
		withLock(func() { apiConfig(req, res, r.URL, "gh1") })
	}()
	if code != 0 {
		return code, "", extra
	}
	return res.status, string(res.body), nil
}

func withConfigServer(t *testing.T) string {
	keepD, keepAd, keepU, keepC, keepF := DATA, ADMINS, users, CONFIG, frozen
	t.Cleanup(func() { DATA, ADMINS, users, CONFIG, frozen = keepD, keepAd, keepU, keepC, keepF })
	DATA = t.TempDir()
	users = newOMap[M]()
	users.Set("gh1", M{"login": "boss"})
	users.Set("gh2", M{"login": "other"})
	ADMINS = []string{"boss"}
	CONFIG = &bridgeCfg{state: "none", set: map[string]cfgVal{}}
	for _, k := range []string{"BRIDGE_CONFIG", "BRIDGE_ORIGIN", "GITHUB_ALLOWED_LOGINS", "BRIDGE_ADMIN_LOGINS", "BRIDGE_PURGE"} {
		t.Setenv(k, "")
	}
	return filepath.Join(DATA, "bridge.yaml")
}

// AC-1474: the export is references only, never a value; saving makes the file once; a second save is refused.
func TestConfigExportSaveCheck(t *testing.T) {
	file := withConfigServer(t)
	t.Setenv("BRIDGE_ORIGIN", "https://b.example")
	t.Setenv("BRIDGE_ADMIN_LOGINS", "Boss")
	t.Setenv("GITHUB_CLIENT_SECRET", "s3cr3t-value")

	text := exportText(env, time.Unix(0, 0))
	ok(t, strings.Contains(text, `primary: "${BRIDGE_ORIGIN:-}"`) && strings.Contains(text, `admins: "${BRIDGE_ADMIN_LOGINS:-}"`), text)
	ok(t, !strings.Contains(text, "b.example") && !strings.Contains(text, "Boss") && !strings.Contains(text, "s3cr3t"), "값·비밀값이 없어야 함")
	ok(t, !strings.Contains(text, "retention:") && strings.Contains(text, "retention.allowPurge"), "빈 절은 쓰지 않고 받는 키로 안내")

	code, body, _ := callConfig(t, "GET", "/api/admin/config/export", "")
	eq(t, code, 200)
	ok(t, strings.Contains(body, "${BRIDGE_ORIGIN:-}"), body)

	code, body, _ = callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 200, body)
	b, err := os.ReadFile(file)
	ok(t, err == nil && strings.Contains(string(b), "${BRIDGE_ADMIN_LOGINS:-}"), "저장된 파일")
	st, _ := os.Stat(file)
	eq(t, st.Mode().Perm(), os.FileMode(0o600))
	ents, _ := os.ReadDir(DATA)
	eq(t, len(ents), 1, "임시 파일이 남지 않아야 함")

	code, _, extra := callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 409, "있으면 덮어쓰지 않음")
	eq(t, extra["exists"], any(true))
	code, _, extra = callConfig(t, "GET", "/api/admin/config/export", "")
	eq(t, code, 409, "파일이 있으면 내보내기도 409")
	ok(t, extra["masked"] != nil && extra["path"] == file, "409 본문에 경로와 가린 원문")

	// The file on disk is checked with the real environment: an exported file has no differences.
	code, body, _ = callConfig(t, "POST", "/api/admin/config/check", "{}")
	eq(t, code, 200)
	jeq(t, oget(js(body), "ok"), "true", body)
	jeq(t, oget(js(body), "diff"), "[]", body)
	// A pasted text may not resolve other variables (secrets must not be probed).
	code, body, _ = callConfig(t, "POST", "/api/admin/config/check", `{"yaml":"auth:\n  admins: \"${GITHUB_CLIENT_SECRET}\"\n"}`)
	eq(t, code, 200)
	jeq(t, oget(js(body), "ok"), "false", body)
	jeq(t, oget(js(body), "unsubstituted"), `["GITHUB_CLIENT_SECRET"]`, body)
	ok(t, !strings.Contains(body, "s3cr3t"), "값이 나오면 안 됨")
	code, body, _ = callConfig(t, "POST", "/api/admin/config/check", `{"yaml":"auth:\n  admins: [a, \"${BRIDGE_ADMIN_LOGINS:-}\"]\n"}`)
	jeq(t, oget(js(body), "ok"), "true", body)
	ok(t, strings.Contains(body, `"key":"auth.admins"`), "차이 목록에 키")
	code, body, _ = callConfig(t, "POST", "/api/admin/config/check", `{"yaml":"hooks:\n  x: 1\n"}`)
	ok(t, strings.Contains(body, "모르는 키 hooks"), body)

	code, body, _ = callConfig(t, "GET", "/api/admin/config", "")
	eq(t, code, 200)
	jeq(t, oget(js(body), "state"), `"file"`, body)
	jeq(t, oget(js(body), "exportable"), "false", body)
}

func TestConfigSaveEdges(t *testing.T) {
	file := withConfigServer(t)
	t.Setenv("BRIDGE_ADMIN_LOGINS", "boss")
	// A 0-byte file left by a removed mount is replaced; a comments-only file is not.
	_ = os.WriteFile(file, nil, 0o600)
	code, body, _ := callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 200, body)
	_ = os.WriteFile(file, []byte("# 손으로 쓴 주석\n"), 0o600)
	code, _, _ = callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 409)
	b, _ := os.ReadFile(file)
	eq(t, string(b), "# 손으로 쓴 주석\n", "주석 파일은 그대로")
	_ = os.Remove(file)
	// During a handover the old instance writes nothing: 503, not a silent no-op.
	frozen = true
	code, _, _ = callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 503)
	frozen = false
	// Another path named by BRIDGE_CONFIG: export only.
	t.Setenv("BRIDGE_CONFIG", filepath.Join(DATA, "elsewhere.yaml"))
	code, _, _ = callConfig(t, "POST", "/api/admin/config/save", "{}")
	eq(t, code, 409)
	t.Setenv("BRIDGE_CONFIG", "")
	// Only operators.
	r := httptest.NewRequest("GET", "/api/admin/config", nil)
	req := newReq(r)
	func() {
		defer func() {
			rf, _ := recover().(*Refuse)
			ok(t, rf != nil && rf.Status == 403, "운영자만")
		}()
		withLock(func() { apiConfig(req, newRes(req), r.URL, "gh2") })
	}()
}

func TestConfigMaskAndCLI(t *testing.T) {
	m := maskConfigText("notify:\n  - url: https://hooks.slack.com/services/T0/B0/xyz?x=1\n    secret: \"${N}\"\n    apiKey: abc\n")
	ok(t, !strings.Contains(m, "services") && !strings.Contains(m, "abc") && strings.Contains(m, "https://hooks.slack.com/…"), m)
	ok(t, strings.Contains(m, "secret: ***"), m)
	_ = withConfigServer(t)
	t.Setenv("BRIDGE_DATA", DATA)
	eq(t, configCLI(nil), 2)
	eq(t, configCLI([]string{"nope"}), 2)
	eq(t, configCLI([]string{"check"}), 0, "파일이 없으면 통과")
	_ = os.WriteFile(filepath.Join(DATA, "bridge.yaml"), []byte("hooks: {}\n"), 0o600)
	eq(t, configCLI([]string{"check"}), 1, "모르는 키")
	ents, _ := os.ReadDir(DATA)
	eq(t, len(ents), 1, "명령줄은 아무 파일도 만들지 않음")
}
