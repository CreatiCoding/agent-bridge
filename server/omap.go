package main

import (
	"bytes"
	"encoding/json"
	"os"
)

// OMap is a JavaScript object or Map: keys keep the order they were first set in, and so does its JSON.
type OMap[V any] struct {
	keys []string
	m    map[string]V
}

func newOMap[V any]() *OMap[V] { return &OMap[V]{m: map[string]V{}} }

func (o *OMap[V]) Get(k string) (V, bool) {
	v, ok := o.m[k]
	return v, ok
}

func (o *OMap[V]) Val(k string) V { return o.m[k] }

func (o *OMap[V]) Has(k string) bool {
	_, ok := o.m[k]
	return ok
}

func (o *OMap[V]) Set(k string, v V) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}

func (o *OMap[V]) Delete(k string) bool {
	if _, ok := o.m[k]; !ok {
		return false
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
	return true
}

// Keys is a copy, safe to change the map while walking it.
func (o *OMap[V]) Keys() []string { return append([]string(nil), o.keys...) }

func (o *OMap[V]) Len() int { return len(o.keys) }

func (o *OMap[V]) Values() []V {
	out := make([]V, 0, len(o.keys))
	for _, k := range o.keys {
		out = append(out, o.m[k])
	}
	return out
}

func (o *OMap[V]) Clear() {
	o.keys = nil
	o.m = map[string]V{}
}

func (o *OMap[V]) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(jsonBytes(k))
		b.WriteByte(':')
		b.Write(jsonBytes(o.m[k]))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// jsonKeyOrder is the order of an object's top-level keys in JSON text.
func jsonKeyOrder(b []byte) []string {
	dec := json.NewDecoder(bytes.NewReader(b))
	t, err := dec.Token()
	if err != nil || t != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return keys
		}
		k, _ := t.(string)
		keys = append(keys, k)
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}

// readOMap reads a JSON object file into an ordered map of objects; an unreadable file is an empty one.
func readOMap(p string) *OMap[M] {
	o := newOMap[M]()
	b, err := os.ReadFile(p)
	if err != nil {
		return o
	}
	v, err := parseJSON(b)
	m, ok := v.(M)
	if err != nil || !ok {
		return o
	}
	for _, k := range jsonKeyOrder(b) {
		if x, ok := m[k].(M); ok {
			o.Set(k, x)
		}
	}
	return o
}

// orderedJSON writes keys in order (Object.fromEntries of a filtered list).
type kv struct {
	K string
	V any
}

type orderedObj []kv

func (o orderedObj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	for _, e := range o {
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.Write(jsonBytes(e.K))
		b.WriteByte(':')
		b.Write(jsonBytes(e.V))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
