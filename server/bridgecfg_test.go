package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func envMap(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func cfgOf(t *testing.T, src string, env map[string]string) *bridgeCfg {
	t.Helper()
	c, err := parseBridgeConfig("/x/bridge.yaml", []byte(src), envMap(env))
	if err != nil {
		t.Fatalf("%q: %v", src, err)
	}
	return c
}

func eff(c *bridgeCfg, i int, env map[string]string) any {
	return c.effective(CFG_KEYS[i], envMap(env))
}

// An exported file (references only) means exactly what the environment means, for every rule (AC-1473).
func TestBridgeConfigReferencesFollowEnv(t *testing.T) {
	exported := "origins:\n  primary: \"${BRIDGE_ORIGIN:-}\"\nauth:\n  allow: \"${GITHUB_ALLOWED_LOGINS:-}\"\n  admins: \"${BRIDGE_ADMIN_LOGINS:-}\"\nretention:\n  allowPurge: \"${BRIDGE_PURGE:-}\"\n"
	envs := []map[string]string{
		{"BRIDGE_ORIGIN": "https://Bridge.Example.com//", "GITHUB_ALLOWED_LOGINS": " Dev4n4, *", "BRIDGE_ADMIN_LOGINS": "CreatiCoding", "BRIDGE_PURGE": "1"},
		{"BRIDGE_PURGE": "true"}, {"BRIDGE_PURGE": "yes"}, {"BRIDGE_PURGE": "0"},
		{"GITHUB_ALLOWED_LOGINS": "*"},
		{},
	}
	for _, e := range envs {
		c := cfgOf(t, exported, e)
		for i, k := range CFG_KEYS {
			if got, want := eff(c, i, e), envOnly(k, envMap(e)); !reflect.DeepEqual(got, want) {
				t.Errorf("env %v key %s: got %#v want %#v", e, k.key, got, want)
			}
		}
		if d := c.diffs(envMap(e)); len(d) != 0 {
			t.Errorf("env %v: 막 내보낸 파일의 차이 목록은 비어야 함: %+v", e, d)
		}
	}
	// The environment's rules, not the file's: no format check for the origin, BRIDGE_PURGE is exactly "1".
	e := map[string]string{"BRIDGE_ORIGIN": "https://Bridge.Example.com/path/", "BRIDGE_PURGE": "true"}
	c := cfgOf(t, exported, e)
	if eff(c, 0, e) != "https://Bridge.Example.com/path" || eff(c, 3, e) != false {
		t.Errorf("환경변수 규칙: %v %v", eff(c, 0, e), eff(c, 3, e))
	}
}

func TestBridgeConfigLiteralsAndLists(t *testing.T) {
	e := map[string]string{"GITHUB_ALLOWED_LOGINS": "a,b", "BRIDGE_ADMIN_LOGINS": "root", "OTHER": "X1, x2"}
	c := cfgOf(t, "origins:\n  primary: https://h.example:8443/\nauth:\n  allow: [\"${GITHUB_ALLOWED_LOGINS:-}\", Me@Example.com, \"*\"]\n  admins: \"${OTHER}\"\nretention:\n  allowPurge: false\n", e)
	if got := eff(c, 0, e); got != "https://h.example:8443" {
		t.Errorf("origin %v", got)
	}
	if got := eff(c, 1, e); !reflect.DeepEqual(got, []string{"a", "b", "me@example.com", "*"}) {
		t.Errorf("allow %v", got)
	}
	if got := eff(c, 2, e); !reflect.DeepEqual(got, []string{"x1", "x2"}) {
		t.Errorf("admins %v", got)
	}
	if eff(c, 3, e) != false {
		t.Error("purge")
	}
	d := c.diffs(envMap(e))
	if len(d) != 3 {
		t.Fatalf("diffs %+v", d)
	}
	for _, x := range d {
		switch x.Key {
		case "auth.allow":
			if !x.RefEnv {
				t.Error("목록 안의 같은 뜻 참조는 refEnv")
			}
		case "auth.admins":
			if x.RefEnv || !x.EnvSet {
				t.Error("다른 이름 참조는 refEnv 가 아님(배너 대상)")
			}
		}
	}
	// A list item that is the same reference and empty is left out; the rest stays.
	c = cfgOf(t, "auth:\n  allow: [\"${GITHUB_ALLOWED_LOGINS:-}\", me@example.com]\n", map[string]string{})
	if got := eff(c, 1, nil); !reflect.DeepEqual(got, []string{"me@example.com"}) {
		t.Errorf("빈 참조 항목 %v", got)
	}
	// Empty sections and ${X:-} that comes out empty are the key left out.
	c = cfgOf(t, "retention:\nauth:\n  admins: \"${NOPE:-}\"\n", map[string]string{"BRIDGE_ADMIN_LOGINS": "z"})
	if len(c.set) != 0 || !reflect.DeepEqual(eff(c, 2, map[string]string{"BRIDGE_ADMIN_LOGINS": "z"}), []string{"z"}) {
		t.Errorf("빈 절·빈 참조: %+v", c.set)
	}
	// $${ is a literal ${.
	if v, _, err := substEnv("a$${b}c", 1, envMap(nil)); err != nil || v != "a${b}c" {
		t.Errorf("$${: %q %v", v, err)
	}
}

func TestBridgeConfigRefuses(t *testing.T) {
	bad := []struct{ src, has string }{
		{"features:\n  voice: false\n", "모르는 키 features"},
		{"auth:\n  allowed: [a]\n", "모르는 키 auth.allowed"},
		{"auth: [a]\n", "키: 값"},
		{"origins:\n  primary: https://h.example/path\n", "경로 없이"},
		{"origins:\n  primary: ftp://h.example\n", "https://"},
		{"origins:\n  primary: [a]\n", "값 하나"},
		{"retention:\n  allowPurge: yes\n", "true 나 false"},
		{"retention:\n  allowPurge: \"1\"\n", "true 나 false"},
		{"auth:\n  admins: \"${MISSING}\"\n", "MISSING 가 비어"},
		{"auth:\n  admins: \"${BRIDGE_ADMIN_LOGINS}\"\n", "BRIDGE_ADMIN_LOGINS 가 비어"},
		{"auth:\n  admins: \"${X:-def}\"\n", "기본값"},
		{"auth:\n  admins: \"${1X}\"\n", "이름이 아닙니다"},
		{"auth:\n  admins: \"${X\"\n", "닫히지"},
		{"auth:\n  admins: [a, \"\"]\n", "빈 항목"},
		{"auth:\n  allow: [*]\n", "앵커"},
	}
	for _, c := range bad {
		_, err := parseBridgeConfig("/x", []byte(c.src), envMap(nil))
		if err == nil || !strings.Contains(err.Error(), c.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", c.src, c.has, err)
		}
	}
}

func TestBridgeConfigFileRules(t *testing.T) {
	dir := t.TempDir()
	get := func(m map[string]string) func(string) string { return envMap(m) }
	// No default file: none. Named but missing: refuse. Relative name: refuse. A folder: refuse.
	if c, err := loadBridgeConfig(dir, get(nil)); err != nil || c.state != "none" || c.path != "" {
		t.Errorf("기본 파일 없음: %+v %v", c, err)
	}
	if _, err := loadBridgeConfig(dir, get(map[string]string{"BRIDGE_CONFIG": filepath.Join(dir, "no.yaml")})); err == nil || !strings.Contains(err.Error(), "마운트") {
		t.Errorf("지정한 파일 없음: %v", err)
	}
	if _, err := loadBridgeConfig(dir, get(map[string]string{"BRIDGE_CONFIG": "rel/bridge.yaml"})); err == nil || !strings.Contains(err.Error(), "절대 경로") {
		t.Errorf("상대 경로: %v", err)
	}
	_ = os.Mkdir(filepath.Join(dir, "bridge.yaml"), 0o700)
	if _, err := loadBridgeConfig(dir, get(nil)); err == nil || !strings.Contains(err.Error(), "폴더") {
		t.Errorf("폴더: %v", err)
	}
	_ = os.Remove(filepath.Join(dir, "bridge.yaml"))
	// 0 bytes or comments only: no settings, but the path is known (the admin page shows "빈 파일").
	for _, s := range []string{"", "# 아직 비어 있음\n\n"} {
		_ = os.WriteFile(filepath.Join(dir, "bridge.yaml"), []byte(s), 0o600)
		if c, err := loadBridgeConfig(dir, get(nil)); err != nil || c.state != "empty" || len(c.set) != 0 {
			t.Errorf("빈 파일 %q: %+v %v", s, c, err)
		}
	}
	_ = os.WriteFile(filepath.Join(dir, "bridge.yaml"), []byte("auth:\n  admins: [a]\n"), 0o600)
	if c, err := loadBridgeConfig(dir, get(nil)); err != nil || c.state != "file" || !reflect.DeepEqual(c.set["auth.admins"].v, []string{"a"}) {
		t.Errorf("파일: %+v %v", c, err)
	}
}

func TestConfigFileReadableAndChownSkip(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bridge.yaml")
	_ = os.WriteFile(f, []byte("a: 1\n"), 0o600)
	me := os.Getuid()
	if !readableBy(f, me, os.Getgid()) {
		t.Error("내 파일은 읽을 수 있어야 함")
	}
	if me != 0 && readableBy(f, me+12345, me+12345) {
		t.Error("남의 0600 파일은 읽을 수 없어야 함")
	}
	_ = os.Chmod(f, 0o644)
	if readableBy(f, me+12345, me+12345) {
		t.Error("0700 폴더 안이면 0644 라도 남은 지나갈 수 없음")
	}
	_ = os.Chmod(dir, 0o755)
	_ = os.Chmod(filepath.Dir(dir), 0o755)
	if !readableBy(f, me+12345, me+12345) {
		t.Error("0644 이고 폴더를 지나갈 수 있으면 누구나 읽음")
	}
	// Not root: nothing to do. Root is pretended.
	if err := prepareConfigFile(f, dir, envMap(nil), procOps{getuid: func() int { return 1000 }}); err != nil {
		t.Error(err)
	}
	// chownTree skips the settings file, so a read-only mount does not count as a failure.
	CHOWN_SKIP = []string{f}
	defer func() { CHOWN_SKIP = nil }()
	calls := []string{}
	chownTreeWith(dir, me+1, me+1, func(p string, _, _ int) error { calls = append(calls, p); return os.ErrPermission })
	for _, p := range calls {
		if p == f {
			t.Error("설정 파일은 건너뛰어야 함")
		}
	}
}
