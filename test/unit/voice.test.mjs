// 음성 입력(REQ-F-754): 전처리(WAV, 잡음 게이트, 무음)와 정리(군말, 문장 부호, 용어)를 마이크·모델 없이 시험한다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWav, wavOf, spectralGate, isSilent, rms, cleanTranscript, applyTerms, parseTerms, termsPrompt, voiceOpts, transcribe, VoiceError } from '../../agent/voice.mjs'

const R = 16000
// Always the same "noise", so a run never passes by luck.
function rand(seed = 7) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648 - 0.5)
}
const tone = (sec, f = 440, amp = 0.3) => Float32Array.from({ length: R * sec }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / R))
const noise = (n, amp, r = rand()) => Float32Array.from({ length: n }, () => amp * 2 * r())

test('WAV: 쓴 것을 그대로 읽는다(16비트 반올림 안)', () => {
  const x = tone(0.5)
  const { rate, samples } = parseWav(wavOf(x))
  assert.equal(rate, R)
  assert.equal(samples.length, x.length)
  for (let i = 0; i < x.length; i += 97) assert.ok(Math.abs(samples[i] - x[i]) < 1e-4)
})

test('WAV: 스테레오는 평균, WAV 가 아니면 audio 오류', () => {
  const buf = Buffer.alloc(44 + 8)
  buf.write('RIFF', 0, 'ascii'), buf.writeUInt32LE(44, 4), buf.write('WAVEfmt ', 8, 'ascii'), buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20), buf.writeUInt16LE(2, 22), buf.writeUInt32LE(R, 24), buf.writeUInt32LE(R * 4, 28), buf.writeUInt16LE(4, 32), buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'), buf.writeUInt32LE(8, 40)
  buf.writeInt16LE(16384, 44), buf.writeInt16LE(0, 46), buf.writeInt16LE(-16384, 48), buf.writeInt16LE(-16384, 50)
  assert.deepEqual([...parseWav(buf).samples], [0.25, -0.5])
  assert.throws(() => parseWav(Buffer.from('not a wav file at all, no header here.......')), (e) => e instanceof VoiceError && e.code === 'audio')
})

test('잡음 게이트: 말 없는 구간의 잡음은 크게 줄고, 소리는 남는다', () => {
  // 1초 잡음만, 1초 소리+잡음, 1초 잡음만
  const clean = new Float32Array(R * 3)
  clean.set(tone(1), R)
  const nz = noise(clean.length, 0.03)
  const x = clean.map((v, i) => v + nz[i])
  const y = spectralGate(x)
  assert.equal(y.length, x.length)
  const quietBefore = rms(x.subarray(0, R))
  const quietAfter = rms(y.subarray(0, R))
  assert.ok(quietAfter < quietBefore * 0.35, `잡음 ${quietBefore.toFixed(4)} → ${quietAfter.toFixed(4)}`)
  // 소리 구간은 원래 소리에 가깝다: 남은 오차가 잡음보다 작다.
  const mid = (a) => a.subarray(R + 1000, 2 * R - 1000)
  const err = rms(mid(y).map((v, i) => v - mid(clean)[i]))
  assert.ok(err < rms(mid(nz)), `오차 ${err.toFixed(4)} < 잡음 ${rms(mid(nz)).toFixed(4)}`)
  assert.ok(rms(mid(y)) > rms(mid(clean)) * 0.8)
})

test('잡음 게이트: 잡음이 없으면 거의 그대로, 짧으면 그대로', () => {
  const x = new Float32Array(R * 2)
  x.set(tone(1), R / 2)
  const y = spectralGate(x)
  const err = rms(y.map((v, i) => v - x[i]))
  assert.ok(err < 0.01, `오차 ${err}`)
  const short = tone(0.01)
  assert.deepEqual([...spectralGate(short)], [...short])
})

test('무음 판정: 아주 작은 잡음은 무음, 말소리 크기는 아님', () => {
  assert.equal(isSilent(noise(R, 0.002)), true)
  assert.equal(isSilent(new Float32Array(R)), true)
  const x = noise(R, 0.002)
  x.set(tone(0.2, 300, 0.05), R / 2)
  assert.equal(isSilent(x), false)
})

test('정리: 한국어 군말과 쉼표를 걷어 낸다', () => {
  assert.equal(cleanTranscript('음, 그러니까 클로드 브리지에서 워크트리 만들고, 어, 매니페스트 고쳐서 PR 올려줘.'), '클로드 브리지에서 워크트리 만들고, 매니페스트 고쳐서 PR 올려줘.')
  assert.equal(cleanTranscript('어어 그 그 파일 열어 줘'), '그 파일 열어 줘')
  assert.equal(cleanTranscript('음... 테스트 돌려 줘'), '테스트 돌려 줘')
})

test('정리: 뜻이 있는 낱말은 남긴다', () => {
  // "그러니까" 가 문장 가운데서 이유를 말할 때, "그" 가 가리킬 때, "어" 가 낱말 안에 있을 때
  assert.equal(cleanTranscript('비가 와서 그러니까 내일 하자'), '비가 와서 그러니까 내일 하자')
  assert.equal(cleanTranscript('그 함수 이름 바꿔 줘'), '그 함수 이름 바꿔 줘')
  assert.equal(cleanTranscript('어디서 에러가 나?'), '어디서 에러가 나?')
  assert.equal(cleanTranscript('많이 많이 고쳐 줘'), '많이 많이 고쳐 줘')
})

test('정리: 영어 군말과 문장 부호', () => {
  assert.equal(cleanTranscript('Um, so, I mean, run the the tests , please..'), 'run the tests, please.')
  assert.equal(cleanTranscript('uh can you,, check it ?'), 'can you, check it?')
  assert.equal(cleanTranscript('버전은 1.140 이고,다음은 2.0'), '버전은 1.140 이고, 다음은 2.0')
})

test('정리: 무음에서 Whisper 가 지어내는 문장은 비운다', () => {
  for (const s of ['시청해주셔서 감사합니다.', '구독과 좋아요 부탁드립니다', 'Thank you for watching!', '[BLANK_AUDIO]']) assert.equal(cleanTranscript(s), '', s)
  assert.equal(cleanTranscript('시청해주셔서 감사합니다 라는 문구 지워 줘'), '시청해주셔서 감사합니다 라는 문구 지워 줘')
})

test('용어: 사전에 적힌 표기로 맞춘다', () => {
  const terms = parseTerms('claude-bridge\nKubernetes, PR\n\nkubernetes\nworktree')
  assert.deepEqual(terms, ['claude-bridge', 'Kubernetes', 'PR', 'worktree'])
  assert.equal(applyTerms('Claude-bridge 에서 claude bridge 랑 ClaudeBridge 를 kubernetes 로 pr', terms), 'claude-bridge 에서 claude-bridge 랑 claude-bridge 를 Kubernetes 로 PR')
  // 다른 낱말의 일부는 건드리지 않는다
  assert.equal(applyTerms('prefix sprint', terms), 'prefix sprint')
  assert.equal(cleanTranscript('음, Claude-bridge에서 worktree 만들어', terms), 'claude-bridge에서 worktree 만들어')
})

test('용어: 프롬프트는 600자를 넘지 않는다', () => {
  const terms = Array.from({ length: 100 }, (_, i) => `term-number-${i}`)
  const p = termsPrompt(terms)
  assert.ok(p.length <= 600 && p.startsWith('term-number-0, term-number-1'))
  assert.equal(termsPrompt([]), '')
})

test('용어: 한국어면 프롬프트 맨 끝에 명령 낱말(전송, 리셋), 600자 안에서', () => {
  assert.equal(termsPrompt([], 'ko'), '전송, 리셋')
  assert.equal(termsPrompt(['claude-bridge', 'worktree'], 'ko'), 'claude-bridge, worktree, 전송, 리셋')
  assert.equal(termsPrompt(['claude-bridge'], 'en'), 'claude-bridge')
  const p = termsPrompt(Array.from({ length: 100 }, (_, i) => `term-number-${i}`), 'ko')
  assert.ok(p.length <= 600 && p.endsWith(', 전송, 리셋'))
})

test('설정: 모르는 값은 기본값으로', () => {
  assert.deepEqual(voiceOpts({}), { model: 'large-v3-turbo-q5_0', language: 'ko', denoise: true, tidy: true, terms: [] })
  // An older server's backend 'openai' is read past: speech is always turned into words on the Mac (1.231).
  assert.deepEqual(voiceOpts({ backend: 'openai', model: '../x', language: 'fr', denoise: false, tidy: false, terms: 'a,b' }), { model: 'large-v3-turbo-q5_0', language: 'ko', denoise: false, tidy: false, terms: ['a', 'b'] })
})

test('전체: 짧음·무음은 모델을 부르지 않고, 원문과 정리본을 함께 돌려준다', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-voice-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'whisper')
  fs.mkdirSync(dir)
  let calls = 0
  const local = { transcribe: async (wav, o) => (calls++, { text: ` 음, Claude-bridge 테스트 돌려 줘 (${o.prompt})`, how: 'fake' }) }
  await assert.rejects(transcribe(wavOf(tone(0.1)), {}, { dir, local }), (e) => e.code === 'silent')
  await assert.rejects(transcribe(wavOf(new Float32Array(R)), {}, { dir, local }), (e) => e.code === 'silent')
  assert.equal(calls, 0)
  const r = await transcribe(wavOf(tone(1)), { terms: 'claude-bridge', denoise: false }, { dir, local })
  // The prompt the model was given comes back in the fake's words: the terms, then the command words.
  assert.equal(r.raw, '음, Claude-bridge 테스트 돌려 줘 (claude-bridge, 전송, 리셋)')
  assert.equal(r.text, 'claude-bridge 테스트 돌려 줘 (claude-bridge, 전송, 리셋)')
  assert.equal(r.denoise, 'off')
  const logged = JSON.parse(fs.readFileSync(path.join(home, 'voice.log'), 'utf8').trim())
  assert.equal(logged.raw, r.raw)
  assert.equal(logged.text, r.text)
})

test('잡음에 지어낸 짧은 말(확신 −0.2 미만, 20자 이하)은 버리고 기록에 남긴다', async (t) => {
  const { meanLogprob, isPhantomGuess } = await import('../../agent/voice.mjs')
  // Values whisper-server gave on this Mac: a cough → "감사합니다." −0.685, "날씨였습니다." −0.274; words −0.002 ~ −0.103.
  assert.ok(Math.abs(meanLogprob([{ start: 0, end: 1, avg_logprob: -0.6 }, { start: 1, end: 4, avg_logprob: -0.2 }]) + 0.3) < 1e-9)
  assert.equal(meanLogprob([]), null)
  assert.equal(meanLogprob(undefined), null)
  assert.equal(isPhantomGuess('감사합니다.', -0.685, 'large-v3-turbo-q5_0'), true)
  assert.equal(isPhantomGuess('감사합니다.', -0.22, 'large-v3-turbo-q5_0'), true)
  assert.equal(isPhantomGuess('날씨였습니다.', -0.274, 'base'), true)
  assert.equal(isPhantomGuess('감사합니다.', -0.041, 'large-v3-turbo-q5_0'), false)
  assert.equal(isPhantomGuess('누가 기침 소리를 내었는가?', -0.172, 'base'), false)
  assert.equal(isPhantomGuess('감사합니다.', -0.22, 'base'), false)
  assert.equal(isPhantomGuess('감사합니다.', null), false)
  assert.equal(isPhantomGuess('이 문장은 공백을 빼고 스무 자가 넘는 긴 말이라 버리지 않아요', -0.5), false)

  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-voice-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'whisper')
  fs.mkdirSync(dir)
  const local = { transcribe: async () => ({ text: ' 감사합니다.', how: 'fake', lp: -0.685 }) }
  await assert.rejects(transcribe(wavOf(tone(1)), { denoise: false }, { dir, local }), (e) => e.code === 'silent')
  const logged = JSON.parse(fs.readFileSync(path.join(home, 'voice.log'), 'utf8').trim())
  assert.equal(logged.raw, '감사합니다.')
  assert.equal(logged.text, '')
  assert.equal(logged.lp, -0.685)
  assert.equal(logged.dropped, 'phantom')
})

test('말소리 감지(VAD)를 쓰면 빈 결과는 버리고, 확신이 낮은 짧은 말도 보낸다 (1.183)', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-voice-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'whisper')
  fs.mkdirSync(dir)
  const lines = () => fs.readFileSync(path.join(home, 'voice.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  // A noise: VAD finds no speech, whisper-server gives nothing.
  await assert.rejects(transcribe(wavOf(tone(1)), { denoise: false }, { dir, local: { transcribe: async () => ({ text: '', how: 'fake', lp: null, vad: true }) } }), (e) => e.code === 'silent')
  assert.equal(lines().at(-1).dropped, 'vad')
  assert.equal(lines().at(-1).vad, true)
  // A real "네." came out at −0.482 on this Mac: with VAD it is sent.
  const r = await transcribe(wavOf(tone(1)), { denoise: false, tidy: false }, { dir, local: { transcribe: async () => ({ text: '네.', how: 'fake', lp: -0.482, vad: true }) } })
  assert.equal(r.text, '네.')
  assert.equal(lines().at(-1).dropped, undefined)
})

test('말소리 감지 모델은 한 번 받아 해시를 맞춰 보고, 틀리면 저장하지 않고 한 시간 안에 다시 받지 않는다', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const crypto = await import('node:crypto')
  const { LocalWhisper, VAD_MODEL } = await import('../../agent/voice.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vad-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let calls = 0
  const body = Buffer.from('fake silero')
  const fetchFn = async (url) => (calls++, assert.equal(url, VAD_MODEL.url), new Response(body))
  const bad = new LocalWhisper({ dir, fetchFn })
  assert.equal(await bad.vad(), null)
  assert.equal(await bad.vad(), null)
  assert.equal(calls, 1)
  assert.equal(fs.existsSync(path.join(dir, VAD_MODEL.name)), false)
  const real = VAD_MODEL.sha256
  VAD_MODEL.sha256 = crypto.createHash('sha256').update(body).digest('hex')
  t.after(() => (VAD_MODEL.sha256 = real))
  const good = new LocalWhisper({ dir, fetchFn })
  assert.equal(await good.vad(), path.join(dir, VAD_MODEL.name))
  assert.equal(fs.readFileSync(path.join(dir, VAD_MODEL.name), 'utf8'), 'fake silero')
  assert.equal(await good.vad(), path.join(dir, VAD_MODEL.name))
  assert.equal(calls, 2)
})

test('whisper-server 가 --vad 로 뜨지 않으면 한 시간 동안만 없이 쓰고, 그 뒤 다시 켠다 (1.194)', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { LocalWhisper, VAD_MODEL } = await import('../../agent/voice.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vad-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, VAD_MODEL.name)
  fs.writeFileSync(file, 'silero')
  const w = new LocalWhisper({ dir, fetchFn: async () => assert.fail('no download') })
  assert.equal(await w.vad(), file)
  w.vadBrokenAt = Date.now()
  assert.equal(await w.vad(), null)
  w.vadBrokenAt = Date.now() - LocalWhisper.VAD_RETRY_MS - 1
  assert.equal(await w.vad(), file)
})

test('맥의 음성 준비 상태: 받아 둔 모델, 감지 모델, 서버의 VAD, 프로그램 (1.194)', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { LocalWhisper, VAD_MODEL, voiceStatus } = await import('../../agent/voice.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vs-'))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vs-bin-'))
  t.after(() => [dir, bin].forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
  assert.deepEqual(voiceStatus({ dir, bins: [bin] }), { whisper: false, models: [], vadModel: false, vad: 'idle', ffmpeg: false })
  fs.writeFileSync(path.join(dir, 'ggml-small.bin'), 'm')
  fs.writeFileSync(path.join(dir, VAD_MODEL.name), 'v')
  fs.writeFileSync(path.join(bin, 'whisper-cli'), '', { mode: 0o755 })
  const local = new LocalWhisper({ dir })
  assert.deepEqual(voiceStatus({ dir, local, bins: [bin] }), { whisper: true, models: ['small'], vadModel: true, vad: 'idle', ffmpeg: false })
  local.vadBrokenAt = Date.now()
  assert.equal(voiceStatus({ dir, local, bins: [bin] }).vad, 'off')
  local.srv = { vad: path.join(dir, VAD_MODEL.name), dead: false }
  assert.equal(voiceStatus({ dir, local, bins: [bin] }).vad, 'on')
})

test('서버: 음성 설정은 계정에 저장하고 목록 밖 값은 400, /api/me 에도 실린다', async () => {
  const { startServer } = await import('./server-harness.mjs')
  const s = await startServer()
  try {
    await s.login('alice')
    const first = await s.api('alice', '/api/prefs/voice')
    assert.deepEqual(first.json, { on: false, model: 'large-v3-turbo-q5_0', language: 'ko', denoise: true, tidy: true, terms: '' })
    const bad = await s.api('alice', '/api/prefs/voice', { method: 'POST', body: { on: true, model: '../../etc/passwd' } })
    assert.equal(bad.status, 400)
    assert.equal((await s.api('alice', '/api/prefs/voice')).json.on, false)
    const ok = await s.api('alice', '/api/prefs/voice', { method: 'POST', body: { on: true, backend: 'openai', language: 'auto', denoise: false, terms: 'claude-bridge\nPR' } })
    assert.equal(ok.status, 200)
    const me = (await s.api('alice', '/api/me')).json
    assert.deepEqual(me.voice, { on: true, model: 'large-v3-turbo-q5_0', language: 'auto', denoise: false, tidy: true, terms: 'claude-bridge\nPR' })
    // Another person's settings are their own.
    await s.login('bob')
    assert.equal((await s.api('bob', '/api/prefs/voice')).json.on, false)
    assert.equal((await s.api('alice', '/api/prefs/voice', { method: 'DELETE', body: {} })).status, 405)
  } finally {
    await s.stop()
  }
})

test('서버: 맥마다 모델은 자기 맥에만, 목록 밖 값은 400, 비우면 계정 값을 따른다 (1.193, 1.231)', async () => {
  const { startServer } = await import('./server-harness.mjs')
  const s = await startServer({ seed: { 'hosts.json': { 'h-alice-mac': { uid: 'dev-alice', name: 'alice-mac', home: '/Users/alice', lastSeen: Date.now() }, 'h-bob-mac1': { uid: 'dev-bob', name: 'bob-mac', home: '/Users/bob', lastSeen: Date.now() } } } })
  try {
    await s.login('alice')
    assert.deepEqual((await s.api('alice', '/api/prefs/voice/hosts')).json, { hosts: {} })
    const set = (body) => s.api('alice', '/api/prefs/voice/hosts', { method: 'POST', body })
    assert.equal((await set({ host: 'h-bob-mac1', backend: 'openai' })).status, 404)
    assert.equal((await set({ host: 'h-alice-mac', model: '../../etc/passwd' })).status, 400)
    const ok = await set({ host: 'h-alice-mac', backend: 'local', model: 'small' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json.hosts, { 'h-alice-mac': { model: 'small' } })
    assert.deepEqual((await s.api('alice', '/api/prefs/voice/hosts')).json.hosts, { 'h-alice-mac': { model: 'small' } })
    // The account's own settings are untouched.
    assert.equal((await s.api('alice', '/api/prefs/voice')).json.model, 'large-v3-turbo-q5_0')
    assert.deepEqual((await set({ host: 'h-alice-mac', model: '' })).json.hosts, {})
    await s.login('bob')
    assert.deepEqual((await s.api('bob', '/api/prefs/voice/hosts')).json, { hosts: {} })
  } finally {
    await s.stop()
  }
})

test('서버: 예전에 저장한 backend openai 는 오류 없이 맥(로컬)으로 읽고, 옛 화면이 보내도 받는다 (1.231)', async () => {
  const { startServer } = await import('./server-harness.mjs')
  const old = { voice: { on: true, backend: 'openai', model: 'small', language: 'ko', denoise: true, tidy: true, terms: '' }, voiceHosts: { 'h-alice-mac': { backend: 'openai', model: '' }, 'h-alice-mac2': { backend: 'openai', model: 'base' } } }
  const hostsSeed = { 'h-alice-mac': { uid: 'dev-alice', name: 'alice-mac', home: '/Users/alice', lastSeen: Date.now() }, 'h-alice-mac2': { uid: 'dev-alice', name: 'alice-mac2', home: '/Users/alice', lastSeen: Date.now() } }
  const s = await startServer({ seed: { 'hosts.json': hostsSeed, 'u/dev-alice/prefs.json': old } })
  try {
    await s.login('alice')
    const v = await s.api('alice', '/api/prefs/voice')
    assert.equal(v.status, 200)
    assert.deepEqual(v.json, { on: true, model: 'small', language: 'ko', denoise: true, tidy: true, terms: '' })
    assert.deepEqual((await s.api('alice', '/api/prefs/voice/hosts')).json.hosts, { 'h-alice-mac2': { model: 'base' } })
    // A page older than 1.231 still sends backend: saved, not refused.
    const post = await s.api('alice', '/api/prefs/voice', { method: 'POST', body: { ...old.voice } })
    assert.equal(post.status, 200)
    assert.equal(post.json.backend, undefined)
  } finally {
    await s.stop()
  }
})

test('제품 코드는 녹음을 외부 AI 로 보내지 않는다: api.openai.com 이 없다 (1.231)', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const root = path.join(import.meta.dirname, '../..')
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (/\.(mjs|js|ts|tsx|html)$/.test(e.name) && fs.readFileSync(f, 'utf8').includes('api.openai.com')) hits.push(path.relative(root, f))
    }
  }
  for (const d of ['agent', 'server', 'ui/src', 'web']) walk(path.join(root, d))
  assert.deepEqual(hits, [])
})
