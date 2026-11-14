// 대화 모드 (REQ-F-907): the rules that need no model answer the plain cases and say 'unsure' for the rest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bargeIn, speakable, turnEnd } from '../../ui/src/lib/talk.ts'
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
