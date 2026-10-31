// 예시 익스텐션과 공개 타입 (AC-1497): the built files in the repository are what its source builds to, with the
// published types; nothing but its own neighbour is imported. Needs ui's packages (corepack yarn install in ui).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const ex = join(root, 'extensions/example')
const tsc = join(root, 'ui/node_modules/.bin/tsc')

test('dist 는 src 를 공개 타입으로 빌드한 그대로다', { skip: !existsSync(tsc) && 'ui 패키지가 없어요' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'ext-example-'))
  // The example's own tsconfig, with react's types taken from ui (the example's package.json has the same ones).
  writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ extends: join(ex, 'tsconfig.json'), compilerOptions: { rootDir: join(ex, 'src'), outDir: join(out, 'dist'), paths: { react: [join(root, 'ui/node_modules/@types/react')] } }, include: [join(ex, 'src')] }))
  execFileSync(tsc, ['-p', join(out, 'tsconfig.json')], { stdio: 'pipe' })
  const built = readdirSync(join(out, 'dist')).sort()
  assert.deepEqual(readdirSync(join(ex, 'dist')).sort(), built)
  for (const f of built) assert.equal(readFileSync(join(ex, 'dist', f), 'utf8'), readFileSync(join(out, 'dist', f), 'utf8'), `dist/${f}: extensions/example 에서 corepack yarn install && corepack yarn build`)
  for (const f of built) for (const m of readFileSync(join(ex, 'dist', f), 'utf8').matchAll(/from '([^']+)'/g)) assert.match(m[1], /^\.\//, `${f}: ${m[1]}`)
})

test('언어 파일은 같은 키를 갖고, 공개 타입은 페이지의 bridge 와 맞대 검사된다', () => {
  const ko = JSON.parse(readFileSync(join(ex, 'locales/ko.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ex, 'locales/en.json'), 'utf8'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort())
  for (const k of readFileSync(join(ex, 'src/index.tsx'), 'utf8').matchAll(/\bt\('([^']+)'\)/g)) assert.ok(k[1] in ko, k[1])
  const check = readFileSync(join(root, 'ui/src/lib/ext-api-check.ts'), 'utf8')
  assert.match(check, /export const fits = \(b: Bridge\): Published => b/)
  assert.match(readFileSync(join(root, 'ui/tsconfig.json'), 'utf8'), /"react": \["\.\/node_modules\/@types\/react"\]/)
})
