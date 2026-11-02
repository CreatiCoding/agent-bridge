package main

import (
	"strings"
	"testing"
)

// REQ-S-095 (AC-1542): a sealed piece is carried whole, shown as 🔒 where the page does not open it, and the line a
// sealing Mac marks bridgeEcho is the echo of what the page said.
func TestSealPiecesAreNeverCut(t *testing.T) {
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", 60) + "⟧"
	s := "앞 " + piece + " 뒤"
	for n := 1; n < jsLen(s); n++ {
		for _, out := range []string{truncate(s, n), clip(s, len(jsSliceTo(s, n))), jsSliceTo(s, n)} {
			if i := strings.Index(out, "⟦"); i >= 0 && !strings.Contains(out, piece) {
				t.Fatalf("%d 에서 조각이 잘림: %q", n, out)
			}
		}
	}
	if got := truncate(s, 5); got != "앞 🔒…" {
		t.Fatalf("truncate: %q", got)
	}
	if got := jsSliceTo("⟦bt", 2); got != "🔒" {
		t.Fatalf("조각의 머리만: %q", got)
	}
	if got := jsSliceTo("a ⟦x b", 4); got != "a ⟦x" {
		t.Fatalf("조각 아닌 ⟦ 는 그대로: %q", got)
	}
	if got := maskSeals("결과: " + piece + " 그리고 ⟦bt1:0a1b"); got != "결과: 🔒 그리고 🔒" {
		t.Fatalf("maskSeals: %q", got)
	}
	if got := string(maskSealsBytes([]byte(`{"text":"` + piece + `"}`))); got != `{"text":"🔒"}` {
		t.Fatalf("maskSealsBytes: %q", got)
	}
}

func TestBridgeEchoLineIsTheEcho(t *testing.T) {
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("B", 60) + "⟧"
	meta := &Sess{m: M{}}
	meta.set("echo", []any{M{"id": "e1", "norm": "⟦bt1:0a1b2c3d:" + strings.Repeat("C", 60) + "⟧", "at": float64(nowMs())}})
	line := `{"type":"user","uuid":"u1","message":{"role":"user","content":"` + piece + `"},"bridgeEcho":true}`
	for _, e := range convert(meta, []string{line}) {
		if mstr(e, "k") == "user" {
			t.Fatalf("에코가 사람 말풍선으로 다시 나옴: %v", e)
		}
	}
	if len(asArr(meta.get("echo"))) != 0 {
		t.Fatal("에코 기다림이 남음")
	}
	// Without the mark the sealed words (a new piece each time) are a person's line as before.
	other := `{"type":"user","uuid":"u2","message":{"role":"user","content":"` + piece + `"}}`
	users := 0
	for _, e := range convert(meta, []string{other}) {
		if mstr(e, "k") == "user" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("표시 없는 사람 줄: %d", users)
	}
}

func TestTrustSealReported(t *testing.T) {
	c := asM(cleanTrust(M{"mode": "enforce", "seal": true, "devices": []any{}}))
	if c["seal"] != true {
		t.Fatalf("seal: %v", c)
	}
	if asM(cleanTrust(M{"mode": "warn", "seal": "yes"}))["seal"] != false {
		t.Fatal("참 말고는 false")
	}
}
