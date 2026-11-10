// 영어 답 번역 (REQ-F-896): only English prose lines go to the device's translator; code, links and paths come back
// byte for byte, or the line stays English. The iOS app's side is checked as text (Swift is built on the TestFlight Mac).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { engine, englishPieces, isEnglish, restore, translateAnswer } from '../../ui/src/lib/translate.ts'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('AC-1732 영어 문장만 고르고 한국어·코드 블록·표·짧은 줄은 그대로 둔다', () => {
  assert.equal(isEnglish('The build passed and the deploy is done.'), true)
  assert.equal(isEnglish('빌드는 통과했어요. The deploy is done.'), false)
  assert.equal(isEnglish('`npm test` ok'), false)
  assert.equal(isEnglish('Done.'), false)
  const md = ['배포했어요.', '', '```sh', 'Run the tests again before you push', '```', '| Run the tests | again now |', '- Then check the status of the commit'].join('\n')
  const { pieces } = englishPieces(md)
  assert.deepEqual(
    pieces.map((p) => (p ? p.body : null)),
    [null, null, null, null, null, null, 'Then check the status of the commit'],
  )
  assert.equal(pieces[6].lead, '- ')
})

test('AC-1733 인라인 코드·링크·경로는 표시로 빼고, 표시가 그대로 돌아올 때만 번역을 쓴다', () => {
  const { pieces } = englishPieces('**→ Run** `npm test` in ui/src/lib before https://ci.example.dev/x shows it')
  const p = pieces[0]
  assert.deepEqual(p.kept, ['`npm test`', 'ui/src/lib', 'https://ci.example.dev/x'])
  assert.equal(p.body, '**→ Run** ⟦0⟧ in ⟦1⟧ before ⟦2⟧ shows it')
  assert.equal(restore(p, '**→ 실행** ⟦2⟧ 가 보이기 전에 ⟦1⟧ 에서 ⟦0⟧'), '**→ 실행** https://ci.example.dev/x 가 보이기 전에 ui/src/lib 에서 `npm test`')
  assert.equal(restore(p, '⟦0⟧ 실행 ⟦1⟧'), null, '빠진 표시')
  assert.equal(restore(p, '⟦0⟧ ⟦0⟧ ⟦1⟧ ⟦2⟧'), null, '두 번 나온 표시')
  assert.equal(restore(p, '⟦0⟧ ⟦1⟧ ⟦2⟧ ⟦3⟧'), null, '없던 표시')
  assert.equal(restore(p, ''), null)
})

test('AC-1734 기기 번역기로 영어 줄만 바꾸고, 번역기가 없거나 실패하면 원문 그대로다', async () => {
  const md = '## Summary\n\n한국어 줄이에요.\n\n```js\nconst x = 1 // keep this English comment\n```\n\nThe tests passed on the first try.'
  // No translator on this machine (no app bridge, no Chrome Translator): unchanged.
  assert.equal(await translateAnswer(md), md)
  const sent = []
  globalThis.Translator = {
    availability: async () => 'available',
    create: async () => ({ translate: async (t) => (sent.push(t), t === 'The tests passed on the first try.' ? '시험이 처음에 통과했어요.' : t) }),
  }
  try {
    const md2 = md + '\n'
    assert.equal(await translateAnswer(md2), '## Summary\n\n한국어 줄이에요.\n\n```js\nconst x = 1 // keep this English comment\n```\n\n시험이 처음에 통과했어요.\n')
    assert.deepEqual(sent, ['The tests passed on the first try.'])
    globalThis.Translator.availability = async () => 'downloadable'
    const md3 = 'Another answer that stays in English here.'
    assert.equal(await translateAnswer(md3), md3)
  } finally {
    delete globalThis.Translator
  }
})

test('AC-1735 iOS 앱이 translate 요청을 기기 안 Translation 으로 받고, 네트워크를 쓰지 않는다', () => {
  const app = read('ios/Bridge/BridgeApp.swift')
  const swift = read('ios/Bridge/ReplyTranslator.swift')
  const page = read('ui/src/lib/translate.ts')
  assert.match(app, /userContentController\.add\(context\.coordinator, name: "translate"\)/)
  assert.match(app, /m\.name == "translate"[\s\S]*ReplyTranslator\.shared\.ask\(id, texts: texts, prepare:/)
  assert.match(app, /ReplyTranslator\.shared\.web = v/)
  assert.match(app, /if #available\(iOS 18\.0, \*\) \{ ReplyTranslatorHost\(\) \}/)
  assert.match(swift, /Configuration\(source: en, target: ko\)/)
  assert.match(swift, /\.translationTask\(config\)/)
  // The download sheet only from the settings button.
  assert.match(swift, /if status == \.supported, job\.prepare \{[\s\S]*prepareTranslation\(\)/)
  assert.match(swift, /window\.bridgeTranslate\?\.\(/)
  assert.match(page, /bridgeTranslate/)
  assert.doesNotMatch(swift, /URLSession|URLRequest|https:\/\//)
  assert.doesNotMatch(page, /fetch\(|XMLHttpRequest|https:\/\//)
})

test('AC-1738 맥 번역기: 처음 한 번 macOS 26 대상으로 빌드하고, 한 프로세스에 줄 단위 JSON 으로 묻고 받는다', async () => {
  const { MacTranslator, canTranslate, SWIFT } = await import('../../agent/translate.mjs')
  const { EventEmitter } = await import('node:events')
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  assert.equal(canTranslate('darwin', '25.0.0'), true)
  assert.equal(canTranslate('darwin', '24.6.0'), false, 'macOS 15')
  assert.equal(canTranslate('linux', '25.0.0'), false)
  assert.match(SWIFT, /TranslationSession\(installedSource: en, target: ko\)/)
  assert.match(SWIFT, /status == \.supported \? "download" : "unsupported"/)
  assert.doesNotMatch(SWIFT, /prepareTranslation|URLSession|https:\/\//, '받기도 네트워크도 하지 않는다')
  const dir = mkdtempSync(path.join(tmpdir(), 'ko-tr-'))
  const builds = []
  const build = (cmd, args, _o, done) => {
    builds.push([cmd, ...args])
    writeFileSync(args[args.length - 1], 'bin')
    done(null, '', '')
  }
  const runs = []
  const run = (bin) => {
    const p = new EventEmitter()
    p.stdout = new EventEmitter()
    p.stdout.setEncoding = () => {}
    p.stdin = {
      write: (line) => {
        const { id, texts } = JSON.parse(line)
        const out = texts.length ? { id, status: 'installed', texts: texts.map((t) => `ko:${t}`) } : { id, status: 'download' }
        // Two answers in one chunk, split over the newline.
        setImmediate(() => p.stdout.emit('data', `${JSON.stringify(out)}\n`))
      },
    }
    p.kill = () => p.emit('exit')
    runs.push(bin)
    return p
  }
  const tr = new MacTranslator({ dir, build, run, can: () => true })
  assert.deepEqual(await tr.translate(['Hello there']), { status: 'installed', texts: ['ko:Hello there'] })
  assert.deepEqual(await tr.translate([]), { status: 'download' })
  assert.equal(builds.length, 1)
  assert.deepEqual(builds[0].slice(0, 6), ['xcrun', 'swiftc', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos26.0`])
  assert.equal(runs.length, 1)
  assert.ok(existsSync(tr.bin()))
  await assert.rejects(new MacTranslator({ dir, build, run, can: () => false }).translate(['x']), (e) => e.code === 'unsupported')
  tr.stop()
})

test('AC-1739 브라우저에 번역기가 없을 때만 맥에 맡기고, 짝지은 맥의 세션은 맡기지 않는다', () => {
  assert.equal(engine(), null)
  assert.equal(engine({ host: 'h1' })?.kind, 'mac')
  globalThis.Translator = { availability: async () => 'available', create: async () => ({ translate: async (t) => t }) }
  try {
    assert.equal(engine({ host: 'h1' })?.kind, 'chrome')
  } finally {
    delete globalThis.Translator
  }
  const view = read('ui/src/components/timeline-view.tsx')
  assert.match(view, /pairedWith\(session\.hostId\) \? null : \{ host: session\.hostId \}/)
  const agent = read('agent/agent.mjs')
  assert.match(agent, /async translate\(\{ reqId, texts \}\) \{\n\s+if \(trustSealing\(\)\) return emit\(\{ t: 'translate', reqId, ok: false, code: 'sealed'/)
  assert.match(agent, /\.\.\.\(canTranslate\(\) \? \['translate'\] : \[\]\)/)
})
