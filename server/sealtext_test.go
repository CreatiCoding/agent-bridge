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

// REQ-S-099 (AC-1601): a short field (a title, a tool's line) keeps a piece whole so the paired device opens it;
// a piece too big for SEAL_KEEP_MAX is cut to 🔒 as before, and plain text is cut as before.
func TestSealedShortKeepsThePiece(t *testing.T) {
	piece := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", 200) + "⟧"
	if got := sealedShort(piece, 80, jsSliceTo); got != piece {
		t.Fatalf("제목: %q", got)
	}
	if got := sealedShort(piece+" 뒤 글", 110, truncate); got != piece {
		t.Fatalf("도구 줄: %q", got)
	}
	if got := sealedShort("앞 "+piece, 80, jsSliceTo); got != "앞 "+piece {
		t.Fatalf("앞 글과 조각: %q", got)
	}
	long := strings.Repeat("가", 90) + piece
	if got := sealedShort(long, 80, jsSliceTo); got != jsSliceTo(long, 80) {
		t.Fatalf("자르는 자리가 조각 앞: %q", got)
	}
	big := "⟦bt1:0a1b2c3d:" + strings.Repeat("A", SEAL_KEEP_MAX) + "⟧"
	if got := sealedShort(big, 80, jsSliceTo); got != "🔒" {
		t.Fatalf("너무 큰 조각: %q", got)
	}
	if got := sealedShort(strings.Repeat("a", 100), 80, jsSliceTo); got != strings.Repeat("a", 80) {
		t.Fatalf("봉인 없는 글: %q", got)
	}
}
