// The example extension's local adapter (REQ-F-893): the agent runs `node adapter.mjs` in this folder once per call,
// with {action, access, input, requestId, session: {id, cwd}, ext} on stdin; what it prints (JSON) is the result.
// note.save keeps a note line in notes.jsonl here; note.list reads the last ones back.
// A write is never run twice for one requestId by the agent; an adapter that sends something outside (a message)
// should still keep its own record of requestIds when it can, in case the agent's record is lost.
import fs from 'node:fs'

const req = JSON.parse(fs.readFileSync(0, 'utf8'))
const file = new URL('./notes.jsonl', import.meta.url)
const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

if (req.action === 'note.save') {
  const text = String(req.input?.text ?? '').slice(0, 4000)
  if (!text.trim()) {
    process.stderr.write('text 가 비었어요\n')
    process.exit(2)
  }
  if (process.env.EXAMPLE_ADAPTER_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.EXAMPLE_ADAPTER_DELAY_MS)))
  fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), sid: req.session?.id ?? null, requestId: req.requestId, text })}\n`)
  process.stdout.write(JSON.stringify({ saved: true, count: lines().length }))
} else if (req.action === 'note.list') {
  const sid = req.session?.id
  process.stdout.write(JSON.stringify({ notes: lines().filter((n) => !sid || n.sid === sid).slice(-20) }))
} else {
  process.stderr.write(`모르는 작업 ${req.action}\n`)
  process.exit(2)
}
