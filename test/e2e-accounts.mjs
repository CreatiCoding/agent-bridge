// End-to-end check of Claude accounts on one Mac (설정 → Claude 계정, agent/accounts.mjs): adding one, the sign-in
// address, a session started in one account and moved to another and back with its conversation, and taking an
// account away, and another tool's config folder linked as an account (폴더 연결) and left as it was. Needs a running server and one agent (see README: 개발), a real `claude` (a few tokens) and
// playwright (not a dependency of this repo).
//
// A second real Claude login is not needed: start the agent with CLAUDE_SECURESTORAGE_CONFIG_DIR= (empty), which makes
// Claude Code keep using the main keychain item while the config folder (and so the conversations) is the
// account's own. Give it its own tmux server (TMUX_TMPDIR) so that setting reaches the sessions, and a `claude` that
// skips `auth logout` (CLAUDE_BRIDGE_CLAUDE, see below): with a shared keychain item a sign-out would sign this
// Mac's real account out. Started from inside tmux, TMUX must go too (env -u TMUX): tmux follows it to the running
// server and ignores TMUX_TMPDIR.
//   printf '#!/bin/sh\n[ "$1 $2" = "auth logout" ] && exit 0\nexec claude "$@"\n' > /tmp/claude-nologout && chmod +x /tmp/claude-nologout
//   env -u TMUX TMUX_TMPDIR=/tmp/cb-tmux CLAUDE_SECURESTORAGE_CONFIG_DIR= CLAUDE_BRIDGE_CLAUDE=/tmp/claude-nologout CLAUDE_BRIDGE_HOME=/tmp/agentA node agent/agent.mjs http://localhost:4399 --port 4398 --name MacA
//   PLAYWRIGHT=… AGENT_A=/tmp/agentA WORK=<folder> SHOTS=<folder> node test/e2e-accounts.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { sharedConfig } from '../agent/accounts.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const [home, work, shots] = [process.env.AGENT_A, process.env.WORK, process.env.SHOTS]
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const newCtx = async (viewport) => {
  const c = await browser.newContext({ viewport })
  await c.request.get(`${SITE}/api/auth/dev?login=tester`)
  return c
}
const mac = await newCtx({ width: 1280, height: 820 })
const phone = await newCtx({ width: 390, height: 844 })
const api = async (method, p, body) => {
  const r = await phone.request.fetch(`${SITE}${p}`, { method, ...(body ? { data: body } : {}) })
  return { status: r.status(), json: await r.json().catch(() => ({})) }
}
const errors = []

step('연동')
const bridge = await mac.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const hostId = cfg.hostId
const accounts = (body) => api('POST', `/api/hosts/${hostId}/accounts`, body)

step('계정 목록과 추가')
let r = await accounts({ op: 'list' })
ok(r.status === 200 && r.json.accounts?.[0]?.main && r.json.accounts[0].loggedIn === true, '기본 계정이 로그인된 채로 보임')
r = await accounts({ op: 'add', name: 'e2e 계정' })
const acc = r.json.id
ok(r.status === 200 && /^a[0-9a-f]{8}$/.test(acc ?? ''), '계정을 더함')
const dir = path.join(home, 'accounts', acc)
ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), '계정 폴더에 settings.json 이 링크로 들어감')
const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
ok(!own.oauthAccount && own.hasCompletedOnboarding === true, '계정 폴더의 .claude.json 에 로그인 정보는 없고 처음 화면 표시는 있음')
ok(r.json.accounts.find((a) => a.id === acc)?.loggedIn === true, '(e2e 는 기본 키체인을 같이 써서) 새 계정도 로그인됨으로 읽힘')
r = await accounts({ op: 'rename', id: acc, name: '회사' })
ok(r.json.accounts.find((a) => a.id === acc)?.name === '회사', '이름을 바꿈')
ok((await accounts({ op: 'nope' })).status === 400, '모르는 동작은 400')
ok((await accounts({ op: 'logout', id: '../x' })).status === 400, '이상한 계정 id 는 400')

step('로그인 주소')
r = await accounts({ op: 'login', id: acc })
ok(r.status === 200 && /^https:\/\/\S+\/oauth\/authorize\?/.test(r.json.url ?? ''), `로그인 주소를 받음 (${(r.json.url ?? r.json.error ?? '').slice(0, 40)}…)`)
ok(r.json.accounts.find((a) => a.id === acc)?.signingIn === true, '로그인하는 중으로 보임')
r = await accounts({ op: 'code', id: acc, code: 'bad code with spaces' })
ok(r.status === 409 && /코드가 올바르지 않아요/.test(r.json.error ?? ''), '모양이 틀린 코드는 맥에 보내지 않음')
r = await accounts({ op: 'cancel', id: acc })
ok(r.status === 200 && !r.json.accounts.find((a) => a.id === acc)?.signingIn, '로그인을 취소함')

step('계정 화면과 가이드')
const app = await phone.newPage()
app.on('pageerror', (e) => errors.push(e.message))
await app.goto(`${SITE}/settings/accounts`)
await app.getByText('회사').first().waitFor({ timeout: 20000 })
ok(await app.getByRole('button', { name: '계정 추가' }).isVisible(), '설정 → Claude 계정에 맥과 계정 추가 버튼이 보임')
await app.screenshot({ path: `${shots}/accounts-0-settings.png`, fullPage: true })
await app.goto(`${SITE}/guide/accounts`)
await app.getByText('계정 더하고 로그인하기').waitFor({ timeout: 20000 })
ok(true, '멀티 계정 가이드가 열림')
await app.screenshot({ path: `${shots}/accounts-1-guide.png`, fullPage: true })

step('기본 계정에서 세션 시작')
const said = async (sid, re, timeout = 120000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await wait(1500)) {
    const ev = (await api('GET', `/api/sessions/${sid}/events`)).json.events ?? []
    if (ev.some((e) => e.k === 'text' && re.test(e.text ?? ''))) return true
  }
  return false
}
const idle = async (sid, timeout = 90000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await wait(1500)) {
    const s = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid]
    const st = (await api('GET', `/api/sessions/${sid}/screen`)).json.text ?? ''
    if (s && /❯/.test(st) && !/esc to interrupt/i.test(st)) return true
  }
  return false
}
r = await api('POST', '/api/sessions', { hostId, cwd: work, prompt: "Remember this harmless test codeword for later: BLUEBIRD47. Reply with exactly OK_NOTED and nothing else.", model: MODEL })
const sid = r.json.id
ok(r.status === 200 && !!sid, '세션을 시작함')
ok(await said(sid, /OK_NOTED/), '기본 계정에서 답함')
await idle(sid)
const conv = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid]?.conv ?? sid

step('다른 계정으로 옮기기')
r = await api('POST', `/api/sessions/${sid}/move`, { hostId, account: acc })
ok(r.status === 200 && r.json.ok, `회사 계정으로 옮김 ${r.json.error ?? ''}`)
const s1 = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid]
ok(s1?.account === acc, '맥의 세션이 그 계정으로 돌고 있음')
const enc = fs.realpathSync(work).replace(/[^a-zA-Z0-9]/g, '-')
ok(fs.existsSync(path.join(dir, 'projects', enc, `${conv}.jsonl`)), '대화 기록이 그 계정의 기록 폴더에 들어감')
await idle(sid)
await api('POST', `/api/sessions/${sid}/send`, { text: 'What was the test codeword I gave you? Reply with exactly that codeword followed by _AGAIN, nothing else.' })
ok(await said(sid, /BLUEBIRD47_AGAIN/), '옮긴 계정에서 앞의 대화를 기억함')
r = await accounts({ op: 'remove', id: acc })
ok(r.status === 409 && /세션이 1개/.test(r.json.error ?? ''), '세션이 쓰는 계정은 빼지 못함')
r = await accounts({ op: 'sync', id: acc })
ok(r.status === 409, '그 계정 세션이 도는 동안은 공유 설정 맞추기를 하지 않음')
const events = (await api('GET', `/api/sessions/${sid}/events`)).json.events ?? []
ok(events.some((e) => e.k === 'notice' && /Claude 계정 .* → 회사 로 옮겼습니다/.test(e.text ?? '')), '대화에 계정을 옮겼다고 남김')

step('기본 계정으로 돌아오기')
await idle(sid)
r = await api('POST', `/api/sessions/${sid}/move`, { hostId, account: '' })
ok(r.status === 200 && r.json.ok, `기본 계정으로 돌아옴 ${r.json.error ?? ''}`)
ok(!JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid]?.account, '맥의 세션이 기본 계정으로 돌고 있음')
await idle(sid)
await api('POST', `/api/sessions/${sid}/send`, { text: 'Reply with exactly the test codeword followed by _HOME, nothing else.' })
ok(await said(sid, /BLUEBIRD47_HOME/), '돌아온 기본 계정에서도 대화를 기억함 (회사 계정에서 한 말 포함)')
r = await api('POST', `/api/sessions/${sid}/move`, { hostId, account: 'a00000000' })
ok(r.status === 409, '맥에 없는 계정으로는 옮기지 않음')

step('계정 빼기')
ok((await api('POST', `/api/sessions/${sid}/close`, {})).status === 200, '세션을 끝냄')
r = await accounts({ op: 'remove', id: acc })
ok(r.status === 200 && !r.json.accounts.some((a) => a.id === acc), '세션이 없는 계정을 뺌')
ok(!fs.existsSync(dir) && fs.readdirSync(path.join(home, 'accounts-removed')).some((d) => d.startsWith(acc)), '계정 폴더는 지우지 않고 accounts-removed 로 옮김')

step('다른 도구의 설정 폴더 연결 (폴더 연결)')
// A folder another tool runs Claude Code with: its own .claude.json and settings, and two conversations of its own.
const toolRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tool-')))
const tool = path.join(toolRoot, 'claude')
const encW = fs.realpathSync(work).replace(/[^a-zA-Z0-9]/g, '-')
fs.mkdirSync(path.join(tool, 'projects', encW), { recursive: true })
const mainCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
fs.writeFileSync(path.join(tool, '.claude.json'), JSON.stringify(sharedConfig(mainCfg), null, 2))
fs.writeFileSync(path.join(tool, 'settings.json'), '{"x-other-tool": true}\n')
const convLine = (conv, text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID(), cwd: fs.realpathSync(work), sessionId: conv, timestamp: new Date().toISOString() }) + '\n'
const oldConv = crypto.randomUUID()
const busyConv = crypto.randomUUID()
fs.writeFileSync(path.join(tool, 'projects', encW, `${oldConv}.jsonl`), convLine(oldConv, 'tool conversation from earlier'))
fs.writeFileSync(path.join(tool, 'projects', encW, `${busyConv}.jsonl`), convLine(busyConv, 'tool conversation being written now'))
const past = new Date(Date.now() - 10 * 60_000)
fs.utimesSync(path.join(tool, 'projects', encW, `${oldConv}.jsonl`), past, past)
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const before = { cfg: sha(path.join(tool, '.claude.json')), settings: sha(path.join(tool, 'settings.json')), names: fs.readdirSync(tool).sort().join(',') }

r = await accounts({ op: 'link', name: '도구', dir: path.join(os.homedir(), '.claude') })
ok(r.status === 409 && /기본 계정/.test(r.json.error ?? ''), `기본 설정 폴더는 연결하지 않음 (${r.json.error ?? ''})`)
r = await accounts({ op: 'link', name: '도구', dir: '~/.CLAUDE' })
ok(r.status === 409, `대소문자만 바꾼 기본 설정 폴더도 연결하지 않음 (${r.json.error ?? ''})`)
const bare = path.join(toolRoot, 'bare')
fs.mkdirSync(bare)
r = await accounts({ op: 'link', name: '도구', dir: bare })
ok(r.status === 409 && /\.claude\.json 이 없어요/.test(r.json.error ?? ''), '.claude.json 없는 폴더는 연결하지 않음')
ok((await accounts({ op: 'link', name: '도구' })).status === 400, '경로 없는 연결은 400')
r = await accounts({ op: 'link', name: '도구', dir: `${tool}/` })
const ext = r.json.id
const extRow = r.json.accounts?.find((a) => a.id === ext)
ok(r.status === 200 && extRow?.external === true && extRow?.dir?.endsWith('/claude'), `폴더를 계정으로 연결함 ${r.json.error ?? ''}`)
ok(extRow?.loggedIn === true, '(e2e 는 기본 키체인을 같이 써서) 연결한 폴더도 로그인됨으로 읽힘')
ok(JSON.parse(fs.readFileSync(path.join(home, 'accounts.json'), 'utf8')).find((a) => a.id === ext)?.dir === tool, 'accounts.json 에 끝 / 를 뗀 경로와 external 로 남음')
r = await accounts({ op: 'link', name: '또', dir: tool })
ok(r.status === 409 && /다른 계정/.test(r.json.error ?? ''), '같은 폴더를 두 번 연결하지 않음')
for (const op of ['sync', 'login', 'logout']) {
  r = await accounts({ op, id: ext })
  ok(r.status === 409 && /연결한 폴더는 bridge 가 고치지 않아요/.test(r.json.error ?? ''), `연결한 폴더에는 ${op} 를 하지 않음`)
}
await accounts({ op: 'list' })
ok(sha(path.join(tool, '.claude.json')) === before.cfg && sha(path.join(tool, 'settings.json')) === before.settings && fs.readdirSync(tool).sort().join(',') === before.names, '연결·거절·목록(로그인 확인) 뒤에도 그 폴더의 파일이 그대로 (링크·사본·lock·backups 없음)')

r = await api('GET', `/api/hosts/${hostId}/recent`)
const listed = r.json.conversations ?? []
ok(listed.some((c) => c.conv === oldConv && c.account === ext), '그 폴더의 대화가 이 맥의 대화 목록에 그 계정으로 보임')
r = await api('POST', `/api/hosts/${hostId}/adopt`, { conv: busyConv, cwd: work, title: 'busy' })
ok(r.status >= 400 && /다른 도구가 이 대화를 지금 쓰는 중/.test(r.json.error ?? ''), `1분 안에 쓰인 그 폴더의 대화는 가져오지 않음 (${r.status} ${r.json.error ?? ''})`)
// A claude that still holds the older conversation (as claude 2.1 writes sessions/<pid>.json): this test's own pid.
fs.mkdirSync(path.join(tool, 'sessions'))
fs.writeFileSync(path.join(tool, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: oldConv, cwd: work }))
r = await api('POST', `/api/hosts/${hostId}/adopt`, { conv: oldConv, cwd: work, title: 'held' })
ok(r.status >= 400 && /다른 도구가 이 대화를 지금 쓰는 중/.test(r.json.error ?? ''), '살아 있는 claude 가 잡고 있는 그 폴더의 대화는 가져오지 않음')
fs.rmSync(path.join(tool, 'sessions'), { recursive: true, force: true })

const page = await phone.newPage()
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${SITE}/settings/accounts`)
await page.getByText('연결한 폴더').first().waitFor({ timeout: 20000 })
ok(await page.getByRole('button', { name: '연결 해제' }).isVisible(), '계정 화면에 연결한 폴더 표시와 연결 해제 버튼이 보임')
await page.screenshot({ path: `${shots}/accounts-2-linked.png`, fullPage: true })

r = await api('POST', '/api/sessions', { hostId, cwd: work, prompt: 'Reply with exactly LINKED_OK and nothing else.', model: MODEL, account: ext })
const sid2 = r.json.id
ok(r.status === 200 && !!sid2, '연결한 폴더의 계정으로 세션을 시작함')
ok(await said(sid2, /LINKED_OK/), '연결한 폴더의 계정에서 답함')
const conv2 = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid2]?.conv ?? sid2
ok(fs.existsSync(path.join(tool, 'projects', encW, `${conv2}.jsonl`)), '대화 기록이 그 폴더의 projects 에 쓰임')
ok(sha(path.join(tool, 'settings.json')) === before.settings && !fs.readdirSync(tool).some((n) => fs.lstatSync(path.join(tool, n)).isSymbolicLink()), '세션을 띄워도 그 폴더에 링크를 걸거나 설정을 바꾸지 않음')
await idle(sid2)
ok((await api('POST', `/api/sessions/${sid2}/close`, {})).status === 200, '세션을 끝냄')
await wait(2000)
r = await accounts({ op: 'remove', id: ext })
ok(r.status === 200 && !r.json.accounts.some((a) => a.id === ext), '연결을 해제함')
ok(fs.existsSync(path.join(tool, '.claude.json')) && sha(path.join(tool, 'settings.json')) === before.settings && fs.existsSync(path.join(tool, 'projects', encW, `${oldConv}.jsonl`)), '연결 해제 뒤에도 그 폴더와 대화가 그대로')
ok(!fs.readdirSync(path.join(home, 'accounts-removed')).some((d) => d.startsWith(ext)), '연결한 폴더는 accounts-removed 로 옮기지 않음')
fs.rmSync(toolRoot, { recursive: true, force: true })

ok(!errors.length, `화면 오류 없음 ${errors.join(' / ')}`)
await browser.close()
