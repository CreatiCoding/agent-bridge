// Security checks from the regular review: HSTS (REQ-S-082), the page policy (REQ-S-011) and the demo gate (REQ-S-068).
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTransportHeadersHSTS(t *testing.T) {
	keep := ORIGIN
	defer func() { ORIGIN = keep }()
	at := func(origin, proto string) string {
		ORIGIN = origin
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = "bridge.test"
		if proto != "" {
			r.Header.Set("X-Forwarded-Proto", proto)
		}
		h := http.Header{}
		transportHeaders(h, newReq(r))
		return h.Get("Strict-Transport-Security")
	}
	eq(t, at("https://bridge.test", ""), HSTS, "https origin")
	eq(t, at("", "https"), HSTS, "https behind a proxy, no BRIDGE_ORIGIN")
	eq(t, at("http://localhost:4300", ""), "", "http origin")
	eq(t, at("", ""), "", "plain http")
	ok(t, !strings.Contains(HSTS, "includeSubDomains"), "the other names under the domain are not this server's")
}

func TestPagePolicy(t *testing.T) {
	keep, keepSec := preview, SECURITY
	defer func() { preview, SECURITY = keep, keepSec }()
	preview = &Preview{ORIGINS: []string{"https://lp1.bridge.test"}}
	initSecurity()
	csp := jsString(SECURITY["Content-Security-Policy"])
	for _, want := range []string{"default-src 'self'", "frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'"} {
		ok(t, strings.Contains(csp, want), want+" in "+csp)
	}
	ok(t, !strings.Contains(csp, "script-src"), "scripts stay under default-src 'self'")
}

// The demo's `:sudo` gate reads leading whitespace as JavaScript does (REQ-S-068): csSend trims U+3000, U+00A0 and the
// like before it reads a colon command, so the gate must not let them through.
func TestDemoSudoTextUnicodeSpace(t *testing.T) {
	for _, s := range []string{":sudo whoami", "  /root", "\u3000:sudo whoami", "\u00a0:SUDO ls", "\u2003/sudo x"} {
		ok(t, demoSudoText.MatchString(s), "blocked: "+s)
	}
	for _, s := range []string{"sudo 가 뭐야?", ":sudoku", "x :sudo"} {
		ok(t, !demoSudoText.MatchString(s), "allowed: "+s)
	}
}

// REQ-S-086: one person's videos on the server are at most UPLOAD_USER_MAX together (uploads kept, and their reports').
func TestUploadUserMax(t *testing.T) {
	oldData, oldReports := DATA, REPORTS
	DATA = t.TempDir()
	REPORTS = filepath.Join(DATA, "reports")
	defer func() { DATA, REPORTS = oldData, oldReports }()
	dir := uploadsDir("u1")
	_ = os.MkdirAll(dir, 0o700)
	big := filepath.Join(dir, strings.Repeat("a", 40)+".mp4")
	f, _ := os.Create(big)
	_ = f.Truncate(UPLOAD_USER_MAX - 10)
	f.Close()
	save := func(uid string, n int) (status int) {
		r := httptest.NewRequest("POST", "/api/reports/upload?name=v", strings.NewReader(strings.Repeat("x", n)))
		r.Header.Set("content-type", "video/mp4")
		withLock(func() {
			defer func() {
				if e, ok := recover().(*Refuse); ok {
					status = e.Status
				}
			}()
			saveUpload(uid, newReq(r), r.URL)
			status = 200
		})
		return
	}
	eq(t, save("u1", 20), 413)
	eq(t, save("u1", 5), 200)
	eq(t, save("u1", 10), 413)
	// Someone else's uploads do not count.
	eq(t, save("u2", 20), 200)
	// A report's videos count for the one who sent it.
	_ = os.Remove(big)
	_ = os.MkdirAll(filepath.Join(REPORTS, "video"), 0o700)
	vid := strings.Repeat("b", 40) + ".mp4"
	f, _ = os.Create(reportVideoFile(vid))
	_ = f.Truncate(UPLOAD_USER_MAX)
	f.Close()
	writeJson(reportFile("r1"), M{"id": "r1", "uid": "u1", "videos": []any{M{"id": vid}}})
	eq(t, save("u1", 1), 413)
	eq(t, len(uploadsHeld), 0)
}
