package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The local screen's bundle (SPEC REQ-F-844, docs/LOCAL-UI-DESIGN.md §2.6): agent/localbundle.mjs, made and signed
// by scripts/sign-agent.mjs with the maintainer's key. This server cannot sign one; it only passes the one it ships
// to a Mac that has an older one, and every Mac checks the signature again before taking it.
type localBundle struct {
	Doc, Sig, Bundle, Version string
	Seq, API                  float64
	OK                        bool
}

// LOCALUI is read once at start (prepare).
var LOCALUI localBundle

const localSigPrefix = "claude-bridge localui v1\n"

var localLineRe = regexp.MustCompile(`(?m)^export const (DOC|SIG|BUNDLE) = (".*")$`)

// loadLocalBundle reads agent/localbundle.mjs: one `export const X = "<JSON string>"` line per value. OK only when
// the signature over the document's exact bytes is one of the update keys' and the bundle is the one it names.
func loadLocalBundle(p string) localBundle {
	b, err := os.ReadFile(p)
	if err != nil {
		return localBundle{}
	}
	vals := map[string]string{}
	for _, m := range localLineRe.FindAllStringSubmatch(string(b), -1) {
		var s string
		if json.Unmarshal([]byte(m[2]), &s) == nil {
			vals[m[1]] = s
		}
	}
	lb := localBundle{Doc: vals["DOC"], Sig: vals["SIG"], Bundle: vals["BUNDLE"]}
	var d struct {
		Name      string  `json:"name"`
		Version   string  `json:"version"`
		Seq       float64 `json:"seq"`
		API       float64 `json:"api"`
		Integrity string  `json:"integrity"`
		Size      int     `json:"size"`
	}
	if lb.Doc == "" || json.Unmarshal([]byte(lb.Doc), &d) != nil || d.Name != "localui" || !isSafeInteger(d.Seq) || d.Seq < 1 {
		return lb
	}
	sig, err := base64.StdEncoding.DecodeString(lb.Sig)
	if err != nil {
		return lb
	}
	signed := false
	for _, k := range updateKeys() {
		if ed25519Verify(k, []byte(localSigPrefix+lb.Doc), sig) {
			signed = true
		}
	}
	h := sha256.Sum256([]byte(lb.Bundle))
	if !signed || d.Integrity != "sha256:"+base64.StdEncoding.EncodeToString(h[:]) || d.Size != len(lb.Bundle) {
		return lb
	}
	lb.Version, lb.Seq, lb.API, lb.OK = d.Version, d.Seq, d.API, true
	return lb
}

// localUiWanted: whether a Mac's hello (its `localUi`) asks for the bundle this server ships: it takes remote
// bundles, for the same api, and what it serves now was signed before this one.
func localUiWanted(lb localBundle, lu M) bool {
	if !lb.OK || lu == nil || !truthy(lu["on"]) || !truthy(lu["ota"]) || jsNumber(lu["api"]) != lb.API {
		return false
	}
	a := asM(lu["active"])
	return strings.TrimSpace(jsString(a["version"])) != lb.Version && jsNumber(a["seq"]) < lb.Seq
}

func offerLocalUi(uid, hostID string, msg M) {
	lu := asM(msg["localUi"])
	if !localUiWanted(LOCALUI, lu) {
		return
	}
	record(uid, hostID, M{"area": "update", "text": "로컬 화면 묶음 " + LOCALUI.Version + " 을 보냄"})
	toHost(hostID, M{"t": "localui", "doc": LOCALUI.Doc, "sig": LOCALUI.Sig, "bundle": LOCALUI.Bundle})
}

func localBundlePath() string { return filepath.Join(ROOT, "agent", "localbundle.mjs") }
