package main

// 읽기 모드 (REQ-F-879): a touch device opens an answer's link in a sheet that shows the page's title, text and
// pictures, drawn by the page itself from plain data. The server fetches the page because a browser cannot read
// another site; what it fetches is guarded against reaching this server's own network (REQ-S-100, SSRF):
// every connection's address is checked after DNS, so a name that resolves (or re-resolves) inward is refused.
// No HTML from the page ever reaches the screen: only text and picture addresses, as JSON.

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	READER_MAX_HTML   = 3 << 20 // bytes of a page read
	READER_MAX_IMG    = 5 << 20 // bytes of a picture passed on
	READER_MAX_BLOCKS = 400
	READER_MAX_TEXT   = 200_000 // characters of text in all
	READER_TIMEOUT    = 10 * time.Second
)

var readerPorts = map[string]bool{"80": true, "443": true, "8080": true, "8443": true}

var cgnat = mustCIDR("100.64.0.0/10")
var benchNet = mustCIDR("198.18.0.0/15")
var zeroNet = mustCIDR("0.0.0.0/8")

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// readerIPOk: only a public unicast address. Loopback, private, link-local (cloud metadata), CGNAT, multicast and
// the like are this server's own neighbourhood.
func readerIPOk(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || cgnat.Contains(ip) || benchNet.Contains(ip) || zeroNet.Contains(ip) || ip.Equal(net.IPv4bcast))
}

var errReaderAddr = errors.New("reader: address refused")

// readerDialer checks the address it really connects to (after DNS), so a rebinding name cannot slip inward.
var readerDialer = &net.Dialer{
	Timeout: 5 * time.Second,
	Control: func(network, address string, _ syscall.RawConn) error {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return errReaderAddr
		}
		ip := net.ParseIP(host)
		if ip == nil || !readerIPOk(ip) || !readerPorts[port] {
			return errReaderAddr
		}
		return nil
	},
}

// readerHTTP: no proxy from the environment (a proxy would connect for us, past the check above), five hops at most.
var readerHTTP = &http.Client{
	Timeout: READER_TIMEOUT,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           readerDialer.DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		MaxIdleConns:          8,
		IdleConnTimeout:       30 * time.Second,
	},
	CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("reader: too many redirects")
		}
		return readerURLOk(r.URL)
	},
}

func readerURLOk(u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errReaderAddr
	}
	return nil
}

// readerGet fetches one address with the lock let go; the body is read up to max (more is an error).
func readerGet(raw string, max int64, accept string) (body []byte, ctype string, final string, status int, err error) {
	u, e := url.Parse(raw)
	if e != nil || readerURLOk(u) != nil {
		return nil, "", "", 0, errReaderAddr
	}
	await(func() {
		ctx, cancel := context.WithTimeout(context.Background(), READER_TIMEOUT)
		defer cancel()
		rq, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if e != nil {
			err = e
			return
		}
		rq.Header.Set("User-Agent", "Mozilla/5.0 (compatible; claude-bridge-reader/1.0)")
		rq.Header.Set("Accept", accept)
		rq.Header.Set("Accept-Language", "ko,en;q=0.8")
		r, e := readerHTTP.Do(rq)
		if e != nil {
			err = e
			return
		}
		defer r.Body.Close()
		status, ctype, final = r.StatusCode, r.Header.Get("Content-Type"), r.Request.URL.String()
		body, err = io.ReadAll(io.LimitReader(r.Body, max+1))
		if err == nil && int64(len(body)) > max {
			err = errReaderBig
		}
	})
	return
}

var errReaderBig = errors.New("reader: too big")

func readerErrText(err error) string {
	switch {
	case errors.Is(err, errReaderAddr):
		return "이 주소는 읽기 모드로 열 수 없어요(내부망·특수 주소나 허용하지 않는 포트)"
	case errors.Is(err, errReaderBig):
		return "페이지가 너무 커서 읽기 모드로 못 열어요"
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(errMsg(err), "Timeout"):
		return "페이지가 너무 늦게 와요"
	}
	return "페이지를 받아 오지 못했어요"
}

// ---------- the page as blocks ----------

type readerBlock struct {
	T    string `json:"t"` // h1 h2 h3 p li pre quote img
	Text string `json:"text,omitempty"`
	Src  string `json:"src,omitempty"`
}

var tagRe = regexp.MustCompile(`^<(/?)([a-zA-Z][a-zA-Z0-9-]*)`)
var attrRe = regexp.MustCompile(`([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?`)
var spaceRe = regexp.MustCompile(`\s+`)
var charsetRe = regexp.MustCompile(`(?i)charset\s*=\s*["']?\s*([-\w]+)`)

// Their whole content is not reading: dropped with what is inside.
var readerDropped = map[string]bool{"script": true, "style": true, "noscript": true, "template": true, "svg": true, "math": true, "iframe": true, "object": true, "canvas": true, "select": true, "textarea": true, "button": true}

// The page's chrome around the text, dropped too (nested ones counted).
var readerChrome = map[string]bool{"nav": true, "header": true, "footer": true, "aside": true, "form": true, "dialog": true, "menu": true}

var readerVoid = map[string]bool{"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true, "input": true, "link": true, "meta": true, "source": true, "track": true, "wbr": true}

func readerAttrs(tag string) map[string]string {
	out := map[string]string{}
	i := strings.IndexAny(tag, " \t\n\r/")
	if i < 0 {
		return out
	}
	for _, m := range attrRe.FindAllStringSubmatch(tag[i:], -1) {
		v := m[2] + m[3] + m[4]
		out[strings.ToLower(m[1])] = html.UnescapeString(v)
	}
	return out
}

type readerPage struct {
	Title  string        `json:"title"`
	Site   string        `json:"site,omitempty"`
	Blocks []readerBlock `json:"blocks"`
}

// tagEnd is the index of the '>' that ends the tag starting at i: a '>' inside a quoted attribute value does not.
func tagEnd(src string, i int) int {
	for j := i + 1; j < len(src); j++ {
		switch src[j] {
		case '>':
			return j
		case '=':
			k := j + 1
			for k < len(src) && (src[k] == ' ' || src[k] == '\t' || src[k] == '\n' || src[k] == '\r') {
				k++
			}
			if k < len(src) && (src[k] == '"' || src[k] == '\'') {
				e := strings.IndexByte(src[k+1:], src[k])
				if e < 0 {
					return -1
				}
				j = k + 1 + e
			}
		}
	}
	return -1
}

// indexFold finds sub (lower case) in s ignoring the case of s.
func indexFold(s, sub string) int {
	n := len(sub)
	for i := 0; i+n <= len(s); i++ {
		if strings.EqualFold(s[i:i+n], sub) {
			return i
		}
	}
	return -1
}

// readerParse turns a page into title and blocks: what is in <article> when there is one, else in <main>, else all.
// Elements are kept on a stack the way a browser does: a closing tag closes every element opened after its own,
// so a page that forgets to close a <nav> or a <p> does not swallow the rest.
func readerParse(src string, base *url.URL) readerPage {
	var pg readerPage
	type blk struct {
		readerBlock
		article, main bool
	}
	var all []blk
	var cur strings.Builder
	curT := "p"
	var stack []string
	chrome, articleD, mainD, preD := 0, 0, 0, 0
	var title string
	total := 0
	add := func(b readerBlock) {
		if total > READER_MAX_TEXT || len(all) >= READER_MAX_BLOCKS {
			return
		}
		// The same line twice in a row: a page's phone and computer layouts of one thing.
		if n := len(all); n > 0 && all[n-1].T == b.T && all[n-1].Text == b.Text && all[n-1].Src == b.Src {
			return
		}
		total += utf8.RuneCountInString(b.Text)
		all = append(all, blk{b, articleD > 0, mainD > 0})
	}
	flush := func() {
		t := cur.String()
		cur.Reset()
		if curT == "pre" {
			t = strings.Trim(t, "\n")
		} else {
			t = strings.TrimSpace(spaceRe.ReplaceAllString(t, " "))
		}
		if t != "" {
			add(readerBlock{T: curT, Text: t})
		}
	}
	start := func(t string) { flush(); curT = t }
	count := func(name string, d int) {
		switch {
		case readerChrome[name]:
			chrome += d
		case name == "article":
			articleD += d
		case name == "main":
			mainD += d
		case name == "pre":
			preD += d
		}
	}
	// What a closing tag (said or implied) does to the block being written.
	closeEffect := func(name string) {
		switch name {
		case "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "blockquote", "pre", "ul", "ol", "dl":
			start("p")
		case "p", "div", "section", "table", "tr", "figure", "figcaption", "article", "main":
			if curT == "pre" {
				cur.WriteString("\n")
			} else {
				flush()
			}
		}
	}
	i := 0
	for i < len(src) {
		lt := strings.IndexByte(src[i:], '<')
		if lt < 0 {
			lt = len(src) - i
		}
		if lt > 0 {
			if chrome == 0 {
				cur.WriteString(html.UnescapeString(src[i : i+lt]))
			}
			i += lt
			if i >= len(src) {
				break
			}
		}
		if strings.HasPrefix(src[i:], "<!--") {
			e := strings.Index(src[i+4:], "-->")
			if e < 0 {
				break
			}
			i += 4 + e + 3
			continue
		}
		gt := tagEnd(src, i)
		if gt < 0 {
			break
		}
		raw := src[i : gt+1]
		i = gt + 1
		m := tagRe.FindStringSubmatch(raw)
		if m == nil {
			continue // <!doctype>, <?xml>, a lone '<'
		}
		closing, name := m[1] == "/", strings.ToLower(m[2])
		if closing {
			at := -1
			for k := len(stack) - 1; k >= 0; k-- {
				if stack[k] == name {
					at = k
					break
				}
			}
			if at < 0 {
				continue
			}
			for len(stack) > at {
				top := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if chrome == 0 || readerChrome[top] {
					closeEffect(top)
				}
				count(top, -1)
			}
			continue
		}
		selfClosed := strings.HasSuffix(raw, "/>")
		// Raw text and dropped elements: skipped to their own closing tag, nothing inside is read as markup.
		if name == "title" || readerDropped[name] {
			if selfClosed {
				continue
			}
			e := indexFold(src[i:], "</"+name)
			if e < 0 {
				break
			}
			if name == "title" && title == "" {
				title = strings.TrimSpace(spaceRe.ReplaceAllString(html.UnescapeString(src[i:i+e]), " "))
			}
			i += e
			if g := strings.IndexByte(src[i:], '>'); g >= 0 {
				i += g + 1
			} else {
				break
			}
			continue
		}
		if name == "meta" {
			a := readerAttrs(raw)
			switch a["property"] {
			case "og:title":
				if pg.Title == "" {
					pg.Title = strings.TrimSpace(a["content"])
				}
			case "og:site_name":
				pg.Site = strings.TrimSpace(a["content"])
			}
			continue
		}
		if !readerVoid[name] && !selfClosed {
			if readerChrome[name] && chrome == 0 {
				flush()
			}
			stack = append(stack, name)
			count(name, 1)
		}
		if chrome > 0 {
			continue
		}
		switch name {
		case "h1", "h2", "h3", "h4", "h5", "h6":
			t := name
			if name > "h3" {
				t = "h3"
			}
			start(t)
		case "li", "dt", "dd":
			start("li")
		case "blockquote":
			start("quote")
		case "pre":
			start("pre")
		case "p", "div", "section", "table", "tr", "ul", "ol", "dl", "figure", "figcaption", "hr", "article", "main":
			if curT == "pre" {
				cur.WriteString("\n")
			} else if curT == "li" || curT == "quote" {
				flush()
			} else {
				start("p")
			}
		case "br":
			cur.WriteString("\n")
		case "td", "th":
			cur.WriteString(" ")
		case "img":
			a := readerAttrs(raw)
			s := a["src"]
			if s == "" || strings.HasPrefix(s, "data:") {
				s = a["data-src"]
			}
			if s == "" {
				if ss := strings.Fields(a["srcset"]); len(ss) > 0 {
					s = ss[0]
				}
			}
			if s == "" {
				continue
			}
			ref, err := url.Parse(strings.TrimSpace(s))
			if err != nil {
				continue
			}
			abs := base.ResolveReference(ref)
			if abs.Scheme != "http" && abs.Scheme != "https" {
				continue
			}
			flush()
			add(readerBlock{T: "img", Src: abs.String(), Text: strings.TrimSpace(a["alt"])})
		}
	}
	flush()
	if pg.Title == "" {
		pg.Title = title
	}
	someArticle, someMain := false, false
	for _, b := range all {
		someArticle = someArticle || b.article
		someMain = someMain || b.main
	}
	pg.Blocks = []readerBlock{}
	for _, b := range all {
		if (someArticle && b.article) || (!someArticle && someMain && b.main) || (!someArticle && !someMain) {
			pg.Blocks = append(pg.Blocks, b.readerBlock)
		}
	}
	return pg
}

func readerCharset(ctype string, body []byte) string {
	if m := charsetRe.FindStringSubmatch(ctype); m != nil {
		return strings.ToLower(m[1])
	}
	head := body
	if len(head) > 4096 {
		head = head[:4096]
	}
	if m := charsetRe.FindSubmatch(head); m != nil {
		return strings.ToLower(string(m[1]))
	}
	return "utf-8"
}

var readerImgTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true}

func apiReader(req *Req, res *Res, u *url.URL, uid string) bool {
	p := u.Path
	if p != "/api/read" && p != "/api/read/img" {
		return false
	}
	if req.Method != "GET" {
		refuse(405, "지원하지 않는 요청이에요")
	}
	target := qstr(u, "u")
	if len(target) > 4096 {
		refuse(400, "주소가 너무 길어요")
	}
	if p == "/api/read/img" {
		if limited(req, 600, "read-img") {
			refuse(429, "너무 자주 열었어요. 잠시 뒤에 다시 해 주세요")
		}
		body, ctype, _, status, err := readerGet(target, READER_MAX_IMG, "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9")
		t := strings.ToLower(strings.TrimSpace(strings.Split(ctype, ";")[0]))
		if err != nil || status != 200 || !readerImgTypes[t] {
			refuse(404, "그림을 받아 오지 못했어요")
		}
		res.WriteHead(200, M{"Content-Type": t, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"}).End(body)
		return true
	}
	if limited(req, 60, "read") {
		refuse(429, "너무 자주 열었어요. 잠시 뒤에 다시 해 주세요")
	}
	body, ctype, final, status, err := readerGet(target, READER_MAX_HTML, "text/html,application/xhtml+xml;q=0.9")
	if err != nil {
		refuse(502, readerErrText(err))
	}
	if status != 200 {
		refuse(502, fmt.Sprintf("페이지가 %d 로 답했어요", status))
	}
	t := strings.ToLower(strings.TrimSpace(strings.Split(ctype, ";")[0]))
	if t != "" && t != "text/html" && t != "application/xhtml+xml" {
		refuse(415, "웹 페이지가 아니라서 읽기 모드로 못 열어요")
	}
	if cs := readerCharset(ctype, body); cs != "utf-8" && cs != "utf8" && cs != "us-ascii" && !utf8.Valid(body) {
		refuse(415, "이 페이지의 글자 형식("+cs+")은 읽기 모드로 못 열어요")
	}
	base, _ := url.Parse(final)
	pg := readerParse(strings.ToValidUTF8(string(body), ""), base)
	jsonRes(res, 200, M{"ok": true, "url": final, "title": pg.Title, "site": pg.Site, "blocks": pg.Blocks})
	return true
}
