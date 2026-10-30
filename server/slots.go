package main

// Server slots (REQ-F-814, REQ-F-815): sign-in from the header of a trusted proxy in front (an SSO gate), and
// more than one origin for one server. Both are off without bridge.yaml, and the server then works as before.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// headerProvider: the trusted-header entry of auth.providers, nil when there is none.
func headerProvider() *authProvider {
	ps, _ := cfgGet("auth.providers").([]authProvider)
	for i := range ps {
		if ps[i].Type == "trusted-header" {
			return &ps[i]
		}
	}
	return nil
}

// A header login is an e-mail address, so it never meets a GitHub name (no @) or an Apple one (apple_…): an
// allow or admin entry names one provider only.
var headerLoginRe = regexp.MustCompile(`^[^\s@<>"',;()\\]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

func isHeaderLogin(login string) bool { return headerLoginRe.MatchString(strings.ToLower(login)) }

// headerUid: the uid of a header login, like an Apple account's (apple.go appleIds). Another address is another person.
func headerUid(login string) string { return "hd" + sha256hexs("trusted-header|" + login)[:24] }

var headerUidRe = regexp.MustCompile(`^hd[0-9a-f]{24}$`)
var appleUidRe = regexp.MustCompile(`^ap[0-9a-f]{24}$`)

// providerOf: how a person signed in, from the uid alone (nothing is stored for it).
func providerOf(uid string) string {
	switch {
	case isDemoUid(uid):
		return "demo"
	case strings.HasPrefix(uid, "dev-"):
		return "dev"
	case headerUidRe.MatchString(uid):
		return "trusted-header"
	case appleUidRe.MatchString(uid):
		return "apple"
	}
	return "github"
}

// The header a newer instance trusts for the peer of a request the old one passed on during a handover. Any
// copy a client sends is dropped first (stripPeerHeaders), so only a value the old instance signed gets through.
const (
	PEER_HEADER     = "X-Bridge-Peer"
	PEER_SIG_HEADER = "X-Bridge-Peer-Sig"
	PEER_OK_HEADER  = "X-Bridge-Peer-Ok"
)

func peerSig(secret, addr string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("peer|" + addr))
	return hex.EncodeToString(m.Sum(nil))
}

// acceptPeer: on the instance that took over, the peer the old one signed, when it said it signs (carry.peerHeader).
func acceptPeer(r *http.Request, fromOld bool, secret string, signs bool) {
	addr, sig := r.Header.Get(PEER_HEADER), r.Header.Get(PEER_SIG_HEADER)
	for _, h := range []string{PEER_HEADER, PEER_SIG_HEADER, PEER_OK_HEADER} {
		r.Header.Del(h)
	}
	if fromOld && signs && addr != "" && hmac.Equal([]byte(sig), []byte(peerSig(secret, addr))) {
		r.Header.Set(PEER_OK_HEADER, addr)
	}
}

// peerIP: the TCP peer of a request (never X-Forwarded-For), or the one the old instance signed during a handover.
func peerIP(req *Req) net.IP {
	addr := req.Header.Get(PEER_OK_HEADER)
	if addr == "" {
		addr = req.remote
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	return net.ParseIP(strings.Trim(host, "[]"))
}

// trustedLogin: the login the proxy says, when the secret header matches and the peer is in trustFrom. The login
// is not checked here (headerSignIn refuses one that is no e-mail address).
func trustedLogin(req *Req) (string, bool) {
	p := headerProvider()
	if p == nil || req.internal {
		return "", false
	}
	got := sha256.Sum256([]byte(req.H(p.SecretHeader)))
	want := sha256.Sum256([]byte(p.Secret))
	if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
		return "", false
	}
	ip := peerIP(req)
	if ip == nil {
		return "", false
	}
	in := false
	for _, n := range p.TrustFrom {
		if n.Contains(ip) {
			in = true
		}
	}
	if !in {
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(req.H(p.UserHeader))), true
}

// headerSignIn: a request the proxy vouches for signs that person in. The person is made on the first visit, and
// the same sign-in cookie as any other provider's is given when the request has none for them, so the routes
// that read the cookie work as they do. whoami then believes the header over any cookie in the request. True when
// it answered the request itself: a page opened by someone this server does not let in, which asks for access as
// a GitHub sign-in does.
func headerSignIn(req *Req, res *Res) bool {
	login, ok := trustedLogin(req)
	if !ok {
		return false
	}
	p := headerProvider()
	if !isHeaderLogin(login) {
		refuse(401, "프록시가 보낸 사용자 헤더("+p.UserHeader+")가 이메일 주소가 아니에요")
	}
	uid := headerUid(login)
	req.trusted, req.headerUid = true, uid
	if u, has := users.Get(uid); !has || mstr(u, "login") != login {
		users.Set(uid, M{"login": login, "name": login, "avatar": ""})
	}
	if !isAllowed(login) {
		p := req.URL.Path
		if req.Method != "GET" || !(p == "/" || APP_PATH.MatchString(p)) {
			return false
		}
		h := M{"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}
		if a := requestAccess(login, login, ""); a["status"] == "denied" {
			res.WriteHead(403, SECURITY, h).EndS(page("허용되지 않은 계정입니다", htmlTagChars.ReplaceAllString(login, "")+" 은 이 서버를 쓸 수 없습니다."))
		} else {
			res.WriteHead(403, SECURITY, h).EndS(pendingPageOf(login, false, "trusted-header"))
		}
		return true
	}
	if l, has := logins.Get(sha256hexs(sessionToken(req))); has && mstr(l, "uid") == uid && jsNumber(l["exp"]) > float64(nowMs()) {
		return false
	}
	token := newSignIn(uid)
	req.movedCb = &token
	addSetCookie(res, cookie(req, cname(req, "cb"), token, LOGIN_DAYS*86_400))
	return false
}

// newSignIn: a new sign-in token for uid, stored as its hash (the same record signIn writes).
func newSignIn(uid string) string {
	token := base64.RawURLEncoding.EncodeToString(randBytes(32))
	logins.Set(sha256hexs(token), M{"uid": uid, "exp": float64(nowMs() + LOGIN_DAYS*86_400_000)})
	touchGlobals()
	return token
}

func addSetCookie(res *Res, lines ...string) {
	res.SetHeader("Set-Cookie", append(append([]string{}, res.setHeaders["Set-Cookie"]...), lines...)...)
}

// pickOrigin: with origins.extra, the Host of a request must be one of the server's origins, and that origin is
// the request's own (the Origin check, Secure cookies). Without extra the Host is not looked at, as before, so
// the service API called by a Docker name keeps working.
func pickOrigin(req *Req) {
	extra, _ := cfgGet("origins.extra").([]string)
	if len(extra) == 0 {
		return
	}
	host := strings.ToLower(req.H("host"))
	if host == "" && req.r != nil {
		host = strings.ToLower(req.r.Host)
	}
	for _, o := range append([]string{ORIGIN}, extra...) {
		if hostOfURL(o) == host {
			req.origin = o
			return
		}
	}
	refuse(421, "이 서버의 주소가 아니에요")
}

// linksHere: whether a page on this request's origin may link a Mac: the agent takes the primary origin only.
func linksHere(req *Req) bool { return req.origin == "" || req.origin == ORIGIN }

const NOT_LINKED_HERE = "이 주소에서는 연동하지 않아요. 맥과의 연동은 처음 주소의 탭이 이어요"
