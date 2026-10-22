package main

import (
	"os"
	"reflect"
	"testing"
)

func TestMain(m *testing.M) {
	initPages()
	os.Exit(m.Run())
}

// norm: a value as JSON reads it back (orderedObj, OMap and M alike), for comparing by value.
func norm(v any) any {
	x, _ := parseJSON(jsonBytes(v))
	return x
}

// jeq: got equals the JSON want, by value.
func jeq(t *testing.T, got any, want string, msg ...string) {
	t.Helper()
	w, err := parseJSON([]byte(want))
	if err != nil {
		t.Fatalf("bad want JSON %q: %v", want, err)
	}
	if g := norm(got); !reflect.DeepEqual(g, w) {
		t.Errorf("%v\n got: %s\nwant: %s", msg, jsonStr(got), want)
	}
}

func eq[T comparable](t *testing.T, got, want T, msg ...string) {
	t.Helper()
	if got != want {
		t.Errorf("%v: got %#v, want %#v", msg, got, want)
	}
}

func ok(t *testing.T, cond bool, msg ...string) {
	t.Helper()
	if !cond {
		t.Errorf("not ok: %v", msg)
	}
}

// js: a JSON literal as the value parseJSON gives.
func js(s string) any {
	v, err := parseJSON([]byte(s))
	if err != nil {
		panic(err)
	}
	return v
}

// withLock runs f holding the server lock, as a request handler does.
func withLock(f func()) {
	mu.Lock()
	defer mu.Unlock()
	f()
}

// oget: a key of an orderedObj, M or JSON value.
func oget(v any, k string) any { return mget(norm(v), k) }
