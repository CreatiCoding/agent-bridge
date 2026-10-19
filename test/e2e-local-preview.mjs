// End-to-end (AC-1181..AC-1184): a web server started in a session's folder shows as the header's computer button.
// On the session's Mac it opens http://localhost:<port> in a new tab; on another device (a browser without the
// agent) it opens inside the page, through the preview origin (lp.localhost here), with absolute paths, redirects,
// POSTs and the app's cookies working. Needs a server (SITE, default :4699) and an agent; its home as the argument.
//   PLAYWRIGHT=… node test/e2e-local-preview.mjs <agent home>
import fs from 'node:fs'
import http from 'node:http'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
/** Vite for the HMR check: the one the page itself is built with (run from the repository root). */
const VITE = process.env.VITE || `${process.cwd()}/ui/node_modules/vite/bin/vite.js`
const LP = SITE.replace('://', '://lp.')
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent/agent.json`, 'utf8'))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })

const work = `${T}/work-lp`
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const { id } = await (await post('/api/sessions', { hostId: cfg.hostId, cwd: work, model: 'claude-haiku-4-5-20251001', prompt: 'Reply with exactly HI.' })).json()

// The app: a page that loads a script by an absolute path, a link, a redirect to its own full address, a POST, a cookie.
// Started here with the session's folder as its folder (as `npm run dev` there would be).
process.chdir(work)
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'appc=yum; Path=/; Domain=localhost', 'X-Frame-Options': 'DENY' }).end('<!doctype html><title>LP_OK</title><h1>home</h1><a id="about" href="/about">about</a><script src="/app.js"></script>')
  if (u.pathname === '/app.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('document.body.dataset.js = "ran"')
  if (u.pathname === '/about') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>about</title><p id="c">cookie=${req.headers.cookie ?? ''}</p><p id="o">origin-host=${req.headers.host}</p>`)
  if (u.pathname === '/go') return res.writeHead(302, { Location: `http://localhost:${app.address().port}/about` }).end()
  if (u.pathname === '/echo' && req.method === 'POST') {
    let b = ''
    req.on('data', (c) => (b += c))
    return req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ got: b, origin: req.headers.origin })))
  }
  res.writeHead(404).end('nope')
})
await new Promise((r) => app.listen(0, '127.0.0.1', r))
const port = app.address().port
console.log('app port', port)

const page = await ctx.newPage()
await page.goto(`${SITE}/#/s/${id}`)
const btn = page.locator(`button[aria-label^="localhost:${port}"]`)
await btn.waitFor({ timeout: 60000 }).then(
  () => ok(true, '세션 폴더에서 띄운 서버가 컴퓨터 버튼으로 보임'),
  async () => {
    ok(false, '세션 폴더에서 띄운 서버가 컴퓨터 버튼으로 보임')
    const st = await page.evaluate(() => new Promise((ok) => { const es = new EventSource('/api/classic/stream'); es.onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) (es.close(), ok(m.sessions.map((s) => [s.id.slice(0, 8), s.state?.alive, s.state?.servers]))) } }))
    console.log('state:', JSON.stringify(st), 'cwd', process.cwd())
  },
)
ok((await btn.getAttribute('aria-label')).includes('LP_OK'), `버튼 설명에 제목: ${await btn.getAttribute('aria-label')}`)
// A server in a folder inside the session's that is no git repository of its: not the session's (AC-1186).
fs.mkdirSync(`${work}/sub`, { recursive: true })
const { spawn } = await import('node:child_process')
const sub = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('<title>SUB</title>')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: `${work}/sub`, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
const subPort = Number(await new Promise((r) => sub.stdout.once('data', (d) => r(String(d).trim()))))
await page.waitForTimeout(25000)
const listed = await page.evaluate(async (sid) => {
  const st = await new Promise((ok) => { const es = new EventSource('/api/classic/stream'); es.onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) (es.close(), ok(m)) } })
  return st.sessions.find((x) => x.id === sid)?.state?.servers?.map((x) => x.port) ?? []
}, id)
ok(!listed.includes(subPort) && listed.includes(port), `하위 폴더(git 아님) 서버 ${subPort} 는 안 잡힘: ${JSON.stringify(listed)}`)
process.kill(-sub.pid)

// The same Mac (this browser has the agent): a new tab on localhost itself.
const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), btn.click()])
await popup.waitForLoadState().catch(() => {})
ok(popup.url() === `http://localhost:${port}/`, `같은 맥은 localhost 를 새 탭으로: ${popup.url()}`)
await popup.close()
// The same Mac can still choose the page inside this one (AC-1194).
await btn.click({ button: 'right' })
await page.locator('.menu-item', { hasText: '인앱으로 열기' }).click()
await page.waitForSelector('.preview-frame', { timeout: 15000 }).then(
  () => ok(true, '같은 맥도 메뉴의 "인앱으로 열기" 로 시트'),
  () => ok(false, '같은 맥도 메뉴의 "인앱으로 열기" 로 시트'),
)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// Another device: no agent in this browser, so the page opens inside the site.
const other = await browser.newContext({ viewport: { width: 390, height: 844 } })
await other.request.get(`${SITE}/api/auth/dev?login=tester`)
const phone = await other.newPage()
await phone.goto(`${SITE}/#/s/${id}`)
const btn2 = phone.locator(`button[aria-label^="localhost:${port}"]`)
await btn2.waitFor({ timeout: 30000 })
// A phone has no right-click: a long press opens the same menu, and the tap that ends it opens nothing.
await btn2.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true })
await phone.waitForTimeout(650)
await btn2.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true })
const pressed = await phone.locator('.menu-item').allTextContents()
ok(pressed.some((t) => t.includes('끄기')) && pressed.some((t) => t.includes('인앱으로 열기')) && pressed.some((t) => t.includes('새 탭으로 열기')), `폰 길게 누르기 메뉴: ${pressed.join(' / ')}`)
// Another device can choose a tab of its own: the preview address (AC-1194).
const [tabbed] = await Promise.all([other.waitForEvent('page', { timeout: 10000 }), phone.locator('.menu-item', { hasText: '새 탭으로 열기' }).click()])
await tabbed.waitForURL(/\/t\//, { timeout: 15000 }).catch(() => {})
ok(tabbed.url().startsWith(`${LP}/t/`) && (await tabbed.title()) === 'LP_OK', `다른 기기의 "새 탭으로 열기" 는 미리보기 주소 탭: ${tabbed.url().slice(0, 40)}…`)
await tabbed.close()
await phone.locator('.menu-item').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => phone.keyboard.press('Escape'))
await phone.waitForTimeout(300)
await btn2.click()
await phone.waitForSelector('.preview-frame', { timeout: 15000 })
const src = await phone.locator('.preview-frame').getAttribute('src')
ok(src.startsWith(`${LP}/t/`), `다른 기기는 미리보기 출처의 iframe: ${src.slice(0, 40)}…`)
const frame = phone.frameLocator('.preview-frame')
await frame.locator('h1').waitFor({ timeout: 20000 })
ok((await frame.locator('h1').textContent()) === 'home', '프레임에 앱 첫 화면')
await phone.waitForFunction(() => true)
const fr = phone.frames().find((f) => f.url().startsWith(LP))
await fr.waitForFunction(() => document.body.dataset.js === 'ran', null, { timeout: 15000 }).then(
  () => ok(true, '절대 경로(/app.js) 스크립트가 실행됨'),
  () => ok(false, '절대 경로(/app.js) 스크립트가 실행됨'),
)
const echo = await fr.evaluate(() => fetch('/echo', { method: 'POST', body: 'ping-1' }).then((r) => r.json()))
ok(echo.got === 'ping-1' && echo.origin === `http://localhost:${port}`, `POST 본문과 Origin 이 앱에 그대로: ${JSON.stringify(echo)}`)
await frame.locator('#about').click()
await frame.locator('#c').waitFor({ timeout: 15000 }).then(() => ok(true, '프레임 안의 링크(/about)로 이동'), () => ok(false, '프레임 안의 링크(/about)로 이동'))
// Cookies, in a tab of its own (새 탭으로): here lp.localhost and localhost are two sites, so the frame's cookies are
// third-party; lp.bridge.creco.dev and bridge.creco.dev are one site and the frame keeps them too.
const tab = await other.newPage()
await tab.goto(src)
await tab.goto(`${src}about`)
const cookieText = await tab.locator('#c').textContent()
ok(cookieText.includes('appc=yum') && !cookieText.includes('lp_t='), `앱 쿠키가 돌아가고 미리보기 쿠키는 숨김: ${cookieText}`)
const go = await fr.evaluate(() => fetch('/go').then((r) => r.url))
ok(/\/t\/[\w-]+\.[\w-]+\/about$/.test(new URL(go).pathname), `localhost 로 가는 리다이렉트가 미리보기 주소로: ${new URL(go).pathname.slice(-12)}`)
await phone.screenshot({ path: `${T}/local-preview.png` })

// The preview origin is not the site: no API there, and a made-up address is refused.
const lpApi = await phone.evaluate((u) => fetch(u).then((r) => r.status), `${LP}/api/health`).catch(() => 'blocked')
ok(lpApi !== 200, `미리보기 출처에 사이트 API 없음 (${lpApi})`)
const bad = await other.newPage()
const r = await bad.goto(`${LP}/t/eyJ1IjoiYSJ9.AAAAAAAAAAAAAAAAAAAAAA/`)
ok(r.status() === 403, `서명 없는 주소는 403 (${r.status()})`)
// Only the session's own servers: any other port is refused.
const refused = await post(`/api/sessions/${id}/preview`, { port: cfg.port })
ok(refused.status() === 404, `세션 서버가 아닌 포트는 거절 (${refused.status()})`)

// The server stops: the button goes.
app.close()
app.closeAllConnections?.()
await btn.waitFor({ state: 'detached', timeout: 40000 }).then(
  () => ok(true, '서버가 꺼지면 버튼이 사라짐'),
  () => ok(false, '서버가 꺼지면 버튼이 사라짐'),
)
// Right-click → 끄기 → 확인: the Mac ends the server process and the button goes (AC-1189).
const doomed = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('<title>DOOMED</title>')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'] })
const doomedPort = Number(await new Promise((r) => doomed.stdout.once('data', (d) => r(String(d).trim()))))
const exited = new Promise((r) => doomed.once('exit', (code, signal) => r(signal || code)))
const btn3 = page.locator(`button[aria-label^="localhost:${doomedPort}"]`)
await btn3.waitFor({ timeout: 40000 })
await btn3.click({ button: 'right' })
const items = await page.locator('.menu-item').allTextContents()
ok(items.some((t) => t.includes('열기')) && items.some((t) => t.includes('끄기')), `우클릭 메뉴에 열기·끄기: ${items.join(' / ')}`)
await page.locator('.menu-item', { hasText: '끄기' }).click()
await page.getByRole('button', { name: '끄기', exact: true }).click()
const how = await Promise.race([exited, new Promise((r) => setTimeout(() => r('살아 있음'), 10000))])
ok(how === 'SIGTERM', `서버 프로세스가 SIGTERM 으로 끝남 (${how})`)
await btn3.waitFor({ state: 'detached', timeout: 15000 }).then(
  () => ok(true, '끈 서버의 버튼이 바로 사라짐'),
  () => ok(false, '끈 서버의 버튼이 바로 사라짐'),
)

// HMR through the preview (AC-1195): a real Vite dev server in the session's folder; a module changed on the Mac
// shows on the other device without the page reloading.
fs.writeFileSync(`${work}/index.html`, '<!doctype html><title>VITE_HMR</title><div id="v"></div><script type="module" src="/main.js"></script>')
fs.writeFileSync(`${work}/msg.js`, "export const msg = 'one'\n")
fs.writeFileSync(`${work}/main.js`, "import { msg } from './msg.js'\nconst show = (m) => (document.getElementById('v').textContent = m)\nshow(msg)\nimport.meta.hot?.accept('./msg.js', (m) => show(m.msg))\n")
const free = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const vite = spawn(process.execPath, [VITE, '--host', '127.0.0.1', '--port', String(free), '--strictPort'], { cwd: work, stdio: 'ignore' })
await page.locator(`button[aria-label^="localhost:${free}"]`).waitFor({ timeout: 60000 })
const { url: viteUrl } = await (await post(`/api/sessions/${id}/preview`, { port: free })).json()
const hmr = await other.newPage()
await hmr.goto(viteUrl)
await hmr.waitForFunction(() => document.getElementById('v')?.textContent === 'one', null, { timeout: 30000 }).then(
  () => ok(true, 'Vite 앱이 미리보기로 뜸'),
  () => ok(false, 'Vite 앱이 미리보기로 뜸'),
)
await hmr.evaluate(() => (window.__same = true))
await hmr.waitForTimeout(1500)
fs.writeFileSync(`${work}/msg.js`, "export const msg = 'two'\n")
await hmr.waitForFunction(() => document.getElementById('v')?.textContent === 'two', null, { timeout: 20000 }).then(
  async () => ok(await hmr.evaluate(() => window.__same === true), '맥에서 파일을 고치면 다른 기기 화면이 새로고침 없이 바뀜(HMR)'),
  async () => ok(false, `맥에서 파일을 고치면 다른 기기 화면이 새로고침 없이 바뀜(HMR): ${await hmr.evaluate(() => document.getElementById('v')?.textContent)}`),
)
vite.kill()
await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await browser.close()
