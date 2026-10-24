// Security checks from the regular review: HSTS (REQ-S-082), the page policy (REQ-S-011) and the demo gate (REQ-S-068).
package main

import (
	"net/http"
	"net/http/httptest"
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
