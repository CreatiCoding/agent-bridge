// 설정 → 기기 (REQ-F-842, AC-1538~AC-1540): the real server over a fresh data folder, Macs played through the bridge
// tab's routes (test/unit/fake-mac.mjs), and a browser on a phone and a PC. Needs playwright (not a dependency):
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-settings-devices.mjs
// The page must be built first (cd ui && corepack yarn build): the server sends ui/dist.
import fs from 'node:fs'
import { startServer } from './unit/server-harness.mjs'
import { mac } from './unit/fake-mac.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT)
const shots = process.env.SHOTS || fs.mkdtempSync('/tmp/cb-shots-')
fs.mkdirSync(shots, { recursive: true })
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const GB = 1024 ** 3
const sys = (cpu, mem, disk, battery) => ({ cpu, cores: 10, memUsed: mem * 16 * GB, memTotal: 16 * GB, disk: { total: 500 * GB, used: (disk / 100) * 500 * GB, avail: ((100 - disk) / 100) * 500 * GB, pct: disk }, ...(battery ? { battery } : {}) })
const ID = (n) => `aaaaaaaa-0000-4000-8000-00000000${String(n).padStart(4, '0')}`

const srv = await startServer()
const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const macs = []
try {
  for (const who of ['boss', 'alice']) await srv.login(who)
  step('기기 준비')
  const studio = await mac(srv, 'boss', ID(1), 'Studio')
  await studio.up({ t: 'health', version: '0.2.0', checks: [], sys: sys(23, 0.62, 97, { present: false, ac: true }) })
  await studio.up({ t: 'tidyReport', report: { at: Date.now(), mode: 'suggest', sessions: [], folders: [{ path: '/Users/x/bridge/works/a', size: 1 }, { path: '/Users/x/bridge/works/b', size: 1 }], transcripts: [{ path: '/Users/x/.claude/projects/a.jsonl', size: 1 }] } })
  const book = await mac(srv, 'boss', ID(2), 'MacBook Air')
  await book.up({ t: 'health', version: '0.2.0', checks: [], sys: sys(71, 0.83, 88, { present: true, ac: false, pct: 16, state: 'discharging', remain: 52, cycles: 300, health: 88 }) })
  const old = await mac(srv, 'boss', ID(3), 'mini')
  await old.up({ t: 'health', version: '0.2.0', checks: [], sys: sys(4, 0.4, 41) })
  old.close()
  const amy = await mac(srv, 'alice', ID(4), 'alice-book')
  await amy.up({ t: 'health', version: '0.2.0', checks: [], sys: sys(12, 0.5, 63, { present: true, ac: true, pct: 80, state: 'charging', remain: 40, cycles: 10, health: 99 }) })
  macs.push(studio, book, amy)
  // The dropped one counts as gone after the link grace.
  for (let i = 0; i < 100; i++) {
    const st = (await srv.api('boss', '/api/state')).json
    if (st?.hosts?.find((h) => h.id === ID(3))?.online === false) break
    await new Promise((r) => setTimeout(r, 200))
  }

  const ctx = async (who, viewport, colorScheme = 'light') => {
    const c = await browser.newContext({ viewport, colorScheme, hasTouch: viewport.width < 744, isMobile: viewport.width < 744 })
    await c.request.get(`${srv.origin}/api/auth/dev?login=${who}`)
    return c
  }
  const errors = []
  const open = async (c, path) => {
    const p = await c.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${srv.origin}${path}`)
    return p
  }
  const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll('.page-tabs, .dev-card')].every((e) => e.scrollWidth <= e.clientWidth + 1))

  step('폰 375 px · 운영자')
  const phone = await ctx('boss', { width: 375, height: 812 })
  let p = await open(phone, '/settings')
  await p.waitForSelector('.dev-card', { timeout: 15000 })
  // Others come from the overview a moment later.
  await p.waitForSelector('#dev-others', { timeout: 15000 })
  ok((await p.locator('.page-tab.on').innerText()).trim() === '기기', '/settings 는 기기 탭')
  const tabs = (await p.locator('.page-tab').allInnerTexts()).map((t) => t.trim())
  ok(JSON.stringify(tabs.slice(0, 4)) === JSON.stringify(['기기', '정리', '세션', '계정']), `탭 줄 앞 넷: ${tabs.slice(0, 4).join(', ')}`)
  ok(!tabs.includes('프롬프트') && !tabs.includes('변경 기록'), '프롬프트·변경 기록 탭은 없음')
  const mine = p.locator('section[aria-labelledby="dev-mine"] .dev-card')
  ok((await mine.count()) === 3, '내 기기 카드 3장')
  ok((await mine.first().locator('.dev-card-name').innerText()) === 'Studio', '연결된 기기 중 디스크가 가장 찬 것이 맨 앞')
  ok((await mine.last().locator('.dev-card-state').innerText()).startsWith('끊김'), '끊긴 기기는 맨 뒤, 끊김')
  const disk = mine.first().locator('[role=meter][aria-label="Studio 디스크"]')
  ok((await disk.getAttribute('aria-valuenow')) === '97' && (await disk.getAttribute('aria-valuetext'))?.startsWith('97%'), '디스크 막대에 값과 aria')
  ok(await disk.evaluate((e) => e.classList.contains('dev-bar-bad')), '95% 이상은 빨강')
  const bookDisk = mine.nth(1).locator('[role=meter][aria-label="MacBook Air 디스크"]')
  ok(await bookDisk.evaluate((e) => e.classList.contains('dev-bar-warn')), '85% 이상은 노랑')
  ok((await mine.first().locator('[role=meter]').count()) === 3, 'CPU·메모리·디스크 세 막대')
  ok((await mine.first().innerText()).includes('배터리 없음'), '배터리 없는 기기')
  ok(await mine.nth(1).locator('.dev-low').count() === 1, '20% 이하·전원 없음 배터리는 빨강')
  const tidy = await mine.first().locator('.dev-foot').innerText()
  ok(/세션 정리\s*제안만\s*내릴 세션 0 · 제안 3/.test(tidy), `세션 정리 요약: ${tidy.replace(/\s+/g, ' ')}`)
  const other = p.locator('section[aria-labelledby="dev-others"] .dev-card')
  ok((await other.count()) === 1 && (await other.first().locator('.dev-card-name').innerText()) === 'alice · alice-book', '다른 사용자 기기는 아래에 따로')
  ok((await other.first().locator('[role=meter]').count()) === 3 && (await other.first().innerText()).includes('배터리 80%'), '다른 사용자 기기도 같은 형식(막대·배터리)')
  ok((await other.first().innerText()).includes('정리 권한을 요청하면 보여요'), '허용 전에는 세션 정리 숫자를 보이지 않음')
  ok(await noSideScroll(p), '375 px 에서 가로 스크롤 없음')
  await p.screenshot({ path: `${shots}/devices-phone-light.png`, fullPage: true })

  step('카드를 키보드로 열기')
  await mine.first().focus()
  await p.keyboard.press('Enter')
  await p.waitForURL(`**/disk?host=${ID(1)}`, { timeout: 10000 })
  await p.waitForSelector(`#disk-${ID(1)} .row`, { timeout: 10000 })
  ok(await p.getByText('Studio 디스크').first().isVisible(), '그 기기의 디스크 관리 칸이 펼쳐짐')
  ok((await p.locator('#disk-' + ID(1)).innerText()).includes('세션 정리 열기'), '그 기기의 세션 정리는 설정 → 세션 정리로 가는 줄')
  await p.screenshot({ path: `${shots}/devices-phone-disk.png` })

  step('예전 주소')
  for (const [path, tab, sel] of [
    ['/settings/prompt', '세션', '#settings-prompt'],
    ['/settings/launch', '세션', '#settings-prompt'],
    ['/settings/changes', '더 보기', '.release'],
    ['/settings/more', '더 보기', '.link-list'],
    ['/disk', null, '.row'],
  ]) {
    await p.goto(`${srv.origin}${path}`)
    await p.waitForSelector(sel, { timeout: 15000 })
    ok(!tab || (await p.locator('.page-tab.on').innerText()).trim() === tab, `${path} 열림${tab ? ` · ${tab} 탭` : ''}`)
    if (path === '/settings/more') ok((await p.locator('.link-row', { hasText: '변경 기록' }).count()) === 1, '더 보기에 변경 기록 줄')
    if (path === '/settings/changes') ok((await p.locator('.link-row').count()) === 0, '변경 기록 화면에는 더 보기의 줄이 섞이지 않음')
  }

  step('폰 375 px · 다크')
  const dark = await ctx('boss', { width: 375, height: 812 }, 'dark')
  p = await open(dark, '/settings')
  await p.waitForSelector('#dev-others', { timeout: 15000 })
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.dev-card')).backgroundColor !== getComputedStyle(document.body).color), '다크에서 카드가 그려짐')
  await p.screenshot({ path: `${shots}/devices-phone-dark.png`, fullPage: true })

  step('넓은 화면 1280 px')
  for (const scheme of ['light', 'dark']) {
    const pc = await ctx('boss', { width: 1280, height: 860 }, scheme)
    p = await open(pc, '/settings')
    await p.waitForSelector('#dev-others', { timeout: 15000 })
    const cols = await p.locator('.dev-grid').first().evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
    if (scheme === 'light') ok(cols >= 2, `넓은 화면은 카드가 ${cols}열`)
    ok(await noSideScroll(p), `1280 px ${scheme} 가로 스크롤 없음`)
    await p.screenshot({ path: `${shots}/devices-wide-${scheme}.png`, fullPage: true })
  }

  step('운영자가 아닌 사람')
  const al = await ctx('alice', { width: 375, height: 812 })
  p = await open(al, '/settings')
  await p.waitForSelector('.dev-card', { timeout: 15000 })
  await p.waitForTimeout(800)
  ok((await p.locator('#dev-others').count()) === 0, '다른 사용자 기기 칸이 없음')
  ok((await p.locator('.dev-card').count()) === 1, '자기 기기만')

  ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`)
  console.log(`\n스크린샷: ${shots}`)
} finally {
  for (const m of macs) m.close()
  await browser.close()
  await srv.stop()
}
