// JavaScript semantics the server was written in and the pages and agents still expect: UTF-16 string lengths and
// slices, truthiness, String(v), JSON without HTML escaping. The objects that cross the wire (sessions, events,
// agent messages) stay loosely typed maps, as they were.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// M is a JSON object as JavaScript code handled it.
type M = map[string]any

func nowMs() int64 { return time.Now().UnixMilli() }

// ---------- JSON ----------

// jsonBytes is JSON.stringify: no HTML escaping, nil for what has no JSON form.
func jsonBytes(v any) []byte {
	// A message ({t: …}) and an answer ({ok: …}) are written with that key first, as the Node server's object
	// literals put it; the rest follow in key order.
	if m, ok := v.(M); ok && len(m) > 1 {
		for _, lead := range []string{"t", "ok"} {
			if x, has := m[lead]; has {
				rest := make(M, len(m)-1)
				for k, y := range m {
					if k != lead {
						rest[k] = y
					}
				}
				rb := jsonBytes(rest)
				head := append(append([]byte(`{"`+lead+`":`), jsonBytes(x)...), ',')
				return append(head, rb[1:]...)
			}
		}
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	out := b.Bytes()
	return out[:len(out)-1]
}

func jsonStr(v any) string { return string(jsonBytes(v)) }

// jsonIndent is JSON.stringify(v, null, n).
func jsonIndent(v any, n int) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", strings.Repeat(" ", n))
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// parseJSON parses into plain values (map[string]any, []any, float64, string, bool, nil).
func parseJSON(b []byte) (any, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data")
	}
	return v, nil
}

// clone makes a deep copy of a JSON value.
func clone(v any) any {
	switch x := v.(type) {
	case M:
		out := make(M, len(x))
		for k, e := range x {
			out[k] = clone(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = clone(e)
		}
		return out
	default:
		return v
	}
}

// shallow copies an object one level, like {...o}.
func shallow(o M) M {
	out := make(M, len(o)+4)
	for k, v := range o {
		out[k] = v
	}
	return out
}

// toJSONValue turns Go values (structs, typed slices) into the plain JSON value shape.
func toJSONValue(v any) any {
	switch v.(type) {
	case nil, M, []any, string, float64, bool:
		return v
	}
	x, err := parseJSON(jsonBytes(v))
	if err != nil {
		return nil
	}
	return x
}

// ---------- accessors with JavaScript's looseness ----------

func mget(o any, k string) any {
	if m, ok := o.(M); ok {
		return m[k]
	}
	// An object built in order (orderedObj) reads the same.
	if oo, ok := o.(orderedObj); ok {
		for _, e := range oo {
			if e.K == k {
				return e.V
			}
		}
	}
	return nil
}

func mobj(o any, k string) M {
	if m, ok := mget(o, k).(M); ok {
		return m
	}
	return nil
}

func marr(o any, k string) []any {
	if a, ok := mget(o, k).([]any); ok {
		return a
	}
	return nil
}

// mstr is a string field, ” when it is not a string.
func mstr(o any, k string) string {
	if s, ok := mget(o, k).(string); ok {
		return s
	}
	return ""
}

func isStr(v any) bool { _, ok := v.(string); return ok }

// mnum is Number(field) || 0 for numbers only.
func mnum(o any, k string) float64 {
	if f, ok := mget(o, k).(float64); ok && !math.IsNaN(f) {
		return f
	}
	return 0
}

func mbool(o any, k string) bool { return truthy(mget(o, k)) }

// truthy is JavaScript's !!v.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	default:
		return true
	}
}

// jsString is String(v).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numStr(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil {
				continue
			}
			parts[i] = jsString(e)
		}
		return strings.Join(parts, ",")
	case M:
		return "[object Object]"
	default:
		return fmt.Sprint(x)
	}
}

// strOr is String(v ?? fallback) for an undefined/null v.
func strOr(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return jsString(v)
}

// numStr formats a number as JavaScript does.
func numStr(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// jsNumber is Number(v): NaN when it is not a number.
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
			if n, err := strconv.ParseInt(s[2:], 16, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
		if s == "Infinity" || s == "+Infinity" {
			return math.Inf(1)
		}
		if s == "-Infinity" {
			return math.Inf(-1)
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || strings.ContainsAny(s, "_") || strings.EqualFold(s, "inf") || strings.EqualFold(s, "nan") {
			return math.NaN()
		}
		return f
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(jsString(x[0]))
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

// numOr0 is Number(v) || 0.
func numOr0(v any) float64 {
	f := jsNumber(v)
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// isFinite is Number.isFinite(v): a number, not NaN or infinite.
func isFinite(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

// isInteger is Number.isInteger(v).
func isInteger(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f)
}

func isSafeInteger(v any) bool {
	f, ok := v.(float64)
	return isInteger(v) && ok && math.Abs(f) <= 9007199254740991
}

func numOrNull(v any) any {
	if isFinite(v) {
		return v
	}
	return nil
}

// ---------- UTF-16 strings ----------

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// jsLen is s.length.
func jsLen(s string) int {
	if isASCII(s) {
		return len(s)
	}
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// jsSlice is s.slice(a, b) with b < 0 meaning to the end when end is false... use jsSliceTo for an end.
func jsSliceFrom(s string, a int) string {
	n := jsLen(s)
	if a < 0 {
		a = max(0, n+a)
	}
	if a >= n {
		return ""
	}
	return jsSub(s, a, n)
}

// jsSliceTo is s.slice(0, b).
func jsSliceTo(s string, b int) string { return jsSlice(s, 0, b) }

// jsSlice is s.slice(a, b) (negative indexes count from the end).
func jsSlice(s string, a, b int) string {
	n := jsLen(s)
	if a < 0 {
		a = max(0, n+a)
	}
	if b < 0 {
		b = max(0, n+b)
	}
	if b > n {
		b = n
	}
	if a >= b {
		return ""
	}
	return jsSub(s, a, b)
}

func jsSub(s string, a, b int) string {
	if isASCII(s) {
		return s[a:b]
	}
	u := utf16.Encode([]rune(s))
	return string(utf16.Decode(u[a:b]))
}

// truncate is the s.length > n ? s.slice(0, n-1)+'…' : s of every module.
func truncate(s string, n int) string {
	if jsLen(s) > n {
		return jsSliceTo(s, n-1) + "…"
	}
	return s
}

// clip is String(v).slice(0, n).
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return jsSliceTo(s, n)
}

// jsIndexOf is s.indexOf(sub) in UTF-16 units (ASCII fast path).
func jsLastIndexOf(s, sub string, from int) int {
	u := utf16.Encode([]rune(s))
	w := utf16.Encode([]rune(sub))
	if from > len(u)-len(w) {
		from = len(u) - len(w)
	}
	for i := from; i >= 0; i-- {
		ok := true
		for j := range w {
			if u[i+j] != w[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

func padStart(s string, n int, c string) string {
	for jsLen(s) < n {
		s = c + s
	}
	return s
}

// ---------- regular expressions with JavaScript's \s ----------

// jsWS is the whitespace JavaScript's \s matches (RE2's \s is ASCII only).
const jsWS = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// re compiles a pattern where `\s` / `\S` stand for JavaScript's.
func re(p string) *regexp.Regexp {
	p = strings.ReplaceAll(p, `[\s\S]`, `(?s:.)`)
	var b strings.Builder
	inClass := false
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '\\' && i+1 < len(p) {
			n := p[i+1]
			if n == 's' {
				if inClass {
					b.WriteString(jsWS)
				} else {
					b.WriteString("[" + jsWS + "]")
				}
				i++
				continue
			}
			if n == 'S' && !inClass {
				b.WriteString("[^" + jsWS + "]")
				i++
				continue
			}
			b.WriteByte(c)
			b.WriteByte(n)
			i++
			continue
		}
		if c == '[' && !inClass {
			inClass = true
		} else if c == ']' && inClass {
			inClass = false
		}
		b.WriteByte(c)
	}
	return regexp.MustCompile(b.String())
}

var wsRun = re(`\s+`)

// collapse is s.replace(/\s+/g, ' ').
func collapse(s string) string { return wsRun.ReplaceAllString(s, " ") }

// jsTrim is String.prototype.trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func jsTrimEnd(s string) string { return strings.TrimRightFunc(s, isJSSpace) }

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// ---------- misc ----------

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// uuidv4 is crypto.randomUUID().
func uuidv4() string {
	b := randBytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func contains[T comparable](list []T, v T) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func containsAny(list []any, v any) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func strList(a []any) []string {
	out := make([]string, 0, len(a))
	for _, x := range a {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func anyList[T any](a []T) []any {
	out := make([]any, len(a))
	for i, x := range a {
		out[i] = x
	}
	return out
}

func sortedKeys(m M) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func validUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return strings.ToValidUTF8(s, "�")
}

// isoTime is new Date(ms).toISOString().
func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseDate is Date.parse for ISO strings: NaN when unreadable.
func parseDate(s string) float64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return float64(t.UnixMilli())
		}
	}
	return math.NaN()
}

func i64(f float64) int64 { return int64(f) }

func f64(n int64) float64 { return float64(n) }

func minF(a, b float64) float64 { return math.Min(a, b) }
func maxF(a, b float64) float64 { return math.Max(a, b) }

// ptrOf is an object's identity, for JavaScript's === between objects.
func ptrOf(m M) uintptr { return reflect.ValueOf(m).Pointer() }

func msDur(n int64) time.Duration { return time.Duration(n) * time.Millisecond }
