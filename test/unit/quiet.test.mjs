// 조용한 답 (REQ-F-850, docs/MESSAGE-HOOK-DESIGN.md): the Mac's side of the test, against the cases the server shares
// (server/testdata/quiet-cases.json), the ends chosen at its terminal, the plain mark on sealed answers, and the
// page's fold and message.render rules (read from the source, as ext-host.test.mjs does).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quietOf, quietSuffixOk, quietChosen, sealLine, trustCli, TRUST_CLASS } from '../../agent/trust.mjs'

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const cases = JSON.parse(read('server/testdata/quiet-cases.json'))

test('quietOf·quietSuffixOk 는 서버와 같은 사례표에서 같은 답을 낸다', () => {
  for (const c of cases.cases) {
    const r = quietOf(c.text, cases.rules)
    assert.equal(r ? `${r.ext}|${r.suffix}` : '', c.want, JSON.stringify(c.text))
  }
  for (const v of cases.valid) assert.equal(quietSuffixOk(v.suffix), v.ok, JSON.stringify(v.suffix))
})

test('봉인하는 맥의 끝 글자는 터미널(trust quiet)에서만 정하고, 서버가 보낼 명령은 없다', async () => {
  assert.equal(TRUST_CLASS.quiet, undefined)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'))
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, '{}')
  const said = []
  const cli = (...w) => trustCli(['quiet', ...w], { stateDir: dir, configPath, hostId: 'h1', ask: async () => '', out: (x) => said.push(x) })
  assert.equal(await cli('add', '[조용히]'), 0)
  assert.equal(await cli('add', '할', '일', '없음'), 0)
  assert.equal(await cli('add', ' 앞 공백'), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).trustQuiet, ['[조용히]', '할 일 없음'])
  assert.deepEqual(quietChosen(JSON.parse(fs.readFileSync(configPath, 'utf8'))), [{ ext: 'mac', suffix: '[조용히]' }, { ext: 'mac', suffix: '할 일 없음' }])
  assert.equal(await cli('rm', '할', '일', '없음'), 0)
  assert.equal(await cli('rm', '없는 것'), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).trustQuiet, ['[조용히]'])
  // A hand-edited agent.json is held to the same limits: bad ends dropped, five at most.
  assert.deepEqual(quietChosen({ trustQuiet: ['', ' x', 'a', 'a', 'b', 'c', 'd', 'e', 'f'] }).map((r) => r.suffix), ['a', 'b', 'c', 'd', 'e'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('봉인한 답 줄에만 평문 표지 bridgeQuiet 를 붙이고, 사람 말·도구에는 붙이지 않는다', () => {
  const seal = (s) => `⟦bt1:0a1b2c3d:${Buffer.from(s).toString('base64url').padEnd(40, 'A')}⟧`
  const rules = [{ ext: 'mac', suffix: '[조용히]' }]
  const answer = (text) => JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const quiet = JSON.parse(sealLine(answer('할 일이 없어요 [조용히]\n'), seal, () => false, rules))
  assert.equal(quiet.bridgeQuiet, 'mac')
  assert.match(quiet.message.content[0].text, /^⟦bt1:/)
  assert.ok(!JSON.stringify(quiet).includes('조용히'), '글은 봉인된 채')
  assert.equal(JSON.parse(sealLine(answer('보통 답'), seal, () => false, rules)).bridgeQuiet, undefined)
  assert.equal(JSON.parse(sealLine(answer('끝 [조용히]'), seal)).bridgeQuiet, undefined, '규칙 없음')
  const person = JSON.stringify({ type: 'user', message: { role: 'user', content: '[조용히]' } })
  assert.equal(JSON.parse(sealLine(person, seal, () => false, rules)).bridgeQuiet, undefined)
})

test('페이지: 서버 표지만 따라 접고, 접기는 지우지 않으며, 훅이 바꾼 글은 표시한다', () => {
  const q = read('ui/src/lib/quiet.ts')
  assert.match(q, /setDefault\('message\.render', \(\{ text, quiet \}\) => \(quiet \? \{ hide: true as const, reason: quiet\.label \} : \{ text \}\)\)/)
  assert.match(q, /const folded = hide \|\| !!a\.quiet/, '규칙이 접은 답은 훅이 펼치지 못함')
  assert.match(q, /if \(!x\.quietAgreed \|\| x\.loadError\) continue/, '사람이 직접 동의한 규칙만')
  const tl = read('ui/src/components/timeline-view.tsx')
  assert.match(tl, /조용히 접은 답/)
  assert.match(tl, /펼치기/)
  assert.match(tl, /원문 보기/)
  assert.match(tl, /<TextBody \{\.\.\.p\} text=\{text\} choices=\{!shown\.folded\} \/>/)
  const host = read('ui/src/lib/ext-host.tsx')
  assert.match(host, /n === 'message\.render' \? signed\(owner, fn as never\) : fn/)
  assert.match(host, /setQuietRules\(list\)\n/)
  assert.ok(host.indexOf('setQuietRules(list)') < host.indexOf('if (!me || !list.length || noExt()) return'), '?noext·짝지은 기기에서도 규칙은 적용')
  assert.match(host, /답을 접어요: 끝이/)
  assert.match(read('ui/src/components/session-list.tsx'), /\(s\.lastQuiet \? s\.loudSeq \?\? 0 : s\.seq\) > \(seen\[s\.id\] \?\? 0\)/)
  // Cards, notes and the person's words never go through message.render.
  assert.equal((tl.match(/messageShown\(/g) ?? []).length, 1)
})
