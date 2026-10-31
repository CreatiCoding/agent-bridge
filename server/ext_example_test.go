package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AC-1497: the example extension in the repository (extensions/example) loads as it is, its built files are
// served and its source is not, and what it keeps goes through the storage it uses.
func TestExtExample(t *testing.T) {
	_ = withConfigServer(t)
	keep := EXTS
	t.Cleanup(func() { EXTS = keep })
	src, _ := filepath.Abs("../extensions/example")
	// A copy with what a build in place leaves (node_modules, a hidden folder): both are left out of the snapshot.
	dir := filepath.Join(t.TempDir(), "example")
	ok(t, os.CopyFS(dir, os.DirFS(src)) == nil)
	_ = os.MkdirAll(filepath.Join(dir, "node_modules", "typescript"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "node_modules", "typescript", "big.js"), make([]byte, EXT_MAX_BYTES+1), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref"), 0o644)
	withCfg(t, "extensionConsent: false\n")
	EXTS = loadExtensions([]extEntry{{Path: dir}}, envMap(nil))
	d := EXTS[0]
	eq(t, d.Err, "")
	eq(t, d.ID, "example")
	eq(t, d.Entry, "dist/index.js")
	eq(t, strings.Join(d.Actions, ","), "composer.submit,renderer.block,session.done")
	eq(t, strings.Join(d.Slots, ","), "composer.actions,session.menu,session-list.row.badges,settings.section")
	for n := range d.Files {
		ok(t, !strings.HasPrefix(n, "node_modules/") && !strings.HasPrefix(n, ".git/") && n != ".gitignore", n)
	}
	// Left-out files do not change what people agree to.
	eq(t, d.Hash, loadExtensions([]extEntry{{Path: src}}, envMap(nil))[0].Hash)
	at := "/ext/example/" + d.Hash + "/"
	for p, want := range map[string]int{"dist/index.js": 200, "dist/jsx.js": 200, "locales/ko.json": 200, "locales/en.json": 200, "src/index.tsx": 404, "src/jsx.ts": 404, "extension.yaml": 404, "node_modules/typescript/big.js": 404} {
		res := newRes(newReq(httptest.NewRequest("GET", at+p, nil)))
		serveExtAs(res, at+p, "gh1")
		eq(t, res.status, want, p)
	}
	// The built entry imports only its neighbour, never a bare module.
	ok(t, strings.Contains(string(d.Files["dist/index.js"]), "from './jsx.js'") && !strings.Contains(string(d.Files["dist/index.js"]), "from 'react'"))
	call := func(m, p, b string) (int, string) { return extCall(t, m, "/api/ext/example"+p, b, extH, "gh1") }
	code, _ := call("PUT", "/storage/user/note.s1", `{"value":"메모"}`)
	eq(t, code, 200)
	_, body := call("GET", "/storage/user?prefix=note.", "")
	jeq(t, oget(js(body), "keys"), `["note.s1"]`)
	code, _ = call("GET", "/call/anything", "")
	eq(t, code, 404) // no routes in the example
}
