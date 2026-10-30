// 액션 버스 (REQ-F-822): order, changed arguments, cancel, time limits, the default run at most once, sync rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { after, around, before, dispatch, isCancel, onCancelShown, setDefault, actionLog, ACTIONS } from '../../ui/src/lib/actions.ts'

const shown = []
onCancelShown((r) => shown.push(r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('훅이 없으면 기본 구현의 결과 그대로, 실패는 원래 오류로', async () => {
  let calls = 0
  setDefault('message.send', (a) => (calls++, { ok: true, text: a.text }))
  assert.deepEqual(await dispatch('message.send', { sid: 's', text: 'hi', kind: 'text', images: [], videos: [] }), { ok: true, text: 'hi' })
  assert.equal(calls, 1)
  const err = new Error('data.missing')
  setDefault('session.create', () => Promise.reject(err))
  await assert.rejects(dispatch('session.create', { hostId: 'h' }), (e) => e === err)
})

test('순서: priority 큰 것이 바깥, 같으면 owner 순, 기본 구현이 가장 안쪽. before 는 인자를 바꾸고 after 는 성공에만', async () => {
  const seen = []
  setDefault('composer.submit', (a) => (seen.push(`default:${a.text}`), { sent: true }))
  const offs = [
    before('composer.submit', (a) => (seen.push('b-ext'), { ...a, text: `${a.text}?` }), { owner: 'b-ext' }),
    before('composer.submit', (a) => (seen.push('a-ext'), { ...a, text: a.text.trim() }), { owner: 'a-ext' }),
    around('composer.submit', async (a, next) => (seen.push('outer'), next(a)), { priority: 5 }),
    after('composer.submit', (a, r) => seen.push(`after:${a.text}:${r.sent}`)),
  ]
  assert.deepEqual(await dispatch('composer.submit', { sid: 's', text: ' 안녕 ' }), { sent: true })
  assert.deepEqual(seen, ['outer', 'a-ext', 'b-ext', 'default:안녕?', 'after:안녕?:true'])
  offs.forEach((f) => f())
})

test('취소: { cancel } 로 끝나고 이유가 보이며, 기본 구현과 after 는 돌지 않는다', async () => {
  let ran = 0
  let afterRan = 0
  setDefault('session.create', () => (ran++, { sid: 'x' }))
  const offs = [before('session.create', () => ({ cancel: '막았어요' })), after('session.create', () => afterRan++)]
  shown.length = 0
  assert.deepEqual(await dispatch('session.create', { hostId: 'h' }), { cancel: '막았어요' })
  assert.equal(ran, 0)
  assert.equal(afterRan, 0)
  assert.deepEqual(shown, ['막았어요'])
  offs.forEach((f) => f())
})

test('시간 초과: 취소하는 액션은 { cancel: "시간 초과" }, 늦게 부른 next() 는 기본 구현을 돌리지 않는다', async () => {
  let ran = 0
  setDefault('message.send', () => (ran++, { ok: true }))
  let late
  const off = around('message.send', async (a, next) => {
    await sleep(60)
    late = next(a)
    return late
  }, { timeoutMs: 20 })
  assert.deepEqual(await dispatch('message.send', { sid: 's', text: 't', kind: 'text', images: [], videos: [] }), { cancel: '시간 초과' })
  await sleep(80)
  assert.equal(ran, 0)
  assert.deepEqual(await late, { cancel: '시간 초과' })
  off()
})

test('시간 초과: 건너뛰는 액션(session.close)은 그 핸들러만 빼고, 기본 구현은 한 번만', async () => {
  let ran = 0
  setDefault('session.close', () => (ran++, { ok: true }))
  let late
  const off = before('session.close', async (a, ctx) => {
    await sleep(60)
    return a
  }, { timeoutMs: 20 })
  const off2 = around('session.close', async (a, next) => {
    await sleep(60)
    late = next(a)
    return late
  }, { timeoutMs: 20, priority: -1 })
  assert.deepEqual(await dispatch('session.close', { sid: 's', kind: 'end' }), { ok: true })
  await sleep(100)
  assert.equal(ran, 1)
  off()
  off2()
})

test('waitUser 동안은 시계가 멈춘다', async () => {
  setDefault('permission.answer', () => ({ ok: true }))
  const off = around('permission.answer', async (a, next, ctx) => ((await ctx.waitUser(sleep(80))) , next(a)), { timeoutMs: 30 })
  assert.deepEqual(await dispatch('permission.answer', { sid: 's', known: true, card: { id: 'c' }, option: { n: 1, label: '예', kind: 'allow-once' } }), { ok: true })
  off()
})

test('핸들러 오류: next 전이면 시간 초과처럼, 뒤면 그 결과를 쓴다', async () => {
  setDefault('message.send', () => ({ ok: 1 }))
  let off = before('message.send', () => {
    throw new Error('boom')
  })
  assert.deepEqual(await dispatch('message.send', { sid: 's', text: 't', kind: 'text', images: [], videos: [] }), { cancel: '시간 초과' })
  off()
  off = around('message.send', async (a, next) => {
    await next(a)
    throw new Error('boom')
  })
  assert.deepEqual(await dispatch('message.send', { sid: 's', text: 't', kind: 'text', images: [], videos: [] }), { ok: 1 })
  off()
  assert.ok(actionLog.some((x) => /boom/.test(x.what)))
})

test('ctx.dispatch 는 자기 자신을 건너뛴다', async () => {
  let n = 0
  setDefault('message.send', (a) => ({ text: a.text }))
  const off = around('message.send', async (a, next, ctx) => (n++, a.text === 'again' ? ctx.dispatch('message.send', { ...a, text: 'inner' }) : next(a)))
  assert.deepEqual(await dispatch('message.send', { sid: 's', text: 'again', kind: 'text', images: [], videos: [] }), { text: 'inner' })
  assert.equal(n, 1)
  off()
})

test('동기 액션: 결과를 바로 돌려주고, Promise 를 돌려주는 before 는 무시, around 가 바꿀 수 있다', () => {
  const opened = []
  setDefault('link.open', (a) => opened.push(a.url))
  let off = before('link.open', async () => ({ cancel: 'x' }), { owner: 'slow' })
  dispatch('link.open', { url: 'https://a', from: 'markdown' })
  assert.deepEqual(opened, ['https://a'])
  assert.ok(actionLog.some((x) => x.owner === 'slow' && /Promise/.test(x.what)))
  off()
  off = around('link.open', (a, next) => (a.url.includes('wiki') ? 'sheet' : next(a)))
  assert.equal(dispatch('link.open', { url: 'https://wiki/x', from: 'markdown' }), 'sheet')
  dispatch('link.open', { url: 'https://b', from: 'markdown' })
  assert.deepEqual(opened, ['https://a', 'https://b'])
  off()
  setDefault('renderer.block', (a) => `code:${a.lang}`)
  assert.throws(() => before('renderer.block', () => {}), /around/)
  off = around('renderer.block', (a, next) => (a.lang === 'chat' ? 'preview' : next(a)))
  assert.equal(dispatch('renderer.block', { lang: 'chat', text: '', closed: true, isLast: false }), 'preview')
  assert.equal(dispatch('renderer.block', { lang: 'js', text: '', closed: true, isLast: false }), 'code:js')
  off()
  assert.equal(isCancel({ cancel: 'a' }), true)
  assert.equal(isCancel({ ok: true }), false)
})

test('공개 액션 10개와 그 성질이 설계(§6.2)와 같다', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['clipboard.copy', 'composer.submit', 'link.open', 'message.send', 'notify.show', 'permission.answer', 'renderer.block', 'session.close', 'session.create', 'session.open'])
  for (const n of ['session.open', 'link.open', 'clipboard.copy', 'renderer.block', 'notify.show']) assert.equal(ACTIONS[n].sync, true, n)
  assert.equal(ACTIONS['session.close'].onTimeout, 'skip')
  assert.throws(() => before('nope.action', () => {}), /모르는 액션/)
})

// The call sites (§6.2 표) go through the bus: no page writes to the clipboard or opens a window on its own.
const grep = (re) => execSync(`grep -rnE '${re}' ui/src || true`, { cwd: new URL('../../', import.meta.url) }).toString().trim().split('\n').filter(Boolean)
// Lines holding a fixed string, as path:line:text (no shell, so any quote or backtick is fine).
const grepF = (str) => {
  const root = new URL('../../', import.meta.url)
  const out = []
  for (const f of readdirSync(new URL('ui/src', root), { recursive: true })) {
    if (!/\.tsx?$/.test(f)) continue
    readFileSync(new URL(`ui/src/${f}`, root), 'utf8').split('\n').forEach((l, i) => l.includes(str) && out.push(`ui/src/${f}:${i + 1}:${l}`))
  }
  return out
}
const files = (lines) => [...new Set(lines.map((l) => l.split(':')[0]))].sort()

test('호출 지점: 클립보드 쓰기와 새 창 열기는 기본 구현에만, 새 창 링크는 모두 link.open 을 지난다', () => {
  assert.deepEqual(files(grep('clipboard\\??\\.writeText')), ['ui/src/lib/builtin-actions.tsx'])
  // The one window opened before its address is known (iOS) stays outside (§6.2), with its fallback.
  assert.deepEqual(files(grep("open\\([^)]*'_blank'")), ['ui/src/components/local-preview.tsx', 'ui/src/lib/builtin-actions.tsx'])
  assert.equal(grep("open\\([^)]*'_blank'").filter((l) => l.startsWith('ui/src/components/local-preview')).length, 2)
  assert.match(readFileSync(new URL('../../ui/src/components/local-preview.tsx', import.meta.url), 'utf8'), /window\.open\('', '_blank'\)/)
  for (const l of grep('target="_blank"')) assert.match(l, /onClick=\{linkClick\(/, l)
  assert.deepEqual(files(grep('location\\.href = ')), ['ui/src/lib/builtin-actions.tsx', 'ui/src/pages/settings.tsx'])
  for (const l of grep('safariHref\\(\\)\\}')) assert.match(l, /linkClick\(safariHref\(\), 'safari', '_self'\)/, l)
})

test('호출 지점: 세션으로 가는 이동은 모두 session.open 을 지난다', () => {
  // Only the default goes to a session's page; split moves (lib/split) are not session.open (§6.2).
  assert.deepEqual(files(grepF("go({ name: 'session'")), ['ui/src/lib/builtin-actions.tsx', 'ui/src/lib/router.ts'])
  assert.deepEqual(grepF('navigate(`/s/'), [])
  assert.match(readFileSync(new URL('../../ui/src/main.tsx', import.meta.url), 'utf8'), /interceptLinks\(\(id, from\) => openSession\(id, from\)\)/)
})
