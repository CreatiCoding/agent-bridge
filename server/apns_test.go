package main

// 앱 알림 (REQ-F-774): the provider token, the payload, the request APNs gets (from apns.test.mjs).

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func tok64(c string) string { return strings.Repeat(c, 64)[:64] }

func json64(t *testing.T, s string) map[string]any {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func testECPem() (*ecdsa.PrivateKey, string) {
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(ec)
	return ec, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestApnsJwt(t *testing.T) {
	ec, _ := testECPem()
	now := time.Date(2026, 10, 18, 4, 0, 0, 0, time.UTC).UnixMilli()
	p := strings.Split(apnsJwt("TEAM123456", "KEY1234567", ec, now), ".")
	if h := json64(t, p[0]); !reflect.DeepEqual(h, map[string]any{"alg": "ES256", "kid": "KEY1234567"}) {
		t.Fatal(h)
	}
	if c := json64(t, p[1]); !reflect.DeepEqual(c, map[string]any{"iss": "TEAM123456", "iat": float64(now / 1000)}) {
		t.Fatal(c)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(p[2])
	sum := sha256.Sum256([]byte(p[0] + "." + p[1]))
	if len(sig) != 64 || !ecdsa.Verify(&ec.PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("서명")
	}
}

func TestApnsNoClientWithoutKey(t *testing.T) {
	_, p := testECPem()
	if apnsClient("T", "", p, "dev.creco.bridge", nil) != nil || apnsClient("", "K", p, "dev.creco.bridge", nil) != nil || apnsClient("T", "K", "", "dev.creco.bridge", nil) != nil {
		t.Fatal("키가 모자라면 nil")
	}
}

func TestDeadToken(t *testing.T) {
	if !deadToken(410, "Unregistered") || !deadToken(400, "BadDeviceToken") || deadToken(400, "BadCollapseId") || deadToken(403, "InvalidProviderToken") || deadToken(200, "") {
		t.Fatal()
	}
}

func roundTrip(v any) any {
	x, _ := parseJSON(jsonBytes(v))
	return x
}

func TestApnsPayload(t *testing.T) {
	got := roundTrip(apnsPayload(M{"sid": "abcdef12", "title": "세션", "text": "권한 대기"}))
	want := roundTrip(M{"aps": M{"alert": M{"title": "세션", "body": "권한 대기"}, "sound": "default", "thread-id": "abcdef12"}, "sid": "abcdef12"})
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	long := roundTrip(apnsPayload(M{"title": strings.Repeat("x", 500), "text": strings.Repeat("y", 500)}))
	if b := mget(mget(mget(long, "aps"), "alert"), "body").(string); len(b) != 200 {
		t.Fatal(len(b))
	}
}

func TestWebTargets(t *testing.T) {
	if deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari") != "iphone" || deviceOf("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)") != "ipad" || deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome") != "" {
		t.Fatal("deviceOf")
	}
	subs := []any{M{"endpoint": "a", "dev": "iphone"}, M{"endpoint": "b"}, M{"endpoint": "c", "dev": "ipad"}}
	eps := func(l []any) []string {
		out := []string{}
		for _, s := range l {
			out = append(out, mstr(s, "endpoint"))
		}
		return out
	}
	if g := eps(webTargets(subs, []any{M{"token": tok64("a1"), "dev": "iphone"}})); !reflect.DeepEqual(g, []string{"b", "c"}) {
		t.Fatal(g)
	}
	if g := eps(webTargets(subs, []any{})); !reflect.DeepEqual(g, []string{"a", "b", "c"}) {
		t.Fatal(g)
	}
}

type apnsSeen struct {
	proto  int
	method string
	path   string
	header http.Header
	body   any
}

// fakeApns: an unencrypted HTTP/2 stand-in for APNs; DEAD gets 410 Unregistered, BAD 400 BadDeviceToken.
func fakeApns(t *testing.T) (string, func() []apnsSeen, func()) {
	var smu sync.Mutex
	var seen []apnsSeen
	dead, bad := tok64("d0"), tok64("b0")
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v, _ := parseJSON(b)
		smu.Lock()
		seen = append(seen, apnsSeen{r.ProtoMajor, r.Method, r.URL.Path, r.Header.Clone(), v})
		smu.Unlock()
		token := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		switch token {
		case dead:
			w.WriteHeader(410)
			io.WriteString(w, `{"reason":"Unregistered"}`)
		case bad:
			w.WriteHeader(400)
			io.WriteString(w, `{"reason":"BadDeviceToken"}`)
		default:
			w.WriteHeader(200)
		}
	})}
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	srv.Protocols = p
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String(), func() []apnsSeen { smu.Lock(); defer smu.Unlock(); return append([]apnsSeen{}, seen...) }, func() { srv.Close() }
}

func TestApnsClientSend(t *testing.T) {
	_, pemText := testECPem()
	prod, prodSeen, closeP := fakeApns(t)
	sand, sandSeen, closeS := fakeApns(t)
	defer closeP()
	defer closeS()
	c := apnsClient("TEAM", "KID", pemText, "dev.creco.bridge", map[string]string{"production": prod, "sandbox": sand})
	defer c.close()
	mu.Lock()
	r1, err1 := c.send(tok64("a1"), "production", apnsPayload(M{"sid": "sess-0001", "title": "t", "text": "x"}), "sess-0001")
	r2, err2 := c.send(tok64("d0"), "sandbox", apnsPayload(M{}), "")
	mu.Unlock()
	if err1 != nil || err2 != nil {
		t.Fatal(err1, err2)
	}
	if r1 != (apnsResult{200, ""}) || r2 != (apnsResult{410, "Unregistered"}) {
		t.Fatal(r1, r2)
	}
	h := prodSeen()[0]
	if h.proto != 2 || h.method != "POST" || h.path != "/3/device/"+tok64("a1") {
		t.Fatal(h.proto, h.method, h.path)
	}
	if h.header.Get("apns-topic") != "dev.creco.bridge" || h.header.Get("apns-push-type") != "alert" || h.header.Get("apns-collapse-id") != "sess-0001" {
		t.Fatal(h.header)
	}
	parts := strings.Split(strings.TrimPrefix(h.header.Get("authorization"), "bearer "), ".")
	if json64(t, parts[0])["kid"] != "KID" || json64(t, parts[1])["iss"] != "TEAM" {
		t.Fatal(parts)
	}
	if len(sandSeen()) != 1 {
		t.Fatal(len(sandSeen()))
	}
}
