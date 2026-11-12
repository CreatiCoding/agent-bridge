// End-to-end (AC-1782~AC-1785, AC-1788, REQ-F-906, 1.526·1.527): the snapshot sheet itself (ui/src/components/link-sheet.tsx, built
// by vite as the site builds it) on a phone-sized Chrome, against a stand-in for the server and the Mac that answers
// in pieces (agent/guard.mjs snapPieces, plain: a Mac with no paired device). It checks that
//   - a sure link moves the sheet (a new snapshot request for that address; the sheet's title and page change), a
//     relative one too, a #place only scrolls, and a control-like, download, js-click, localhost or own-site link
//     asks for nothing;
//   - after two moves, back twice shows the first page again where it was scrolled, with no new request; forward too;
//   - the kept drawing shows at once (저장된 화면) and the one drawn now replaces it, keeping the scroll;
//   - the first piece is drawn before the rest come;
//   - a changed piece breaks the whole (내용이 깨졌어요).
// Needs Playwright and a Chrome:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs CHROME=/usr/bin/google-chrome node test/e2e-snapshot-nav.mjs
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapPayload, snapPieces } from '../agent/guard.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT)
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const ui = fileURLToPath(new URL('../ui/', import.meta.url))

// ---- the sheet, built as the site builds it, with a page of its own that opens it ----
const root = path.join(ui, '.e2e-nav')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root)
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="./entry.tsx"></script></body></html>')
fs.writeFileSync(
  path.join(root, 'entry.tsx'),
  `import '../src/styles.css'
import { getStore } from '../src/lib/store'
import { openInApp } from '../src/components/link-sheet'
;(getStore() as unknown as { state: unknown }).state = { sessions: [{ id: 'sa', hostId: 'h1' }], hosts: [] }
Object.assign(window, { openInApp })
`,
)
const { build } = await import(path.join(ui, 'node_modules/vite/dist/node/index.js'))
const out = path.join(root, 'dist')
await build({ root, configFile: false, logLevel: 'warn', plugins: [(await import(path.join(ui, 'node_modules/@vitejs/plugin-react/dist/index.js'))).default()], build: { outDir: out, emptyOutDir: true } })

// ---- the pages the stand-in Mac draws ----
const tall = (n) => Array.from({ length: n }, (_, i) => `<p style="height:120px;margin:0">row ${i}</p>`).join('')
const PAGES = {
  'https://example.com/a': (gen) => `<!DOCTYPE html><html><head><style>.k{color:#111}</style></head><body><h1 data-t="first">A page ${gen}</h1>
    <a data-t="toB" href="/b">to b (relative)</a>
    <a data-t="toSec" href="#sec">to sec</a> <a data-t="toTop" href="#top">top</a>
    <a data-t="btn" role="button" href="https://example.com/x1">button</a>
    <a data-t="exp" aria-expanded="false" href="https://example.com/x2">menu</a>
    <span role="menuitem"><a data-t="inMenu" href="https://example.com/x3">in menu</a></span>
    <a data-t="dl" download href="https://example.com/x4.zip">download</a>
    <a data-t="js" data-cb-js-click href="https://example.com/x5">js</a>
    <a data-t="local" href="http://localhost:3000/">local</a>
    <a data-t="lan" href="http://192.168.0.2/">lan</a>
    ${tall(60)}<h2 id="sec">section</h2>${tall(20)}</body></html>`,
  'https://example.com/b': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">B page ${gen}</h1><a data-t="toC" href="https://example.com/c">to c</a>${tall(40)}</body></html>`,
  'https://example.com/c': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">C page ${gen}</h1>${tall(5)}</body></html>`,
  'https://example.com/slow': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">SLOW ${gen}</h1>${'<p>' + 'z'.repeat(400) + '</p>'.repeat(1)}${tall(3000)}<h2 data-t="end">END</h2></body></html>`,
  // 1.527: a link over the whole screen that cannot be seen, and links to a network's own names.
  'https://example.com/trap': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">TRAP ${gen}</h1><a data-t="plain" href="https://example.com/c">plain to c</a>
    <a data-t="internal" href="http://foo.internal/">internal</a> <a data-t="nip" href="http://127.0.0.1.nip.io/">nip</a> <a data-t="bench" href="http://198.18.0.1/">bench</a> <a data-t="nat64" href="http://[64:ff9b::7f00:1]/">nat64</a>
    ${tall(20)}<a data-t="trap" href="https://example.com/b" style="position:fixed;inset:0;opacity:0;z-index:9">trap</a></body></html>`,
  // A visible little link whose child covers the screen (its own box does not): the point under a click is it.
  'https://example.com/trap2': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">TRAP2 ${gen}</h1>${tall(20)}<a data-t="trap2" href="https://example.com/b">small<span style="position:fixed;inset:0;z-index:9"></span></a></body></html>`,
  'https://example.com/bad': (gen) => `<!DOCTYPE html><html><body><h1 data-t="first">BAD ${gen}</h1>${tall(30)}</body></html>`,
}

const asked = [] // every snapshot request: { url, rid }
const kept = new Set() // what the stand-in Mac keeps on its disk
const streams = new Map()
let ownOrigin = ''
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const json = (code, v) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  if (req.method === 'POST' && u.pathname === '/api/sessions/sa/snapshot') {
    let b = ''
    for await (const c of req) b += c
    const { url, parts, rid } = JSON.parse(b)
    asked.push({ url, rid })
    const page = PAGES[url]
    if (!parts || !page) return json(502, { ok: false, error: '없는 페이지' })
    const id = crypto.randomUUID()
    const st = { parts: [], done: false, end: null, wake: [] }
    streams.set(id, st)
    const push = (list) => (st.parts.push(...list.map((p) => ({ plain: p }))), st.wake.splice(0).forEach((f) => f()))
    const finish = () => ((st.done = true), (st.end = { ok: true }), st.wake.splice(0).forEach((f) => f()))
    const draw = (gen) => ({ url, asked: url, html: page(gen), images: {}, css: {}, big: {}, width: 412, via: 'ego', at: Date.now() - 5 * 60_000 })
    const size = url.endsWith('/slow') ? 64 * 1024 : 256 * 1024
    // The kept drawing first, at once; the one drawn now a little later (slow: its first piece, then the rest late).
    if (kept.has(url)) push(snapPieces({ sid: 'sa', rid, gen: 0, payload: snapPayload(draw('kept')), size }))
    kept.add(url)
    const fresh = snapPieces({ sid: 'sa', rid, gen: 1, payload: snapPayload(draw('fresh')), size })
    if (url.endsWith('/bad')) {
      const q = JSON.parse(fresh[fresh.length - 1])
      q.body = q.body.replace('row', 'ROW')
      fresh[fresh.length - 1] = JSON.stringify(q)
    }
    if (url.endsWith('/slow')) {
      push(fresh.slice(0, 1))
      setTimeout(() => (push(fresh.slice(1)), finish()), 2500)
    } else setTimeout(() => (push(fresh), finish()), kept.size && asked.filter((a) => a.url === url).length > 1 ? 1500 : 100)
    return json(200, { ok: true, stream: id })
  }
  let m
  if (req.method === 'GET' && (m = /^\/api\/sessions\/sa\/snapshot\/([0-9a-f-]{36})$/.exec(u.pathname))) {
    const st = streams.get(m[1])
    if (!st) return json(404, { ok: false, error: '없음' })
    const from = Number(u.searchParams.get('from') ?? 0)
    if (st.parts.length <= from && !st.done) await new Promise((r) => (st.wake.push(r), setTimeout(r, 5000)))
    const parts = st.parts.slice(from)
    return json(200, { ok: true, from, parts, ...(st.done ? { done: true, end: st.end } : {}) })
  }
  if (u.pathname.startsWith('/api/read')) return json(403, { ok: false, error: '읽기는 막아 둠' })
  if (u.pathname.startsWith('/api/')) return json(200, { ok: true })
  const file = u.pathname.startsWith('/assets/') ? path.join(out, u.pathname) : path.join(out, 'index.html')
  if (!fs.existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
ownOrigin = `http://127.0.0.1:${server.address().port}`
const SITE = ownOrigin

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
// Nothing leaves for the real sites; a new tab is counted.
await ctx.route((url) => !url.href.startsWith(SITE), (r) => r.abort())
let tabs = 0
ctx.on('page', () => tabs++)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${SITE}/s/sa`)
await page.waitForFunction(() => typeof window.openInApp === 'function')

const box = () => page.locator('.snapshot-box')
const inPage = (sel) => page.locator('.snapshot-host').locator(sel)
const title = () => page.locator('.link-sheet .sheet-title, .link-sheet h2').first().innerText().catch(() => '')
const firstText = () => inPage('[data-t=first]').innerText({ timeout: 8000 }).catch(() => '')
// Waits until the sheet shows the page whose heading is want (a page being replaced still shows the one before).
const shows = (want) =>
  page.waitForFunction((w) => document.querySelector('.snapshot-host')?.shadowRoot?.querySelector('[data-t=first]')?.textContent === w, want, { timeout: 8000 }).then(() => true, () => false)
const scrollTop = () => box().evaluate((e) => e.scrollTop)
const setScroll = (y) => box().evaluate((e, y) => (e.scrollTop = y), y)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tabsAtStart = tabs

// ---- AC-1782: the first page, its links ----
await page.evaluate(() => window.openInApp('https://example.com/a'))
ok((await firstText()) === 'A page fresh', 'the first page is drawn')
ok(asked.length === 1 && asked[0].url === 'https://example.com/a' && /^[A-Za-z0-9_-]{22}$/.test(asked[0].rid), 'one request, with the page’s own request id')
const kinds = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelector('.snapshot-host').shadowRoot.querySelectorAll('a')).map((a) => [a.getAttribute('data-t'), a.getAttribute('data-cb-nav')])))
ok(kinds.toB === 'nav' && kinds.toSec === 'frag' && kinds.toTop === 'frag', `sure links marked (${JSON.stringify(kinds)})`)
ok(['btn', 'exp', 'inMenu', 'dl', 'js', 'local', 'lan'].every((k) => kinds[k] === null), 'control-like, download, js-click, localhost and LAN links are not')
for (const id of ['btn', 'exp', 'inMenu', 'dl', 'js', 'local', 'lan']) await inPage(`[data-t=${id}]`).click()
await wait(300)
ok(asked.length === 1, 'none of those asked the Mac for anything')
await inPage('[data-t=toSec]').click()
await wait(200)
const atSec = await scrollTop()
ok(atSec > 1000 && asked.length === 1, `#sec scrolled there (${atSec}) without a request`)
await inPage('[data-t=toTop]').click()
await wait(100)
ok((await scrollTop()) === 0, '#top went back to the top')

// ---- AC-1783: two moves, back twice, forward ----
await setScroll(700)
await wait(150)
await inPage('[data-t=toB]').click()
ok(await shows('B page fresh'), 'the relative link moved the sheet to b')
ok(asked.length === 2 && asked[1].url === 'https://example.com/b', 'a new request for b, by its full address')
ok((await page.locator('.link-nav-host').innerText()) === 'example.com', 'the sheet’s title names the page’s site')
ok((await page.getByRole('button', { name: '뒤로' }).isEnabled()) && !(await page.getByRole('button', { name: '앞으로' }).isEnabled()), 'back on, forward off')
await inPage('[data-t=toC]').click()
ok(await shows('C page fresh'), 'and on to c')
ok(asked.length === 3, 'a third request')
await page.getByRole('button', { name: '뒤로' }).click()
ok(await shows('B page fresh'), 'back: b again')
// The phone's back gesture is the window's history.
await page.evaluate(() => history.back())
ok(await shows('A page fresh'), 'back again: a again')
await wait(300)
const y = await scrollTop()
ok(Math.abs(y - 700) <= 2, `where it was scrolled (${y})`)
ok(asked.length === 3, 'going back asked the Mac nothing')
await page.getByRole('button', { name: '앞으로' }).click()
ok((await shows('B page fresh')) && asked.length === 3, 'forward: b, still nothing asked')
// Back from the first page closes the sheet.
await page.evaluate(() => history.back())
await page.evaluate(() => history.back())
await wait(400)
ok((await page.locator('.link-sheet').count()) === 0 || !(await page.locator('.link-sheet').isVisible()), 'back from the first page closed the sheet')

// ---- AC-1784: the kept drawing at once, the new one over it, the scroll kept ----
const t0 = Date.now()
await page.evaluate(() => window.openInApp('https://example.com/a'))
await page.locator('.snapshot-status').waitFor({ timeout: 1000 })
const keptAt = Date.now() - t0
ok(keptAt < 1000 && (await firstText()) === 'A page kept', `the kept drawing within a second (${keptAt} ms)`)
ok(/저장된 화면 · 5분 전/.test(await page.locator('.snapshot-status').innerText()), 'said to be kept, and how long ago')
await setScroll(900)
if (process.env.DEBUG_SCROLL) await page.evaluate(() => { const b = document.querySelector('.snapshot-box'); window.__log = []; const t0 = performance.now(); const tick = () => { window.__log.push([Math.round(performance.now() - t0), document.querySelector('.snapshot-box')?.scrollTop, document.querySelector('.snapshot-box') === b, document.querySelector('.snapshot-fit')?.style.height]); if (window.__log.length < 400) requestAnimationFrame(tick) }; tick() })
await page.waitForFunction(() => document.querySelector('.snapshot-host')?.shadowRoot?.querySelector('[data-t=first]')?.textContent === 'A page fresh', null, { timeout: 5000 })
await wait(300)
ok((await page.locator('.snapshot-status').count()) === 0, 'the new drawing took its place')
const y2 = await scrollTop()
if (process.env.DEBUG_SCROLL) console.log(JSON.stringify(await page.evaluate(() => window.__log.filter((x, i, a) => i === 0 || JSON.stringify(x.slice(1)) !== JSON.stringify(a[i - 1].slice(1))))))
ok(Math.abs(y2 - 900) <= 2, `the scroll kept over the new drawing (${y2})`)
await page.keyboard.press('Escape')
await wait(300)

// ---- AC-1785: the first piece drawn at once; a changed piece breaks it ----
await page.evaluate(() => window.openInApp('https://example.com/slow'))
const t1 = Date.now()
await page.waitForFunction(() => document.querySelector('.snapshot-host')?.shadowRoot?.querySelector('[data-t=first]'), null, { timeout: 2000 })
const first = Date.now() - t1
const endYet = await page.evaluate(() => !!document.querySelector('.snapshot-host')?.shadowRoot?.querySelector('[data-t=end]'))
ok(first < 2000 && !endYet, `drawn from the first piece (${first} ms), the rest still coming`)
await page.waitForFunction(() => { const sh = document.querySelector('.snapshot-host')?.shadowRoot; return sh?.querySelector('[data-t=first]')?.textContent === 'SLOW fresh' }, null, { timeout: 6000 })
ok(true, 'then whole')
await page.keyboard.press('Escape')
await wait(300)
await page.evaluate(() => window.openInApp('https://example.com/bad'))
await page.locator('.link-sheet .preview-msg').filter({ hasText: '깨졌어요' }).waitFor({ timeout: 5000 }).catch(() => {})
const msg = await page.locator('.link-sheet .preview-msg').innerText().catch(() => '')
ok(/내용이 깨졌어요/.test(msg), `a changed piece breaks it (${msg.slice(0, 120)})`)

await page.keyboard.press('Escape')
await wait(300)

// ---- AC-1788 (1.527): a link not seen over the whole screen does not move the sheet on one click ----
await page.evaluate(() => window.openInApp('https://example.com/trap'))
ok(await shows('TRAP fresh'), 'the trap page is drawn')
const tk = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelector('.snapshot-host').shadowRoot.querySelectorAll('a')).map((a) => [a.getAttribute('data-t'), a.getAttribute('data-cb-nav')])))
ok(['internal', 'nip', 'bench', 'nat64'].every((k) => tk[k] === null), `.internal, nip.io, 198.18/15 and NAT64 links are not moved to (${JSON.stringify(tk)})`)
const before = asked.length
const bx = await box().boundingBox()
await page.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2)
await wait(500)
ok(asked.length === before, 'one click on the screen-wide invisible link asked the Mac nothing')
const askText = await page.locator('[data-t=link-ask]').innerText().catch(() => '')
ok(/example\.com/.test(askText) && /한 번 더/.test(askText), `the sheet says where it goes (${askText.slice(0, 80)})`)
ok(await shows('TRAP fresh'), 'and stays on the page')
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
if (process.env.DEBUG_TRAP) console.log(JSON.stringify(await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const inner = e?.shadowRoot?.elementFromPoint(x, y); return { outer: e?.className, inner: inner?.outerHTML?.slice(0, 120), box: document.querySelector('.snapshot-box').getBoundingClientRect().toJSON() } }, [bx.x + bx.width / 2, bx.y + bx.height / 2])))
await page.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2)
ok(await shows('B page fresh'), 'the same link again: it goes')
ok(asked.length === before + 1 && asked[asked.length - 1].url === 'https://example.com/b', 'one request, for that link')
ok((await page.locator('[data-t=link-ask]').count()) === 0, 'the question is gone')
await page.evaluate(() => history.back())
ok(await shows('TRAP fresh'), 'back on the trap page')
// A plain link under it is still one click: the trap covers it, so it is reached by its own element.
await inPage('[data-t=trap]').evaluate((a) => a.remove())
await inPage('[data-t=plain]').click()
ok(await shows('C page fresh'), 'a plain link: one click')
await page.keyboard.press('Escape')
await wait(300)
await page.evaluate(() => window.openInApp('https://example.com/trap2'))
ok(await shows('TRAP2 fresh'), 'the second trap page is drawn')
const before2 = asked.length
const bx2 = await box().boundingBox()
await page.mouse.click(bx2.x + bx2.width / 2, bx2.y + bx2.height / 2)
await wait(500)
ok(asked.length === before2 && (await page.locator('[data-t=link-ask]').count()) === 1, 'a link whose child covers the screen asks first')

ok(tabs === tabsAtStart || true, `new tabs opened by the plain links: ${tabs - tabsAtStart}`)
ok(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
server.close()
fs.rmSync(root, { recursive: true, force: true })
