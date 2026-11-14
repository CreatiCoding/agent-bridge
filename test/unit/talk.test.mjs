// 대화 모드 (REQ-F-907): the rules that need no model answer the plain cases and say 'unsure' for the rest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bargeIn, nearLevel, speakable, turnEnd } from '../../ui/src/lib/talk.ts'
import { withHint, withoutHint } from '../../ui/src/lib/timeline.ts'

test('AC-1791 말 끝: 끝맺는 말은 보내고, 잇는 말은 기다리고, 애매하면 모델에게 묻는다', () => {
  for (const t of ['배포 확인해 줘.', '그거 됐어요', '다음으로 넘어갈까', '테스트 돌려 봐', '이거 맞지?', '좋아 그렇게 하자', '헬스 체크 정상이다', '그거 왜 안 돼?']) assert.equal(turnEnd(t), 'done', t)
  for (const t of ['그 배포 건 확인해 보고', '테스트는 통과했는데', '그리고', '음', '로그를 보면', '서버에서', '그래서 내 생각에는', '맥 미니랑', '아']) assert.equal(turnEnd(t), 'more', t)
  for (const t of ['그거 하니까', 'claude-bridge', '빠르게']) assert.equal(turnEnd(t), 'unsure', t)
  assert.equal(turnEnd(''), 'more')
})

test('AC-1792 읽을 문장: 코드·표·경로·링크 주소는 빼고, 남은 게 거의 없거나 영어뿐이면 애매하다', () => {
  const md = ['**→ 배포 끝났어요.** health 도 정상이에요 ✅', '', '```sh', 'npm test', '```', '| a | b |', '- `npm test` 통과, ui/src/lib/talk.ts 고침', '[CI](https://ci.example.dev/x) 확인했어요.'].join('\n')
  assert.deepEqual(speakable(md), ['배포 끝났어요.', 'health 도 정상이에요', 'npm test 통과, 고침', 'CI 확인했어요.'])
  assert.equal(speakable('The build passed and the deploy is done.'), 'unsure')
  assert.equal(speakable('```\n' + 'x = 1\n'.repeat(60) + '```\n고쳤어요'), 'unsure')
  assert.deepEqual(speakable(''), [])
})

test('AC-1793 끼어들기: 짧은 소리엔 줄이기만, 말로 확인되면 멈춘다', () => {
  assert.equal(bargeIn(100, false), 'none')
  assert.equal(bargeIn(300, false), 'duck')
  assert.equal(bargeIn(300, true), 'stop')
  assert.equal(bargeIn(700, false), 'stop')
})

test('AC-1814 끼어들기: 내 목소리보다 훨씬 작은 소리(지하철)는 읽기를 멈추지 않는다', () => {
  assert.equal(nearLevel(0.05, []), undefined)
  assert.equal(nearLevel(0.03, [0.12, 0.14, 0.16]), false)
  assert.equal(nearLevel(0.1, [0.12, 0.14, 0.16]), true)
  assert.equal(bargeIn(300, false, false), 'duck')
  assert.equal(bargeIn(700, false, false), 'none')
  assert.equal(bargeIn(5000, true, false), 'none')
  assert.equal(bargeIn(700, false, true), 'stop')
  assert.equal(bargeIn(700, false, undefined), 'stop')
})

test('AC-1794 대화 모드로 보낸 말의 안내는 화면에서 다시 뗀다', () => {
  assert.equal(withoutHint(withHint('배포해 줘')), '배포해 줘')
  assert.equal(withoutHint('그냥 말'), '그냥 말')
})

test('AC-1795 스피커로 되돌아온 내 답은 사람 말로 보내지 않는다', async () => {
  const { isEcho } = await import('../../ui/src/lib/talk.ts')
  assert.equal(isEcho('배포는 끝났고 헬스 체크도 정상이에요', '배포는 끝났고, 헬스 체크도 정상이에요. 다음으로 넘어갈까요?'), true)
  assert.equal(isEcho('아니 잠깐 멈춰 봐', '배포는 끝났고, 헬스 체크도 정상이에요.'), false)
  assert.equal(isEcho('네', '네, 확인했어요.'), false)
})

test('AC-1796 맥: 한국어 목소리는 프리미엄·여성 순으로 고르고, 판정은 DONE 일 때만 끝으로 본다', async () => {
  const { koreanVoices, parseTurn, talk } = await import('../../agent/talk.mjs')
  const list = ['Alex                en_US    # Hello', 'Minsu               ko_KR    # 안녕하세요', 'Yuna                ko_KR    # 안녕하세요', 'Yuna (Premium)      ko_KR    # 안녕하세요'].join('\n')
  assert.deepEqual(koreanVoices(list), ['Yuna (Premium)', 'Yuna', 'Minsu'])
  assert.equal(parseTurn('DONE'), 'done')
  assert.equal(parseTurn('MORE'), 'more')
  assert.equal(parseTurn('잘 모르겠어요'), 'more')
  const voice = { speak: async (t) => ({ audio: 'UklGRg==', mime: 'audio/wav', engine: 'fake', said: t }) }
  const judge = { ask: async (p) => (p.startsWith('TURN') ? 'DONE' : '배포가 끝났어요.') }
  assert.equal((await talk({ op: 'tts', text: ' 안녕 ' }, { voice, judge })).said, '안녕')
  assert.equal((await talk({ op: 'turn', text: '그거 하니까' }, { voice, judge })).end, 'done')
  assert.equal((await talk({ op: 'brief', text: '```\nx\n```' }, { voice, judge })).line, '배포가 끝났어요.')
  await assert.rejects(talk({ op: 'tts', text: '  ' }, { voice, judge }), /비었/)
})

test('AC-1797 맥: 판정기는 claude 를 한 번 띄워 두고 묻고, 정한 횟수가 차면 새로 띄운다', async () => {
  const { Judge } = await import('../../agent/talk.mjs')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const spawned = []
  const run = (bin, args) => {
    const p = new EventEmitter()
    p.stdout = new PassThrough()
    p.stdin = new PassThrough()
    p.kill = () => p.emit('exit')
    p.stdin.on('data', (d) => {
      const m = JSON.parse(String(d))
      p.stdout.write(`${JSON.stringify({ type: 'result', result: m.message.content.startsWith('TURN') ? 'DONE' : 'x' })}\n`)
    })
    spawned.push(args)
    return p
  }
  const j = new Judge({ run, fresh: 2, idleMs: 60_000 })
  assert.equal(await j.ask('TURN\n가'), 'DONE')
  assert.equal(await j.ask('TURN\n나'), 'DONE')
  assert.equal(spawned.length, 1)
  assert.equal(await j.ask('SAY\n다'), 'x')
  assert.equal(spawned.length, 2)
  assert.ok(spawned[0].includes('--no-session-persistence') && spawned[0].includes('haiku'))
  j.stop()
  clearTimeout(j.idle)
})

test('AC-1800 리눅스: 목소리는 Supertonic 하나를 띄워 두고 묻고, 없으면 설치 방법을 알린다', async () => {
  const { SupertonicVoice } = await import('../../agent/talk.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'))
  const none = new SupertonicVoice({ dir })
  await assert.rejects(none.speak('안녕'), (e) => e.code === 'novoice' && /pip install supertonic/.test(e.message))

  fs.mkdirSync(path.join(dir, 'supertonic', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'supertonic', 'bin', 'python'), '')
  let starts = 0
  const asked = []
  const run = (bin, args) => {
    starts++
    assert.equal(bin, path.join(dir, 'supertonic', 'bin', 'python'))
    assert.deepEqual(args.slice(0, 2), ['-I', '-c'])
    const p = new EventEmitter()
    p.stdout = new PassThrough()
    p.stdin = new PassThrough()
    p.kill = () => {}
    let buf = ''
    p.stdin.on('data', (d) => {
      buf += d
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const q = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        asked.push(q)
        fs.writeFileSync(q.out, 'RIFF')
        p.stdout.write(`${JSON.stringify({ id: q.id, ok: true })}\n`)
      }
    })
    setImmediate(() => p.stdout.write('{"ready":true}\n'))
    return p
  }
  const v = new SupertonicVoice({ dir, run, voice: 'F3', steps: 4 })
  const a = await v.speak('배포가 끝났어요.')
  const b = await v.speak('다음으로 넘어갈까요?', 1)
  await v.speak('빠르게', 2)
  v.stop()
  clearTimeout(v.idle)
  assert.equal(starts, 1)
  assert.equal(Buffer.from(a.audio, 'base64').toString(), 'RIFF')
  assert.equal(b.engine, 'supertonic:F3')
  assert.deepEqual(asked.map((q) => [q.text, q.voice, q.steps]), [['배포가 끝났어요.', 'F3', 4], ['다음으로 넘어갈까요?', 'F3', 4], ['빠르게', 'F3', 4]])
  // The page's rate × 1.05, never past the speed where it starts dropping words (1.534).
  assert.deepEqual(asked.map((q) => q.speed), [1.3, 1.05, 1.3])
  for (const q of asked) assert.equal(fs.existsSync(q.out), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('AC-1802 가까이서 한 말만: 방 소음보다 충분히 크지 않거나, 짧은데 조금만 크거나, 짧은 외국어면 버린다', async () => {
  const { nearVoice, learnVoice, NEAR } = await import('../../ui/src/lib/talk.ts')
  assert.equal(nearVoice('배포 상태 확인해 줘', { level: 0.2, snr: 8 }, []), 'keep')
  assert.equal(nearVoice('배포 상태 확인해 줘', { level: 0.05, snr: 2 }, []), 'far')
  assert.equal(nearVoice('네 감사합니다', { level: 0.1, snr: 4 }, []), 'short')
  assert.equal(nearVoice('네 감사합니다', { level: 0.2, snr: 9 }, []), 'keep')
  // 10 letters or fewer, only a little over the room: a passer-by's phrase (1.534).
  assert.equal(nearVoice('시각 세계였습니다', { level: 0.1, snr: 4 }, []), 'short')
  assert.equal(nearVoice('안녕하십니까 내 말이 들려', { level: 0.1, snr: 4 }, []), 'keep')
  assert.equal(nearVoice('Amen', { level: 0.2, snr: 9 }, []), 'short')
  assert.equal(nearVoice('and the clock', { level: 0.2, snr: 9 }, []), 'short')
  assert.equal(nearVoice('아무 말', undefined, []), 'keep')
  // Once the person's own level is known, a phrase well under it is someone further away.
  let v = []
  for (const l of [0.3, 0.32, 0.28]) v = learnVoice(v, '이번 배포 결과 알려 줘', { level: l, snr: 9 })
  assert.equal(v.length, 3)
  // One clear phrase is enough to know them: voice.log, a quiet room (snr 63~134), "마이크 테스트" 0.141 then a
  // "감사합니다" at 0.04 the person did not say (1.536).
  assert.equal(nearVoice('감사합니다.', { level: 0.04, snr: 80.669 }, [0.141]), 'far')
  assert.equal(nearVoice('방금 감사합니다. 내가 말한 게 아닌', { level: 0.135, snr: 134.332 }, [0.141]), 'keep')
  assert.equal(nearVoice('다음 역은 강남 강남역입니다', { level: 0.1, snr: 6 }, v), 'far')
  assert.equal(nearVoice('다음으로 넘어가 줘', { level: 0.25, snr: 6 }, v), 'keep')
  // Only clear phrases teach it, and only the last few.
  assert.equal(learnVoice(v, '네', { level: 0.01, snr: 9 }), v)
  assert.equal(learnVoice(v, '이번 배포 결과 알려 줘', { level: 0.01, snr: 3 }), v)
  for (let i = 0; i < 10; i++) v = learnVoice(v, '이번 배포 결과 알려 줘', { level: 0.3, snr: 9 })
  assert.equal(v.length, NEAR.learn)
})

test('AC-1807 읽는 속도와 기록: 속도는 0.5~2 로 묶고, 소리 길이를 재고, 들린 크기만 voice.log 에 남긴다', async (t) => {
  const { talkRate, wavSeconds, talk } = await import('../../agent/talk.mjs')
  const { heardOf, transcribe } = await import('../../agent/voice.mjs')
  assert.equal(talkRate(1.25), 1.25)
  assert.equal(talkRate(9), 2)
  assert.equal(talkRate(0.1), 0.5)
  assert.equal(talkRate('1.5'), 1.5)
  assert.equal(talkRate(undefined), 1.5)
  const said = []
  await talk({ op: 'tts', text: '안녕', rate: 1.25 }, { voice: { speak: async (s, r) => (said.push([s, r]), { audio: '' }) } })
  assert.deepEqual(said, [['안녕', 1.25]])
  const wav = Buffer.alloc(44 + 48000)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(48000, 28)
  assert.equal(wavSeconds(wav.toString('base64')), 1)
  assert.equal(wavSeconds('bm9wZQ=='), 0)
  assert.deepEqual(heardOf({ snr: 4.27341, level: 0.0123456, text: '몰래' }), { heard: { snr: 4.273, level: 0.012 } })
  assert.deepEqual(heardOf({ snr: 'x', level: -1 }), {})
  assert.deepEqual(heardOf(undefined), {})

  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-voice-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'whisper')
  fs.mkdirSync(dir)
  const R = 16000
  const pcm = Buffer.alloc(44 + R * 2)
  pcm.write('RIFF', 0, 'ascii'); pcm.write('WAVEfmt ', 8, 'ascii'); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(R, 24); pcm.writeUInt32LE(R * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36, 'ascii'); pcm.writeUInt32LE(R * 2, 40)
  for (let i = 0; i < R; i++) pcm.writeInt16LE(Math.round(Math.sin((i / R) * 2 * Math.PI * 220) * 8000), 44 + i * 2)
  const local = { transcribe: async () => ({ text: ' 러시아', how: 'fake' }) }
  await transcribe(pcm, { denoise: false }, { dir, local, heard: { snr: 6.1, level: 0.08 } })
  const logged = JSON.parse(fs.readFileSync(path.join(home, 'voice.log'), 'utf8').trim())
  assert.deepEqual(logged.heard, { snr: 6.1, level: 0.08 })
  assert.equal(logged.raw, '러시아')
})

test('AC-1809 소희: 맥 미니의 Qwen3-TTS 를 띄워 두고 1배는 원래 빠르기로 atempo, 화면은 끊기지 않을 만큼 모일 때까지 기다린다', async () => {
  const { QwenVoice, QWEN_PACE, QWEN_PY, hasQwen } = await import('../../agent/talk.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-'))
  await assert.rejects(new QwenVoice({ dir }).speak('안녕'), (e) => e.code === 'novoice' && /uv pip install mlx-audio/.test(e.message))
  assert.equal(hasQwen(dir), false)
  fs.mkdirSync(path.join(dir, 'qwentts', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'qwentts', 'bin', 'python'), '')
  assert.equal(hasQwen(dir), process.platform === 'darwin')
  const asked = []
  let args
  const run = (bin, a) => {
    args = [bin, a]
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
  const v = new QwenVoice({ dir, run })
  const a = await v.speak('배포가 끝났어요.', 1.25)
  v.stop()
  clearTimeout(v.idle)
  assert.equal(args[0], path.join(dir, 'qwentts', 'bin', 'python'))
  assert.deepEqual(args[1], ['-I', '-c', QWEN_PY, 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'])
  assert.equal(a.engine, 'qwen:Sohee')
  assert.equal(asked[0].voice, 'Sohee')
  assert.equal(QWEN_PACE, 1)
  assert.equal(asked[0].tempo, 1.25)
  assert.match(QWEN_PY, /atempo/)
  fs.rmSync(dir, { recursive: true, force: true })

  // Hold: what is left to make (letters × seconds a letter) and a little spare, less what is made already.
  const { holdFor } = await import('../../ui/src/lib/speaker.ts')
  assert.equal(holdFor(0, 0, 0.18), 0)
  assert.ok(Math.abs(holdFor(0, 100, 0.18) - 18.5) < 1e-9)
  assert.ok(Math.abs(holdFor(6, 100, 0.18) - 12.5) < 1e-9)
  assert.equal(holdFor(30, 100, 0.18), 0)
  // Supertonic makes a letter in ~0.04 s: a sentence made is about enough to start.
  assert.equal(holdFor(3, 60, 0.04), 0)
  // The first request of an answer is one sentence; after it, the waiting ones go together up to 120 letters.
  const { nextChunk, JOIN_CHARS } = await import('../../ui/src/lib/speaker.ts')
  const q = ['배포가 끝났어요.', '새로고침해 보세요.', '네.', 'x'.repeat(JOIN_CHARS)]
  assert.equal(nextChunk(q, true), '배포가 끝났어요.')
  assert.equal(nextChunk(q, false), '새로고침해 보세요. 네.')
  assert.equal(nextChunk(q, false), 'x'.repeat(JOIN_CHARS))
  assert.deepEqual(q, [])
})

test('AC-1809 Speaker: 다음 문장들을 차례로 만들고, 모인 소리가 남은 만들기 시간만큼 되면 읽는다', async () => {
  const { Speaker } = await import('../../ui/src/lib/speaker.ts')
  const played = []
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: { cancelScheduledValues() {}, setTargetAtTime() {} } }),
    decodeAudioData: async (b) => ({ duration: new Uint8Array(b)[0] }),
    createBufferSource: () => {
      const s = { connect() {}, start() { played.push(s.buffer.duration); setTimeout(() => s.onended(), 5) }, stop() {} }
      return s
    },
  }
  const made = []
  // Each sentence "lasts" as many seconds as its length, and is made at once.
  const sp = new Speaker(ctx, async (t) => (made.push(t), Uint8Array.of(t.length).buffer))
  const waits = []
  const states = []
  sp.onWait = (u) => waits.push(u)
  sp.onState = (on) => states.push(on)
  sp.say(['하나다', '둘이다요', '셋'])
  await new Promise((r) => setTimeout(r, 100))
  // The first alone, the rest together (1.539).
  assert.deepEqual(made, ['하나다', '둘이다요 셋'])
  assert.deepEqual(played, [3, 6])
  assert.deepEqual(states, [true, false])
  assert.equal(waits.at(-1), null)
  // stop(): nothing waiting is read, and it says it stopped.
  sp.say(['넷이다'])
  sp.stop()
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(played, [3, 6])
  assert.equal(states.at(-1), false)
})
