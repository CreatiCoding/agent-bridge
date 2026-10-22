// Apple로 로그인 (server/apple.mjs, REQ-F-772) and 앱 알림 (server/apns.mjs, REQ-F-774).
package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const APPLE_ISSUER = "https://appleid.apple.com"

// AppleTokenError: the identity token is not good (shown to the person); any other error is the keys' fetch.
type AppleTokenError struct{ msg string }

func (e *AppleTokenError) Error() string { return e.msg }
func (e *AppleTokenError) thrown()       {}

func appleRefuse(msg string) { panic(&AppleTokenError{msg}) }

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func b64urlDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// AppleKeys: Apple's public keys by kid, fetched when a token names one not seen yet and otherwise kept an hour.
type AppleKeys struct {
	fetch func() (any, error)
	keys  map[string]*rsa.PublicKey
	at    int64
	ttl   int64
}

var appleHTTP = &http.Client{Timeout: 10 * time.Second}

func newAppleKeys(fetch func() (any, error)) *AppleKeys {
	if fetch == nil {
		fetch = func() (any, error) {
			var raw []byte
			var err error
			await(func() {
				var r *http.Response
				r, err = appleHTTP.Get(APPLE_ISSUER + "/auth/keys")
				if err != nil {
					return
				}
				defer r.Body.Close()
				raw, err = io.ReadAll(r.Body)
			})
			if err != nil {
				return nil, errors.New("fetch failed")
			}
			return parseJSON(raw)
		}
	}
	return &AppleKeys{fetch: fetch, keys: map[string]*rsa.PublicKey{}, ttl: 3_600_000}
}

func jwkRSA(k M) *rsa.PublicKey {
	n, err1 := b64urlDecode(mstr(k, "n"))
	e, err2 := b64urlDecode(mstr(k, "e"))
	if err1 != nil || err2 != nil || len(n) == 0 || len(e) == 0 {
		return nil
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
}

func (a *AppleKeys) keyOf(kid string) *rsa.PublicKey {
	if _, ok := a.keys[kid]; !ok || nowMs()-a.at > a.ttl {
		j, err := a.fetch()
		if err != nil {
			throw(err.Error())
		}
		next := map[string]*rsa.PublicKey{}
		for _, k := range marr(j, "keys") {
			km := asM(k)
			if km["kty"] == "RSA" && truthy(km["kid"]) {
				if pk := jwkRSA(km); pk != nil {
					next[jsString(km["kid"])] = pk
				}
			}
		}
		a.keys = next
		a.at = nowMs()
	}
	return a.keys[kid]
}

// verifyIdentityToken: the claims of an identity token that is Apple's, for audience, in date and carrying nonce.
func verifyIdentityToken(token string, audience string, nonce string, keys *AppleKeys) M {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		appleRefuse("토큰 모양이 아닙니다")
	}
	var head, claims M
	hb, e1 := b64urlDecode(parts[0])
	cb, e2 := b64urlDecode(parts[1])
	if e1 != nil || e2 != nil {
		appleRefuse("토큰을 읽지 못했습니다")
	}
	hv, e3 := parseJSON(hb)
	cv, e4 := parseJSON(cb)
	if e3 != nil || e4 != nil {
		appleRefuse("토큰을 읽지 못했습니다")
	}
	head, _ = hv.(M)
	claims, _ = cv.(M)
	if claims == nil {
		claims = M{}
	}
	// Only RS256: a token that names another algorithm is not looked at.
	if _, ok := head["kid"].(string); head == nil || head["alg"] != "RS256" || !ok {
		appleRefuse("서명 방식이 맞지 않습니다")
	}
	key := keys.keyOf(head["kid"].(string))
	if key == nil {
		appleRefuse("모르는 서명 키입니다")
	}
	sig, err := b64urlDecode(parts[2])
	h := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err != nil || rsa.VerifyPKCS1v15(key, crypto.SHA256, h[:], sig) != nil {
		appleRefuse("서명이 맞지 않습니다")
	}
	if claims["iss"] != APPLE_ISSUER {
		appleRefuse("발급자가 맞지 않습니다")
	}
	aud, isArr := claims["aud"].([]any)
	if !isArr {
		aud = []any{claims["aud"]}
	}
	if !containsAny(aud, audience) {
		appleRefuse("이 앱의 토큰이 아닙니다")
	}
	if exp, ok := claims["exp"].(float64); !ok || exp*1000 < float64(nowMs()) {
		appleRefuse("토큰이 만료됐습니다")
	}
	cn, ok := claims["nonce"].(string)
	if nonce == "" || !ok || subtle.ConstantTimeCompare([]byte(sha256hex(cn)), []byte(sha256hex(nonce))) != 1 {
		appleRefuse("로그인 요청이 맞지 않습니다")
	}
	if sub, ok := claims["sub"].(string); !ok || sub == "" {
		appleRefuse("계정 정보가 없습니다")
	}
	return claims
}

// appleIds: this server's names for an Apple account: never a GitHub name, which has no `_`.
func appleIds(sub string) (string, string) {
	h := sha256hex("apple|" + sub)
	return "ap" + h[:24], "apple_" + h[:10]
}

var appleLoginRe = regexp.MustCompile(`^apple_[0-9a-f]{10}$`)

func isAppleLogin(login any) bool {
	s := ""
	if login != nil {
		s = jsString(login)
	}
	return appleLoginRe.MatchString(strings.ToLower(s))
}

// ecKey: a .p8 key's text (with or without its PEM lines).
func ecKey(privateKey string) *ecdsa.PrivateKey {
	if !strings.Contains(privateKey, "BEGIN") {
		privateKey = "-----BEGIN PRIVATE KEY-----\n" + privateKey + "\n-----END PRIVATE KEY-----"
	}
	blk, _ := pem.Decode([]byte(privateKey))
	if blk == nil {
		throw("error:1E08010C:DECODER routines::unsupported")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		if ek, err2 := x509.ParseECPrivateKey(blk.Bytes); err2 == nil {
			return ek
		}
		throw(err.Error())
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		throw("not an EC key")
	}
	return ek
}

func es256JWT(key *ecdsa.PrivateKey, head, claims orderedObj) string {
	data := base64.RawURLEncoding.EncodeToString(jsonBytes(head)) + "." + base64.RawURLEncoding.EncodeToString(jsonBytes(claims))
	return data + "." + base64.RawURLEncoding.EncodeToString(es256Sign(key, []byte(data)))
}

// AppleClient talks to Apple's token and revoke endpoints with a client secret signed by the Sign in with Apple key.
type AppleClient struct {
	teamID, keyID, clientID string
	key                     *ecdsa.PrivateKey
}

func appleClient(teamID, keyID, privateKey, clientID string) *AppleClient {
	if teamID == "" || keyID == "" || privateKey == "" || clientID == "" {
		return nil
	}
	return &AppleClient{teamID: teamID, keyID: keyID, clientID: clientID, key: ecKey(privateKey)}
}

func (a *AppleClient) secret() string {
	iat := float64(nowMs() / 1000)
	return es256JWT(a.key, orderedObj{{"alg", "ES256"}, {"kid", a.keyID}}, orderedObj{{"iss", a.teamID}, {"iat", iat}, {"exp", iat + 300}, {"aud", APPLE_ISSUER}, {"sub", a.clientID}})
}

// applePostFn is how the client posts its form (tests put Apple's place in it).
var applePostFn = applePost

func applePost(u string, fields [][2]string) (bool, M) {
	form := url.Values{}
	parts := []string{}
	for _, f := range fields {
		parts = append(parts, url.QueryEscape(f[0])+"="+url.QueryEscape(f[1]))
	}
	_ = form
	var ok bool
	var j M
	var ferr error
	await(func() {
		r, err := appleHTTP.Post(u, "application/x-www-form-urlencoded", strings.NewReader(strings.Join(parts, "&")))
		if err != nil {
			ferr = err
			return
		}
		defer r.Body.Close()
		ok = r.StatusCode >= 200 && r.StatusCode < 300
		raw, _ := io.ReadAll(r.Body)
		v, _ := parseJSON(raw)
		j, _ = v.(M)
	})
	if ferr != nil {
		throw("fetch failed")
	}
	return ok, j
}

// refreshToken: the refresh token for an authorization code (good for five minutes after sign-in), or "".
func (a *AppleClient) refreshToken(code string) string {
	if code == "" {
		return ""
	}
	ok, j := applePostFn(APPLE_ISSUER+"/auth/token", [][2]string{{"client_id", a.clientID}, {"client_secret", a.secret()}, {"code", code}, {"grant_type", "authorization_code"}})
	if s, isS := j["refresh_token"].(string); ok && isS {
		return s
	}
	return ""
}

// revoke: the app no longer appears under the person's Apple ID. True when Apple said yes.
func (a *AppleClient) revoke(token string) bool {
	ok, _ := applePostFn(APPLE_ISSUER+"/auth/revoke", [][2]string{{"client_id", a.clientID}, {"client_secret", a.secret()}, {"token", token}, {"token_type_hint", "refresh_token"}})
	return ok
}

// ---------- apns.mjs ----------

var (
	APNS_ORIGINS = map[string]string{"production": "https://api.push.apple.com", "sandbox": "https://api.sandbox.push.apple.com"}
	APNS_TOKEN   = regexp.MustCompile(`^[0-9a-f]{64,200}$`)
	APNS_ENVS    = []string{"production", "sandbox"}
	APNS_DEVICES = []string{"iphone", "ipad"}
)

// deadToken: a token APNs says is no longer anyone's.
func deadToken(status int, reason string) bool {
	return status == 410 || (status == 400 && reason == "BadDeviceToken")
}

// apnsPayload: what a notice says on the lock screen. `sid` opens that session when the notification is pressed.
func apnsPayload(n M) orderedObj {
	title := "Agent Bridge"
	if truthy(n["title"]) {
		title = jsString(n["title"])
	}
	body := "확인할 것이 있어요"
	if truthy(n["text"]) {
		body = jsString(n["text"])
	}
	aps := orderedObj{{"alert", orderedObj{{"title", jsSliceTo(title, 80)}, {"body", jsSliceTo(body, 200)}}}, {"sound", "default"}}
	sid := ""
	if truthy(n["sid"]) {
		aps = append(aps, kv{"thread-id", n["sid"]})
		sid = jsString(n["sid"])
	}
	return orderedObj{{"aps", aps}, {"sid", sid}}
}

// webTargets: the web push subscriptions to post to when the person also has the app on the same kind of device.
func webTargets(subs []any, devices []any) []any {
	app := map[any]bool{}
	for _, d := range devices {
		app[mget(d, "dev")] = true
	}
	out := []any{}
	for _, s := range subs {
		dev := mget(s, "dev")
		if !truthy(dev) || !app[dev] {
			out = append(out, s)
		}
	}
	return out
}

var (
	iphoneUA = regexp.MustCompile(`iPhone|iPod`)
	ipadUA   = regexp.MustCompile(`iPad`)
)

func deviceOf(ua string) string {
	if iphoneUA.MatchString(ua) {
		return "iphone"
	}
	if ipadUA.MatchString(ua) {
		return "ipad"
	}
	return ""
}

type apnsResult struct {
	status int
	reason string
}

// ApnsClient sends to APNs over HTTP/2 with a provider token, one kept connection per APNs.
type ApnsClient struct {
	teamID, keyID, topic string
	key                  *ecdsa.PrivateKey
	origins              map[string]string
	jwt                  string
	jwtAt                int64
	clients              map[string]*http.Client
}

func apnsClient(teamID, keyID, privateKey, topic string, origins map[string]string) *ApnsClient {
	if teamID == "" || keyID == "" || privateKey == "" || topic == "" {
		return nil
	}
	if origins == nil {
		origins = APNS_ORIGINS
	}
	return &ApnsClient{teamID: teamID, keyID: keyID, topic: topic, key: ecKey(privateKey), origins: origins, clients: map[string]*http.Client{}}
}

// apnsJwt: a provider token (ES256, kid; iss and iat).
func apnsJwt(teamID, keyID string, key *ecdsa.PrivateKey, now int64) string {
	return es256JWT(key, orderedObj{{"alg", "ES256"}, {"kid", keyID}}, orderedObj{{"iss", teamID}, {"iat", float64(now / 1000)}})
}

// bearer: Apple takes a provider token for up to an hour and refuses a new one more often than every 20 minutes.
func (a *ApnsClient) bearer() string {
	if a.jwt == "" || nowMs()-a.jwtAt > 40*60_000 {
		a.jwtAt = nowMs()
		a.jwt = apnsJwt(a.teamID, a.keyID, a.key, nowMs())
	}
	return a.jwt
}

func (a *ApnsClient) client(origin string) *http.Client {
	if c, ok := a.clients[origin]; ok {
		return c
	}
	t := &http.Transport{IdleConnTimeout: 10 * time.Minute, ForceAttemptHTTP2: true}
	p := new(http.Protocols)
	if strings.HasPrefix(origin, "http://") {
		p.SetUnencryptedHTTP2(true)
	} else {
		p.SetHTTP2(true)
	}
	t.Protocols = p
	c := &http.Client{Transport: t}
	a.clients[origin] = c
	return c
}

// send posts one notification and says APNs' status and its reason (empty on 200).
func (a *ApnsClient) send(token, env string, payload any, collapseID string) (apnsResult, error) {
	body := jsonBytes(payload)
	origin := a.origins[env]
	c := a.client(origin)
	rq, err := http.NewRequest("POST", origin+"/3/device/"+token, bytes.NewReader(body))
	if err != nil {
		return apnsResult{}, err
	}
	rq.Header.Set("authorization", "bearer "+a.bearer())
	rq.Header.Set("apns-topic", a.topic)
	rq.Header.Set("apns-push-type", "alert")
	rq.Header.Set("apns-priority", "10")
	rq.Header.Set("apns-expiration", itoa(int(nowMs()/1000+3600)))
	if collapseID != "" {
		rq.Header.Set("apns-collapse-id", jsSliceTo(collapseID, 64))
	}
	rq.Header.Set("content-type", "application/json")
	var res apnsResult
	var ferr error
	await(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		r, err := c.Do(rq.WithContext(ctx))
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
				res = apnsResult{0, "Timeout"}
				return
			}
			ferr = err
			return
		}
		defer r.Body.Close()
		raw, _ := io.ReadAll(r.Body)
		res.status = r.StatusCode
		if len(raw) > 0 {
			v, err := parseJSON(raw)
			if err == nil {
				if s := mget(v, "reason"); s != nil {
					res.reason = jsString(s)
				}
			}
		}
	})
	return res, ferr
}

func (a *ApnsClient) close() {
	for _, c := range a.clients {
		c.CloseIdleConnections()
	}
	a.clients = map[string]*http.Client{}
}
