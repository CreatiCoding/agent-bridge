package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---------- session locks ----------
// A session can be locked with a password. The page sends only a hash of it (the proof); the server keeps that proof
// stretched with a salt. While locked, nothing of the conversation leaves the server without an unlock token.

const LOCKED = "🔒 잠긴 세션이에요. 비밀번호로 연 뒤에 볼 수 있어요."
const LOCK_TOKEN_MS = 12 * 3_600_000

// unlocks: sha256 hex of the token -> { uid, sid, exp }. In memory: a restart asks for the password again.
var unlocks = map[string]M{}

// stretch runs with the lock let go: 120,000 rounds would hold every other request (R1-M4).
func stretch(proof, salt string) string {
	var out string
	await(func() {
		s, _ := hex.DecodeString(salt)
		k, _ := pbkdf2.Key(sha256.New, proof, s, 120_000, 32)
		out = hex.EncodeToString(k)
	})
	return out
}

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

func proofOk(meta *Sess, proof any) bool {
	lock, ok := meta.get("lock").(M)
	p := ""
	if proof != nil {
		p = jsString(proof)
	}
	if !ok || !truthy(meta.get("lock")) || !hex64Re.MatchString(p) {
		return false
	}
	a, _ := hex.DecodeString(stretch(p, mstr(lock, "salt")))
	b, _ := hex.DecodeString(hexPrefix(mstr(lock, "hash")))
	return len(a) == len(b) && subtle.ConstantTimeCompare(a, b) == 1
}

// hexPrefix is what Buffer.from(s, 'hex') reads: the hex pairs up to the first that is not.
func hexPrefix(s string) string {
	i := 0
	for i+1 < len(s) {
		if !isHex(s[i]) || !isHex(s[i+1]) {
			break
		}
		i += 2
	}
	return s[:i]
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func lockToken(meta *Sess) string {
	token := base64.RawURLEncoding.EncodeToString(randBytes(24))
	unlocks[sha256hexs(token)] = M{"uid": meta.uid(), "sid": meta.id(), "exp": float64(nowMs() + LOCK_TOKEN_MS)}
	return token
}

// unlockedBy: whether this request may see and drive a locked session. One that is not locked is always open.
func unlockedBy(req *Req, meta *Sess) bool {
	if !truthy(meta.get("lock")) {
		return true
	}
	h := ""
	if req != nil {
		h = req.H("x-lock")
	}
	t, ok := unlocks[sha256hexs(h)]
	return ok && t["uid"] == meta.uid() && t["sid"] == meta.id() && jsNumber(t["exp"]) > float64(nowMs())
}

// shielded: a session as the list and every device sees it: the lock never leaves, a locked one says only that.
func shielded(meta *Sess) M {
	m := shallow(meta.m)
	if meta.hasOpen {
		m["openTools"] = M{}
	}
	if meta.hasSilent {
		m["silentTools"] = M{}
	}
	lock := m["lock"]
	delete(m, "lock")
	if !truthy(lock) {
		return m
	}
	st := asM(m["state"])
	m["locked"] = true
	if !truthy(m["manualTitle"]) {
		m["title"] = "잠긴 세션"
	}
	m["cwd"] = ""
	m["last"] = ""
	m["preview"] = ""
	m["writing"] = ""
	m["echo"] = []any{}
	bg := []any{}
	for _, t := range asArr(m["bg"]) {
		bg = append(bg, M{"kind": mget(t, "kind"), "label": ""})
	}
	m["bg"] = bg
	m["prMentions"] = nil
	delete(m, "todoHidden")
	if f, ok := m["folder"].(M); ok && f != nil {
		repos := []any{}
		for _, r := range asArr(f["repos"]) {
			var pe any
			if truthy(mget(r, "pushError")) {
				pe = "(가림)"
			}
			repos = append(repos, M{"dir": "", "branch": "", "sha": "", "remote": "", "pushError": pe, "pr": nil})
		}
		m["folder"] = M{"repos": repos}
	}
	if c, ok := m["card"].(M); ok && c != nil {
		m["card"] = M{"id": c["id"], "kind": c["kind"], "open": c["open"]}
	} else {
		m["card"] = nil
	}
	ns := shallow(st)
	held := []any{}
	for _, h := range asArr(st["held"]) {
		held = append(held, M{"id": mget(h, "id"), "at": mget(h, "at"), "text": ""})
	}
	ns["held"] = held
	if t, ok := st["tool"].(M); ok && t != nil {
		ns["tool"] = M{"name": t["name"], "title": nil, "at": t["at"]}
	} else {
		ns["tool"] = nil
	}
	ns["running"] = []any{}
	m["state"] = ns
	return m
}

// addNotice: newest first, thirty kept for 30 days. The same key is raised once.
func addNotice(uid string, n M) {
	// A locked session's notice says only that there is something to see, not even its name (REQ-S-071).
	if sid, ok := n["sid"].(string); ok && sid != "" {
		if s, ok := sessions.Get(sid); ok && truthy(s.get("lock")) {
			n = shallow(n)
			n["title"] = "잠긴 세션"
			n["text"] = "확인할 것이 있어요"
		}
	}
	list := noticesOf(uid, nil)
	for _, x := range list {
		if mget(x, "key") == n["key"] {
			return
		}
	}
	kept := M{"id": randHex(6), "at": float64(nowMs()), "sid": n["sid"], "key": n["key"], "title": jsSliceTo(jsString(n["title"]), 80), "text": jsSliceTo(jsString(n["text"]), 200), "tone": n["tone"]}
	list = append([]any{kept}, list...)
	if len(list) > 30 {
		list = list[:30]
	}
	noticeCache[uid] = list
	writeJson(noticesFile(uid), list)
	broadcastState(uid)
	if truthy(n["push"]) {
		always := n["push"] == "always"
		goLocked("push", func() { pushTo(uid, kept, always) })
	}
}

func dropNotices(uid string, match func(M) bool) {
	list := noticesOf(uid, nil)
	kept := []any{}
	for _, x := range list {
		if !match(asM(x)) {
			kept = append(kept, x)
		}
	}
	if len(kept) == len(list) {
		return
	}
	noticeCache[uid] = kept
	writeJson(noticesFile(uid), kept)
	broadcastState(uid)
}

// ---------- web push ----------
// A push carries no content: it only wakes the page's service worker, which asks this server what there is to say.

var vapid M
var vapidKey *ecdsa.PrivateKey

func loadVapid() {
	file := filepath.Join(DATA, "vapid.json")
	vapid, _ = readJSON(file, nil).(M)
	if vapid != nil {
		if blk, _ := pem.Decode([]byte(mstr(vapid, "privateKey"))); blk != nil {
			if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
				vapidKey, _ = k.(*ecdsa.PrivateKey)
			}
		}
		return
	}
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	pub, _ := k.PublicKey.Bytes()
	vapid = M{"publicKey": base64.RawURLEncoding.EncodeToString(pub), "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))}
	vapidKey = k
	writeJson(file, vapid)
}

func subsFile(uid string) string { return filepath.Join(userDir(uid), "push.json") }

func subsOf(uid string) []any {
	l, _ := readJSON(subsFile(uid), []any{}).([]any)
	return l
}

// lookingAt: uid -> when one of its control pages last said it was on screen.
var lookingAt = map[string]int64{}

// viewing: uid -> (sid -> when a page last said it shows that conversation).
var viewing = map[string]map[string]int64{}

func isViewing(uid, sid string) bool {
	at, ok := viewing[uid][sid]
	return ok && nowMs()-at < 45_000
}

// PUSH_HOSTS: a browser's push service: the only hosts the server posts a push to (R1-L13).
var PUSH_HOSTS = regexp.MustCompile(`(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$`)

func pushService(endpoint any) bool {
	s, ok := endpoint.(string)
	if !ok {
		return false
	}
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	return u.Scheme == "https" && PUSH_HOSTS.MatchString(u.Hostname())
}

func es256Sign(key *ecdsa.PrivateKey, data []byte) []byte {
	h := sha256.Sum256(data)
	r, s, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		return nil
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out
}

func b64json(o any) string { return base64.RawURLEncoding.EncodeToString(jsonBytes(o)) }

var pushClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// pushTo: `always`: sent even while a page is in front.
func pushTo(uid string, n M, always bool) {
	if !always && nowMs()-lookingAt[uid] < 45_000 {
		return
	}
	devices := devicesOf(uid)
	goLocked("apns", func() { apnsTo(uid, n, devices) })
	subs := subsOf(uid)
	gone := []any{}
	for _, sub := range webTargets(subs, devices) {
		if !pushService(mget(sub, "endpoint")) || vapidKey == nil {
			continue
		}
		ep := mstr(sub, "endpoint")
		u, _ := url.Parse(ep)
		aud := u.Scheme + "://" + u.Host
		o := ORIGIN
		if o == "" {
			o = "http://localhost"
		}
		ou, _ := url.Parse(o)
		head := b64json(M{"typ": "JWT", "alg": "ES256"}) + "." + b64json(M{"aud": aud, "exp": float64(nowMs()/1000 + 12*3600), "sub": "mailto:noreply@" + ou.Hostname()})
		sig := base64.RawURLEncoding.EncodeToString(es256Sign(vapidKey, []byte(head)))
		var status int
		var err error
		await(func() {
			req, _ := http.NewRequest("POST", ep, nil)
			req.Header.Set("TTL", "3600")
			req.Header.Set("Urgency", "high")
			req.Header.Set("Authorization", "vapid t="+head+"."+sig+", k="+mstr(vapid, "publicKey"))
			var r *http.Response
			r, err = pushClient.Do(req)
			if err == nil {
				status = r.StatusCode
				r.Body.Close()
			}
		})
		if err != nil {
			logLine("push failed", err.Error())
			continue
		}
		if status == 404 || status == 410 {
			gone = append(gone, ep)
		}
	}
	if len(gone) > 0 {
		keep := []any{}
		for _, x := range subs {
			if !containsAny(gone, mget(x, "endpoint")) {
				keep = append(keep, x)
			}
		}
		writeJson(subsFile(uid), keep)
	}
}

// ---------- app push (APNs, REQ-F-775) ----------

func devicesFile(uid string) string { return filepath.Join(userDir(uid), "apns.json") }

func devicesOf(uid string) []any {
	l, _ := readJSON(devicesFile(uid), []any{}).([]any)
	return l
}

var apnsSkipSaid bool

func apnsTo(uid string, n M, devices []any) {
	if len(devices) == 0 || isDemoUid(uid) {
		return
	}
	if apns == nil {
		if !apnsSkipSaid {
			logLine("앱 알림 건너뜀: 서버에 APNs 키가 없습니다 (APPLE_TEAM_ID 와 APNS_KEY_ID·APNS_PRIVATE_KEY 또는 APPLE_KEY_ID·APPLE_PRIVATE_KEY)")
		}
		apnsSkipSaid = true
		return
	}
	gone := []any{}
	fs := []func(){}
	for _, d := range devices {
		fs = append(fs, func() {
			if n == nil {
				n = M{}
			}
			var collapse string
			if s, ok := n["sid"].(string); ok {
				collapse = s
			}
			r, err := apns.send(mstr(d, "token"), mstr(d, "env"), apnsPayload(n), collapse)
			if err != nil {
				logLine("apns failed", err.Error())
				return
			}
			if deadToken(r.status, r.reason) {
				gone = append(gone, mget(d, "token"))
			} else if r.status != 200 {
				logLine("apns " + itoa(r.status) + " " + r.reason)
			}
		})
	}
	parallel(fs...)
	if len(gone) > 0 {
		logLine("apns: 기기 토큰 " + itoa(len(gone)) + "개를 지움 (더 쓰이지 않음)")
		keep := []any{}
		for _, d := range devicesOf(uid) {
			if !containsAny(gone, mget(d, "token")) {
				keep = append(keep, d)
			}
		}
		writeJson(devicesFile(uid), keep)
	}
}

// ---------- pictures ----------

var IMG_TYPES = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
var IMG_TYPE_ORDER = []string{"image/png", "image/jpeg", "image/gif", "image/webp"}

func imgDir(uid string) string { return filepath.Join(userDir(uid), "img") }

// imageSize: width and height read off the file's own header (PNG, GIF, JPEG, WebP).
func imageSize(b []byte) M {
	be16 := func(i int) int { return int(binary.BigEndian.Uint16(b[i:])) }
	le16 := func(i int) int { return int(binary.LittleEndian.Uint16(b[i:])) }
	le24 := func(i int) int { return int(b[i]) | int(b[i+1])<<8 | int(b[i+2])<<16 }
	defer func() { _ = recover() }()
	if len(b) > 24 && binary.BigEndian.Uint32(b) == 0x89504e47 {
		return M{"w": float64(binary.BigEndian.Uint32(b[16:])), "h": float64(binary.BigEndian.Uint32(b[20:]))}
	}
	if len(b) > 10 && string(b[:3]) == "GIF" {
		return M{"w": float64(le16(6)), "h": float64(le16(8))}
	}
	if len(b) > 30 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		switch string(b[12:16]) {
		case "VP8X":
			return M{"w": float64(1 + le24(24)), "h": float64(1 + le24(27))}
		case "VP8 ":
			return M{"w": float64(le16(26) & 0x3fff), "h": float64(le16(28) & 0x3fff)}
		case "VP8L":
			n := binary.LittleEndian.Uint32(b[21:])
			return M{"w": float64(1 + (n & 0x3fff)), "h": float64(1 + ((n >> 14) & 0x3fff))}
		}
	}
	if len(b) > 1 && b[0] == 0xff && b[1] == 0xd8 {
		for i := 2; i+9 < len(b); {
			if b[i] != 0xff {
				return nil
			}
			m := b[i+1]
			if m >= 0xc0 && m <= 0xcf && m != 0xc4 && m != 0xc8 && m != 0xcc {
				return M{"w": float64(be16(i + 7)), "h": float64(be16(i + 5))}
			}
			i += 2 + be16(i+2)
		}
	}
	return nil
}

// imgInfoCache: uid -> { imageId: { w, h, bytes, name } }. Read from the index an older server wrote (REQ-S-069).
var imgInfoCache = map[string]M{}

func imgInfoOf(uid string) M {
	if m, ok := imgInfoCache[uid]; ok {
		return m
	}
	m, _ := readJSON(filepath.Join(imgDir(uid), "index.json"), M{}).(M)
	if m == nil {
		m = M{}
	}
	imgInfoCache[uid] = m
	return m
}

// ---------- 영상 (REQ-F-761) ----------

var VIDEO_TYPES = []string{"video/mp4", "video/quicktime", "video/webm", "video/x-m4v"}
var VIDEO_EXT = map[string]string{"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v"}

const UPLOAD_MAX = 500 * 1024 * 1024
const UPLOAD_TTL_MS = 24 * 3600_000

func uploadsDir(uid string) string { return filepath.Join(DATA, "u", uid, "uploads") }

var uploadIDRe = regexp.MustCompile(`^[0-9a-f]{40}\.(mp4|mov|webm|m4v)$`)

func uploadId(s any) bool {
	str, ok := s.(string)
	return ok && uploadIDRe.MatchString(str)
}

var uploadNameRe = regexp.MustCompile(`[^\w.가-힣 -]`)

func uploadName(s any) string {
	str := ""
	if s != nil {
		str = jsString(s)
	}
	// Each UTF-16 unit that is not allowed is one '_', as the JavaScript replace saw them.
	var b strings.Builder
	for _, r := range str {
		if uploadNameRe.MatchString(string(r)) {
			if r > 0xffff {
				b.WriteString("__")
			} else {
				b.WriteString("_")
			}
		} else {
			b.WriteRune(r)
		}
	}
	out := jsSliceTo(b.String(), 120)
	if out == "" {
		return "video"
	}
	return out
}

// saveUpload: the request's body straight into a file (not held in memory), up to UPLOAD_MAX.
func saveUpload(uid string, req *Req, u *url.URL) M {
	typ := jsTrim(strings.Split(req.H("content-type"), ";")[0])
	id := randHex(20) + "." + VIDEO_EXT[typ]
	dir := uploadsDir(uid)
	_ = os.MkdirAll(dir, 0o700)
	file := filepath.Join(dir, id)
	var size int64
	var tooBig bool
	var werr error
	await(func() {
		out, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			werr = err
			return
		}
		defer out.Close()
		if req.body == nil {
			return
		}
		size, werr = io.Copy(out, io.LimitReader(req.body, UPLOAD_MAX+1))
		if size > UPLOAD_MAX {
			tooBig = true
		}
	})
	if tooBig {
		_ = os.Remove(file)
		refuse(413, "영상은 "+itoa(UPLOAD_MAX/1024/1024)+"MB 까지 보낼 수 있어요")
	}
	if werr != nil {
		_ = os.Remove(file)
		panic(werr)
	}
	if size == 0 {
		_ = os.Remove(file)
		refuse(400, "영상이 비어 있어요")
	}
	name := uploadName(nilIfEmpty(u.Query(), "name"))
	writeJson(file+".json", M{"name": name, "type": typ, "size": float64(size), "at": float64(nowMs())})
	return M{"id": id, "name": name, "size": float64(size)}
}

// nilIfEmpty is searchParams.get(k): null when the parameter is not there.
func nilIfEmpty(q url.Values, k string) any {
	if v, ok := q[k]; ok && len(v) > 0 {
		return v[0]
	}
	return nil
}

// uploadOf: an upload of this person's, with what was said of it; nil when it is not there (or too old).
func uploadOf(uid string, id any) M {
	if !uploadId(id) {
		return nil
	}
	file := filepath.Join(uploadsDir(uid), id.(string))
	info, _ := readJSON(file+".json", nil).(M)
	if info == nil || !exists(file) || float64(nowMs())-jsNumber(info["at"]) > UPLOAD_TTL_MS {
		return nil
	}
	return M{"id": id, "file": file, "name": info["name"], "type": info["type"], "size": info["size"]}
}

func dropOldUploads() {
	uids, _ := os.ReadDir(filepath.Join(DATA, "u"))
	for _, u := range uids {
		dir := uploadsDir(u.Name())
		fs, _ := os.ReadDir(dir)
		for _, f := range fs {
			if !strings.HasSuffix(f.Name(), ".json") {
				continue
			}
			info, _ := readJSON(filepath.Join(dir, f.Name()), nil).(M)
			if info != nil && float64(nowMs())-jsNumber(info["at"]) <= UPLOAD_TTL_MS {
				continue
			}
			_ = os.Remove(filepath.Join(dir, f.Name()))
			_ = os.Remove(filepath.Join(dir, strings.TrimSuffix(f.Name(), ".json")))
		}
	}
}

// sentUploads: message id -> the uploads it carried, as [uid, upload id] (REQ-S-074).
var sentUploads = map[string][][2]string{}

func dropSentUploads(msgIDs []any) {
	for _, idv := range msgIDs {
		id := jsString(idv)
		for _, p := range sentUploads[id] {
			if uploadId(p[1]) {
				_ = os.Remove(filepath.Join(uploadsDir(p[0]), p[1]))
				_ = os.Remove(filepath.Join(uploadsDir(p[0]), p[1]+".json"))
			}
		}
		delete(sentUploads, id)
	}
}

// imageRef: a picture's id (`<sha1>.<ext>`) and, in memory, its size and name for the page (REQ-S-069).
func imageRef(uid string, mediaType any, b64 any, name any) any {
	ext := IMG_TYPES[jsString(mediaType)]
	if ext == "" {
		return nil
	}
	bytes := decodeB64(jsString(b64))
	if len(bytes) == 0 || len(bytes) > 12*1024*1024 {
		return nil
	}
	sum := sha1.Sum(bytes)
	id := hex.EncodeToString(sum[:]) + "." + ext
	info := imgInfoOf(uid)
	cur, has := info[id].(M)
	if !has || (truthy(name) && !truthy(cur["name"])) {
		n := M{}
		for k, v := range imageSize(bytes) {
			n[k] = v
		}
		n["bytes"] = float64(len(bytes))
		for k, v := range cur {
			n[k] = v
		}
		if truthy(name) {
			n["name"] = jsSliceTo(jsString(name), 120)
		}
		info[id] = n
	}
	return id
}

// decodeB64 is Buffer.from(s, 'base64'): standard or url-safe, padding optional, stops at what is not base64.
func decodeB64(s string) []byte {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			b.WriteByte(c)
		case c == '-':
			b.WriteByte('+')
		case c == '_':
			b.WriteByte('/')
		case c == '=':
			i = len(s)
		}
	}
	t := b.String()
	if len(t)%4 == 1 {
		t = t[:len(t)-1]
	}
	out, err := base64.RawStdEncoding.DecodeString(t)
	if err != nil {
		return nil
	}
	return out
}

// imgPassing: pictures passed on lately, so a page drawing the same one again does not ask the Mac again.
type passed struct {
	typ   string
	bytes []byte
}

var imgPassing = newOMap[passed]()

const IMG_PASSING_BYTES = 32 * 1024 * 1024

func passImage(id, typ string, b []byte) {
	imgPassing.Delete(id)
	imgPassing.Set(id, passed{typ, b})
	total := 0
	for _, v := range imgPassing.Values() {
		total += len(v.bytes)
	}
	for _, k := range imgPassing.Keys() {
		if total <= IMG_PASSING_BYTES {
			break
		}
		total -= len(imgPassing.Val(k).bytes)
		imgPassing.Delete(k)
	}
}

// imageFromMacs: a picture from the person's Macs: the one asked first, then the others connected and keeping logs.
func imageFromMacs(uid, id, first string) *passed {
	if hit, ok := imgPassing.Get(id); ok {
		return &hit
	}
	macs := []string{}
	for _, h := range hosts.Keys() {
		if mstr(hosts.Val(h), "uid") == uid && online(h) && storeOn(h) {
			macs = append(macs, h)
		}
	}
	sort.SliceStable(macs, func(i, j int) bool { return macs[i] == first && macs[j] != first })
	for _, hostID := range macs {
		r := ask(hostID, M{"t": "img", "id": id}, 30_000)
		data, ok := r["data"].(string)
		if !truthy(r["ok"]) || !ok {
			continue
		}
		typ := jsString(r["type"])
		if IMG_TYPES[typ] == "" {
			typ = ""
			parts := strings.Split(id, ".")
			for _, t := range IMG_TYPE_ORDER {
				if len(parts) > 1 && IMG_TYPES[t] == parts[1] {
					typ = t
					break
				}
			}
		}
		got := passed{typ, decodeB64(data)}
		passImage(id, got.typ, got.bytes)
		return &got
	}
	return nil
}

var _ = bytes.NewReader
var _ = big.NewInt
var _ = errors.New
