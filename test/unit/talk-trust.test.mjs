// 대화 모드의 보안 (1.548, REQ-S-112): the words a server sends to be read never reach a program as an option, every
// talk op on a Mac in trust enforce is a paired device's, a sealing Mac's answer leaves sealed, a Mac takes only so much
// of it, the judge reads nothing of the person's, and 소희's model is never fetched because of a command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Trust, classOf, rebuild, hashesHold, pairCommit, sha256Hex, b64u, deviceIdOf, sealWith, openWith, sealOut, TRUST_CLASS } from '../../agent/trust.mjs'
import { SayVoice, SupertonicVoice, QwenVoice, Judge, TalkGate, TALK_LIMITS, talk, hfCached, QWEN_MODEL } from '../../agent/talk.mjs'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

test('AC-1820: talk 의 글은 명령줄 옵션이 되지 않는다: say 는 -f 파일로, Supertonic·소희는 표준입력 JSON 으로', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-talk-arg-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  for (const text of ['-o/tmp/x', '-f/etc/hosts', '--output-file=/tmp/y', '-v Yuna 안녕']) {
    const calls = []
    const run = (bin, args, _o, cb) => {
      if (args[0] === '-v' && args[1] === '?') return cb(null, 'Yuna               ko_KR    # 안녕하세요\n')
      // What `say` gets: the words only through the file named after -f, whose content is exactly them.
      const f = args[args.indexOf('-f') + 1]
      calls.push({ args, file: fs.readFileSync(f, 'utf8'), mode: fs.statSync(f).mode & 0o777 })
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'RIFF')
      cb(null, '')
    }
    const r = await talk({ op: 'tts', text }, { voice: new SayVoice({ run, tmp }) })
    assert.equal(Buffer.from(r.audio, 'base64').toString(), 'RIFF')
    assert.equal(calls.length, 1)
    const { args, file, mode } = calls[0]
    assert.ok(!args.includes(text) && !args.some((a) => a.includes(text.trim())), `글이 인자로 가지 않음: ${JSON.stringify(args)}`)
    assert.equal(args[args.length - 2], '-f', '마지막은 -f <파일>')
    assert.equal(file, text.trim())
    assert.equal(mode, 0o600)
    // The sentence's folder is gone afterwards.
    assert.deepEqual(fs.readdirSync(tmp), [])
  }
  // The real `say`, where there is one: "-o<path>" is read aloud, no file is made there.
  let haveSay = false
  try {
    haveSay = process.platform === 'darwin' && !!execFileSync('which', ['say']).toString().trim()
  } catch {}
  if (haveSay) {
    const trap = path.join(tmp, 'trap.wav')
    const v = new SayVoice({ tmp })
    // A Korean voice when there is one, else the first voice this Mac lists.
    await v.pick().catch(() => (v.voice = /^(.+?)\s{2,}/.exec(execFileSync('say', ['-v', '?']).toString())[1]))
    const r = await v.speak(`-o${trap}`, 2).catch((e) => ({ error: e }))
    assert.ok(!r.error, String(r.error))
    assert.equal(fs.existsSync(trap), false, 'say 가 글을 옵션으로 읽지 않음')
    assert.ok(Buffer.from(r.audio, 'base64').length > 44)
  }
  // Supertonic and 소희: the words ride in a JSON line on stdin; the command line is fixed.
  for (const V of [SupertonicVoice, QwenVoice]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'v-'))
    const venv = V === QwenVoice ? 'qwentts' : 'supertonic'
    fs.mkdirSync(path.join(dir, venv, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, venv, 'bin', 'python'), '')
    const hub = path.join(dir, 'hub')
    fs.mkdirSync(path.join(hub, `models--${QWEN_MODEL.replace('/', '--')}`, 'snapshots', 'abc'), { recursive: true })
    fs.writeFileSync(path.join(hub, `models--${QWEN_MODEL.replace('/', '--')}`, 'snapshots', 'abc', 'config.json'), '{}')
    let argv
    const asked = []
    const run = (bin, a) => {
      argv = a
      const p = new EventEmitter()
      p.stdout = new PassThrough()
      p.stdin = new PassThrough()
      p.kill = () => {}
      p.stdin.on('data', (d) => {
        for (const l of String(d).trim().split('\n')) {
          const q = JSON.parse(l)
          asked.push(q)
          fs.writeFileSync(q.out, 'RIFF')
          p.stdout.write(`${JSON.stringify({ id: q.id, ok: true })}\n`)
        }
      })
      setImmediate(() => p.stdout.write('{"ready":true}\n'))
      return p
    }
    const v = new V({ dir, run, hub })
    await v.speak('-o/tmp/x')
    v.stop()
    clearTimeout(v.idle)
    assert.ok(!argv.some((a) => a.includes('/tmp/x')))
    assert.equal(asked[0].text, '-o/tmp/x')
  }
})

async function device() {
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const dh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  return { sign, spub: b64u(new Uint8Array(await subtle.exportKey('raw', sign.publicKey))), dpub: b64u(new Uint8Array(await subtle.exportKey('raw', dh.publicKey))) }
}
function pairIn(t, dev) {
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  const nb = b64u(rand(32))
  const r1 = t.pair1({ c: pairCommit(dev.spub, dev.dpub, nb) }, 'enforce')
  const { sas } = t.pair3({ pid: r1.pid, spub: dev.spub, dpub: dev.dpub, nb, name: '폰' })
  fs.writeFileSync(t.p.confirm, JSON.stringify({ pid: r1.pid, sas }))
  assert.equal(t.pair4({ pid: r1.pid }).state, 'ok')
}
let seq = 0
async function signed(t, dev, i) {
  const p = JSON.stringify({ v: 1, h: t.hostId, d: deviceIdOf(dev.spub, dev.dpub), ts: Date.now(), n: ++seq, t: 'talk', i })
  const s = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.sign.privateKey, enc.encode(p)))
  return { p, s: b64u(s) }
}
/** agent.mjs trustGate in enforce, from the same pieces: the command to run, or {refused}. */
function gate(t, cmd) {
  const rule = classOf(cmd)
  if (rule === 'free') return cmd
  if (rule === 'off') return { refused: '이 모드에서 쓸 수 없는 동작' }
  let v = t.verify(cmd)
  if (v.ok && !hashesHold(cmd, v.i)) v = { ok: false, why: '서명한 글·그림과 다름' }
  if (!v.ok) return { refused: v.why }
  return { ...rebuild(cmd, rule, v.i), signed: v.dev.id }
}
function mac(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-talk-trust-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const tr = new Trust({ stateDir: dir, hostId: 'h1' })
  tr.ensure()
  return tr
}

test('AC-1821: trust enforce 맥은 서명 없는 talk(tts·turn·brief·warm)를 거절하고, 짝지은 기기가 서명한 것만(그 글 그대로) 받는다', async (t) => {
  const tr = mac(t)
  const dev = await device()
  pairIn(tr, dev)
  for (const op of ['tts', 'turn', 'brief', 'warm']) {
    assert.notEqual(classOf({ t: 'talk', op }), 'free', op)
    assert.equal(gate(tr, { t: 'talk', op, text: '안녕' }).refused, '서명 없음', op)
  }
  assert.equal(classOf({ t: 'talk', op: 'sing' }), 'off')
  // What the page signs (ui/src/lib/trust.ts talkIntents): the op and the hash of the words as sent.
  const text = '배포가 끝났어요.'
  const ok = gate(tr, { t: 'talk', op: 'tts', text, rate: 1.25, engine: 'qwen', reqId: 'r1', auth: await signed(tr, dev, { op: 'tts', textH: sha256Hex(text) }) })
  assert.equal(ok.refused, undefined)
  assert.deepEqual({ op: ok.op, text: ok.text, rate: ok.rate, engine: ok.engine, reqId: ok.reqId }, { op: 'tts', text, rate: 1.25, engine: 'qwen', reqId: 'r1' })
  // Other words than the ones signed, another op, the same signature twice: refused.
  assert.equal(gate(tr, { t: 'talk', op: 'tts', text: '-o/tmp/x', auth: await signed(tr, dev, { op: 'tts', textH: sha256Hex(text) }) }).refused, '서명한 글·그림과 다름')
  assert.equal(gate(tr, { t: 'talk', op: 'brief', text, auth: await signed(tr, dev, { op: 'tts', textH: sha256Hex(text) }) }).refused, '다른 명령의 서명')
  const once = { t: 'talk', op: 'turn', text: '그거 하니까', auth: await signed(tr, dev, { op: 'turn', textH: sha256Hex('그거 하니까') }) }
  assert.equal(gate(tr, { ...once }).refused, undefined)
  assert.equal(gate(tr, { ...once }).refused, '이미 쓴 서명')
  const warm = gate(tr, { t: 'talk', op: 'warm', engine: 'qwen', auth: await signed(tr, dev, { op: 'warm' }) })
  assert.equal(warm.refused, undefined)
  assert.equal(warm.engine, 'qwen')
  // A sealing Mac's device sends the words sealed for it: the hash is of the piece, the Mac opens it.
  const k = tr.contentKeys()
  const piece = sealWith(tr.keyOf(k.current), k.current, 'h1', '봉인된 말', 'u', '')
  const s = gate(tr, { t: 'talk', op: 'brief', text: piece, auth: await signed(tr, dev, { op: 'brief', textH: sha256Hex(piece) }) })
  assert.equal(s.refused, undefined)
  assert.equal(tr.openText(s.text), '봉인된 말')
  // The agent opens it before running, and the page signs and seals it (code, as for send).
  const agent = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const fn = agent.slice(agent.indexOf('  async talk({ reqId, op, text, rate, engine })'), agent.indexOf('  async voice({ reqId'))
  assert.match(fn, /text = trustText\(text\)/)
  assert.match(fn, /gate: talkGate/)
  const page = fs.readFileSync(new URL('../../ui/src/lib/trust.ts', import.meta.url), 'utf8')
  assert.match(page, /async function talkIntents\(/)
  assert.match(page, /t: 'talk', i \}/)
  assert.ok(TRUST_CLASS.talk.ops && !Object.values(TRUST_CLASS.talk.ops).includes('free'))
})

test('AC-1822: 봉인 켠 맥의 talk 답은 op 에 묶인 봉인 조각 하나로 나간다', async (t) => {
  const tr = mac(t)
  const dev = await device()
  pairIn(tr, dev)
  const seal = tr.sealer()
  for (const [op, r] of [
    ['tts', { audio: 'UklGRg==', mime: 'audio/wav', engine: 'say:Yuna' }],
    ['brief', { line: '배포가 끝났어요.' }],
    ['turn', { end: 'done' }],
  ]) {
    const out = sealOut({ t: 'talk', reqId: 'r', op, ok: true, ms: 12, ...r }, seal)
    for (const k of ['audio', 'line', 'end', 'engine', 'mime']) assert.equal(out[k], undefined, `${op}: ${k} 평문 없음`)
    assert.equal(out.ok, true)
    assert.equal(out.ms, 12)
    const o = openWith((kid) => tr.keyOf(kid), 'h1', out.sealed)
    assert.equal(o.d, 'm')
    const inner = JSON.parse(o.v)
    assert.equal(inner.kind, 'talk')
    assert.equal(inner.op, op)
    for (const [k, v] of Object.entries(r)) assert.equal(inner[k], v)
  }
  const bad = sealOut({ t: 'talk', reqId: 'r', op: 'tts', ok: false, code: 'busy', error: '너무 많아요' }, seal)
  assert.equal(bad.code, 'busy')
  assert.match(bad.error, /^⟦bt1:/)
  // The page opens it only bound to the op it asked, with that Mac's key, and refuses a plain answer from it.
  const page = fs.readFileSync(new URL('../../ui/src/lib/trust.ts', import.meta.url), 'utf8')
  const fn = page.slice(page.indexOf('export async function openTalk'), page.indexOf('// ---------- 세션 찾기'))
  assert.match(fn, /inner\?\.kind !== 'talk' \|\| inner\.op !== op/)
  assert.match(fn, /o\.d !== 'm'/)
  assert.match(fn, /sealsTo\(hostId\)\) throw/)
})

test('AC-1823: 맥 한 대가 받는 대화 모드에는 한도가 있고, 판정기는 사람의 설정을 읽지 않고, 소희 모델은 명령으로 받지 않는다', async (t) => {
  let now = 0
  const g = new TalkGate({ now: () => now })
  // At once: the judge takes two (one running, one waiting), the third is refused until one is done.
  const a = g.take('turn')
  const b = g.take('brief')
  assert.throws(() => g.take('turn'), (e) => e.code === 'busy')
  a()
  a()
  const c = g.take('turn')
  b()
  c()
  // In a minute: no more than perMin, then again after the minute.
  for (let i = 3; i < TALK_LIMITS.judge.perMin; i++) g.take('brief')()
  assert.throws(() => g.take('turn'), /1분에 너무 많아요/)
  now += 60_001
  g.take('turn')()
  // Reads have their own budget.
  for (let i = 0; i < TALK_LIMITS.tts.perMin; i++) g.take('tts')()
  assert.throws(() => g.take('tts'), (e) => e.code === 'busy')
  // talk() asks the gate and gives the place back, even when the voice fails.
  const g2 = new TalkGate({ limits: { tts: { at: 1, perMin: 100 } } })
  await assert.rejects(talk({ op: 'tts', text: '안녕' }, { voice: { speak: async () => Promise.reject(new Error('x')) }, gate: g2 }))
  await talk({ op: 'tts', text: '안녕' }, { voice: { speak: async () => ({ audio: '' }) }, gate: g2 })
  // An unknown op or empty words take no place.
  await assert.rejects(talk({ op: 'sing', text: 'x' }, { gate: g2 }), /모르는 op/)

  // The judge: no settings file of the person's (hooks, plugins), no CLAUDE.md, an empty folder of its own.
  const spawned = []
  const run = (bin, args, o) => {
    spawned.push({ args, cwd: o.cwd })
    const p = new EventEmitter()
    p.stdout = new PassThrough()
    p.stdin = new PassThrough()
    p.kill = () => p.emit('exit')
    p.stdin.on('data', () => p.stdout.write(`${JSON.stringify({ type: 'result', result: 'DONE' })}\n`))
    return p
  }
  const j = new Judge({ run, idleMs: 60_000 })
  assert.equal(await j.ask('TURN\n가'), 'DONE')
  j.stop()
  clearTimeout(j.idle)
  const { args, cwd } = spawned[0]
  assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(f), f)
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.notEqual(cwd, os.homedir())
  assert.deepEqual(fs.readdirSync(cwd), [])
  fs.rmSync(cwd, { recursive: true, force: true })

  // 소희: not in the cache → refused with the command to run at the Mac, nothing started; loaded offline otherwise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qwen-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'qwentts', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'qwentts', 'bin', 'python'), '')
  const hub = path.join(dir, 'hub')
  let started = 0
  let env
  const runQ = (bin, a, o) => {
    started++
    env = o.env
    const p = new EventEmitter()
    p.stdout = new PassThrough()
    p.stdin = new PassThrough()
    p.kill = () => {}
    setImmediate(() => p.stdout.write('{"ready":true}\n'))
    return p
  }
  const q = new QwenVoice({ dir, run: runQ, hub })
  await assert.rejects(talk({ op: 'warm' }, { voice: q }), (e) => e.code === 'nomodel' && /snapshot_download/.test(e.message))
  clearTimeout(q.idle)
  assert.equal(started, 0, '모델이 없으면 띄우지 않음(내려받기 없음)')
  assert.equal(hfCached(hub, QWEN_MODEL), false)
  const snap = path.join(hub, `models--${QWEN_MODEL.replace('/', '--')}`, 'snapshots', 'abc')
  fs.mkdirSync(snap, { recursive: true })
  assert.equal(hfCached(hub, QWEN_MODEL), false, '빈 스냅샷은 받은 것이 아님')
  fs.writeFileSync(path.join(snap, 'config.json'), '{}')
  assert.equal(hfCached(hub, QWEN_MODEL), true)
  await talk({ op: 'warm' }, { voice: q })
  q.stop()
  clearTimeout(q.idle)
  assert.equal(started, 1)
  assert.equal(env.HF_HUB_OFFLINE, '1')
  assert.equal(env.HF_HUB_CACHE, hub)
})
