package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// REQ-F-844: the server reads the signed local screen bundle the sign script wrote, and passes it only to a Mac that
// takes remote bundles of its api and serves an older one.
func TestLocalBundleIsReadAndOfferedOnlyWhenNewer(t *testing.T) {
	saved := ROOT
	ROOT = ".."
	defer func() { ROOT = saved }()
	lb := loadLocalBundle(localBundlePath())
	ok(t, lb.OK, "agent/localbundle.mjs 의 서명이 맞아야 함 (node scripts/sign-agent.mjs)")
	ok(t, lb.Seq > 0 && lb.API == 1 && len(lb.Version) == 12)
	hello := func(on, ota bool, api float64, ver string, seq float64) M {
		return M{"on": on, "ota": ota, "api": api, "active": M{"source": "builtin", "version": ver, "seq": seq}}
	}
	ok(t, localUiWanted(lb, hello(true, true, 1, "000000000000", lb.Seq-1)), "더 오래된 묶음을 쓰는 맥")
	ok(t, !localUiWanted(lb, hello(true, true, 1, lb.Version, lb.Seq)), "같은 묶음")
	ok(t, !localUiWanted(lb, hello(true, true, 1, "000000000000", lb.Seq+1)), "더 새것")
	ok(t, !localUiWanted(lb, hello(true, false, 1, "000000000000", 1)), "ota 끔")
	ok(t, !localUiWanted(lb, hello(false, true, 1, "000000000000", 1)), "로컬 화면 끔")
	ok(t, !localUiWanted(lb, hello(true, true, 2, "000000000000", 1)), "다른 api")
	ok(t, !localUiWanted(lb, nil), "localUi 를 모르는 예전 에이전트")

	// A bundle changed after signing, or another signature, is not passed on.
	b, _ := os.ReadFile(localBundlePath())
	dir := t.TempDir()
	bad := filepath.Join(dir, "localbundle.mjs")
	_ = os.WriteFile(bad, []byte(strings.Replace(string(b), "index.html", "index.htm", 1)), 0o600)
	ok(t, !loadLocalBundle(bad).OK, "바뀐 묶음")
	_ = os.WriteFile(bad, []byte(regexp.MustCompile(`(?m)^export const SIG = ".*"$`).ReplaceAllString(string(b), `export const SIG = "AAAA"`)), 0o600)
	ok(t, !loadLocalBundle(bad).OK, "다른 서명")
	ok(t, !loadLocalBundle(filepath.Join(dir, "none.mjs")).OK, "파일 없음")
}

// The agent's file list is in two places; the build fingerprint depends on its order.
func TestAgentFilesMatchTheAgent(t *testing.T) {
	b, err := os.ReadFile("../agent/agent.mjs")
	ok(t, err == nil)
	m := regexp.MustCompile(`const AGENT_FILES = \[([^\]]+)\]`).FindSubmatch(b)
	ok(t, m != nil)
	names := regexp.MustCompile(`'([^']+)'`).FindAllStringSubmatch(string(m[1]), -1)
	got := []string{}
	for _, n := range names {
		got = append(got, n[1])
	}
	eq(t, strings.Join(got, ","), strings.Join(AGENT_FILES, ","))
}
