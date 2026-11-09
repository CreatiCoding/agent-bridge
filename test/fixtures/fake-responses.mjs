// A stand-in for an OpenAI Responses API endpoint (server-sent events), for the codex runner's e2e (test/e2e-codex.mjs):
// codex is pointed at it through its own config (model_providers), so no account or key is used. Answers by the last
// thing the user said:
//  - after a tool's output: "명령 결과를 받았습니다: <output>"
//  - "RUNCMD": an exec_command that asks to run outside the sandbox (codex shows its approval question)
//  - "WAIT": waits 6 s, then answers (a turn that is still going)
//  - anything else: "echo: <text>"
//   node test/fixtures/fake-responses.mjs <port>
import http from 'node:http'

const port = Number(process.argv[2] || 18765)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0

function lastUserText(input) {
  for (let i = (input?.length ?? 0) - 1; i >= 0; i--) {
    const it = input[i]
    if (it.type !== 'message' || it.role !== 'user') continue
    const real = (it.content || []).filter((c) => c.type === 'input_text' && !c.text.trimStart().startsWith('<') && !c.text.startsWith('# AGENTS.md')).map((c) => c.text)
    if (real.length) return real.join('\n')
  }
  return ''
}

// The same stand-in as an Anthropic Messages API, for `claude` pointed at it with ANTHROPIC_BASE_URL (test/e2e-switch.mjs:
// the first message the agent puts into the runner it switched to). Answers "echo: <first line of the last user text>".
function lastClaudeText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const all = typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    // What claude adds around the person's words (<system-reminder>…) is left out, and a message of several lines
    // reaches the model wrapped in <pasted_content …>: what is inside is the message.
    const real = all
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, '$1')
      .trim()
    if (real && !real.startsWith('<')) return real
  }
  return ''
}

function messages(req, res, body) {
  if (req.url.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"input_tokens":10}')
  }
  let json = {}
  try {
    json = JSON.parse(body)
  } catch {}
  const id = `msg_${++seq}`
  const said = lastClaudeText(json.messages)
  let text = `echo: ${said.split('\n')[0]}`
  // 세션 찾기 (REQ-F-895, test/e2e-find.mjs): picks the listed session whose digest holds the words searched (the
  // first word of `찾는 글`), and one id that was never listed, which the agent must drop.
  if (said.includes('[세션 찾기]')) {
    const want = (/찾는 글: <<<(\S+)/.exec(said)?.[1] ?? '').replace(/>+$/, '').toLowerCase()
    const picks = said
      .split('\n- id: ')
      .slice(1)
      .filter((b) => want && b.toLowerCase().includes(want))
      .map((b) => ({ id: b.split('\n')[0].trim(), why: `시험: "${want}" 가 나온 세션` }))
    text = JSON.stringify({ picks: [...picks, { id: 'deadbeef-0000-4000-8000-000000000000', why: '지어낸 id' }] })
  }
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const message = { id, type: 'message', role: 'assistant', model: json.model || 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }
  if (!json.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(message))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
  send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } })
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  send({ type: 'content_block_stop', index: 0 })
  send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
  send({ type: 'message_stop' })
  res.end()
}

http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }], models: [] }))
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) return messages(req, res, body)
    if (!(req.method === 'POST' && req.url.startsWith('/v1/responses'))) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":{"message":"not found"}}')
    }
    let json = {}
    try {
      json = JSON.parse(body)
    } catch {}
    const id = `resp_${++seq}`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    const say = (text) => send({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${seq}`, content: [{ type: 'output_text', text }] } })
    send({ type: 'response.created', response: { id } })
    const input = json.input || []
    const last = input[input.length - 1]
    const text = lastUserText(input)
    if (last && /_output$/.test(last.type || '')) say(`명령 결과를 받았습니다: ${String(typeof last.output === 'string' ? last.output : JSON.stringify(last.output)).slice(0, 200)}`)
    else if (text.includes('RUNCMD')) send({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_${seq}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hello-from-fake', sandbox_permissions: 'require_escalated', justification: '시험용 명령' }) } })
    else if (text.includes('WAIT')) (await sleep(6000), say(`기다린 뒤 답: ${text}`))
    else say(`echo: ${text}`)
    send({ type: 'response.completed', response: { id, usage: { input_tokens: 100, input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 110 } } })
    res.end()
  })
  .listen(port, '127.0.0.1', () => console.log(`fake responses on ${port}`))
