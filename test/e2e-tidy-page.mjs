// 설정 → 세션 정리 (REQ-F-839, AC-1634): its own tab, one card per host, rows named by their session (the path or id
// only small under it), the actions as before, and 디스크 관리 only linking there. The real server over a fresh data
// folder, a Mac played through the bridge tab's routes, a browser on a phone and a PC. Needs playwright:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-tidy-page.mjs
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
const ID = (n) => `bbbbbbbb-0000-4000-8000-00000000${String(n).padStart(4, '0')}`
const SID = (n) => `cccccccc-0000-4000-8000-00000000${String(n).padStart(4, '0')}`
const DAY = 86_400_000

const srv = await startServer()
const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
let studio
try {
  await srv.login('boss')
  step('기기·세션 준비')
  studio = await mac(srv, 'boss', ID(1), 'Studio')
  const W = '/Users/x/bridge/works/app'
  await studio.up({
    t: 'hello', caps: ['store'], version: '0.2.0', build: 'x', hostId: ID(1), name: 'Studio', kind: 'other', home: '/Users/x', info: {},
    sessions: [
      { id: SID(1), cwd: `${W}/1101-pay`, alive: true, conv: SID(1) },
      { id: SID(2), cwd: `${W}/1102-login`, alive: false, conv: SID(2) },
      { id: SID(3), cwd: `${W}/1103-old`, alive: false, conv: 'conv-old' },
      { id: SID(4), cwd: `${W}/1104-noname`, alive: true, conv: SID(4) },
    ],
  })
  for (const [n, title] of [[1, '결제 화면 고치기'], [2, '로그인 오류 찾기'], [3, '예전 리포트 정리']]) {
    const r = await srv.api('boss', `/api/sessions/${SID(n)}/settings`, { method: 'POST', body: { title } })
    ok(r.status === 200, `제목 ${title}`)
  }
  const now = Date.now()
  await studio.up({
    t: 'tidyReport',
    report: {
      at: now, mode: 'suggest',
      sessions: [
        { sid: SID(1), alive: true, act: 'suggest', idleDays: 4.2, from: 'transcript', why: '사람 입력이 4일 없음' },
        { sid: SID(4), alive: true, act: 'suggest', idleDays: 5, from: 'launch' },
        { sid: SID(2), alive: false, act: null, idleDays: 9, rest: true },
        { sid: SID(3), alive: false, act: null, idleDays: 33, rest: true, close: true },
      ],
      folders: [{ dir: `${W}/1103-old`, path: '~/bridge/works/app/1103-old', size: 2.4e9, lastAt: now - 20 * DAY, why: '14일 넘게 안 씀' }, { dir: `${W}/0901-x`, path: '~/bridge/works/app/0901-x', size: 3e8, lastAt: now - 40 * DAY }],
      transcripts: [{ path: '~/.claude/projects/-Users-x/conv-old.jsonl', conv: 'conv-old', size: 6e7, lastAt: now - 31 * DAY, why: '30일 넘게 안 씀' }],
    },
  })

  const ctx = async (viewport, colorScheme = 'light') => {
    const c = await browser.newContext({ viewport, colorScheme, hasTouch: viewport.width < 744, isMobile: viewport.width < 744 })
    await c.request.get(`${srv.origin}/api/auth/dev?login=boss`)
    return c
  }
  const errors = []
  const open = async (c, path) => {
    const p = await c.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${srv.origin}${path}`)
    return p
  }
  const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll('.page-tabs, .tidy-host, .tidy-row')].every((e) => e.scrollWidth <= e.clientWidth + 1))

  step('폰 375 px · 설정 → 세션 정리')
  const phone = await ctx({ width: 375, height: 812 })
  let p = await open(phone, '/settings/tidy')
  await p.waitForSelector('.tidy-row', { timeout: 15000 })
  ok((await p.locator('.page-tab.on').innerText()).trim() === '정리', '세션 정리 탭이 켜짐')
  const box = p.locator(`#tidy-${ID(1)}`)
  ok((await box.locator('.tidy-host-name').innerText()) === 'Studio', '기기 이름이 카드 머리')
  ok((await box.locator('.dev-mode').innerText()) === '제안만', '정리 방식이 머리에')
  const stats = (await box.locator('.tidy-stat').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  ok(JSON.stringify(stats) === JSON.stringify(['2 내릴 세션', '2 휴면·끝내기 제안', '3 폴더·기록 제안']), `숫자 세 칸: ${stats.join(' | ')}`)
  const names = await box.locator('.tidy-name').allInnerTexts()
  ok(names.includes('결제 화면 고치기') && names.includes('로그인 오류 찾기') && names.includes('예전 리포트 정리'), `세션 이름으로 보임: ${names.join(', ')}`)
  ok(!names.some((n) => n.includes(SID(1))), '세션 id 를 이름 자리에 쓰지 않음')
  ok(names.includes('예전 리포트 정리') && names.filter((n) => n === '예전 리포트 정리').length === 2, '폴더 줄도 그 폴더 세션 이름')
  ok(names.includes('대화 기록 · 예전 리포트 정리'), '대화 기록 줄도 그 세션 이름')
  ok(names.includes('0901-x'), '세션을 모르는 폴더는 폴더 이름')
  ok(names.includes('1104-noname') && !names.some((n) => /^cccccccc/.test(n)), '이름 없는 세션은 id 가 아니라 폴더 이름')
  const ids = await box.locator('.tidy-id').allInnerTexts()
  ok(ids.some((t) => t.includes('app/1101-pay') && t.includes(SID(1).slice(0, 8))), `경로·id 는 작은 줄에: ${ids[0]}`)
  const row1 = box.locator('.tidy-row', { hasText: '결제 화면 고치기' })
  for (const b of ['종료', '자동 종료 안 함']) ok((await row1.getByRole('button', { name: b, exact: true }).count()) === 1, `내릴 세션 줄에 "${b}"`)
  ok((await box.locator('.tidy-row', { hasText: '로그인 오류 찾기' }).getByRole('button', { name: '휴면' }).count()) === 1, '꺼진 줄에 "휴면"')
  ok((await box.locator('.tidy-row', { hasText: '예전 리포트 정리' }).first().getByRole('button', { name: '끝내기' }).count()) === 1, '끝내기 제안 줄에 "끝내기"')
  ok(await noSideScroll(p), '375 px 에서 가로 스크롤 없음')
  await p.screenshot({ path: `${shots}/tidy-phone-light.png`, fullPage: true })

  step('유지 동작 그대로: 자동 종료 안 함')
  await row1.getByRole('button', { name: '자동 종료 안 함' }).click()
  await p.waitForFunction(() => document.body.innerText.includes('자동으로 내리지 않아요'), null, { timeout: 8000 })
  ok(true, '"자동 종료 안 함" 이 세션 설정으로 저장됨(토스트)')

  step('디스크 관리는 링크만')
  p = await open(phone, `/disk?host=${ID(1)}`)
  await p.waitForSelector(`#disk-${ID(1)} .row`, { timeout: 15000 })
  ok((await p.locator('.tidy-host').count()) === 0, '디스크 관리에 세션 정리 목록이 없음')
  await p.getByText('세션 정리 열기').click()
  await p.waitForURL(`**/settings/tidy?host=${ID(1)}`, { timeout: 10000 })
  await p.waitForSelector(`#tidy-${ID(1)} .tidy-row`, { timeout: 15000 })
  ok(true, '링크가 그 기기의 세션 정리로')

  step('폭 360·320 px 탭 줄')
  for (const width of [360, 320]) {
    const c = await ctx({ width, height: 700 })
    const q = await open(c, '/settings/tidy')
    await q.waitForSelector('.tidy-host', { timeout: 15000 })
    const cut = await q.evaluate(() => [...document.querySelectorAll('.page-tab .page-tab-short')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
    ok(await noSideScroll(q), width + ' px 가로 스크롤 없음')
    if (width >= 360) ok(!cut.length, width + ' px 탭 이름이 잘리지 않음' + (cut.length ? ': ' + cut.join(', ') : ''))
    await c.close()
  }

  step('폰 다크 · PC')
  const dark = await ctx({ width: 375, height: 812 }, 'dark')
  p = await open(dark, '/settings/tidy')
  await p.waitForSelector('.tidy-row', { timeout: 15000 })
  await p.screenshot({ path: `${shots}/tidy-phone-dark.png`, fullPage: true })
  const pc = await ctx({ width: 1280, height: 900 })
  p = await open(pc, '/settings/tidy')
  await p.waitForSelector('.tidy-row', { timeout: 15000 })
  ok(await noSideScroll(p), 'PC 에서 가로 스크롤 없음')
  await p.screenshot({ path: `${shots}/tidy-pc.png`, fullPage: true })
  ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
  console.log(`\n스크린샷: ${shots}`)
} finally {
  studio?.close()
  await browser.close()
  await srv.stop?.()
}
