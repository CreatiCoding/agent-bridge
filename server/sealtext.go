package main

import (
	"regexp"
	"strings"
)

// Pieces a Mac sealed for its paired devices (docs/TRUST-DESIGN.md §6, REQ-S-095): ⟦bt1:<kid>:<base64url>⟧. The
// server cannot open them; it carries them whole, never cuts one in two, and says 🔒 where a person would read one
// somewhere the page does not open it (a push, Slack, a webhook).

const sealOpen = "⟦bt1:"

// sealPieceRe matches a whole piece, or the start of one that was already cut.
var sealPieceRe = regexp.MustCompile(`⟦bt1:[0-9a-f]{0,8}:?[A-Za-z0-9_-]*⟧?`)

func hasSeal(s string) bool { return strings.Contains(s, sealOpen) }

// sealSafeEnd: a string cut at its end that would end inside a piece ends before it, with 🔒 in its place.
func sealSafeEnd(s string) string {
	i := strings.LastIndex(s, "⟦")
	if i < 0 || strings.Contains(s[i:], "⟧") {
		return s
	}
	rest := s[i:]
	if strings.HasPrefix(rest, sealOpen) || strings.HasPrefix(sealOpen, rest) {
		return s[:i] + "🔒"
	}
	return s
}

// maskSeals: every piece (and a cut one) as 🔒, for text that leaves for something that is not the page.
func maskSeals(s string) string {
	if !strings.Contains(s, "⟦bt") {
		return s
	}
	return sealPieceRe.ReplaceAllString(s, "🔒")
}

func maskSealsBytes(b []byte) []byte {
	if !strings.Contains(string(b), "⟦bt") {
		return b
	}
	return sealPieceRe.ReplaceAll(b, []byte("🔒"))
}
