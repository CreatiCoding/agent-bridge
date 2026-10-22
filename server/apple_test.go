package main

// Apple로 로그인 (REQ-F-772): the identity token check on its own and the client secret (from apple-login.test.mjs).

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"regexp"
	"testing"
	"time"
)

const testAUD = "dev.creco.bridge"

func encJ(o any) string {
	b, _ := json.Marshal(o)
	return b64u(b)
}

func appleToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any, head map[string]any) string {
	now := time.Now().Unix()
	c := map[string]any{"iss": "https://appleid.apple.com", "aud": testAUD, "sub": "001234.abcdef", "iat": now, "exp": now + 600, "nonce": "N", "email": "x@privaterelay.appleid.com"}
	for k, v := range claims {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	if head == nil {
		head = map[string]any{"alg": "RS256", "kid": "k1"}
	}
	data := encJ(head) + "." + encJ(c)
	h := sha256.Sum256([]byte(data))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:])
	if err != nil {
		t.Fatal(err)
	}
	return data + "." + b64u(sig)
}

func TestIdentityToken(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	jwks := map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig", "n": b64u(priv.N.Bytes()), "e": b64u(big.NewInt(int64(priv.E)).Bytes())}}}
	raw, _ := json.Marshal(jwks)
	keys := newAppleKeys(func() (any, error) { return parseJSON(raw) })
	check := func(tok, nonce string) (M, error) {
		var c M
		err := try(func() { c = verifyIdentityToken(tok, testAUD, nonce, keys) })
		return c, err
	}
	c, err := check(appleToken(t, priv, nil, nil), "N")
	if err != nil || c["sub"] != "001234.abcdef" {
		t.Fatalf("좋은 토큰: %v %v", c, err)
	}
	good := appleToken(t, priv, nil, nil)
	parts := regexp.MustCompile(`\.`).Split(good, 3)
	cases := map[string]string{
		"another key’s signature": appleToken(t, other, nil, nil),
		"a changed payload":       parts[0] + "." + encJ(map[string]any{"iss": "https://appleid.apple.com", "aud": testAUD, "sub": "someone-else", "exp": 9e9, "nonce": "N"}) + "." + parts[2],
		"alg none":                encJ(map[string]any{"alg": "none", "kid": "k1"}) + "." + encJ(map[string]any{"iss": "https://appleid.apple.com", "aud": testAUD, "sub": "s", "exp": 9e9, "nonce": "N"}) + ".",
		"an unknown kid":          appleToken(t, priv, nil, map[string]any{"alg": "RS256", "kid": "k9"}),
		"another issuer":          appleToken(t, priv, map[string]any{"iss": "https://evil.example"}, nil),
		"another app":             appleToken(t, priv, map[string]any{"aud": "com.other.app"}, nil),
		"an old token":            appleToken(t, priv, map[string]any{"exp": time.Now().Unix() - 5}, nil),
		"another nonce":           appleToken(t, priv, map[string]any{"nonce": "M"}, nil),
		"no nonce":                appleToken(t, priv, map[string]any{"nonce": nil}, nil),
		"not a JWT":               "abc",
	}
	for what, tok := range cases {
		_, err := check(tok, "N")
		var ate *AppleTokenError
		if !errors.As(err, &ate) {
			t.Errorf("refused: %s: got %v", what, err)
		}
	}
}

func TestAppleNames(t *testing.T) {
	uid, login := appleIds("001234.abcdef")
	if !regexp.MustCompile(`^ap[0-9a-f]{24}$`).MatchString(uid) {
		t.Fatal(uid)
	}
	if !isAppleLogin(login) || regexp.MustCompile(`^[a-z0-9-]+$`).MatchString(login) || isAppleLogin("apple-0123456789") {
		t.Fatal(login)
	}
}

func TestAppleClientSecret(t *testing.T) {
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(ec)
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	type sent struct {
		url string
		f   map[string]string
	}
	var got []sent
	old := applePostFn
	applePostFn = func(u string, fields [][2]string) (bool, M) {
		f := map[string]string{}
		for _, x := range fields {
			f[x[0]] = x[1]
		}
		got = append(got, sent{u, f})
		return true, M{"refresh_token": "R"}
	}
	defer func() { applePostFn = old }()
	c := appleClient("TEAM", "KEY", pemText, testAUD)
	if r := c.refreshToken("CODE"); r != "R" {
		t.Fatal(r)
	}
	if !c.revoke("R") {
		t.Fatal("revoke")
	}
	if got[1].url != "https://appleid.apple.com/auth/revoke" {
		t.Fatal(got[1].url)
	}
	f := got[1].f
	if f["token"] != "R" || f["token_type_hint"] != "refresh_token" || f["client_id"] != testAUD {
		t.Fatal(f)
	}
	p := regexp.MustCompile(`\.`).Split(f["client_secret"], 3)
	hb, _ := base64.RawURLEncoding.DecodeString(p[0])
	pb, _ := base64.RawURLEncoding.DecodeString(p[1])
	var h, cl map[string]any
	json.Unmarshal(hb, &h)
	json.Unmarshal(pb, &cl)
	if h["alg"] != "ES256" || h["kid"] != "KEY" || len(h) != 2 {
		t.Fatal(h)
	}
	if cl["iss"] != "TEAM" || cl["aud"] != "https://appleid.apple.com" || cl["sub"] != testAUD {
		t.Fatal(cl)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(p[2])
	sum := sha256.Sum256([]byte(p[0] + "." + p[1]))
	if len(sig) != 64 || !ecdsa.Verify(&ec.PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("서명")
	}
	if appleClient("", "KEY", "x", testAUD) != nil {
		t.Fatal("키가 없으면 nil")
	}
}

func TestSha256hex(t *testing.T) {
	h := sha256.Sum256([]byte("a"))
	eq(t, sha256hex("a"), hex.EncodeToString(h[:]), "the checks hold with the real hash of a nonce")
}
