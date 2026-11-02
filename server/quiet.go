package main

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 조용한 답 (REQ-F-850, docs/MESSAGE-HOOK-DESIGN.md): an extension declares the literal ends (`messages.quiet`) that
// make one of Claude's answers quiet: folded on the page, no "새 답" dot, no notify webhook, not posted to Slack.
// The same test runs here, on a sealing Mac (agent/trust.mjs quietOf) and on the page (ui/src/lib/quiet.ts); the
// three share server/testdata/quiet-cases.json. A literal end, not a regular expression: the three must agree, and
// a pattern the server hands a Mac must not be able to hang it.

const (
	QUIET_RULES_MAX  = 5
	QUIET_SUFFIX_MAX = 40
	QUIET_LABEL_MAX  = 40
)

type quietRule struct {
	Ext    string `json:"ext"`
	Suffix string `json:"suffix"`
	Label  string `json:"label"`
}

// quietTrim: the end whitespace the test ignores, the same four characters in the three places.
func quietTrim(s string) string { return strings.TrimRight(s, " \t\r\n") }

// quietSuffixOk: 1-40 characters on one line, nothing around it to trim, no control character, no seal bracket.
func quietSuffixOk(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > QUIET_SUFFIX_MAX || !utf8.ValidString(s) || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == '⟦' || r == '⟧' {
			return false
		}
	}
	return true
}

// quietLabel: what the folded line says, cut to 40 characters, control characters dropped.
func quietLabel(s string) string {
	out := []rune{}
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) {
			continue
		}
		if len(out) >= QUIET_LABEL_MAX {
			break
		}
		out = append(out, r)
	}
	return string(out)
}

// quietOf: the first rule whose end the answer has, or nil. A text holding a sealed piece is never judged here.
func quietOf(text string, rules []quietRule) *quietRule {
	if strings.Contains(text, sealOpen) {
		return nil
	}
	t := quietTrim(text)
	if t == "" {
		return nil
	}
	for i := range rules {
		if rules[i].Suffix != "" && strings.HasSuffix(t, rules[i].Suffix) {
			return &rules[i]
		}
	}
	return nil
}

// quietAgreed: the person's own consent to the extension's current files. Not cfg extensionConsent: with it off an
// operator's rule would fold everyone's answers and keep their notifications back without anyone having read it.
func quietAgreed(uid string, d *extDef) bool {
	return d != nil && d.Err == "" && !isDemoUid(uid) && cfgOn("extensionConsent") && consentOf(uid)[d.ID] == d.Hash
}

// quietRulesOf: the rules of the extensions this person agreed to (quietAgreed), in bridge.yaml order.
func quietRulesOf(uid string) []quietRule {
	out := []quietRule{}
	for _, d := range EXTS {
		if len(d.Quiet) > 0 && quietAgreed(uid, d) {
			out = append(out, d.Quiet...)
		}
	}
	return out
}

// QUIET_MAC: the mark of a sealing Mac's own ends (`trust quiet add`, chosen at its terminal, not by the server).
const QUIET_MAC = "mac"

// quietList: an extension's rules as /api/ext lists them (the page applies them itself, REQ-F-850).
func quietList(d *extDef) []any {
	out := []any{}
	for _, r := range d.Quiet {
		out = append(out, orderedObj{{"suffix", r.Suffix}, {"label", r.Label}})
	}
	return out
}

// quietLineMark: what a sealing Mac put on a transcript line ("bridgeQuiet": "mac"), or "".
func quietLineMark(line string) string {
	if !strings.Contains(line, `"bridgeQuiet"`) {
		return ""
	}
	var o struct {
		BridgeQuiet string `json:"bridgeQuiet"`
	}
	if json.Unmarshal([]byte(line), &o) != nil || o.BridgeQuiet != QUIET_MAC {
		return ""
	}
	return o.BridgeQuiet
}
