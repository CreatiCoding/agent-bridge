// 서버 경로의 그림은 공통 fetch 로 받아 blob: 주소로 그린다 (REQ-F-890, AC-1694): an <img src="/api/…"> sends none
// of the headers every other request carries, so behind a proxy that wants one the picture never came.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(join(root, p), 'utf8')
const api = read('ui/src/lib/api.ts')
const lib = read('ui/src/lib/api-img.tsx')
const view = read('ui/src/components/timeline-view.tsx')

test('getBlob 은 잠금 토큰·로그인 확인·캐시 건너뛰기를 call 과 같이 한다', () => {
  const at = api.indexOf('export async function getBlob(')
  assert.ok(at >= 0)
  const body = api.slice(at, api.indexOf('export const errorText', at))
  assert.match(body, /credentials: 'same-origin'/)
  assert.match(body, /'X-Lock': token/)
  assert.match(body, /cache: fresh \? 'reload' : 'default'/)
  assert.match(body, /status === 401[\s\S]*location\.reload\(\)/)
  assert.match(body, /res\.blob\(\)/)
})

test('/api/ 주소만 fetch 로 받고, data:·blob: 는 그대로 그린다', () => {
  const m = /export const viaFetch = \(src[^)]*\)[^=]*=> (.+)\n/.exec(lib)
  assert.ok(m)
  const viaFetch = new Function('src', `return ${m[1]}`)
  assert.equal(viaFetch('/api/img/a.png'), true)
  assert.equal(viaFetch('/api/sessions/x/localimg?path=%2Ftmp%2Fa.png'), true)
  assert.equal(viaFetch('data:image/png;base64,AAAA'), false)
  assert.equal(viaFetch('blob:https://x/1'), false)
  assert.equal(viaFetch(''), false)
  assert.equal(viaFetch(null), false)
})

test('같은 주소는 한 번 받아 썸네일과 확대 보기가 나눠 쓰고, 실패는 남기지 않는다', () => {
  assert.match(lib, /getBlob\(src, fresh\)\.then\(\(b\) => URL\.createObjectURL\(b\)\)/)
  assert.match(lib, /e\.url\.catch\(\(\) => held\.get\(src\) === e && held\.delete\(src\)\)/)
  assert.match(lib, /URL\.revokeObjectURL/)
  // A retry fetches again even with a blob held (it may be bytes that are not a picture).
  assert.match(lib, /if \(!h \|\| fresh\) \{/)
})

test('대화의 그림·경로 그림·확대 보기가 공통 fetch 를 거친다', () => {
  const thumb = view.slice(view.indexOf('function Thumb('), view.indexOf('const THUMB_RETRY_MS'))
  assert.match(thumb, /<ApiImg/)
  assert.doesNotMatch(thumb, /<img/)
  const local = view.slice(view.indexOf('function LocalThumbs('), view.indexOf('const UserMsg ='))
  assert.match(local, /<ApiImg/)
  assert.doesNotMatch(local, /<img/)
  const viewer = view.slice(view.indexOf('export function ImageViewer('), view.indexOf('const img ='))
  assert.match(viewer, /useImageSrc\(src\)/)
  assert.match(viewer, /src=\{url\}/)
})

test('화면 어디에도 <img src="/api/…"> 가 남지 않는다', () => {
  const files = []
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx$/.test(f) && files.push(join(d, f))))
  walk(join(root, 'ui/src'))
  const bad = []
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/<img\b[^>]*\bsrc=\{?["'`]\/api\//g)) bad.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(bad, [])
})
