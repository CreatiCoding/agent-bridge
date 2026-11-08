// End-to-end (REQ-F-890, AC-1695): pictures behind a proxy that lets a route through only with a header. The page's
// own fetch carries the header (an init script stands in for what such a setup adds); an <img src> cannot. Starts its
// own server (built from server/) and the fake proxy; sends a report with a picture and opens 지난 제보 보기, whose
// picture must come as a blob: address and be drawn. No agent, no claude session.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [BROWSER=webkit] [CHANNEL=chrome] node test/e2e-api-img.mjs
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pw = await import(process.env.PLAYWRIGHT)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'cb-apiimg-'))
const [SERVER, PROXY] = [4819, 4818]
const SITE = `http://localhost:${PROXY}`
const HEADER = 'x-proxy-auth'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
process.on('exit', () => procs.forEach((p) => p.kill()))

// ---- the proxy: a route of /api/ without the header is refused (sign-in is let through) ----
const refused = []
http
  .createServer((req, res) => {
    const u = new URL(req.url, SITE)
    if (u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/auth/') && req.headers[HEADER] !== 'e2e') {
      refused.push(u.pathname)
      return res.writeHead(403, { 'Content-Type': 'text/plain' }).end('header required')
    }
    const up = http.request({ host: '127.0.0.1', port: SERVER, path: req.url, method: req.method, headers: req.headers }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)))
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  .listen(PROXY)

// ---- the server ----
execFileSync('go', ['build', '-o', path.join(T, 'bridge-server'), '.'], { cwd: path.join(REPO, 'server'), stdio: 'inherit' })
const out = fs.openSync(path.join(T, 'server.log'), 'a')
procs.push(spawn(path.join(T, 'bridge-server'), [], { cwd: REPO, env: { ...process.env, PORT: String(SERVER), BRIDGE_DATA: path.join(T, 'data'), BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'tester' }, stdio: ['ignore', out, out] }))
for (let i = 0; i < 60 && !(await fetch(`http://127.0.0.1:${SERVER}/api/health`).then((r) => r.ok, () => false)); i++) await wait(500)

// A 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const browser = await pw[process.env.BROWSER || 'chromium'].launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
// What a header-signing setup does to the page's requests: every fetch to this origin carries the header.
await ctx.addInitScript((h) => {
  const f = window.fetch.bind(window)
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
    headers.set(h, 'e2e')
    return f(input, { ...init, headers })
  }
}, HEADER)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(SITE)
await page.waitForSelector('.list, .empty, main', { timeout: 20000 })

const sent = await page.evaluate(async (data) => {
  const r = await fetch('/api/reports', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'e2e 그림', images: [{ name: 'a.png', data }] }) })
  return { status: r.status, body: await r.json().catch(() => null) }
}, PNG)
ok(sent.status === 200, `제보를 보냄 (${sent.status} ${JSON.stringify(sent.body)})`)
const list = await page.evaluate(() => fetch('/api/reports').then((r) => r.json()))
const rep = (list.reports ?? list.list ?? list.items ?? []).find?.((r) => r.text === 'e2e 그림')
const imgPath = rep ? `/api/reports/${rep.id}/img/${rep.images[0]}` : null
ok(!!imgPath, `지난 제보에 그림이 있음 (${imgPath})`)

// The bug, shown: an <img> pointed at the route is refused by the proxy.
const plain = await page.evaluate(
  (src) => new Promise((done) => {
    const im = new Image()
    im.onload = () => done('loaded')
    im.onerror = () => done('error')
    im.src = src
  }),
  imgPath,
)
ok(plain === 'error' && refused.includes(imgPath), `<img src> 는 헤더가 없어 프록시가 막음 (${plain})`)

// The fix: the report sheet draws it from a blob: address fetched with the header.
await page.evaluate(() => dispatchEvent(new Event('cb-report'))) // what the 문제 제보 button does
await page.getByText('지난 제보 보기').click()
const drawn = await page
  .waitForFunction(() => [...document.querySelectorAll('.report-past img')].find((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)?.src, null, { timeout: 15000 })
  .then((h) => h.jsonValue(), () => null)
ok(!!drawn, `지난 제보의 그림이 blob: 으로 그려짐 (${drawn})`)
await page.screenshot({ path: path.join(T, 'report-past.png') })
ok(!errors.length, `페이지 오류 없음 ${errors.join(' | ')}`)
console.log(`(기록: ${T})`)
await browser.close()
process.exit()
