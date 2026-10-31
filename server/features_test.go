package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// withCfg sets CONFIG from a text for one test.
func withCfg(t *testing.T, src string) {
	t.Helper()
	keep := CONFIG
	t.Cleanup(func() { CONFIG = keep })
	c, err := parseBridgeConfig("/etc/bridge/bridge.yaml", []byte(src), envMap(nil))
	if err != nil {
		t.Fatalf("%q: %v", src, err)
	}
	CONFIG = c
}

// AC-1477: without the keys every feature is on, as today; the keys read with their kinds.
func TestFeatureKeysDefaultsAndValues(t *testing.T) {
	withCfg(t, "")
	for _, f := range []string{"sessionMove", "webpush", "voice", "preview", "skills", "slack", "remoteKeys"} {
		ok(t, cfgOn("features."+f), f+" 기본은 켜짐")
	}
	ok(t, reflect.DeepEqual(cfgGet("features.permissionModes"), LAUNCH_MODES), "모드 기본은 여섯 전부")
	eq(t, cfgGet("retention.uploadsHours").(int), 24)
	ok(t, cfgOn("retention.previews"))
	eq(t, cfgGet("privacy.file").(string), "")
	eq(t, cspMore("csp.frameSrc"), "")

	withCfg(t, "features:\n  voice: false\n  permissionModes: [plan, acceptEdits]\nretention:\n  uploadsHours: 2\n  previews: false\ncsp:\n  frameSrc: [https://frame.example.com, \"https://*.docs.example.com:8443/a/B\"]\nprivacy:\n  file: ./privacy.html\n")
	ok(t, !cfgOn("features.voice") && cfgOn("features.webpush"))
	ok(t, reflect.DeepEqual(cfgGet("features.permissionModes"), []string{"default", "plan", "acceptEdits"}), "default 는 늘 들어 있고 대소문자 그대로")
	eq(t, cfgGet("retention.uploadsHours").(int), 2)
	eq(t, uploadTTL(), 2*3600_000.0)
	ok(t, !cfgOn("retention.previews"))
	eq(t, cfgGet("privacy.file").(string), "/etc/bridge/privacy.html", "설정 파일 폴더 기준")
	eq(t, cspMore("csp.frameSrc"), " https://frame.example.com https://*.docs.example.com:8443/a/B")
	keepP, keepSec := preview, SECURITY
	defer func() { preview, SECURITY = keepP, keepSec }()
	preview = &Preview{ORIGINS: []string{"https://lp1.bridge.test"}}
	initSecurity()
	csp := SECURITY["Content-Security-Policy"].(string)
	ok(t, strings.Contains(csp, "frame-src 'self' ") && strings.Contains(csp, "https://frame.example.com"), csp)
	connect := strings.Split(strings.Split(csp, "connect-src")[1], ";")[0]
	ok(t, !strings.Contains(connect, "frame.example.com") && !strings.Contains(csp, "script-src"), "connect-src 는 넓히지 않고 script-src 는 생기지 않음")
}

func TestFeatureKeysRefuse(t *testing.T) {
	bad := []struct{ src, has string }{
		{"features:\n  voice: off\n", "true 나 false"},
		{"features:\n  nope: true\n", "모르는 키 features.nope"},
		{"features:\n  permissionModes: [plan, yolo]\n", "yolo 는 모르는 모드"},
		{"features:\n  permissionModes: [Plan]\n", "Plan 는 모르는 모드"},
		{"retention:\n  uploadsHours: 0\n", "1 부터 8760"},
		{"retention:\n  uploadsHours: 1.5\n", "1 부터 8760"},
		{"csp:\n  imgSrc: [\"https://a.example; script-src *\"]\n", "https://호스트"},
		{"csp:\n  imgSrc: [http://a.example]\n", "https://호스트"},
		{"csp:\n  imgSrc: [\"'unsafe-inline'\"]\n", "https://호스트"},
		{"privacy:\n  file: ./privacy.md\n", ".html"},
	}
	for _, c := range bad {
		_, err := parseBridgeConfig("/x/bridge.yaml", []byte(c.src), envMap(nil))
		if err == nil || !strings.Contains(err.Error(), c.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", c.src, c.has, err)
		}
	}
}

// A mode outside permissionModes is lowered to default (asking), not refused; the defaults and the list follow.
func TestPermissionModesLower(t *testing.T) {
	withCfg(t, "features:\n  permissionModes: [plan]\n")
	m, all := startMode("allowAll")
	ok(t, m == "default" && !all, "전부 허용은 default 로")
	m, all = startMode("plan")
	ok(t, m == "plan" && !all)
	m, _ = startMode("")
	eq(t, m, "", "맥 기본값은 그대로")
	ok(t, modeOk("default") && !modeOk("autoAllow") && !modeOk("acceptEdits"))
	eq(t, cleanLaunch(M{"mode": "autoAllow"})["mode"].(string), "", "개인 기본값도 거름")
	eq(t, cleanLaunch(M{"mode": "plan"})["mode"].(string), "plan")
	withCfg(t, "features:\n  permissionModes: [autoAllow]\n")
	m, all = startMode("autoAllow")
	ok(t, m == "default" && all, "안전한 전부 허용은 그대로")
	ok(t, !modeOk(allowMode(true)) && modeOk(allowMode(false)))
}

func TestNeedFeature(t *testing.T) {
	withCfg(t, "features:\n  remoteKeys: false\n")
	defer func() {
		rf, _ := recover().(*Refuse)
		ok(t, rf != nil && rf.Status == 403, "꺼진 기능은 403")
	}()
	needFeature("voice")
	needFeature("remoteKeys")
	t.Error("여기 오면 안 됨")
}

// privacy.file must be there and readable at start, like the settings file.
func TestPrivacyFileAtStart(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bridge.yaml")
	_ = os.WriteFile(f, []byte("privacy:\n  file: mine.html\n"), 0o600)
	c, err := loadBridgeConfig(dir, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	ok(t, reflect.DeepEqual(c.files(), []string{f, filepath.Join(dir, "mine.html")}), "설정 파일과 가리키는 파일")
	me := procOps{getuid: func() int { return 1000 }}
	err = prepareConfigFile(filepath.Join(dir, "mine.html"), dir, envMap(nil), me)
	ok(t, err != nil && strings.Contains(err.Error(), "없습니다"), "없으면 시작하지 않음")
	_ = os.WriteFile(filepath.Join(dir, "mine.html"), []byte("<p>mine</p>"), 0o600)
	ok(t, prepareConfigFile(filepath.Join(dir, "mine.html"), dir, envMap(nil), me) == nil)
}

// callAPI runs one signed-in route and gives the status and body (a refusal's status when refused).
func callAPI(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	req := newReq(r)
	res := newRes(req)
	code := 0
	func() {
		defer func() {
			if x := recover(); x != nil {
				rf, isRefuse := x.(*Refuse)
				if !isRefuse {
					panic(x)
				}
				code = rf.Status
			}
		}()
		withLock(func() { api(req, res, r.URL, "gh1") })
	}()
	if code != 0 {
		return code, ""
	}
	return res.status, string(res.body)
}

// AC-1477: a feature turned off answers 403 at its API, /api/me says so, the mode list is filtered.
func TestFeaturesOffAtAPI(t *testing.T) {
	_ = withConfigServer(t)
	withCfg(t, "features:\n  webpush: false\n  voice: false\n  skills: false\n  slack: false\n  permissionModes: [plan]\n")
	code, body := callAPI(t, "GET", "/api/me", "")
	eq(t, code, 200)
	jeq(t, oget(js(body), "features"), `{"background":true,"permissionModes":["default","plan"],"preview":true,"remoteKeys":true,"sessionMove":true,"skills":false,"slack":false,"voice":false,"webpush":false}`, body)
	// Who is signed in, and how (REQ-F-824: an extension's settings section gets them).
	uid, _ := oget(js(body), "uid").(string)
	ok(t, uid != "", body)
	jeq(t, oget(js(body), "provider"), `"`+providerOf(uid)+`"`, body)
	for _, c := range [][2]string{{"GET", "/api/push/key"}, {"POST", "/api/push/subscribe"}, {"POST", "/api/prefs/voice"}, {"GET", "/api/skills"}, {"GET", "/api/prefs/skills"}, {"POST", "/api/plugins/slack"}} {
		code, _ = callAPI(t, c[0], c[1], "{}")
		eq(t, code, 403, c[0]+" "+c[1])
	}
	code, body = callAPI(t, "GET", "/api/options", "")
	eq(t, code, 200)
	modes := []string{}
	for _, m := range asArr(oget(js(body), "modes")) {
		modes = append(modes, mstr(m, "value"))
	}
	ok(t, reflect.DeepEqual(modes, []string{"default", "plan"}), strings.Join(modes, ","))
	// Nothing off: the same routes answer as today.
	withCfg(t, "")
	code, _ = callAPI(t, "GET", "/api/push/key", "")
	eq(t, code, 200)
}
