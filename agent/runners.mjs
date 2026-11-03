// Session runners (REQ-F-851): which CLI a session runs in its terminal. Claude Code is the first and the default;
// every session with no `runner` on record is a Claude Code session and goes through exactly the code it always did.
// Another runner (OpenAI Codex CLI, agent/codex.mjs) starts its own program, reads its own conversation file and turns
// it into lines of the one shape the server reads (Claude Code's transcript lines), so the server and the page do not
// need to know which program a session runs. What a runner cannot do is said in its `caps`: the page hides it, and the
// agent and the server refuse it.

/**
 * Everything a session can do beyond seeing the conversation and typing into it. Claude Code has all of them.
 * - hooks: Claude Code's hooks report turns and tools (otherwise the transcript and the screen do).
 * - cards: questions and permission dialogs become cards on the page.
 * - bridgeTools: the bridge MCP server's tools (todos, delegate, attach, read_session) inside the session.
 * - model / effort / mode: switching them while it runs. autoAllow: 전부 허용.
 * - fork: 복제 and 가벼운 복제. move: to another Mac, another account or another folder. account: Claude 계정.
 * - compact / trim: 지금 압축, 자동 압축 창, 대화 기록 정리. skills / btw / todos: the slash menu, /btw, 할 일 정리.
 * - preview: what is being written, read off the screen. adopt: 가져오기. routing: 모델 라우팅. chrome: Claude in Chrome.
 * - sessionMd: SESSION.md kept with the session. zeropty: runs in zeropty (otherwise tmux only).
 */
export const CAPS = Object.freeze(['hooks', 'cards', 'bridgeTools', 'model', 'effort', 'mode', 'autoAllow', 'fork', 'move', 'account', 'compact', 'trim', 'skills', 'btw', 'todos', 'preview', 'adopt', 'routing', 'chrome', 'sessionMd', 'zeropty'])

/** Runner ids as they are written in sessions.json and sent to the server: short, lowercase. */
export const RUNNER_ID_RE = /^[a-z][a-z0-9-]{0,15}$/

export const CLAUDE = Object.freeze({ id: 'claude', name: 'Claude Code', caps: CAPS })

/** The runner of a session: Claude Code unless another one is on record. */
export const runnerIdOf = (s) => (typeof s?.runner === 'string' && s.runner && s.runner !== 'claude' ? s.runner : 'claude')
export const isClaude = (s) => runnerIdOf(s) === 'claude'

/** Whether a session's runner can do `cap` (one of CAPS). Claude Code can do everything. */
export function can(s, cap, runners) {
  const id = runnerIdOf(s)
  if (id === 'claude') return true
  return !!runners?.[id]?.caps?.includes(cap)
}

/**
 * The runner a request names, checked: '' and 'claude' are Claude Code; any other must be one this Mac has.
 * Returns the id, or null when it is not a runner here.
 */
export function pickRunner(want, available) {
  if (want == null || want === '' || want === 'claude') return 'claude'
  if (typeof want !== 'string' || !RUNNER_ID_RE.test(want)) return null
  return available.includes(want) ? want : null
}

/** What hello tells the server about the runners on this Mac: id, name, version, what they can do. */
export const runnerBrief = (r, version) => ({ id: r.id, name: r.name, ...(version ? { version: String(version).slice(0, 40) } : {}), caps: [...r.caps] })
