// REQ-F-879: a touch device opens an answer's link in the in-app browser sheet (reading mode, localhost through the
// preview); a computer, a new tab.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { imageUrl, localPort, modeFor, modeOf, opensInApp, readerImg, ruleFor, ruleHost, throughPreview } from '../../ui/src/lib/in-app.ts'
import { snapshotImageUrls, snapshotUserAgent, snapshotSheetUrls, cssReady, cssImports, cssImageUrls, SNAPSHOT_IMG_COUNT, egoSnapshotScript, egoSnapshotResult, EGO_MARK, EGO_QUIET } from '../../agent/guard.mjs'

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
  // Two frames: the localhost preview, and the snapshot as the page looked (1.488), which runs nothing and has no
  // origin of its own (sandbox without allow-scripts or allow-same-origin).
  assert.equal((sheet.match(/<iframe/g) ?? []).length, 2)
  assert.match(sheet, /kind: 'frame', src: throughPreview\(/)
  assert.match(sheet, /sandbox="allow-popups allow-popups-to-escape-sandbox"\s+referrerPolicy="no-referrer"\s+srcDoc=\{v\.doc\}/)
  assert.doesNotMatch(sheet, /allow-scripts|allow-same-origin/)
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
  assert.match(sheet, /post<[^>]+>\(`\/api\/sessions\/\$\{sid\}\/snapshot`, \{ url: abs \}\)/)
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
  assert.deepEqual(egoSnapshotResult(`[ego] hello\n${EGO_MARK}{"url":"https://e/","html":"<p>a</p>","images":{"https://e/a.png":"data:image/png;base64,AA"}}\n`), { url: 'https://e/', html: '<p>a</p>', images: { 'https://e/a.png': 'data:image/png;base64,AA' }, css: {}, width: 0 })
  assert.equal(egoSnapshotResult('no result'), null)
  assert.equal(egoSnapshotResult(`${EGO_MARK}{"html":1}`), null)
})

test('AC-1661: a Mac that does not trust the server takes a snapshot only for the address the device signed, and seals it', async () => {
  const { classOf, rebuild, sealOut } = await import('../../agent/trust.mjs')
  const rule = classOf({ t: 'snapshot' })
  assert.deepEqual(rule, { i: ['sid', 'url'] })
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
  assert.match(sheet, /if \(fromRule\) return snapshotView\(sid, abs\)/)
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
  assert.match(agent, /emit\(\{ t: 'snapshot', reqId, sid, ok: true, url: r\.url, html: r\.html, images, css, width: r\.width \|\| 0, via \}\)/)
  const trust = readFileSync(new URL('../../agent/trust.mjs', import.meta.url), 'utf8')
  assert.match(trust, /css: m\.css \?\? \{\}, width: m\.width \?\? 0/)
  // The screen puts it together with nothing left that runs or fetches.
  const sp = readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(sp, /script, noscript, iframe, frame, frameset, object, embed, applet, portal, base, meta\[http-equiv\]/)
  assert.match(sp, /new DOMParser\(\)\.parseFromString/)
  assert.match(sp, /\/\^on\/i\.test\(a\.name\)/)
  assert.match(sp, /a\.setAttribute\('target', '_blank'\)/)
})
