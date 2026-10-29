package main

import (
	"strings"
	"testing"
)

// yDump writes a node compactly so a test can compare the whole shape.
func yDump(n *yNode) string {
	if n == nil {
		return "<nil>"
	}
	switch n.kind {
	case yMap:
		var b []string
		for _, p := range n.pairs {
			b = append(b, p.key+":"+yDump(p.val))
		}
		return "{" + strings.Join(b, ",") + "}"
	case yList:
		var b []string
		for _, it := range n.items {
			b = append(b, yDump(it))
		}
		return "[" + strings.Join(b, ",") + "]"
	}
	if n.null {
		return "~"
	}
	if n.quoted {
		return `"` + n.raw + `"`
	}
	return n.raw
}

func TestYAMLSubset(t *testing.T) {
	ok := []struct{ src, want string }{
		{"a: 1\nb: x y  # 주석\n", "{a:1,b:x y}"},
		{"# 처음 주석\n\nauth:\n  allow: [me, \"*\"]\n  admins:\n    - Alice\n    - \"bob\"\n", `{auth:{allow:[me,"*"],admins:[Alice,"bob"]}}`},
		{"origins:\n  primary: https://a.example:8443\n", "{origins:{primary:https://a.example:8443}}"},
		{"x: \"a # b\"\ny: 'it''s'\nz: a#b\n", `{x:"a # b",y:"it's",z:a#b}`},
		{"list:\n- a\n- b\n", "{list:[a,b]}"},
		{"hooks:\n  - type: webhook\n    url: https://h.example/x\n    events: [a, b]\n  - type: exec\n", "{hooks:[{type:webhook,url:https://h.example/x,events:[a,b]},{type:exec}]}"},
		{"m: {k: v, \"q\": \"w\"}\ne: []\nn:\nt: ~\n", `{m:{k:v,q:"w"},e:[],n:~,t:~}`},
		{"esc: \"\\u00e9\\n\\\"\"\n", "{esc:\"é\n\"\"}"},
		{"ref: \"${BRIDGE_ADMIN_LOGINS:-}\"\nplain: ${X}\n", `{ref:"${BRIDGE_ADMIN_LOGINS:-}",plain:${X}}`},
		{"on: yes\n", "{on:yes}"},
		{"{\"b\": [1, true], \"a\": {\"c\": null}}", `{a:{c:~},b:[1,true]}`},
		{"\ufeffa: 1\r\nb: 2\r\n", "{a:1,b:2}"},
	}
	for _, c := range ok {
		n, err := parseYAML([]byte(c.src))
		if err != nil {
			t.Fatalf("%q: %v", c.src, err)
		}
		if got := yDump(n); got != c.want {
			t.Errorf("%q\n got %s\nwant %s", c.src, got, c.want)
		}
	}
	for _, src := range []string{"", "\n\n", "# 주석만\n  # 또\n"} {
		if n, err := parseYAML([]byte(src)); n != nil || err != nil {
			t.Errorf("%q: 빈 파일은 nil, nil 이어야 함: %v %v", src, n, err)
		}
	}
	bad := []struct{ src, has string }{
		{"a: &x 1\n", "앵커"},
		{"allow: [*]\n", "앵커"},
		{"a: *x\n", "앵커"},
		{"a: !!str 1\n", "태그"},
		{"a: |\n  x\n", "여러 줄"},
		{"---\na: 1\n", "여러 문서"},
		{"a:\n\tb: 1\n", "탭"},
		{"a: 1\na: 2\n", "두 번"},
		{"m: {k: 1, k: 2}\n", "두 번"},
		{"a: [1, 2\n", "닫히지"},
		{"a: \"x\n", "닫히지"},
		{"a: [${A}]\n", "큰따옴표"},
		{"a: 1\n  b: 2\n", "들여"},
		{"- a\n- b\n", "맨 위"},
		{"just text\n", "키: 값"},
		{"a: \"\\q\"\n", "이스케이프"},
		{"{\"a\": 1", "JSON"},
		{"a: \xff\n", "UTF-8"},
	}
	for _, c := range bad {
		_, err := parseYAML([]byte(c.src))
		if err == nil || !strings.Contains(err.Error(), c.has) {
			t.Errorf("%q: %q 가 든 오류여야 함, got %v", c.src, c.has, err)
		}
	}
	// 오류에 줄 번호가 붙는다
	if _, err := parseYAML([]byte("a: 1\nb: 2\nb: 3\n")); err == nil || !strings.HasPrefix(err.Error(), "3번째 줄") {
		t.Errorf("줄 번호: %v", err)
	}
}
