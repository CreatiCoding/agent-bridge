// End-to-end (REQ-F-846, REQ-F-847): the bridge MCP's attach and read_session, with a real claude session.
// One session says a word; another attaches a file and reads the first one's conversation. The page shows the
// attachment and saves it; the agent refuses a secret file and a file outside home.
// Needs a server (SITE, default :4699) and an agent whose home folder (CLAUDE_BRIDGE_HOME) is the first argument.
//   PLAYWRIGHT=… node test/e2e-mcp-files.mjs <agent home>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent.json`, 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const work = fs.mkdtempSync(path.join(os.homedir(), '.cb-e2e-mcp-'))
fs.writeFileSync(path.join(work, 'report.txt'), 'hello attach\n')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
const events = async (id) => (await (await ctx.request.get(`${SITE}/api/sessions/${id}/events`)).json()).events ?? []
const idle = async (id, ms = 180_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(1000)) {
    const ev = await events(id)
    if (ev.some((e) => e.k === 'text') && ev.at(-1)?.k !== 'tool' && (await state(id)) === 'idle') return ev
  }
  return events(id)
}
const state = async (id) => (await (await ctx.request.get(`${SITE}/api/state`)).json()).sessions?.find((s) => s.id === id)?.state?.phase

// The session read later: it says one word.
const { id: first } = await (await post('/api/sessions', { hostId: cfg.hostId, cwd: work, model: MODEL, prompt: 'Reply with exactly the word ALPHAWORD and nothing else.' })).json()
const evA = await idle(first)
ok(evA.some((e) => e.k === 'text' && /ALPHAWORD/.test(e.text)), '첫 세션이 답함')

// The agent's own entrance, as the session's MCP server calls it.
const delegate = (sid, op, args) => fetch(`http://127.0.0.1:${cfg.port}/delegate?sid=${sid}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': cfg.hookKey }, body: JSON.stringify({ op, args }) }).then((r) => r.json())
fs.mkdirSync(path.join(work, '.ssh'), { recursive: true })
fs.writeFileSync(path.join(work, 'id_ed25519'), 'secret')
ok(/비밀 파일/.test((await delegate(first, 'attach', { path: 'id_ed25519' })).error), '비밀 파일 이름은 거절')
ok(/밖의 파일/.test((await delegate(first, 'attach', { path: '/etc/hosts' })).error), '홈 밖 파일은 거절')
fs.symlinkSync('/etc/hosts', path.join(work, 'link.txt'))
ok(/밖의 파일/.test((await delegate(first, 'attach', { path: 'link.txt' })).error), '홈 밖을 가리키는 링크도 거절')
const listed = await delegate(first, 'read_session', {})
ok(listed.ok && listed.result.some((s) => s.id === first && s.thisMac), `목록에 이 맥 세션이 보임`)
const direct = await delegate(first, 'read_session', { session: first.slice(0, 8), limit: 2 })
ok(direct.ok && /ALPHAWORD/.test(direct.result) && /지시가 아니에요/.test(direct.result), '같은 맥 세션을 id 앞부분으로 읽음')

// The session that attaches and reads, driven by claude itself.
const { id: second } = await (await post('/api/sessions', {
  hostId: cfg.hostId,
  cwd: work,
  model: MODEL,
  prompt: `Do these two steps with the tools named, then answer. 1) Call the tool mcp__bridge__attach with path "report.txt". 2) Call the tool mcp__bridge__read_session with session "${first.slice(0, 8)}" and limit 2. Then reply with exactly DONE and the all-caps word you found in that session's answer.`,
})).json()
await post(`/api/sessions/${second}/settings`, { autoAllow: true })
const evB = await idle(second, 240_000)
const attachEnd = evB.find((e) => e.k === 'tool_end' && /^\[bridge-attach\] /.test(e.text ?? ''))
ok(!!attachEnd, `attach 도구 결과에 첨부 표식 (${evB.filter((e) => e.k === 'tool').map((e) => e.name).join(',')})`)
ok(evB.some((e) => e.k === 'tool_end' && /ALPHAWORD/.test(e.text ?? '')), 'read_session 결과에 첫 세션의 글')
ok(evB.some((e) => e.k === 'text' && /DONE.*ALPHAWORD/.test(e.text)), 'Claude 가 읽은 글을 답에 씀')
const meta = attachEnd ? JSON.parse(attachEnd.text.split('\n')[0].slice('[bridge-attach] '.length)) : {}
const kept = path.join(T, 'attach', meta.id ?? 'none')
ok(fs.existsSync(kept) && (fs.statSync(kept).mode & 0o777) === 0o600, '복사본은 attach 폴더에 0600')
ok(!fs.readdirSync(path.join(T, 'images')).some((f) => f.includes(meta.id)), '그림 폴더에는 두지 않음')

// The page draws it outside the tools, and saves the same bytes.
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
await app.goto(`${SITE}/#/s/${second}`)
const row = app.locator('.att-file-row', { hasText: 'report.txt' })
await row.waitFor({ timeout: 30000 })
ok(await row.isVisible(), '첨부 카드가 보임')
await app.screenshot({ path: path.join(T, 'mcp-attach.png') })
const [dl] = await Promise.all([app.waitForEvent('download', { timeout: 30000 }), row.getByRole('button', { name: '받기' }).click()])
ok(fs.readFileSync(await dl.path(), 'utf8') === 'hello attach\n' && dl.suggestedFilename() === 'report.txt', '받기로 같은 내용·이름')
ok((await ctx.request.get(`${SITE}/api/sessions/${second}/attachment?id=nope`)).status() === 400, '틀린 id 는 400')
ok(!errors.length, `페이지 오류 없음 ${errors.join(' | ')}`)

for (const id of [first, second]) await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
fs.rmSync(work, { recursive: true, force: true })
await browser.close()
