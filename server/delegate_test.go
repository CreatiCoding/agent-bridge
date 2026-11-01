// delegate 의 model·effort (REQ-F-760, 1.383): only what is given reaches startSession, a bad value is refused.
package main

import (
	"strings"
	"testing"
)

func TestDelegateLaunchValid(t *testing.T) {
	for _, c := range []struct {
		args M
		want M
	}{
		{M{"model": "sonnet", "effort": "low"}, M{"model": "sonnet", "effort": "low"}},
		{M{"model": " claude-sonnet-5-5 "}, M{"model": "claude-sonnet-5-5"}},
		{M{"model": "opus[1m]", "effort": "max"}, M{"model": "opus[1m]", "effort": "max"}},
		{M{"effort": "xhigh"}, M{"effort": "xhigh"}},
	} {
		var got M
		if err := try(func() { got = delegateLaunch(c.args) }); err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("%v: got %v want %v", c.args, got, c.want)
		}
		for k, v := range c.want {
			if got[k] != v {
				t.Fatalf("%v: %s = %v want %v", c.args, k, got[k], v)
			}
		}
	}
}

// Left out (or empty): no key at all, so startSession still fills in the person's launch default.
func TestDelegateLaunchDefaultKeepsLaunch(t *testing.T) {
	for _, a := range []M{{}, {"model": "", "effort": ""}, {"model": "  "}, {"model": nil}} {
		var got M
		if err := try(func() { got = delegateLaunch(a) }); err != nil {
			t.Fatalf("%v: %v", a, err)
		}
		if _, has := got["model"]; has {
			t.Fatalf("%v: model key present: %v", a, got)
		}
		if _, has := got["effort"]; has {
			t.Fatalf("%v: effort key present: %v", a, got)
		}
		if l := launchLabel(got); l["model"] != "기본" || l["effort"] != "기본" {
			t.Fatalf("label %v", l)
		}
	}
	if l := launchLabel(M{"model": "haiku"}); l["model"] != "haiku" || l["effort"] != "기본" {
		t.Fatalf("label %v", l)
	}
}

func TestDelegateLaunchInvalid(t *testing.T) {
	for _, c := range []struct {
		args M
		msg  string
	}{
		{M{"model": "opus; rm -rf /"}, "model 이 올바르지 않아요"},
		{M{"model": strings.Repeat("a", 61)}, "model 이 올바르지 않아요"},
		{M{"model": "son net"}, "model 이 올바르지 않아요"},
		{M{"effort": "huge"}, "effort 가 올바르지 않아요"},
		{M{"model": "sonnet", "effort": "LOW"}, "effort 가 올바르지 않아요"},
	} {
		err := try(func() { delegateLaunch(c.args) })
		if err == nil || !strings.Contains(err.Error(), c.msg) {
			t.Fatalf("%v: err %v, want %q", c.args, err, c.msg)
		}
	}
}
