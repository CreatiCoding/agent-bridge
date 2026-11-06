// 퀵 제보 (REQ-F-870, AC-1629): the clipboard's text and pictures are read in one go and sent as they are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QUICK_MAX_IMAGES, QUICK_MAX_TEXT, readClipboard } from '../../ui/src/lib/clip-report.ts'

const item = (parts) => ({ types: Object.keys(parts), getType: async (t) => new Blob([parts[t]], { type: t }) })

test('글과 그림을 함께 읽는다', async () => {
  const got = await readClipboard({ read: async () => [item({ 'text/plain': '  화면이 멈춰요 \n' }), item({ 'image/png': 'png-bytes' })] })
  assert.equal(got.text, '화면이 멈춰요')
  assert.equal(got.files.length, 1)
  assert.equal(got.files[0].type, 'image/png')
  assert.equal(got.files[0].name, 'clipboard-1.png')
  assert.equal(await got.files[0].text(), 'png-bytes')
})

test('read 가 없으면 readText 로 글만 읽는다', async () => {
  const got = await readClipboard({ readText: async () => ' 안녕 ' })
  assert.deepEqual(got, { text: '안녕', files: [] })
})

test('빈 클립보드는 빈 결과', async () => {
  assert.deepEqual(await readClipboard({ read: async () => [item({ 'text/plain': '   ' })] }), { text: '', files: [] })
})

test('그림은 8장, 글은 20,000자까지', async () => {
  const many = Array.from({ length: 12 }, () => item({ 'image/jpeg': 'x' }))
  const got = await readClipboard({ read: async () => [...many, item({ 'text/plain': 'a'.repeat(30_000) })] })
  assert.equal(got.files.length, QUICK_MAX_IMAGES)
  assert.equal(got.text.length, QUICK_MAX_TEXT)
})

test('클립보드를 못 읽으면 던진다', async () => {
  await assert.rejects(readClipboard(undefined))
  await assert.rejects(readClipboard({ read: async () => Promise.reject(new Error('NotAllowedError')) }))
})

test('폰 목록 위 바의 알림 왼쪽에 퀵 제보 버튼', () => {
  const app = readFileSync(new URL('../../ui/src/app.tsx', import.meta.url), 'utf8')
  const bar = app.slice(app.indexOf('<div className="topbar">'), app.indexOf('<MenuButton me={me} />'))
  assert.ok(bar.indexOf('<QuickReportButton') > 0 && bar.indexOf('<QuickReportButton') < bar.indexOf('<Bell'))
})
