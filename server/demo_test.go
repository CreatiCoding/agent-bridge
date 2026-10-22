package main

// The demo replies (from demo.test.mjs): the default says it is the demo, the permission words ask with a card.

import (
	"regexp"
	"testing"
)

func TestDemoReply(t *testing.T) {
	if !regexp.MustCompile(`데모 모드예요\. 실제 맥에 연결돼 있지 않아요`).MatchString(demoReply("아무 말").text) {
		t.Fatal(demoReply("아무 말").text)
	}
	if demoReply("권한 요청 보여 줘").permission == "" {
		t.Fatal("권한 카드")
	}
	if !regexp.MustCompile("```ts").MatchString(demoReply("코드 예시 보여 줘").text) {
		t.Fatal(demoReply("코드 예시 보여 줘").text)
	}
}
