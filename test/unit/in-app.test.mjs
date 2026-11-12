// REQ-F-879: a touch device opens an answer's link in the in-app browser sheet (reading mode, localhost through the
// preview); a computer, a new tab.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { imageUrl, localPort, modeFor, modeOf, opensInApp, readerImg, ruleFor, ruleHost, throughPreview } from '../../ui/src/lib/in-app.ts'
import { snapshotImageUrls, snapshotUserAgent, snapshotSheetUrls, cssReady, cssImports, cssImageUrls, SNAPSHOT_IMG_COUNT, egoSnapshotScript, egoSnapshotResult, EGO_MARK, EGO_QUIET, SNAPSHOT_VIEW_W, SNAPSHOT_VIEW_H } from '../../agent/guard.mjs'

const base = 'https://bridge.example/s/abc'

test('a touch device takes answers and the pages’ links into the sheet', () => {
  for (const from of ['markdown', 'report', 'guide', 'settings']) assert.equal(opensInApp('https://example.com/a', from, true, base), true, from)
  assert.equal(opensInApp('https://github.com/o/r', 'markdown', true, base), true)
  assert.equal(opensInApp('http://localhost:3000/x', 'markdown', true, base), true)
  assert.equal(opensInApp('/api/reports/r1/img/a.png', 'report', true, base), true)
})

test('a computer, a login, a PR, the sheet’s own button and this site’s pages go to the browser', () => {
  assert.equal(opensInApp('https://example.com/a', 'markdown', false, base), false)
  for (const from of ['accounts', 'pr', 'slack', 'preview', 'inapp']) assert.equal(opensInApp('https://example.com/a', from, true, base), false, from)
  assert.equal(opensInApp('mailto:a@b.c', 'markdown', true, base), false)
  assert.equal(opensInApp('/settings', 'settings', true, base), false)
})

test('a picture shows as one picture: this site’s directly, another’s through the server', () => {
  assert.equal(imageUrl('/api/reports/r1/img/a.png', base), '/api/reports/r1/img/a.png')
  assert.equal(imageUrl('https://cdn.example/a.JPG?w=1', base), readerImg('https://cdn.example/a.JPG?w=1'))
  assert.equal(readerImg('https://cdn.example/a b.png'), '/api/read/img?u=https%3A%2F%2Fcdn.example%2Fa%20b.png')
  assert.equal(imageUrl('https://example.com/post', base), null)
})

test('a localhost link: its port, and its path on the preview root', () => {
  assert.equal(localPort('http://localhost:5173/a?b=1'), 5173)
  assert.equal(localPort('http://127.0.0.1/'), 80)
  assert.equal(localPort('https://example.com:5173/'), null)
  assert.equal(throughPreview('https://p.example/t/tok/', 'http://localhost:5173/docs/a?b=1#c'), 'https://p.example/t/tok/docs/a?b=1#c')
})

test('link.open’s default asks the sheet before a new tab; the sheet draws data, never the page’s HTML', () => {
  const src = readFileSync(new URL('../../ui/src/lib/builtin-actions.tsx', import.meta.url), 'utf8')
  assert.match(src, /else if \(opensInApp\(url, from\)\) openInApp\(url\)\s*\n\s*else window\.open\(url, '_blank', 'noopener'\)/)
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /openLink\(outside, 'inapp'\)/)
  assert.match(sheet, /\/api\/read\?u=/)
  assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|innerHTML/)
  // One frame: the localhost preview. The snapshot as the page looked is drawn in a shadow root (1.523), made safe by
  // lib/snapshot-page (AC-1763), not in a frame.
  assert.equal((sheet.match(/<iframe/g) ?? []).length, 1)
  assert.match(sheet, /kind: 'frame', src: throughPreview\(/)
  assert.match(sheet, /mountSnapshot\(host, v\.doc, undefined, onLink\)/)
  assert.doesNotMatch(sheet, /srcDoc|allow-scripts|allow-same-origin/)
})

// REQ-F-881: per host, how the sheet opens a link.
test('AC-1659: a host’s rule, its subdomains’ too, the closest one first; none: localhost previews, the rest reads', () => {
  const rules = [
    { host: 'example.com', mode: 'snapshot' },
    { host: 'docs.example.com', mode: 'read' },
    { host: 'x.com', mode: 'browser' },
    { host: 'localhost', mode: 'snapshot' },
  ]
  assert.equal(ruleFor('a.example.com', rules), 'snapshot')
  assert.equal(ruleFor('docs.example.com', rules), 'read')
  assert.equal(ruleFor('notexample.com', rules), null)
  assert.equal(modeFor('https://www.example.com/p', base, rules), 'snapshot')
  assert.equal(modeFor('http://localhost:3000/', base, rules), 'snapshot')
  assert.equal(modeFor('http://localhost:3000/', base, []), 'preview')
  assert.equal(modeFor('https://other.com/', base, []), 'read')
  // 미리보기 is a Mac's own address only.
  assert.equal(modeFor('https://other.com/', base, [{ host: 'other.com', mode: 'preview' }]), 'read')
  // 브라우저: no sheet, except for a picture.
  assert.equal(opensInApp('https://x.com/a', 'markdown', true, base, rules), false)
  assert.equal(opensInApp('https://x.com/a.png', 'markdown', true, base, rules), true)
  assert.equal(opensInApp('https://example.com/a', 'markdown', true, base, rules), true)
  assert.equal(ruleHost(' https://Docs.Example.com:8080/a?b '), 'docs.example.com')
  assert.equal(ruleHost('localhost:3000'), 'localhost')
  assert.equal(ruleHost('not a host'), null)
})

test('AC-1660: a snapshot reads all the page’s pictures on the Mac; a data: picture shows as it is', () => {
  const html = '<img src="/a.png"><img src="data:x" data-src="b.jpg"><img srcset="c.webp 1x, d.webp 2x"><img src="https://cdn.example/x.png"><img src="/a.png"><img src="javascript:x">'
  assert.deepEqual(snapshotImageUrls(html, 'http://localhost:3000/p/q'), ['http://localhost:3000/a.png', 'http://localhost:3000/p/b.jpg', 'http://localhost:3000/p/c.webp', 'https://cdn.example/x.png'])
  assert.equal(readerImg('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  // POST (signed), the sealed piece checked for this session, read on the screen.
  // Since 1.526 in pieces (lib/snap-stream), the request id made on the screen; a whole answer read as before.
  const stream = readFileSync(new URL('../../ui/src/lib/snap-stream.ts', import.meta.url), 'utf8')
  assert.match(stream, /post<Record<string, unknown>>\(`\/api\/sessions\/\$\{sid\}\/snapshot`, \{ url: u, parts: true, rid \}\)/)
  assert.match(sheet, /snapshotStream\(sid, hostId, abs, onDraw, signal\)/)
  assert.match(sheet, /o\.kind !== 'snapshot'/)
  assert.match(sheet, /o\.sid !== sid/)
  assert.match(sheet, /readSnapshot\(s\.html, s\.url,/)
  assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|innerHTML/)
  const trust = readFileSync(new URL('../../ui/src/lib/trust.ts', import.meta.url), 'utf8')
  assert.match(trust, /op === 'snapshot'\) xs = \[\{ t: 'snapshot', i: \{ sid, url: str\(body\.url\) \} \}\]/)
})

test('AC-1661: ego lite’s script opens the address, finishes its task space, and its result line is found', () => {
  const s = egoSnapshotScript({ name: 'cb-snapshot-ab12', url: 'https://example.com/"x', budgetMs: 8000, gotoMs: 15000 })
  assert.match(s, /taskSpace\("cb-snapshot-ab12"\)/)
  assert.match(s, /page\.goto\("https:\/\/example\.com\/\\"x", \{ waitUntil: "load", timeout: 15000 \}\)/)
  assert.match(s, /finally \{\n  await task\.finish\(\{ keep: \[\] \}\)/)
  assert.match(s, /credentials: "include"/)
  // The in-page function is valid JavaScript.
  assert.doesNotThrow(() => new Function(`return (${s.slice(s.indexOf('page.evaluate(') + 14, s.lastIndexOf(', {"count"'))})`))
  assert.deepEqual(egoSnapshotResult(`[ego] hello\n${EGO_MARK}{"url":"https://e/","html":"<p>a</p>","images":{"https://e/a.png":"data:image/png;base64,AA"}}\n`), { url: 'https://e/', html: '<p>a</p>', images: { 'https://e/a.png': 'data:image/png;base64,AA' }, big: {}, css: {}, width: 0 })
  assert.equal(egoSnapshotResult('no result'), null)
  assert.equal(egoSnapshotResult(`${EGO_MARK}{"html":1}`), null)
})

test('AC-1661: a Mac that does not trust the server takes a snapshot only for the address the device signed, and seals it', async () => {
  const { classOf, rebuild, sealOut } = await import('../../agent/trust.mjs')
  const rule = classOf({ t: 'snapshot' })
  assert.deepEqual(rule, { i: ['sid', 'url'], keep: ['parts', 'rid'] })
  assert.deepEqual(rebuild({ t: 'snapshot', reqId: 'r1', sid: 's1', url: 'https://evil/' }, rule, { sid: 's1', url: 'https://good/' }), { t: 'snapshot', reqId: 'r1', sid: 's1', url: 'https://good/' })
  const m = sealOut({ t: 'snapshot', reqId: 'r1', sid: 's1', ok: true, url: 'https://good/', html: '<p>secret</p>', images: {}, via: 'ego' }, (v, sid) => `⟦${sid}:${v}⟧`)
  assert.equal(m.html, undefined)
  assert.equal(m.url, undefined)
  assert.equal(JSON.parse(m.sealed.slice(4, -1)).html, '<p>secret</p>')
  assert.equal(JSON.parse(m.sealed.slice(4, -1)).kind, 'snapshot')
})

test('AC-1663: with no rule a session’s page takes a snapshot (localhost too) and goes back to the old way when it fails; a rule wins', () => {
  assert.deepEqual(modeOf('https://other.com/', true, base, []), { mode: 'snapshot', fromRule: false })
  assert.deepEqual(modeOf('http://localhost:3000/', true, base, []), { mode: 'snapshot', fromRule: false })
  assert.deepEqual(modeOf('https://other.com/', false, base, []), { mode: 'read', fromRule: false })
  assert.deepEqual(modeOf('http://localhost:3000/', false, base, []), { mode: 'preview', fromRule: false })
  assert.deepEqual(modeOf('https://other.com/', true, base, [{ host: 'other.com', mode: 'read' }]), { mode: 'read', fromRule: true })
  assert.deepEqual(modeOf('http://localhost:3000/', true, base, [{ host: 'localhost', mode: 'preview' }]), { mode: 'preview', fromRule: true })
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /if \(fromRule\) return snapshotView\(sid, abs, show, signal\)/)
  assert.match(sheet, /if \(local\) return previewView\(url, sid\)/)
  assert.match(sheet, /스냅샷을 만들지 못해 읽기로 열었어요/)
})

test('AC-1668: ego lite’s snapshot waits for the page to go quiet in the page, not for ego’s networkidle', () => {
  const s = egoSnapshotScript({ name: 'cb-snapshot-ab12', url: 'https://example.com/', budgetMs: 8000, gotoMs: 15000 })
  assert.doesNotMatch(s, /networkidle/)
  assert.ok(s.includes(`page.waitForFunction(${EGO_QUIET}, undefined, { timeout: 8000 })`))
  assert.doesNotThrow(() => new Function(`return (${EGO_QUIET})`))
  assert.match(EGO_QUIET, /document\.readyState !== "complete"/)
  assert.match(EGO_QUIET, /getEntriesByType\("resource"\)/)
  assert.match(EGO_QUIET, />= 500/)
})

test('AC-1762: ego lite draws the snapshot in the same 412×915 view as Chrome, set before the page opens', () => {
  assert.equal(SNAPSHOT_VIEW_W, 412)
  assert.equal(SNAPSHOT_VIEW_H, 915)
  const s = egoSnapshotScript({ name: 'n', url: 'https://a/', budgetMs: 8000, gotoMs: 15000 })
  const view = 'page.cdp("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 0, mobile: false })'
  assert.ok(s.includes(`try { await ${view} } catch (e) { viewError = `))
  assert.ok(s.indexOf(view) < s.indexOf('page.goto('))
  assert.match(s, /if \(viewError && out\) out\.viewError = viewError/)
  // The whole script is valid JavaScript (top-level await, so as an async function body).
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  assert.doesNotThrow(() => new AsyncFunction('taskSpace', s))
  assert.equal(egoSnapshotResult(`${EGO_MARK}{"url":"https://e/","html":"","width":1496,"viewError":"no cdp"}`).viewError, 'no cdp')
  assert.equal('viewError' in egoSnapshotResult(`${EGO_MARK}{"url":"https://e/","html":"","width":412}`), false)
  const agent = readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.ok(agent.includes('`--window-size=${SNAPSHOT_VIEW_W},${SNAPSHOT_VIEW_H}`'))
  assert.match(agent, /width: SNAPSHOT_VIEW_W \}/)
  assert.match(agent, /if \(r\.viewError\) log\('warn', 'snapshot'/)
})

test('AC-1677: the snapshot’s headless Chrome sends a windowed Chrome’s User-Agent, without "Headless"', () => {
  const mac = snapshotUserAgent('Google Chrome 156.0.8078.47\n', true)
  assert.equal(mac, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
  const linux = snapshotUserAgent('Chromium 120.0.6099.71 snap', false)
  assert.equal(linux, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  assert.equal(snapshotUserAgent('', false), '')
  assert.equal(snapshotUserAgent(undefined, true), '')
  for (const ua of [mac, linux]) assert.doesNotMatch(ua, /Headless/)
  const agent = readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /snapshotUserAgent\(await chromeVersionOnce\(\), IS_MAC\)/)
  assert.match(agent, /`--user-agent=\$\{ua\}`/)
})

test('AC-1679: a default snapshot that fails, then reading that fails too, shows both reasons', () => {
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /readView\(abs\)\.catch\(/)
  assert.ok(sheet.includes('스냅샷을 만들지 못했어요 (${why}). 읽기로도 못 열었어요 ('))
})

test('AC-1685: a sealed snapshot this device cannot open says which step failed', () => {
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.ok(sheet.includes('이 기기에서는 풀 수 없는 스냅샷이에요: ${why}'))
  assert.match(sheet, /t === LOCKED/)
  assert.match(sheet, /풀었지만 내용이 깨졌어요/)
  assert.match(sheet, /스냅샷이 아닌 답이에요/)
  assert.match(sheet, /다른 세션의 스냅샷이에요/)
})

test('AC-1687: a snapshot carries the page’s style sheets and the pictures they name, ready for a frame that fetches nothing', () => {
  const page = 'https://www.example.com/a/b.html'
  const html = `<link rel="preload" href="/x.css"><link href="/s/one.css" rel="stylesheet"><link rel='stylesheet alternate' href='two.css?v=1&amp;x=2'><link rel=stylesheet href="javascript:alert(1)">`
  assert.deepEqual(snapshotSheetUrls(html, page), ['https://www.example.com/s/one.css', 'https://www.example.com/a/two.css?v=1&x=2'])
  const css = cssReady(`@import "base.css"; @font-face{font-family:x;src:url(f.woff2)} .a{background:url('../i/bg.png')} .b{background:url(data:image/png;base64,AA)} .c{mask:url(#m)}`, 'https://cdn.example.com/css/site.css')
  assert.doesNotMatch(css, /font-face/)
  assert.match(css, /@import url\("https:\/\/cdn\.example\.com\/css\/base\.css"\)/)
  assert.match(css, /url\("https:\/\/cdn\.example\.com\/i\/bg\.png"\)/)
  assert.match(css, /url\(data:image\/png;base64,AA\)/)
  assert.match(css, /url\(#m\)/)
  assert.deepEqual(cssImports(css), ['https://cdn.example.com/css/base.css'])
  // Pictures only: not the @import sheet, not fonts.
  assert.deepEqual(cssImageUrls([css, '.d{background:url("https://x/f.woff2")}']), ['https://cdn.example.com/i/bg.png'])
  assert.equal(SNAPSHOT_IMG_COUNT, 80)
  // ego lite reads the sheets the page may read and writes script-made rules into their <style>, and the page's width.
  const s = egoSnapshotScript({ name: 'n', url: 'https://a/', budgetMs: 8000, gotoMs: 15000 })
  assert.match(s, /document\.styleSheets/)
  assert.match(s, /sh\.ownerNode\.textContent = text/)
  assert.match(s, /width: document\.documentElement\.scrollWidth/)
  // The agent asks as a browser would, sends css and width, and seals them with the page.
  const agent = readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /referer: String\(page\)/)
  assert.match(agent, /let msg = \{ t: 'snapshot', reqId, sid, ok: true, url: r\.url, html: r\.html, images, big, css, width: r\.width \|\| 0, via \}/)
  assert.match(agent, /const s = \{ url: r\.url, asked: page\.href, html: r\.html, images, big, css, width: r\.width \|\| 0, via, at: Date\.now\(\) \}/)
  const trust = readFileSync(new URL('../../agent/trust.mjs', import.meta.url), 'utf8')
  assert.match(trust, /css: m\.css \?\? \{\}, big: m\.big \?\? \{\}, width: m\.width \?\? 0/)
  // The screen puts it together with nothing left that runs or fetches.
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe, base, meta, link, template, source, track, animate, animateMotion, animateTransform, set'/)
  assert.match(sp, /new DOMParser\(\)\.parseFromString/)
  assert.match(sp, /if \(\/\^on\/\.test\(n\) \|\| DROP_ATTRS\.includes\(n\)\) e\.removeAttribute\(a\.name\)/)
  assert.match(sp, /a\.setAttribute\('target', '_blank'\)/)
})

test('AC-1688: a picture of the page’s styles is written once, on :host, and named by var()', () => {
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /`--cb-i\$\{vars\.size\}`/)
  assert.match(sp, /return `var\(\$\{v\}\)`/)
  assert.match(sp, /const varsText = \[\.\.\.vars\]\.map\(\(\[d, v\]\) => `\$\{v\}:url\(\$\{cssString\(d\)\}\)`\)\.join\(';'\)/)
  assert.match(sp, /SHADOW_BASE \+ \(d\.vars \? `:host\{\$\{d\.vars\}\}` : ''\)/)
})

test('AC-1689: a snapshot has no @import left', async () => {
  const { dropImports } = await import('../../ui/src/lib/snapshot-page.ts')
  assert.equal(dropImports('@import "http://a/x";p{color:red}'), 'p{color:red}')
  assert.equal(dropImports("@import url(http://a/x) screen; p{}"), ' p{}')
  assert.equal(dropImports("@IMPORT 'a';p{}"), 'p{}')
  assert.equal(dropImports('@\\69mport "a";p{}'), 'p{}')
  assert.equal(dropImports('@\\000069 mport "a";p{}'), 'p{}')
  assert.equal(dropImports('@im\\port "a";p{}'), 'p{}')
  assert.equal(dropImports('p{} @import "a;b"; q{}'), 'p{}  q{}')
  // Left alone: an "@import" inside a comment or a string, other at-rules, and a cut never eats past its rule.
  assert.equal(dropImports('/* @import "a"; */p{}'), '/* @import "a"; */p{}')
  assert.equal(dropImports('p::after{content:"@import x;"}'), 'p::after{content:"@import x;"}')
  assert.equal(dropImports('@media screen{p{color:red}}@importx{}'), '@media screen{p{color:red}}@importx{}')
  assert.equal(dropImports('@import "a" p{color:red}'), '{color:red}')
  // Every sheet goes through dropImports and then scrubCss (AC-1763), the document CSP of 1.490 no longer exists.
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /let t = dropImports\(text\)\n  t = dropFunctions\(t\)/)
  assert.match(sp, /return scrubCss\(t, picture\)/)
  assert.doesNotMatch(sp, /SNAPSHOT_CSP|http-equiv', 'Content-Security-Policy/)
})

test('AC-1696: a snapshot that cannot be drawn says so, and a report carries the last snapshots', () => {
  const ls = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  // Since 1.523 a shadow root, not a frame: an error putting the page in is said over the box (no timer to wait out).
  assert.doesNotMatch(ls, /SNAPSHOT_FRAME_MS|onLoad=/)
  assert.match(ls, /try \{\n      mountSnapshot\(host, v\.doc, undefined, onLink\)\n    \} catch \(e\) \{/)
  assert.match(ls, /v\.note\.frame = 'failed'\n      v\.note\.error = why/)
  assert.match(ls, /v\.note\.frame = 'drawn'/)
  assert.match(ls, /원본 모양을 그리지 못했어요 \(\{\(v\.doc\.bytes \/ 1048576\)\.toFixed\(1\)\} MB, 폭 \{pw\}px, \{failed\}\)/)
  assert.match(ls, /읽기 모양으로 보기/)
  // The host only, never the whole address.
  assert.match(ls, /site = new URL\(s\.url\)\.host/)
  const dbg = readFileSync(new URL('../../ui/src/lib/debug.ts', import.meta.url), 'utf8')
  assert.match(dbg, /const SNAPS_MAX = 5/)
  assert.match(dbg, /snapshots: snaps\.map/)
  assert.match(dbg, /frame: 'waiting' \| 'drawn' \| 'failed'; error: string \| null/)
})

test('AC-1763: a snapshot in a shadow root sends no form, keeps no address, and its html, body and :root are its own', async () => {
  const { hostSelector, scrubCss, SHADOW_BASE } = await import('../../ui/src/lib/snapshot-page.ts')
  // html, body, :root and form become the snapshot's own roots, same specificity; parts of names and strings do not.
  assert.equal(hostSelector('html'), 'cb-html')
  assert.equal(hostSelector('html.dark body > .x, BODY'), 'cb-html.dark cb-body > .x, cb-body')
  assert.equal(hostSelector(':root'), ':is(cb-html)')
  assert.equal(hostSelector('html:root .a'), 'cb-html:is(cb-html) .a')
  assert.equal(hostSelector(':not(body) form input'), ':not(cb-body) cb-form input')
  assert.equal(hostSelector('\\62 ody'), 'cb-body')
  assert.equal(hostSelector('.body #html tbody .html-x [data-x="body"] a[title=html]'), '.body #html tbody .html-x [data-x="body"] a[title=html]')
  assert.equal(hostSelector('::part(x) :root-ish p::before'), '::part(x) :root-ish p::before')
  // Every address a style could fetch becomes a picture the Mac sent or nothing; strings and comments elsewhere stay.
  const seen = []
  const pic = (raw) => (seen.push(raw), raw === 'ok.png' ? 'var(--cb-i0)' : 'url("data:,")')
  const out = scrubCss(
    [
      '.a{background:url(http://e/a.png)}',
      '.b{background:URL( "http://e/b.png" )}',
      ".c{background:\\75 rl('http://e/c.png')}",
      '.d{background:u\\rl(http://e/d.png)}',
      '.e{background-image:image-set("http://e/e.png" 1x, url(ok.png) 2x)}',
      '.f{background-image:-webkit-image-set("http://e/f.png" 1x)}',
      '.g{background:src("http://e/g.png")}',
      '.h{width:expression(alert(1))}',
      '@font-face{font-family:x;src:url(http://e/font.woff2)}',
      '.i::after{content:"url(http://e/kept-text)"} /* url(http://e/comment) */',
    ].join('\n'),
    pic,
  )
  for (const x of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'font.woff2']) assert.ok(!out.includes(`http://e/${x}`), x)
  assert.deepEqual(seen, ['http://e/a.png', 'http://e/b.png', 'http://e/c.png', 'http://e/d.png', 'http://e/e.png', 'ok.png', 'http://e/f.png', 'http://e/g.png', 'http://e/font.woff2'])
  assert.match(out, /image-set\(url\("data:,"\) 1x, var\(--cb-i0\) 2x\)/)
  assert.match(out, /\.h\{width:none\}/)
  assert.match(out, /content:"url\(http:\/\/e\/kept-text\)"/)
  assert.match(out, /\/\* url\(http:\/\/e\/comment\) \*\//)
  // A picture function that takes a value filled in later (var, env, attr) is none: the string could be an address.
  assert.equal(scrubCss('.v{--u:"/api/x";background:image-set(var(--u) 1x)}', pic), '.v{--u:"/api/x";background:none}')
  assert.equal(scrubCss('.v{background:-webkit-image-set(v\\61r(--u))}', pic), '.v{background:none}')
  assert.equal(scrubCss('.v{background:image(attr(data-u))} .w{content:var(--x)}', pic), '.v{background:none} .w{content:var(--x)}')
  // The shadow root's base keeps this page's styles out and paints a white page.
  assert.match(SHADOW_BASE, /^:host\{all:initial;display:block;color-scheme:light;background:#fff;color:#000\}/)
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  // A form becomes <cb-form> (not a form), controls are inert, and attributes that act or name an address go.
  assert.match(sp, /doc\.querySelectorAll\('form'\)\.forEach\(\(f\) => \{\n    const b = doc\.createElement\('cb-form'\)/)
  assert.match(sp, /querySelectorAll\('button, input, select, textarea, fieldset'\)\.forEach\(\(e\) => \{\n    e\.setAttribute\('inert', ''\)/)
  for (const a of ['formaction', 'action', 'ping', 'download', 'srcdoc', 'background', 'autofocus', 'popovertarget', 'contenteditable']) assert.match(sp, new RegExp(`'${a}'`))
  // Links: http(s) only, a new tab without referrer; a click or a submit stops at the shadow root and its host.
  assert.match(sp, /if \(!\/\^https\?:\/i\.test\(href\)\) return void a\.removeAttribute\('href'\)/)
  assert.match(sp, /a\.setAttribute\('rel', 'noopener noreferrer'\)/)
  assert.match(sp, /for \(const at of \[sh, host\]\)/)
  // Rules that style the host are dropped (their !important would win over the box), and the box wraps the host.
  assert.match(sp, /\/:host\/i\.test\(prelude\) \|\|/)
  assert.match(sp, /'attributionsrc', 'accesskey'/)
  assert.match(sp, /if \(!a\.hasAttribute\('href'\)\) return/)
  const ls = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(ls, /<div className="snapshot-page" style=\{[^\n]*\n\s*<div ref=\{page\} className="snapshot-host"/)
  // The box keeps the page's fixed and stacked elements inside it.
  const styles = readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /\.snapshot-page \{[^}]*transform-origin: 0 0;\n  contain: layout paint;\n  isolation: isolate;\n  overflow: hidden;/)
})

test('AC-1764: a snapshot keeps no custom function, and a picture function holds nothing that brings a value in', async () => {
  const { dropFunctions, scrubCss } = await import('../../ui/src/lib/snapshot-page.ts')
  const pic = (raw) => (raw === 'ok.png' ? 'var(--cb-i0)' : 'url("data:,")')
  const sheet = (t) => scrubCss(dropFunctions(t), pic)
  // The reported case: @function returns a string, image-set() fetches it from this site with its cookies.
  assert.equal(sheet('@function --u(){result:"/api/fn"} p{background:image-set(--u() 1x)}'), ' p{background:none}')
  // Escaped name, nested in @media/@supports/@layer, with arguments and a body that holds a brace in a string.
  assert.equal(dropFunctions('@\\66unction --e(){result:"/api/x"} q{}'), ' q{}')
  assert.equal(dropFunctions('@FUNCTION --e() returns <string> {result:"}"} q{}'), ' q{}')
  assert.equal(dropFunctions('@media screen{@supports (a:b){@layer l{@function --n(--a <length>){result:var(--a)}}} p{color:red}}'), '@media screen{@supports (a:b){@layer l{}} p{color:red}}')
  assert.equal(dropFunctions('p::after{content:"@function --x(){}"} /* @function --y(){} */'), 'p::after{content:"@function --x(){}"} /* @function --y(){} */')
  // A style attribute (no rules): the call is none in a picture function, and anywhere else.
  for (const prop of ['background', 'background-image', 'list-style-image', 'border-image-source', 'mask-image', 'content'])
    assert.equal(scrubCss(`${prop}:image-set(--u() 1x)`, pic), `${prop}:none`, prop)
  assert.equal(scrubCss('background-image:--u()', pic), 'background-image:none')
  assert.equal(scrubCss('background-image:-\\-u()', pic), 'background-image:none')
  assert.equal(scrubCss('color:--c(1px)', pic), 'color:none')
  // Picture functions: only addresses, type(), pictures, gradients, colours and maths inside; anything else is none.
  assert.equal(scrubCss('a{background:image-set("x.png" type("image/png") 1x, url(ok.png) 2dppx)}', pic), 'a{background:image-set(url("data:,") type(url("data:,")) 1x, var(--cb-i0) 2dppx)}')
  assert.equal(scrubCss('a{background:image-set(linear-gradient(rgb(1 2 3), calc(50% - 1px), red) 1x)}', pic), 'a{background:image-set(linear-gradient(rgb(1 2 3), calc(50% - 1px), red) 1x)}')
  assert.equal(scrubCss('a{background:cross-fade(url(ok.png) 50%, -webkit-image-set(url(ok.png) 1x))}', pic), 'a{background:cross-fade(var(--cb-i0) 50%, -webkit-image-set(var(--cb-i0) 1x))}')
  for (const inner of ['if(style(--x:1): "/api/a"; else: "/api/b")', 'var(--u)', 'env(x)', 'attr(data-u)', 'inherit(--u)', 'linear-gradient(var(--c), red)', 'calc(var(--n) * 1px)', 'somefuture(--u)'])
    assert.equal(scrubCss(`a{background:image-set(${inner} 1x)}`, pic), 'a{background:none}', inner)
  // Read as the browser reads: CR LF, CR and FF are one LF before anything (an escape's whitespace, a string's end).
  assert.equal(scrubCss('a{background:ur\\6c\r\n(/api/x)}', pic), 'a{background:url("data:,")}')
  assert.equal(scrubCss('a{--z:"x\\\r\n";background:url(/api/x)/*"*/}', pic), 'a{--z:"x\\\n";background:url("data:,")/*"*/}')
  assert.equal(dropFunctions('@\\66 \r\nunction --u(){result:"/api/x"} q{}'), '@\\66 \nunction --u(){result:"/api/x"} q{}')
  assert.equal(dropFunctions('@\\66\r\nunction --u(){result:"/api/x"} q{}'), ' q{}')
  // A site's own pictures named by var() outside a picture function are untouched.
  assert.equal(scrubCss('a{background-image:var(--cb-i3);mask:var(--cb-i0) center}', pic), 'a{background-image:var(--cb-i3);mask:var(--cb-i0) center}')
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /\/\^@function\\b\/i\.test\(text\)/)
})

test('AC-1765: a snapshot keeps no link to this site or its previews; other links open a new tab', async () => {
  const { atOwnOrigin, ownOrigins } = await import('../../ui/src/lib/snapshot-page.ts')
  const own = ['https://bridge.example.com', 'https://lp.bridge.example.com', 'https://lp1-bridge.example.com']
  assert.equal(atOwnOrigin('https://bridge.example.com/api/x', own), true)
  assert.equal(atOwnOrigin('https://BRIDGE.example.com:443/api/x', own), true)
  assert.equal(atOwnOrigin('https://lp1-bridge.example.com/t/a.b/', own), true)
  assert.equal(atOwnOrigin('https://example.com/', own), false)
  assert.equal(atOwnOrigin('http://bridge.example.com/api/x', own), false)
  assert.equal(atOwnOrigin('not a url', own), true)
  assert.deepEqual(ownOrigins(), [])
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /if \(atOwnOrigin\(href, own\)\) return void a\.removeAttribute\('href'\)/)
  assert.match(sp, /const own = s\.own \?\? ownOrigins\(\)/)
  const main = readFileSync(new URL('../../ui/src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /setAppOrigins\(\[me\.origin, \.\.\.\(Array\.isArray\(me\.previewOrigins\) \? me\.previewOrigins : \[\]\)\]\)/)
})

test('AC-1766: a snapshot’s cursor is its keyword alone, never a picture', async () => {
  const { scrubCss, keywordCursors } = await import('../../ui/src/lib/snapshot-page.ts')
  const pic = (raw) => (/^data:image\//.test(raw) ? `url("${raw}")` : 'url("data:,")')
  assert.equal(scrubCss('cursor:url(data:image/png;base64,AAAA) 1 1, pointer', pic), 'cursor:pointer')
  assert.equal(scrubCss('a{cursor: image-set("x.png" 1x) 2 2 , POINTER !important;color:red}', pic), 'a{cursor:POINTER !important;color:red}')
  assert.equal(keywordCursors('a{CURSOR:var(--c)}'), 'a{CURSOR:auto}')
  assert.equal(keywordCursors('a{cursor:url(x)}'), 'a{cursor:auto}')
  assert.equal(keywordCursors('a{cursor:pointer} b{cursor : grab }'), 'a{cursor:pointer} b{cursor : grab }')
  // Not a declaration: a selector, a custom property, a string or a comment.
  assert.equal(
    keywordCursors('cursor:hover{cursor:url(x),move} a{--cursor:url(x),move;content:"cursor:url(x),a"} /* cursor:url(x),b */'),
    'cursor:hover{cursor:move} a{--cursor:url(x),move;content:"cursor:url(x),a"} /* cursor:url(x),b */',
  )
  // Nested rules: after a nested block too.
  assert.equal(keywordCursors('.a{.b{color:red} cursor:url(x) 1 1,help}'), '.a{.b{color:red} cursor:help}')
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /'attributionsrc', 'accesskey', 'cursor'\]/)
  assert.match(sp, /return keywordCursors\(out\)/)
})

// Snapshots in a real browser (PLAYWRIGHT=<path to playwright/index.mjs>, CHROME=<a Chrome> as test/e2e-snapshot-net.mjs;
// CI has none, so there these parts are skipped and the source checks around them stand).
const SNAPSHOT_TS = new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url)
async function inChromium(t, name, fn) {
  await t.test(name, { skip: !process.env.PLAYWRIGHT && 'PLAYWRIGHT not set' }, async () => {
    const { stripTypeScriptTypes } = await import('node:module')
    const { chromium } = await import(process.env.PLAYWRIGHT)
    const lib =
      stripTypeScriptTypes(readFileSync(SNAPSHOT_TS, 'utf8')).replace(/^export /gm, '') +
      '\nObject.assign(window, { snapshotPage, mountSnapshot, snapshotMore, renameSelector, SNAPSHOT_CHUNK })\n' +
      // A selector of the page as the snapshot names it (1.525: classes and ids are made short).
      'window.named = (d, sel) => (d.names ? renameSelector(sel, d.names.classes, d.names.ids) : sel)\n'
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
    try {
      const page = await browser.newPage({ viewport: { width: 412, height: 700 } })
      await page.setContent('<div id="host"></div><div id="host2"></div>')
      await page.addScriptTag({ content: lib })
      await fn(page)
    } finally {
      await browser.close()
    }
  })
}

test('AC-1769: a snapshot keeps no popover attribute, and what was a popover stays hidden', async (t) => {
  const sp = readFileSync(SNAPSHOT_TS, 'utf8')
  // The attribute still goes (no top layer over this page, 1.523) ...
  assert.match(sp, /'contenteditable', 'popover', 'popovertarget'/)
  // ... and the closed menu or tooltip it hid stays hidden, by the one declaration no page rule can win over.
  assert.match(sp, /const closed = e\.hasAttribute\('popover'\) && !\(tag === 'dialog' && e\.hasAttribute\('open'\)\)/)
  assert.match(sp, /if \(closed\) \{\n      e\.setAttribute\('style', 'display:none!important'\)/)
  await inChromium(t, 'in Chromium', async (page) => {
    const html = `<html><head><style>
anchored-position{display:block!important} .force[popover]{display:flex!important;position:static} #tip{display:block}
</style></head><body>
<div popover="auto" id="menu"><a href="https://example.com/">메뉴</a></div><p id="body">본문</p>
<anchored-position popover="auto" id="ap" class="force"><a href="https://example.com/more">더 보기</a></anchored-position>
<tool-tip popover="manual" id="tip" style="display:block!important">툴팁</tool-tip>
<div popover id="bare" style="color:red/*">비어 있는 popover</div>
<dialog open popover id="dlg">열린 dialog</dialog>
</body></html>`
    const r = await page.evaluate((a) => {
      const d = window.snapshotPage(a)
      const sh = window.mountSnapshot(document.getElementById('host'), d)
      const el = (id) => sh.querySelector(window.named(d, `#${id}`))
      const shown = (id) => getComputedStyle(el(id)).display !== 'none' && el(id).getBoundingClientRect().height > 0
      return {
        attrs: sh.querySelectorAll('[popover]').length,
        display: ['menu', 'ap', 'tip', 'bare'].map((id) => getComputedStyle(el(id)).display),
        body: shown('body'),
        dialog: shown('dlg'),
      }
    }, { url: 'https://example.com/page', html, own: [] })
    assert.equal(r.attrs, 0, 'no popover attribute is left')
    assert.deepEqual(r.display, ['none', 'none', 'none', 'none'])
    assert.equal(r.body, true, 'the text beside it shows')
    // As the browser's own rule: an open <dialog popover> is drawn.
    assert.equal(r.dialog, true)
  })
})

test('AC-1770: a big picture is not sent; its size is, and the snapshot draws a grey box that size', async (t) => {
  const { imageSize, bigSizes, SNAPSHOT_IMG_BIG, SNAPSHOT_BIG_COUNT, egoSnapshotScript } = await import('../../agent/guard.mjs')
  assert.equal(SNAPSHOT_IMG_BIG, 256 * 1024)
  assert.equal(SNAPSHOT_BIG_COUNT, 200)
  // The size from the picture's own header.
  const png = Buffer.alloc(24)
  png.writeUInt32BE(0x89504e47, 0)
  png.write('IHDR', 12, 'latin1')
  png.writeUInt32BE(640, 16)
  png.writeUInt32BE(480, 20)
  assert.deepEqual(imageSize(png), [640, 480])
  assert.deepEqual(imageSize(Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1')), [800, 600])
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, ...Array(9).fill(0)])
  assert.deepEqual(imageSize(jpg), [400, 300])
  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBPVP8X', 8, 'latin1')
  webp.writeUIntLE(1023, 24, 3)
  webp.writeUIntLE(767, 27, 3)
  assert.deepEqual(imageSize(webp), [1024, 768])
  const avif = Buffer.concat([Buffer.from('\0\0\0\x1cftypavif', 'latin1'), Buffer.alloc(16), Buffer.from('\0\0\0\x14ispe', 'latin1'), Buffer.from([0, 0, 0, 0, 0, 0, 7, 0x80, 0, 0, 4, 0x38])])
  assert.deepEqual(imageSize(avif), [1920, 1080])
  assert.equal(imageSize(Buffer.from('not a picture')), null)
  // What goes out: http(s) addresses, two whole sizes 1–100000.
  assert.deepEqual(bigSizes({ 'https://a/x.png': [640, 480], 'javascript:x': [1, 1], 'https://a/y': [0, 1], 'https://a/z': [1.5, 2], 'https://a/w': '640x480' }), { 'https://a/x.png': [640, 480] })
  // ego lite: a picture over the line goes as its size in the page; the agent: as its header says, not its bytes.
  const ego = egoSnapshotScript({ name: 'n', url: 'https://a/', budgetMs: 1, gotoMs: 1 })
  assert.match(ego, /b\.size > o\.big\) \{\n        if \(nb < o\.bigCount && img\.naturalWidth > 0/)
  const agent = readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /if \(bytes\.length > SNAPSHOT_IMG_BIG\) \{\n          const size = imgs\.has\(src\) \? imageSize\(bytes\) : null/)
  assert.match(agent, /let msg = \{ t: 'snapshot', reqId, sid, ok: true, url: r\.url, html: r\.html, images, big, css,/)
  const ls = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(ls, /snapshotPage\(\{ url: s\.url, html: s\.html, images, css, big \}\)/)
  await inChromium(t, 'in Chromium', async (page) => {
    const html = `<style>img{max-width:100%;height:auto} .half{width:206px}</style>
<img id="a" src="/a.jpg" alt="a"><img id="b" class="half" src="/b.jpg"><img id="c" width="100" src="/c.jpg"><img id="d" src="/d.png">`
    const big = { 'https://example.com/a.jpg': [1600, 1200], 'https://example.com/b.jpg': [800, 400], 'https://example.com/c.jpg': [300, 150], 'https://example.com/d.png': 'x' }
    const r = await page.evaluate((a) => {
      const d = window.snapshotPage(a)
      const sh = window.mountSnapshot(document.getElementById('host'), d)
      return ['a', 'b', 'c', 'd'].map((id) => {
        const e = sh.querySelector(window.named(d, `#${id}`))
        const b = e.getBoundingClientRect()
        return { src: (e.getAttribute('src') ?? '').slice(0, 30), w: Math.round(b.width), h: Math.round(b.height), wa: e.getAttribute('width'), ha: e.getAttribute('height'), big: e.hasAttribute('data-cb-big') }
      })
    }, { url: 'https://example.com/page', html, big, own: [] })
    const grey = 'data:image/png;base64,iVBORw0K'
    // Full width (the host's 396 less the snapshot body's 8px margins), at the picture's own ratio.
    assert.deepEqual(r[0], { src: grey, w: 380, h: 285, wa: '1600', ha: '1200', big: true })
    assert.deepEqual(r[1], { src: grey, w: 206, h: 103, wa: '800', ha: '400', big: true })
    // Its own width attribute stays; the height follows the picture's ratio.
    assert.deepEqual(r[2], { src: grey, w: 100, h: 50, wa: '100', ha: null, big: true })
    // A size that is not two numbers is no size: the picture is left out as before.
    assert.equal(r[3].src, '')
    assert.equal(r[3].big, false)
  })
})

test('AC-1771: a snapshot drops the style rules that match nothing, and keeps those it cannot judge', async (t) => {
  const sp = readFileSync(SNAPSHOT_TS, 'utf8')
  assert.match(sp, /if \(!nested && !\/\[:&\]\/\.test\(r\.selectorText\) && !matches\(r\.selectorText\)\) del\(i\)/)
  // What lighten writes goes through the filters again.
  assert.match(sp, /const names = lighten\(root, head, \(t\) => scrubCss\(dropFunctions\(dropImports\(t\)\), pictureFor\(\)\)\)/)
  await inChromium(t, 'in Chromium', async (page) => {
    const html = `<style>.used{color:rgb(1, 1, 1)} .unused{color:rgb(2, 2, 2)} .unused:hover{color:rgb(3, 3, 3)} p::before{content:"b"}
@media (min-width:1px){.unused2{color:rgb(4, 4, 4)}} @layer l{.gone{color:rgb(5, 5, 5)} .used{color:rgb(6, 6, 6)}}
@keyframes k{from{color:rgb(7, 7, 7)}} div > .used{margin:9px}
.a{background:url(http://e/x.png)} @import "http://e/y.css"; :host{position:fixed}</style><p class="used">x</p>`
    const r = await page.evaluate((a) => {
      const d = window.snapshotPage(a)
      const sh = window.mountSnapshot(document.getElementById('host'), d)
      const css = Array.from(sh.querySelectorAll('style'), (s) => s.textContent).join('\n')
      return { css, color: getComputedStyle(sh.querySelector('p')).color, margin: getComputedStyle(sh.querySelector('p')).marginTop }
    }, { url: 'https://example.com/page', html, own: [] })
    for (const gone of ['rgb(2, 2, 2)', 'rgb(5, 5, 5)', 'margin: 9px']) assert.ok(!r.css.includes(gone), `${gone} is gone`)
    for (const kept of ['rgb(3, 3, 3)', 'rgb(4, 4, 4)', 'rgb(6, 6, 6)', 'rgb(7, 7, 7)', 'content: "b"']) assert.ok(r.css.includes(kept), `${kept} is kept`)
    assert.equal(r.color, 'rgb(1, 1, 1)')
    assert.equal(r.margin, '16px')
    // Nothing taken out before comes back through the browser's writing of the sheet.
    assert.ok(!/http:\/\/e\/|@import|:host\{position/.test(r.css), r.css)
  })
})

test('AC-1772: a snapshot is written short (comments, layout whitespace, short names) and looks the same', async (t) => {
  const sp = readFileSync(SNAPSHOT_TS, 'utf8')
  assert.match(sp, /function nameTests\(sel: string/)
  assert.match(sp, /if \(fixed \|\| \(blocked\['\.'\] && blocked\['#'\]\)\) \{\n    write\(pruned\)\n    return null\n  \}/)
  await inChromium(t, 'in Chromium', async (page) => {
    const html = `<style>.card .title{color:rgb(10, 20, 30)} #main{padding:3px} .pre-ish{white-space:pre}</style>
<!-- a comment -->
<div id="main" class="card wide">
  <h1 class="title" id="t">Title</h1>
  <label for="q" id="lab">L</label><input id="q" aria-labelledby="lab t">
  <svg width="20" height="20"><defs><linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient><symbol id="icon"><rect width="5" height="5"/></symbol></defs><rect id="r" width="10" height="10" fill="url(#grad)"/><use id="u" href="#icon"/></svg>
  <pre id="code">  a
    b</pre>
  <div class="pre-ish" id="ws">${'   \n   '}</div>
  <span id="s1">a</span>${'   \n   '}<span id="s2">b</span>
</div>`
    const r = await page.evaluate((a) => {
      const d = window.snapshotPage(a)
      const sh = window.mountSnapshot(document.getElementById('host'), d)
      const $ = (s) => sh.querySelector(window.named(d, s))
      const w = document.createTreeWalker(sh, NodeFilter.SHOW_COMMENT)
      return {
        names: d.names,
        title: getComputedStyle($('#main .title')).color,
        pad: getComputedStyle($('#main')).paddingTop,
        mainClass: $('#main').getAttribute('class'),
        labFor: $('#lab').getAttribute('for'),
        labelled: $('#q').getAttribute('aria-labelledby'),
        fill: $('#r').getAttribute('fill'),
        use: $('#u').getAttribute('href'),
        code: $('#code').textContent,
        ws: $('#ws').textContent,
        between: $('#s1').nextSibling.data,
        comments: w.nextNode() === null,
        html: sh.innerHTML,
      }
    }, { url: 'https://example.com/page', html, own: [] })
    const { classes, ids } = r.names
    assert.ok(classes.card.length <= 2 && ids.main.length <= 2, JSON.stringify(r.names))
    assert.equal(r.title, 'rgb(10, 20, 30)')
    assert.equal(r.pad, '3px')
    assert.equal(r.mainClass, `${classes.card} ${classes.wide}`)
    assert.equal(r.labFor, ids.q)
    assert.equal(r.labelled, `${ids.lab} ${ids.t}`)
    // (sheetText's filters write every url() quoted)
    assert.equal(r.fill, `url("#${ids.grad}")`)
    assert.equal(r.use, `#${ids.icon}`)
    // Whitespace that shows stays: in <pre>, and where a style keeps it; layout whitespace is one space.
    assert.equal(r.code, '  a\n    b')
    assert.equal(r.ws, '   \n   ')
    assert.equal(r.between, ' ')
    assert.equal(r.comments, true)
    for (const long of ['card', 'pre-ish', 'linearGradient id="grad"', 'a comment']) assert.ok(!r.html.includes(long), long)
  })
  await inChromium(t, 'a name a selector tests as text keeps its own, and no short name passes the test', async (page) => {
    const look = (html) =>
      page.evaluate(
        (a) => {
          const d = window.snapshotPage(a)
          const sh = window.mountSnapshot(document.getElementById('host'), d)
          return { names: d.names, cls: Array.from(sh.querySelectorAll('div'), (e) => e.className), color: Array.from(sh.querySelectorAll('div'), (e) => getComputedStyle(e).color) }
        },
        { url: 'https://example.com/page', html, own: [] },
      )
    // [class*=wi] matched "wide": it still does; "other" is made short.
    const a = await look('<style>[class*=wi]{color:rgb(9, 9, 9)} .other{margin:1px}</style><div class="wide other">x</div>')
    assert.equal(a.cls[0], `wide ${a.names.classes.other}`)
    assert.equal(a.names.classes.wide, undefined)
    assert.equal(a.color[0], 'rgb(9, 9, 9)')
    // [class^=a] matched nothing (kept, in @media): the short names skip "a…", so it still matches nothing.
    const b = await look('<style>@media screen{[class^=a]{color:rgb(9, 9, 9)}} .x{margin:1px}</style><div class="wide">x</div><div class="x">y</div>')
    assert.ok(Object.values(b.names.classes).every((n) => !n.startsWith('a')), JSON.stringify(b.names))
    assert.deepEqual(b.color, ['rgb(0, 0, 0)', 'rgb(0, 0, 0)'])
    // A test of two names at once: classes stay as they are, ids are still made short.
    const c = await look('<style>[class="p q"]{color:rgb(9, 9, 9)} #i{margin:1px}</style><div class="p q" id="i">x</div>')
    assert.deepEqual(c.names.classes, {})
    assert.equal(c.cls[0], 'p q')
    assert.equal(c.color[0], 'rgb(9, 9, 9)')
    assert.ok(c.names.ids.i)
  })
})

test('AC-1773: a snapshot over 200 KB goes in by pieces, at element bounds, the rest as the box is scrolled', async (t) => {
  const sp = readFileSync(SNAPSHOT_TS, 'utf8')
  assert.match(sp, /export const SNAPSHOT_CHUNK = 200 \* 1024/)
  const ls = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(ls, /el\?\.addEventListener\('scroll', fill, \{ passive: true \}\)/)
  assert.match(ls, /el\.scrollTop \+ el\.clientHeight \* 3 >= host\.offsetHeight \* scale\.current; n\+\+\) \{\n\s+if \(!snapshotMore\(host\)\) break/)
  await inChromium(t, 'in Chromium', async (page) => {
    const item = (i) => `<section><p>${String(i).padStart(4, '0')}${'x'.repeat(296)}</p></section>`
    const html = `<div id="wrap">${Array.from({ length: 3000 }, (_, i) => item(i)).join('')}</div><p id="end">end</p>`
    const r = await page.evaluate((a) => {
      const d = window.snapshotPage(a)
      const host = document.getElementById('host')
      const sh = window.mountSnapshot(host, d)
      const full = window.mountSnapshot(document.getElementById('host2'), d, Infinity).querySelector('cb-html').outerHTML
      const first = sh.querySelector('cb-html').outerHTML.length
      const whole = Array.from(sh.querySelectorAll('p'), (p) => p.textContent.length).every((n) => n === 300)
      let pieces = 1
      while (window.snapshotMore(host)) pieces++
      pieces++
      return { first, whole, pieces, same: sh.querySelector('cb-html').outerHTML === full, size: full.length, more: window.snapshotMore(host), chunk: window.SNAPSHOT_CHUNK }
    }, { url: 'https://example.com/page', html, own: [] })
    // About the size: its boxes' own tags are counted as they go in, within a few characters.
    assert.ok(r.first <= r.chunk * 1.01 && r.first > r.chunk * 0.9, `the first piece is about ${r.chunk} (${r.first})`)
    assert.equal(r.whole, true, 'no paragraph is cut')
    assert.ok(r.pieces >= Math.floor(r.size / r.chunk), `${r.pieces} pieces for ${r.size}`)
    assert.equal(r.same, true, 'all the pieces are the page, in its order')
    assert.equal(r.more, false)
    // A small page goes in at once.
    const small = await page.evaluate((a) => {
      const host = document.getElementById('host')
      window.mountSnapshot(host, window.snapshotPage(a))
      return window.snapshotMore(host)
    }, { url: 'https://example.com/page', html: '<p>small</p>', own: [] })
    assert.equal(small, false)
    // A big <style> in the body (as github.com writes one) goes with the head's, in order: the first piece is the page.
    const styled = await page.evaluate(
      (a) => {
        const host = document.getElementById('host')
        const sh = window.mountSnapshot(host, window.snapshotPage(a))
        const p = sh.querySelector('cb-body p')
        return { first: p?.textContent ?? null, color: p ? getComputedStyle(p).color : null, inBody: sh.querySelectorAll('cb-body style').length, last: getComputedStyle(sh.querySelectorAll('cb-body p')[1] ?? p).color }
      },
      { url: 'https://example.com/page', html: `<style>.t{color:rgb(9, 9, 9)}</style><p class="t">first</p><style>.t{color:rgb(1, 2, 3)}${'.u{color:rgb(4, 5, 6)}'.repeat(12000)}</style><p class="u">x</p>`, own: [] },
    )
    assert.deepEqual(styled, { first: 'first', color: 'rgb(1, 2, 3)', inBody: 0, last: 'rgb(4, 5, 6)' })
  })
})

test('AC-1767: an @scope with no start of its own, and :scope outside a started @scope, are dropped', () => {
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /\(scope && \(!start\.trim\(\) \|\| \(!scoped && \/:scope\|&\/i\.test\(start\)\)\)\) \|\|/)
  assert.match(sp, /\(!scoped && !scope && r instanceof CSSStyleRule && \/:scope\/i\.test\(r\.selectorText\)\)/)
  assert.match(sp, /fixRules\(g\.cssRules, \(j\) => g\.deleteRule\(j\), scoped \|\| scope\)/)
  // The comment says what is so: page CSS can style the host, and these rules are why it does not here.
  const ls = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(ls, /an\n\s*@scope with no start, whose :scope is the host/)
})
