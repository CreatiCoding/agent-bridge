package main

// A YAML subset for bridge.yaml (REQ-F-809): block maps and lists, one-line yFlow [a, b] and {k: v},
// plain, "double" and 'single' quoted scalars, # comments. A file that starts with { is read as JSON.
// Anchors, aliases, tags, block scalars (| >), several documents and tabs in indentation are refused,
// so a file never means more than it shows. Every scalar stays a string; the schema gives it a type
// (so `on`/`yes` are not booleans as in YAML 1.1).

import (
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type yKind int

const (
	yScalar yKind = iota
	yMap
	yList
)

type yPair struct {
	key  string
	val  *yNode
	line int
}

// yNode: a parsed value. raw is the scalar as written (quotes removed, escapes resolved) before ${ENV}.
type yNode struct {
	kind   yKind
	raw    string
	quoted bool
	pairs  []yPair
	items  []*yNode
	line   int
	null   bool // `key:` with nothing under it
}

func (n *yNode) get(k string) *yNode {
	if n == nil || n.kind != yMap {
		return nil
	}
	for _, p := range n.pairs {
		if p.key == k {
			return p.val
		}
	}
	return nil
}

type yamlErr struct {
	line int
	msg  string
}

func (e *yamlErr) Error() string {
	if e.line > 0 {
		return itoa(e.line) + "번째 줄: " + e.msg
	}
	return e.msg
}

func yfail(line int, msg string) { panic(&yamlErr{line, msg}) }

type yLine struct {
	n      int // 1-based line number
	indent int
	text   string // without indentation and comment, right-trimmed
}

// parseYAML reads the subset. An empty file (or only comments) gives nil, nil.
func parseYAML(src []byte) (root *yNode, err error) {
	defer func() {
		if r := recover(); r != nil {
			if ye, ok := r.(*yamlErr); ok {
				root, err = nil, ye
				return
			}
			panic(r)
		}
	}()
	if !utf8.Valid(src) {
		yfail(0, "UTF-8 이 아닙니다")
	}
	s := strings.TrimPrefix(string(src), "\ufeff")
	if t := strings.TrimSpace(s); strings.HasPrefix(t, "{") {
		return yJsonToNode(t), nil
	}
	var lines []yLine
	for i, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		ind := 0
		for ind < len(l) && l[ind] == ' ' {
			ind++
		}
		if ind < len(l) && l[ind] == '\t' {
			yfail(i+1, "들여쓰기에 탭을 쓸 수 없습니다")
		}
		t := strings.TrimRight(yStripComment(l[ind:], i+1), " \t")
		if t == "" {
			continue
		}
		if t == "---" || t == "..." || strings.HasPrefix(t, "--- ") || strings.HasPrefix(t, "%") {
			yfail(i+1, "여러 문서(---)와 지시어(%)는 받지 않습니다")
		}
		lines = append(lines, yLine{i + 1, ind, t})
	}
	if len(lines) == 0 {
		return nil, nil
	}
	p := &yParser{lines: lines}
	root = p.block(lines[0].indent)
	if p.i < len(lines) {
		yfail(lines[p.i].n, "들여쓰기가 맞지 않습니다")
	}
	if root.kind != yMap {
		yfail(lines[0].n, "맨 위는 키: 값 목록이어야 합니다")
	}
	return root, nil
}

// yStripComment drops a # that starts a comment: at the start or after a space, outside quotes.
func yStripComment(t string, line int) string {
	inD, inS := false, false
	for i := 0; i < len(t); i++ {
		c := t[i]
		switch {
		case inD:
			if c == '\\' {
				i++
			} else if c == '"' {
				inD = false
			}
		case inS:
			if c == '\'' {
				if i+1 < len(t) && t[i+1] == '\'' {
					i++
				} else {
					inS = false
				}
			}
		case c == '"':
			inD = true
		case c == '\'':
			inS = true
		case c == '#' && (i == 0 || t[i-1] == ' ' || t[i-1] == '\t'):
			return t[:i]
		}
	}
	return t
}

type yParser struct {
	lines []yLine
	i     int
}

func yIsListLine(t string) bool { return t == "-" || strings.HasPrefix(t, "- ") }

// block parses the lines at exactly this indent (a map or a list) and what nests under them.
func (p *yParser) block(indent int) *yNode {
	first := p.lines[p.i]
	if yIsListLine(first.text) {
		n := &yNode{kind: yList, line: first.n}
		for p.i < len(p.lines) && p.lines[p.i].indent == indent && yIsListLine(p.lines[p.i].text) {
			l := p.lines[p.i]
			rest := strings.TrimLeft(strings.TrimPrefix(l.text, "-"), " ")
			if rest == "" {
				p.i++
				if p.i < len(p.lines) && p.lines[p.i].indent > indent {
					n.items = append(n.items, p.block(p.lines[p.i].indent))
				} else {
					n.items = append(n.items, &yNode{kind: yScalar, null: true, line: l.n})
				}
				continue
			}
			// "- key: v" starts a map whose other keys sit under the text after "- ".
			off := indent + (len(l.text) - len(rest))
			if _, _, ok := ySplitKey(rest, l.n); ok {
				p.lines[p.i] = yLine{l.n, off, rest}
				n.items = append(n.items, p.block(off))
				continue
			}
			p.i++
			n.items = append(n.items, p.value(rest, l.n))
		}
		return n
	}
	n := &yNode{kind: yMap, line: first.n}
	seen := map[string]bool{}
	for p.i < len(p.lines) && p.lines[p.i].indent == indent && !yIsListLine(p.lines[p.i].text) {
		l := p.lines[p.i]
		k, v, ok := ySplitKey(l.text, l.n)
		if !ok {
			yfail(l.n, "\"키: 값\" 모양이 아닙니다")
		}
		if seen[k] {
			yfail(l.n, "키 "+k+" 가 두 번 나옵니다")
		}
		seen[k] = true
		p.i++
		var val *yNode
		if v == "" {
			switch {
			case p.i < len(p.lines) && p.lines[p.i].indent > indent:
				val = p.block(p.lines[p.i].indent)
			case p.i < len(p.lines) && p.lines[p.i].indent == indent && yIsListLine(p.lines[p.i].text):
				val = p.block(indent) // key:\n- a (a list at the key's own indent)
			default:
				val = &yNode{kind: yScalar, null: true, line: l.n}
			}
		} else {
			val = p.value(v, l.n)
			if p.i < len(p.lines) && p.lines[p.i].indent > indent {
				yfail(p.lines[p.i].n, "값이 있는 키 아래에 더 들여 쓴 줄이 있습니다")
			}
		}
		n.pairs = append(n.pairs, yPair{k, val, l.n})
	}
	return n
}

// ySplitKey finds "key: value" (or "key:" at the end). The key is plain or quoted.
func ySplitKey(t string, line int) (key, val string, ok bool) {
	if t == "" {
		return "", "", false
	}
	if t[0] == '"' || t[0] == '\'' {
		k, rest := yQuoted(t, line)
		rest = strings.TrimLeft(rest, " ")
		if !strings.HasPrefix(rest, ":") {
			return "", "", false
		}
		return k, strings.TrimSpace(rest[1:]), true
	}
	if t[0] == '[' || t[0] == '{' {
		return "", "", false
	}
	for i := 0; i < len(t); i++ {
		if t[i] == ':' && (i == len(t)-1 || t[i+1] == ' ') {
			k := strings.TrimSpace(t[:i])
			if k == "" || strings.ContainsAny(k[:1], "&*!|>%@`?-") && k != "-" {
				return "", "", false
			}
			return k, strings.TrimSpace(t[i+1:]), true
		}
	}
	return "", "", false
}

// value reads what follows "key: " or "- " on one line.
func (p *yParser) value(t string, line int) *yNode {
	switch t[0] {
	case '[', '{':
		f := &yFlow{s: t, line: line}
		n := f.node()
		f.space()
		if f.i < len(f.s) {
			yfail(line, "흐름 표기 뒤에 남은 글자가 있습니다")
		}
		return n
	case '"', '\'':
		s, rest := yQuoted(t, line)
		if strings.TrimSpace(rest) != "" {
			yfail(line, "따옴표 뒤에 남은 글자가 있습니다")
		}
		return &yNode{kind: yScalar, raw: s, quoted: true, line: line}
	}
	return yPlainScalar(t, line)
}

func yPlainScalar(t string, line int) *yNode {
	switch t[0] {
	case '&', '*':
		yfail(line, "앵커·별칭(& *)은 받지 않습니다. 글자 그대로라면 큰따옴표로 감싸세요(예: \"*\")")
	case '!':
		yfail(line, "태그(!)는 받지 않습니다")
	case '|', '>':
		yfail(line, "여러 줄 글(| >)은 받지 않습니다")
	case '@', '`', '%':
		yfail(line, string(t[0])+" 로 시작하는 값은 큰따옴표로 감싸세요")
	}
	if t == "~" || t == "null" || t == "Null" || t == "NULL" {
		return &yNode{kind: yScalar, null: true, line: line}
	}
	return &yNode{kind: yScalar, raw: t, line: line}
}

// yQuoted reads a "..." or '...' string at the start of t and returns it and what follows.
func yQuoted(t string, line int) (string, string) {
	q := t[0]
	var b strings.Builder
	for i := 1; i < len(t); i++ {
		c := t[i]
		if q == '\'' {
			if c == '\'' {
				if i+1 < len(t) && t[i+1] == '\'' {
					b.WriteByte('\'')
					i++
					continue
				}
				return b.String(), t[i+1:]
			}
			b.WriteByte(c)
			continue
		}
		if c == '"' {
			return b.String(), t[i+1:]
		}
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		i++
		if i >= len(t) {
			break
		}
		switch t[i] {
		case '"', '\\', '/':
			b.WriteByte(t[i])
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case 'u':
			if i+4 >= len(t) {
				yfail(line, "\\u 뒤에 16진수 네 자리가 필요합니다")
			}
			r, err := strconv.ParseUint(t[i+1:i+5], 16, 32)
			if err != nil {
				yfail(line, "\\u 뒤에 16진수 네 자리가 필요합니다")
			}
			b.WriteRune(rune(r))
			i += 4
		default:
			yfail(line, "모르는 이스케이프 \\"+string(t[i]))
		}
	}
	yfail(line, "따옴표가 닫히지 않았습니다")
	return "", ""
}

type yFlow struct {
	s    string
	i    int
	line int
}

func (f *yFlow) space() {
	for f.i < len(f.s) && f.s[f.i] == ' ' {
		f.i++
	}
}

func (f *yFlow) node() *yNode {
	f.space()
	if f.i >= len(f.s) {
		yfail(f.line, "흐름 표기가 닫히지 않았습니다(한 줄에 써야 합니다)")
	}
	switch c := f.s[f.i]; c {
	case '[':
		f.i++
		n := &yNode{kind: yList, line: f.line}
		f.space()
		if f.i < len(f.s) && f.s[f.i] == ']' {
			f.i++
			return n
		}
		for {
			n.items = append(n.items, f.node())
			f.space()
			if f.i >= len(f.s) {
				yfail(f.line, "흐름 표기가 닫히지 않았습니다(한 줄에 써야 합니다)")
			}
			if f.s[f.i] == ']' {
				f.i++
				return n
			}
			if f.s[f.i] != ',' {
				yfail(f.line, "목록 항목 사이에는 쉼표가 필요합니다")
			}
			f.i++
		}
	case '{':
		f.i++
		n := &yNode{kind: yMap, line: f.line}
		seen := map[string]bool{}
		f.space()
		if f.i < len(f.s) && f.s[f.i] == '}' {
			f.i++
			return n
		}
		for {
			f.space()
			var k string
			if f.i < len(f.s) && (f.s[f.i] == '"' || f.s[f.i] == '\'') {
				var rest string
				k, rest = yQuoted(f.s[f.i:], f.line)
				f.i = len(f.s) - len(rest)
			} else {
				st := f.i
				for f.i < len(f.s) && f.s[f.i] != ':' && f.s[f.i] != ',' && f.s[f.i] != '}' {
					f.i++
				}
				k = strings.TrimSpace(f.s[st:f.i])
			}
			f.space()
			if k == "" || f.i >= len(f.s) || f.s[f.i] != ':' {
				yfail(f.line, "{ } 안은 \"키: 값\" 이어야 합니다")
			}
			if seen[k] {
				yfail(f.line, "키 "+k+" 가 두 번 나옵니다")
			}
			seen[k] = true
			f.i++
			n.pairs = append(n.pairs, yPair{k, f.node(), f.line})
			f.space()
			if f.i >= len(f.s) {
				yfail(f.line, "흐름 표기가 닫히지 않았습니다(한 줄에 써야 합니다)")
			}
			if f.s[f.i] == '}' {
				f.i++
				return n
			}
			if f.s[f.i] != ',' {
				yfail(f.line, "항목 사이에는 쉼표가 필요합니다")
			}
			f.i++
		}
	case '"', '\'':
		s, rest := yQuoted(f.s[f.i:], f.line)
		f.i = len(f.s) - len(rest)
		return &yNode{kind: yScalar, raw: s, quoted: true, line: f.line}
	default:
		st := f.i
		for f.i < len(f.s) && !strings.ContainsRune(",]}", rune(f.s[f.i])) {
			if f.s[f.i] == '{' || f.s[f.i] == '[' {
				yfail(f.line, "흐름 표기 안의 값에 { [ 가 있으면 큰따옴표로 감싸세요(예: [\"${A}\"])")
			}
			f.i++
		}
		t := strings.TrimSpace(f.s[st:f.i])
		if t == "" {
			yfail(f.line, "빈 항목이 있습니다")
		}
		return yPlainScalar(t, f.line)
	}
}

// yJsonToNode reads a JSON file into the same nodes (numbers and booleans become their text).
func yJsonToNode(t string) *yNode {
	v, err := parseJSON([]byte(t))
	if err != nil {
		yfail(0, "JSON 으로 읽지 못했습니다: "+err.Error())
	}
	var conv func(any) *yNode
	conv = func(v any) *yNode {
		switch x := v.(type) {
		case M:
			n := &yNode{kind: yMap}
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				n.pairs = append(n.pairs, yPair{key: k, val: conv(x[k])})
			}
			return n
		case []any:
			n := &yNode{kind: yList}
			for _, e := range x {
				n.items = append(n.items, conv(e))
			}
			return n
		case nil:
			return &yNode{kind: yScalar, null: true}
		case string:
			return &yNode{kind: yScalar, raw: x, quoted: true}
		case bool:
			return &yNode{kind: yScalar, raw: strconv.FormatBool(x)}
		case float64:
			return &yNode{kind: yScalar, raw: strconv.FormatFloat(x, 'f', -1, 64)}
		}
		yfail(0, "JSON 값을 읽지 못했습니다")
		return nil
	}
	n := conv(v)
	if n.kind != yMap {
		yfail(0, "맨 위는 { } 객체여야 합니다")
	}
	return n
}
