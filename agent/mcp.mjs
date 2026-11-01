#!/usr/bin/env node
// The `bridge` MCP server a session is started with (REQ-F-760): its tools hand work to a Claude session on another
// of the person's Macs, through this Mac's agent and the bridge server, much like a sub-agent but on another machine.
// Its `todos` tool shows the session's to-do list in the page's side panel (REQ-F-778).
// It speaks MCP over stdio (one JSON-RPC message per line) and asks the agent at CB_DELEGATE with the hook key.
import fs from 'node:fs'
import readline from 'node:readline'

const URL_ = process.env.CB_DELEGATE || ''
const KEY_FILE = process.env.CB_KEY_FILE || ''

export const TOOLS = [
  {
    name: 'hosts',
    description: "The person's Macs this session can hand work to: name, whether it is online, and whether it takes work from other Macs.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegate',
    description:
      'Hand a task to a new Claude session on another of the person\'s Macs (like a sub-agent, on that machine with its own files, tools and logins). The new session follows this session\'s permission policy. With wait (default true) it returns that session\'s final answer once its turn ends, or its state after timeout_s; otherwise it returns at once with the id. When that session\'s turn ends and no call is waiting on it, its answer arrives in this conversation as a message starting with ↪, so do not poll it with a script; end your turn and pick the work up from that message. Once its answer is handed to you (the call returns state done, or the ↪ message arrives), that session closes by itself and leaves the list; a folder bridge made for it (no cwd given) is deleted when no other session uses it. To have more done there, delegate again. Pick model and effort for the job: light read-only checks and repetitive work take a light model (sonnet, haiku) and low effort; work where judgment matters (design, debugging with an unknown cause, code or security review, hard-to-undo operations) takes opus.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'The Mac, by the name `hosts` lists' },
        task: { type: 'string', description: 'What to do, written for a session that knows nothing of this conversation' },
        cwd: { type: 'string', description: "Folder on that Mac to work in (absolute or ~/…). Default: a new folder under the person's default folder (~/bridge/works/<this session's group>/<MMDD>-<id>)" },
        wait: { type: 'boolean', description: 'Wait for the answer (default true)' },
        timeout_s: { type: 'number', description: 'How long to wait, 10–1800 seconds (default 600)' },
        model: { type: 'string', description: "Model for that session: an alias (opus, sonnet, haiku, fable) or a full model ID (e.g. claude-sonnet-5-5). Default: the person's default model" },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: "Reasoning effort for that session. Default: the person's default" },
      },
      required: ['host', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'delegate_status',
    description: 'State of a session this one handed work to: working, waiting (on a permission or a question for the person), done or closed, and its last answer. A closed one (it closes by itself once its answer is handed over) still gives its last answer. With wait, waits up to timeout_s for it to finish first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, wait: { type: 'boolean' }, timeout_s: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delegate_send',
    description: 'Send a follow-up message to a session this one handed work to (same as the person typing it) while it is still open: working, or waiting on a permission or a question. Waits for the answer like delegate. A session whose answer was handed over is closed already; delegate a new task instead.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' }, wait: { type: 'boolean' }, timeout_s: { type: 'number' } },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'delegate_stop',
    description: 'Stop and close a session this one handed work to before it answers (one that answered closed by itself). A folder bridge made for it is deleted when no other session uses it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'todos',
    description:
      "Show this session's to-do list in the side panel of the person's web page (REQ-F-778). Send the whole list each time; it replaces the last one. Use it for work of three or more steps: write the list when you start, mark one item in_progress before working on it, and completed as soon as it is done. Write the items in the person's language. An empty list clears the panel.",
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What to do, as a short imperative' },
              activeForm: { type: 'string', description: 'The same, as what is being done now (shown while in_progress)' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
]

/**
 * The to-do list needs nothing from the agent: the call itself, in the transcript, is what the page reads
 * (server/events.mjs). This only checks it and says what was shown.
 */
export function todosAnswer(args) {
  const list = Array.isArray(args?.todos) ? args.todos : null
  if (!list) throw new Error('todos 는 배열이어야 해요')
  if (!list.length) return '할 일 패널을 비웠어요.'
  const done = list.filter((t) => t?.status === 'completed').length
  return `할 일 ${list.length}개 중 ${done}개 완료로 패널에 보였어요.`
}

/** One tool call, asked of the agent. Long waits are the agent's: this only allows for them. */
async function call(name, args) {
  if (name === 'todos') return todosAnswer(args)
  const key = fs.readFileSync(KEY_FILE, 'utf8').match(/x-bridge-key:\s*(\S+)/)?.[1] ?? ''
  const wait = args?.wait !== false && name !== 'hosts' && name !== 'delegate_stop'
  const timeout = wait ? (Math.min(1800, Math.max(10, Number(args?.timeout_s) || 600)) + 60) * 1000 : 60_000
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': key }, body: JSON.stringify({ op: name, args: args ?? {} }), signal: AbortSignal.timeout(timeout) })
  const j = await r.json().catch(() => ({ ok: false, error: `에이전트 응답을 읽지 못했어요 (HTTP ${r.status})` }))
  if (!j.ok) throw new Error(j.error || '실패했어요')
  return j.result
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

export async function handle(msg, run = call) {
  const { id, method, params } = msg ?? {}
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bridge', version: '1' } } }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const name = params?.name
    if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `없는 도구: ${name}` } }
    try {
      const out = await run(name, params?.arguments ?? {})
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } }
    }
  }
  // Notifications (no id) get no answer.
  if (id === undefined || id === null) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `지원하지 않는 메서드: ${method}` } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const out = await handle(msg)
    if (out) send(out)
  })
}
