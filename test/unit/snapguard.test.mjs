// 1.527 (REQ-S-111): a snapshot never reaches this Mac or its network: by name, by what a name resolves to, through a
// redirect, through the sheets and pictures read here, or through the headless Chrome; a trap link asks first; a
// cache turned off is emptied; the cache's names are salted; snapshot logs carry no address.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { blockedIp, blockedName, snapGuardOf, urlRefusal, guardedGet, guardLookup, snapProxy, chromeErrorPage, PRIVATE_WHY, egoGuardScript, egoSnapshotScript, egoSnapshotResult, EGO_MARK, SnapCache, snapKey, clearSnapCache, snapLogText, chromeArgs } from '../../agent/guard.mjs'
import { privateHost, sneakyLink, linkKind } from '../../ui/src/lib/snapshot-page.ts'

const on = { on: true, allow: [] }
// A resolver of this test: public names that answer this Mac's own addresses, as a DNS of an attacker would.
const names = { 'evil.test': '10.0.0.5', 'rebind.test': '127.0.0.1', 'pub.test': '127.0.0.1', 'wiki.corp.test': '10.1.1.1', 'ok.test': '93.184.216.34', 'six.test': '::1' }
const lookup = (host, opts, cb) => {
  if (typeof opts === 'function') cb = opts
  const a = names[host]
  if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
  const list = [{ address: a, family: net.isIP(a) }]
  return opts?.all ? cb(null, list) : cb(null, a, net.isIP(a))
}

test('AC-1786: this Mac and its networks by address: loopback, private, link-local, CGNAT, 198.18/15, ULA, fec0::/10, IPv4 in IPv6', () => {
  for (const ip of ['127.0.0.1', '127.255.0.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'feff::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::192.168.0.1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:101::1', '[::1]', 'not-an-ip'])
    assert.equal(blockedIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.32.0.1', '198.17.255.255', '198.20.0.1', '192.169.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])
    assert.equal(blockedIp(ip), false, ip)
  for (const n of ['localhost', 'a.localhost', 'printer.local', 'x.localdomain', 'foo.internal', 'foo.lan', 'nas.home.arpa', 'intranet', 'corp-wiki', '127.0.0.1.nip.io', '10-0-0-1.sslip.io', 'localtest.me', 'a.localtest.me', 'lvh.me', ''])
    assert.equal(blockedName(n), true, n)
  for (const n of ['example.com', 'local.example.com', 'internal.example.com', 'lan.example.org', 'nip.io.example.com']) assert.equal(blockedName(n), false, n)
})

test('AC-1786: urlRefusal: by name, by what it resolves to, this site always; agent.json snapshotGuard turns it off or allows names', async () => {
  const own = ['https://bridge.example']
  const r = (u, guard = on) => urlRefusal(u, { guard, own, lookup })
  for (const u of ['http://127.0.0.1:8080/', 'https://127.0.0.1.nip.io/', 'https://localtest.me/', 'https://evil.test/', 'http://rebind.test:3000/x', 'https://six.test/', 'http://[64:ff9b::7f00:1]/', 'http://[fec0::1]/', 'http://198.18.0.1/', 'http://foo.internal/', 'http://foo.lan/', 'http://nas.home.arpa/', 'http://2130706433/', 'http://0x7f.1/'])
    assert.equal(await r(u), PRIVATE_WHY, u)
  assert.equal(await r('https://ok.test/a'), '')
  // A name that does not resolve is not this Mac's network: the browser says so itself.
  assert.equal(await r('https://nowhere.test/'), '')
  assert.equal(await r('https://bridge.example/api/me'), '이 사이트 주소는 스냅샷으로 열지 않아요')
  assert.equal(await r('javascript:alert(1)'), 'http(s) 주소만 스냅샷으로 열 수 있어요')
  // Off, or a name allowed: a company's own pages, drawn on purpose. This site stays refused.
  assert.deepEqual(snapGuardOf({}), { on: true, allow: [] })
  assert.deepEqual(snapGuardOf({ snapshotGuard: false }), { on: false, allow: [] })
  const g = snapGuardOf({ snapshotGuard: { allow: ['wiki.corp.test', '*.lan', 'bad name', 42] } })
  assert.deepEqual(g, { on: true, allow: ['wiki.corp.test', '*.lan'] })
  assert.equal(await r('https://wiki.corp.test/', g), '')
  assert.equal(await r('http://nas.lan/', g), '')
  assert.equal(await r('http://lan/', g), PRIVATE_WHY, '*.lan is the names under it')
  assert.equal(await r('https://evil.test/', g), PRIVATE_WHY)
  assert.equal(await r('http://127.0.0.1/', { on: false, allow: [] }), '')
  assert.equal(await r('https://bridge.example/', { on: false, allow: [] }), '이 사이트 주소는 스냅샷으로 열지 않아요')
})

/** A web server on 127.0.0.1 standing in for the public site (pub.test, allowed) and for this Mac's own service. */
async function servers() {
  const hits = []
  const s = http.createServer((req, res) => {
    hits.push(req.url)
    const port = s.address().port
    if (req.url === '/ok.css') return res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' }), res.end(zlib.gzipSync('p{color:red}'))
    if (req.url === '/r-loop') return res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }), res.end()
    if (req.url === '/r-evil') return res.writeHead(302, { location: 'http://evil.test/x.png' }), res.end()
    if (req.url === '/r-nip') return res.writeHead(301, { location: `http://127.0.0.1.nip.io:${port}/secret` }), res.end()
    if (req.url === '/r-ok') return res.writeHead(302, { location: '/ok.css' }), res.end()
    if (req.url === '/gz-stall') return res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' }), res.write(zlib.gzipSync('p{}'.repeat(5000)).subarray(0, 100))
    if (req.url === '/gz-cut') return res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' }), res.write(zlib.gzipSync('p{}'.repeat(5000)).subarray(0, 100), () => res.destroy())
    if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html><body><p>public page</p></body></html>')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('SECRET of this Mac')
  })
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok))
  return { s, port: s.address().port, hits }
}
const allowPub = { on: true, allow: ['pub.test'] }

test('AC-1786: the sheets and pictures read here: every redirect checked, connected through the check', async (t) => {
  const { s, port, hits } = await servers()
  t.after(() => s.close())
  const get = (u) => guardedGet(u, { guard: allowPub, lookup, ms: 3000 })
  const ok = await get(`http://pub.test:${port}/r-ok`)
  assert.equal(ok.ok, true)
  assert.equal(ok.type, 'text/css')
  assert.equal(ok.body.toString(), 'p{color:red}', 'gzip undone')
  assert.equal(ok.url, `http://pub.test:${port}/ok.css`)
  for (const p of ['/r-loop', '/r-evil', '/r-nip']) await assert.rejects(get(`http://pub.test:${port}${p}`), { code: 'CB_PRIVATE', message: PRIVATE_WHY }, p)
  assert.ok(!hits.includes('/secret'), 'this Mac’s own service was never asked')
  // A compressed answer that stops or is cut ends in time (it waited for good before: the decoder never heard).
  for (const p of ['/gz-stall', '/gz-cut']) {
    const t0 = Date.now()
    await assert.rejects(guardedGet(`http://pub.test:${port}${p}`, { guard: allowPub, lookup, ms: 800 }), p)
    assert.ok(Date.now() - t0 < 3000, `${p} ended in ${Date.now() - t0} ms`)
  }
  // The name checked is the name connected to: one that resolves to this Mac at connection is refused there too.
  await assert.rejects(guardedGet(`http://rebind.test:${port}/secret`, { guard: on, lookup, ms: 3000 }), { code: 'CB_PRIVATE' })
  const err = await new Promise((done) => guardLookup(on, lookup)('rebind.test', {}, done))
  assert.equal(err.code, 'CB_PRIVATE')
  assert.ok(!hits.includes('/secret'))
  // The agent reads them this way, not with fetch's redirect: 'follow'.
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const css = agent.slice(agent.indexOf('async function snapshotCss('), agent.indexOf('const inlineStyles'))
  const img = agent.slice(agent.indexOf('async function snapshotImages('), agent.indexOf('const bg = {'))
  for (const f of [css, img]) {
    assert.match(f, /guardedGet\(/)
    assert.doesNotMatch(f, /redirect: 'follow'|await fetch\(/)
  }
})

test('AC-1786: the headless Chrome goes through a proxy that refuses this Mac’s network (requests and CONNECT)', async (t) => {
  const { s, port, hits } = await servers()
  const proxy = await snapProxy({ guard: allowPub, lookup })
  t.after(async () => (s.close(), await proxy.close()))
  const viaProxy = (url) =>
    new Promise((done, fail) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host } }, (r) => {
        let b = ''
        r.on('data', (c) => (b += c))
        r.on('end', () => done({ status: r.statusCode, body: b }))
      })
      req.on('error', fail)
      req.end()
    })
  assert.equal((await viaProxy(`http://pub.test:${port}/page`)).status, 200)
  for (const u of [`http://127.0.0.1:${port}/secret`, `http://localhost:${port}/secret`, `http://127.0.0.1.nip.io:${port}/secret`, `http://evil.test/`]) {
    const r = await viaProxy(u)
    assert.equal(r.status, 403, u)
    assert.equal(r.body, PRIVATE_WHY)
  }
  const connect = (target) =>
    new Promise((done) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target })
      req.on('connect', (res, sock) => (sock.destroy(), done(res.statusCode)))
      req.on('error', () => done(0))
      req.end()
    })
  assert.equal(await connect(`127.0.0.1:${port}`), 403)
  assert.equal(await connect(`rebind.test:${port}`), 403)
  assert.equal(await connect(`[::1]:${port}`), 403)
  assert.equal(await connect(`pub.test:${port}`), 200)
  // An https request (not a CONNECT) or garbage is answered 400; the proxy (and the agent) go on.
  assert.equal((await viaProxy(`https://pub.test:${port}/page`)).status, 400)
  await new Promise((done) => {
    const sock = net.connect(proxy.port, '127.0.0.1', () => sock.end('NOT HTTP\r\n\r\n'))
    sock.on('close', done)
    sock.on('error', done)
  })
  assert.equal((await viaProxy(`http://pub.test:${port}/page`)).status, 200, 'still serving')
  assert.ok(!hits.includes('/secret'))
  assert.ok(proxy.state.refused >= 7)
  // The agent starts its Chrome on it, loopback included.
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.ok(agent.includes("`--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>'"))
  assert.match(agent, /if \(proxy\.state\.refused && chromeErrorPage\(html\)\) throw/)
})

const CHROME = ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p))
test('AC-1786: a real headless Chrome: a link that redirects to 127.0.0.1 is not opened, and the page says it is Chrome’s error', { skip: !CHROME && 'no Chrome here' }, async (t) => {
  const { s, port, hits } = await servers()
  const proxy = await snapProxy({ guard: allowPub, lookup })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-guard-'))
  t.after(async () => (s.close(), await proxy.close(), fs.rmSync(profile, { recursive: true, force: true })))
  const dump = (url) =>
    new Promise((done) => {
      const args = [...chromeArgs(profile, { mac: process.platform === 'darwin', headless: true }), `--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-gpu', '--virtual-time-budget=3000', '--dump-dom', url]
      const c = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      c.stdout.on('data', (d) => (out += d))
      const timer = setTimeout(() => c.kill('SIGKILL'), 30_000)
      c.on('close', () => (clearTimeout(timer), done(out)))
    })
  const good = await dump(`http://pub.test:${port}/page`)
  assert.match(good, /public page/)
  assert.equal(chromeErrorPage(good), false)
  const before = proxy.state.refused
  const bad = await dump(`http://pub.test:${port}/r-loop`)
  assert.ok(proxy.state.refused > before, 'the redirect was refused')
  assert.doesNotMatch(bad, /SECRET/)
  assert.equal(chromeErrorPage(bad), true, bad.slice(0, 300))
  assert.ok(!hits.includes('/secret'), 'this Mac’s own service was never asked')
})

test('AC-1786: ego lite holds every document request (redirects too) and fails what is refused; its refusal fails the snapshot', async () => {
  const s = egoSnapshotScript({ name: 'n', url: 'https://ok.test/', budgetMs: 1000, gotoMs: 1000, guard: on, own: ['https://bridge.example'] })
  assert.ok(s.includes('Fetch.enable') && s.includes('resourceType: "Document"') && s.includes('Fetch.failRequest') && s.includes('BlockedByClient') && s.includes('Fetch.disable'))
  assert.ok(s.indexOf('const held = await guardPages(page)') < s.indexOf('await held.open('), 'held before the page is opened')
  assert.ok(!s.includes('page.goto('), 'not page.goto: ego answers page.events() only after a goto ends')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  assert.doesNotThrow(() => new AsyncFunction('taskSpace', s))
  const judge = await new AsyncFunction(`${egoGuardScript({ on: true, allow: ['wiki.corp.test'] }, ['https://bridge.example'])}; return judge`)()
  for (const u of ['http://127.0.0.1:8080/', 'https://127.0.0.1.nip.io/', 'http://[::1]/', 'http://[64:ff9b::a00:1]/', 'http://foo.internal/', 'http://localhost/']) assert.equal(await judge(u), PRIVATE_WHY, u)
  assert.equal(await judge('https://bridge.example/x'), '이 사이트 주소는 스냅샷으로 열지 않아요')
  assert.equal(await judge('https://wiki.corp.test/'), '')
  assert.equal(await judge('https://example.com/'), '')
  // A fake ego: requests paused come from page.events(), and each is let go or failed.
  const run = new AsyncFunction(`${egoGuardScript(on, [])}; return { guardPages, refused }`)
  const { guardPages, refused } = await run()
  // What was buffered before is dropped at start.
  const queue = [{ method: 'Fetch.requestPaused', params: { requestId: 'old', request: { url: 'https://example.com/' } } }]
  const calls = []
  const page = {
    events: async () => queue.splice(0),
    cdp: async (m, p) => (m === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'TOP' } } } : (calls.push([m, p?.requestId ?? (p?.patterns ? JSON.stringify(p.patterns) : null), p?.errorReason ?? null]), {})),
  }
  const { stop } = await guardPages(page)
  const paused = (requestId, url, resourceType, frameId = 'TOP') => ({ method: 'Fetch.requestPaused', params: { requestId, resourceType, frameId, request: { url } } })
  // A picture of this Mac's network and a frame of it are refused, but the page goes on: only its own document fails it.
  queue.push(paused('a', 'https://example.com/', 'Document'), { method: 'Network.x' }, paused('i', 'http://192.168.0.1/cgi?reboot', 'Image'), paused('f', 'http://localhost:3000/w', 'Document', 'SUB'))
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(refused.why, '', 'a picture or a frame refused does not fail the page')
  assert.equal(refused.n, 2)
  queue.push(paused('b', 'http://127.0.0.1:3000/admin', 'Document'))
  await new Promise((r) => setTimeout(r, 120))
  queue.push(paused('c', 'http://10.0.0.1/', 'Script'))
  await stop()
  const fetchCalls = calls.filter((c) => c[0].startsWith('Fetch.'))
  assert.deepEqual(fetchCalls[0], ['Fetch.enable', '[{"urlPattern":"*","requestStage":"Request"}]', null], 'every kind of request is held')
  assert.deepEqual(fetchCalls.at(-1), ['Fetch.disable', null, null])
  assert.deepEqual(fetchCalls.slice(1, -1).sort(), [
    ['Fetch.continueRequest', 'a', null],
    ['Fetch.failRequest', 'b', 'BlockedByClient'],
    ['Fetch.failRequest', 'c', 'BlockedByClient'],
    ['Fetch.failRequest', 'f', 'BlockedByClient'],
    ['Fetch.failRequest', 'i', 'BlockedByClient'],
  ])
  assert.equal(refused.why, PRIVATE_WHY)
  // open(): a fake ego that runs a page's commands one at a time, as ego 0.6.2.9 does (seen on creco-macmini): while a
  // document request is held, any command but the answers to it never returns, and page.events() waits behind it.
  const serialEgo = (target) => {
    const q = []
    let held = null
    let stuck = false
    const never = new Promise(() => {})
    const page = {
      calls: [],
      stuck: () => stuck,
      events: async () => (stuck ? never : q.splice(0)),
      cdp: async (m, p) => {
        page.calls.push(m)
        if (m === 'Fetch.continueRequest' || m === 'Fetch.failRequest') {
          const ok = m === 'Fetch.continueRequest'
          held = null
          q.push({ method: 'Page.frameNavigated', params: { frame: { id: 'TOP', url: ok ? target : 'chrome-error://chromewebdata/', ...(ok ? {} : { unreachableUrl: target }) } } }, { method: 'Page.loadEventFired', params: {} })
          return {}
        }
        if (held) return ((stuck = true), never)
        if (m === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TOP' } } }
        if (m === 'Runtime.evaluate' && /location\.href = /.test(p.expression)) {
          // The page before (ego's new tab) says it loaded; the move's document request is held.
          held = { requestId: 'n1' }
          q.push({ method: 'Page.loadEventFired', params: {} }, { method: 'Fetch.requestPaused', params: { requestId: 'n1', resourceType: 'Document', frameId: 'TOP', request: { url: target } } })
          return { result: {} }
        }
        if (m === 'Page.navigate') return ((held = { requestId: 'n1' }), (stuck = true), never)
        return {}
      },
    }
    return page
  }
  const env = async () => new AsyncFunction(`${egoGuardScript(on, [])}; return { guardPages, refused }`)()
  {
    const { guardPages, refused } = await env()
    const p = serialEgo('https://example.com/')
    const held = await guardPages(p)
    await held.open('https://example.com/', 3000)
    await held.quiet(100, 1000)
    await held.narrow()
    await held.stop()
    assert.equal(p.stuck(), false, 'nothing waited behind the held request')
    // Nothing left to keep a process running once it is done (a timer of within() kept ego's node 15 s).
    const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    assert.ok(timers <= 1, `timers left: ${timers}`)
    assert.equal(refused.why, '')
    assert.ok(p.calls.includes('Fetch.continueRequest'))
    assert.ok(!p.calls.includes('Page.navigate'))
  }
  {
    const { guardPages, refused } = await env()
    const p = serialEgo('http://127.0.0.1:3000/')
    const held = await guardPages(p)
    await assert.rejects(held.open('http://127.0.0.1:3000/', 3000), { message: PRIVATE_WHY })
    await held.stop()
    assert.equal(p.stuck(), false)
    assert.equal(refused.why, PRIVATE_WHY)
  }
  {
    // An address that does not load: Chrome's error page, not the page.
    const { guardPages } = await new AsyncFunction(`${egoGuardScript({ on: false, allow: [] }, [])}; return { guardPages, refused }`)()
    const p = serialEgo('https://nowhere.example/')
    const page = { ...p, cdp: async (m, x) => (m === 'Fetch.continueRequest' ? p.cdp('Fetch.failRequest', x) : p.cdp(m, x)) }
    const held = await guardPages(page)
    await assert.rejects(held.open('https://nowhere.example/', 3000), /페이지를 열지 못했어요/)
    await held.stop()
  }
  assert.deepEqual(egoSnapshotResult(`${EGO_MARK}{"refused":"${PRIVATE_WHY}"}`), { refused: PRIVATE_WHY })
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /if \(r\.refused\) throw Object\.assign\(new Error\(r\.refused\), \{ code: 'CB_PRIVATE' \}\)/)
  assert.match(agent, /if \(e\.code === 'CB_PRIVATE'\) return fail\(e\.message\)/)
  assert.match(agent, /const refusal = await urlRefusal\(page\.href, \{ guard, own: \[SITE_ORIGIN\] \}\)\n    if \(refusal\) return fail\(refusal\)/)
})

test('AC-1787: the phone’s privateHost knows .internal, .lan, .home.arpa, nip.io and the like, 198.18/15, fec0::/10, NAT64', () => {
  for (const h of ['foo.internal', 'foo.lan', 'nas.home.arpa', 'a.localhost', 'x.localdomain', 'intranet', '127.0.0.1.nip.io', '10.0.0.1.sslip.io', 'localtest.me', 'lvh.me', '198.18.0.1', '198.19.1.1', '[fec0::1]', '[64:ff9b::7f00:1]', '[64:ff9b::a00:1]', '[2002:7f00:1::]', '[ff02::1]', '224.0.0.1', '[::ffff:0:7f00:1]'])
    assert.equal(privateHost(h), true, h)
  for (const h of ['example.com', 'internal.example.com', '198.20.0.1', '[64:ff9b::808:808]', '[2606:4700::1111]']) assert.equal(privateHost(h), false, h)
  const a = { localName: 'a', parentElement: null, getAttribute: (k) => (k === 'href' ? 'http://foo.internal/' : null), hasAttribute: () => false }
  assert.equal(linkKind(a, 'https://example.com/', []), null)
})

// A tiny element for sneakyLink: its style and boxes.
function box(style, rects, parent = null) {
  const view = { getComputedStyle: (e) => ({ opacity: '1', visibility: 'visible', display: 'inline', ...e._style }) }
  return { _style: style, parentElement: parent, ownerDocument: { defaultView: view }, getClientRects: () => rects }
}
test('AC-1788: a link not seen or covering half the screen is asked about; the sheet goes on the second click only', () => {
  const view = { left: 0, top: 0, right: 400, bottom: 800 }
  const r = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h })
  assert.equal(sneakyLink(box({ opacity: '0' }, [r(0, 0, 400, 800)]), view), true, 'position:fixed;inset:0;opacity:0')
  assert.equal(sneakyLink(box({}, [r(0, 0, 400, 800)]), view), true, 'covers the screen')
  assert.equal(sneakyLink(box({}, [r(0, 0, 400, 400)]), view), true, 'half of it')
  assert.equal(sneakyLink(box({ opacity: '0.05' }, [r(10, 10, 50, 20)]), view), true)
  assert.equal(sneakyLink(box({}, [r(10, 10, 50, 20)], box({ opacity: '0' }, [])), view), true, 'a box around it')
  assert.equal(sneakyLink(box({ visibility: 'hidden' }, [r(10, 10, 50, 20)]), view), true)
  assert.equal(sneakyLink(box({}, [r(10, 10, 120, 20)]), view), false, 'a plain link')
  assert.equal(sneakyLink(box({ opacity: '0.5' }, [r(0, 0, 400, 300)]), view), false)
  // Three boxes of 0.3 make 0.027; a filter with opacity(0) too.
  assert.equal(sneakyLink(box({ opacity: '0.3' }, [r(10, 10, 50, 20)], box({ opacity: '0.3' }, [], box({ opacity: '0.3' }, []))), view), true)
  assert.equal(sneakyLink(box({ filter: 'opacity(0)' }, [r(10, 10, 50, 20)]), view), true)
  // What is on top at the points of the screen, whatever box it is (a child over the screen, display: contents).
  const link = box({}, [])
  const child = { parent: link }
  link.contains = (x) => x === child
  const top = (pick) => ({ elementFromPoint: (x, y) => pick(x, y) })
  assert.equal(sneakyLink(link, view, top(() => child)), true, 'a child over the whole screen')
  assert.equal(sneakyLink(link, view, top((x, y) => (y < 500 ? child : null))), true, 'over half of it')
  assert.equal(sneakyLink(link, view, top((x, y) => (y < 300 ? child : null))), false, 'under half')
  assert.equal(sneakyLink(link, view, top(() => ({}))), false, 'something else on top')
  const page = fs.readFileSync(new URL('../../ui/src/lib/snapshot-page.ts', import.meta.url), 'utf8')
  assert.match(page, /f\(href, kind, kind === 'nav' && sneakyLink\(a, view, root\)\)/)
  const sheet = fs.readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /if \(sneaky && !\(asking && asking\.href === href && Date\.now\(\) - asking\.at < ASK_MS\)\) return setAsk\(\{ href, at: Date\.now\(\) \}\)/)
  assert.match(sheet, /if \(kind === 'nav'\) return goLink\(href, sneaky\)/)
})

test('AC-1789: snapshotCache: false empties the folder at start; the names are this Mac’s HMAC; 1.526’s plain names go', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snapg-')), 'snapshots')
  fs.mkdirSync(dir, { mode: 0o700 })
  // 1.526 left files named by the plain hash: a new salt makes them useless, so they go.
  const old = `${snapKey('https://intra.example/secret')}.json`
  fs.writeFileSync(path.join(dir, old), '{"url":"https://intra.example/secret","html":"<p>secret</p>"}', { mode: 0o600 })
  const c = new SnapCache(dir, { days: 7, mb: 200 })
  c.put('https://example.com/a', { url: 'https://example.com/a', html: '<p>a</p>' })
  const listed = fs.readdirSync(dir).sort()
  assert.ok(!listed.includes(old), 'the plain-hash file went')
  assert.deepEqual(listed, [`${c.keyOf('https://example.com/a')}.json`, 'salt'].sort())
  assert.equal(fs.statSync(path.join(dir, 'salt')).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(path.join(dir, 'salt'), 'utf8'), /^[0-9a-f]{64}$/)
  // Another Mac (another salt) names the same address otherwise: a listing tells nothing without the salt.
  const other = new SnapCache(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snapg-')), 'x'), {})
  other.put('https://example.com/a', { url: 'https://example.com/a', html: '' })
  assert.notEqual(other.keyOf('https://example.com/a'), c.keyOf('https://example.com/a'))
  assert.equal(new SnapCache(dir, {}).get('https://example.com/a').html, '<p>a</p>', 'the salt is kept between starts')
  c.prune()
  assert.ok(fs.existsSync(path.join(dir, 'salt')), 'prune keeps the salt')
  // Turned off: emptied, a link inside removed without following it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'snapg-out-'))
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x')
  fs.symlinkSync(outside, path.join(dir, 'link'))
  assert.equal(clearSnapCache(dir).removed, 3)
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')))
  assert.deepEqual(clearSnapCache(path.join(dir, 'none')), { removed: 0 })
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /const c = snapshotCache\(\)\n {6}if \(c\) c\.prune\(\)\n {6}else clearSnapCache\(SNAP_CACHE_DIR\)/)
})

test('AC-1790: snapshot log lines carry no address', () => {
  assert.equal(snapLogText('ego lite 로 못 그려 Chrome 으로 (net::ERR_NAME_NOT_RESOLVED at https://intra.example/a?b=1)'), 'ego lite 로 못 그려 Chrome 으로 (net::ERR_NAME_NOT_RESOLVED at (주소)')
  for (const t of ['getaddrinfo ENOTFOUND wiki.corp.example', 'see //mail.example.com/inbox', '"https://x.example/a_(b)/secret-path"', 'connect ECONNREFUSED 10.0.0.1:443', 'at [fd00::1]:80']) assert.doesNotMatch(snapLogText(t), /corp|mail\.example|secret|10\.0\.0\.1|fd00/, t)
  assert.equal(snapLogText('ego lite 가 너무 오래 걸려요'), 'ego lite 가 너무 오래 걸려요')
  assert.equal(snapLogText('page.goto: Timeout 15000ms exceeded. navigating to "http://10.0.0.1:8080/x", waiting'), 'page.goto: Timeout 15000ms exceeded. navigating to "(주소)", waiting')
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const fn = agent.slice(agent.indexOf('  async snapshot({ reqId, sid, url, parts, rid })'), agent.indexOf('  async killserver('))
  for (const m of fn.matchAll(/log\('(?:warn|info|error)', 'snapshot', ([^\n]+)/g)) assert.ok(m[1].startsWith('snapLogText(') || !/\$\{(?:e\.message|egoWhy|page|asked|url)/.test(m[1]), m[0])
})
