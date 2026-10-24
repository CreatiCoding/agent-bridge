// The things around the conversation: the plan above the input, the usage gauges, the chips (settings, PR,
// AGENTS.md, the terminal screen) and the sheets they open.
import { useEffect, useState } from 'react'
import { errorText, get } from '../lib/api'
import { ago, bytes, clock, duration, shortPath, tokens } from '../lib/format'
import { getPref, setPref } from '../lib/local'
import { inline, Markdown } from '../lib/markdown'
import { modelName, MODE_NAMES } from '../lib/sessions'
import { useStore } from '../lib/store'
import { todoKey } from '../lib/timeline'
import type { CacheUsage, Options, Session, Todo } from '../lib/types'
import { Button, Chip, Collapse, Field, Help, Icon, IconButton, Segmented, Spinner, Switch } from '../kit'
import { openMenu, Sheet, toast, type MenuEntry } from '../kit/overlay'
import { act, command, sessionPost } from './session-menu'
import { AllowHint, confirmAllowAll } from './auto-allow-confirm'

/** How a to-do's state reads at a glance (REQ-F-778). */
const TODO_MARK: Record<string, string> = { completed: 'todoDone', in_progress: 'todoNow', pending: 'todo' }
const TODO_NAME: Record<string, string> = { completed: '완료', in_progress: '하는 중', pending: '할 일' }

/**
 * A to-do's words: **bold** and `code` as Claude wrote them, and a trailing "(…)" note dimmed so the words that say
 * what to do are read first.
 */
function TodoText({ text }: { text: string }) {
  const m = /^(.*\S)\s*(\([^()]*\))$/.exec(text)
  if (!m) return <span>{inline(text)}</span>
  return (
    <span>
      {inline(m[1])} <span className="todo-note">{inline(m[2], 'n')}</span>
    </span>
  )
}

function TodoItem({ t, onRun, onRemove }: { t: Todo; onRun?: (t: Todo) => void; onRemove?: (t: Todo) => void }) {
  const text = t.status === 'in_progress' && t.active ? t.active : t.text
  return (
    <li className={t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : undefined}>
      <span className="todo-mark" role="img" aria-label={TODO_NAME[t.status] ?? '할 일'}>
        <Icon name={TODO_MARK[t.status] ?? 'todo'} />
      </span>
      {onRun && t.status !== 'completed' ? (
        <button type="button" className="todo-run" title="하던 일 끝나면 이 일 이어서 하기" onClick={() => onRun(t)}>
          <TodoText text={text} />
          <Icon name="play" />
        </button>
      ) : (
        <TodoText text={text} />
      )}
      {onRemove ? (
        <button type="button" className="todo-del" aria-label={`할 일에서 빼기: ${plain(t)}`} title="할 일에서 빼기" onClick={() => onRemove(t)}>
          <Icon name="close" />
        </button>
      ) : null}
    </li>
  )
}

function TodoList({ items, onRun, onRemove }: { items: Todo[]; onRun?: (t: Todo) => void; onRemove?: (t: Todo) => void }) {
  // Finished items sink to the bottom, folded under one row so what is left stays in view; the order within each
  // group is Claude's. Whether they are shown is remembered on this device.
  const [showDone, setShowDone] = useState(() => getPref('todoDone', false))
  const left = items.filter((t) => t.status !== 'completed')
  const done = items.filter((t) => t.status === 'completed')
  const toggle = () => {
    setShowDone(!showDone)
    setPref('todoDone', !showDone)
  }
  return (
    <ul>
      {left.map((t, i) => (
        <TodoItem key={i} t={t} onRun={onRun} onRemove={onRemove} />
      ))}
      {done.length ? (
        <li className="todo-fold">
          <button type="button" onClick={toggle} aria-expanded={showDone}>
            <Icon name="down" className={`chev-flip${showDone ? ' chev-flip-open' : ''}`} />
            완료 {done.length}개
          </button>
        </li>
      ) : null}
      {showDone && done.map((t, i) => <TodoItem key={`d${i}`} t={t} onRemove={onRemove} />)}
    </ul>
  )
}

/**
 * What "지금까지 한 일로 정리" sends (REQ-F-778). A session started before the bridge MCP had its todos tool cannot
 * call it, so the same list may come back as a ```todos block at the end of the answer (server/events.mjs).
 */
export const TODO_ASK =
  '지금까지 이 세션에서 한 일과 남은 일을 할 일 패널에 정리해 주세요. `mcp__bridge__todos` 도구가 있으면 그 도구로 보내고, 없으면 답 맨 끝에 ```todos 블록으로 한 줄에 하나씩 적어 주세요(`[x] 한 일`, `[>] 하는 중`, `[ ] 남은 일`). 항목마다 핵심 낱말 하나를 **굵게** 쓰고, 덧붙이는 말은 끝의 괄호에 넣어 주세요.'
/**
 * "다시 정리" with a list already there (REQ-F-778 rule 6a): the same request (so its card still matches) plus a check
 * of each item against the real state, since another session may have done or changed the work meanwhile.
 */
export const TODO_REASK = `${TODO_ASK} 지금 패널의 목록을 그대로 믿지 말고, 끝나지 않은 일마다 실제로 어떤지 지금 상태로 다시 확인해 주세요. 다른 세션이 그사이 같은 일을 했거나 바꿨을 수 있으니, 그 일에 맞는 곳(예: \`git fetch\` 뒤 \`origin/main\` 의 최근 커밋, 다른 worktree·브랜치, 열린 PR, 배포·서버 상태, 파일 내용)을 살펴보고, 이미 된 일은 완료로, 더 할 필요가 없어진 일은 빼고, 새로 생긴 일은 더해 주세요. 이미 완료인 항목도 목록에 그대로 넣어 보내 주세요. 확인한 근거는 그 항목 끝 괄호에 짧게 적어 주세요.`

/**
 * What the panel's ▶ (every item left, in order) and an item (that one once the current work is done, then the rest) send (REQ-F-779). The **bold** marks
 * are dropped: the message stays in the conversation as a bubble, which shows them raw.
 */
const plain = (t: Todo) => t.text.replace(/\*\*/g, '')
export const todoRunAll = (items: Todo[]) =>
  `할 일 패널의 남은 일을 위에서부터 차례로 모두 진행해 주세요. 하나를 시작하고 마칠 때마다 \`mcp__bridge__todos\` 로 패널을 갱신해 주세요.\n\n${items
    .filter((t) => t.status !== 'completed')
    .map((t) => `- ${plain(t)}`)
    .join('\n')}`
const TODO_NEXT_HEAD = '지금 하던 일이 있으면 그것을 먼저 마치고, 이어서 할 일 패널의 이 일을 진행해 주세요: '
export const todoRunOne = (t: Todo) =>
  `${TODO_NEXT_HEAD}${plain(t)}\n\n이 일도 끝나면 남은 일을 위에서부터 차례로 이어서 진행하고, 하나를 시작하고 마칠 때마다 \`mcp__bridge__todos\` 로 패널을 갱신해 주세요.`

/**
 * Which of the panel's requests a sent message is, if any (REQ-F-780): the conversation draws those as a 할 일 card
 * instead of the words written for Claude. Matched by their opening sentence, so lists sent before a wording change
 * at the end still match.
 */
export type TodoAsk = { kind: 'ask' | 'one' | 'from' | 'next' | 'all'; items: string[] }
export function todoAskOf(text: string): TodoAsk | null {
  if (text.startsWith(TODO_ASK.slice(0, TODO_ASK.indexOf('.') + 1))) return { kind: 'ask', items: [] }
  // 'one' (that one alone, before 1.256) and 'from' (that one first, 1.256–1.260) are what an item sent before; they
  // stay so those messages keep their card.
  for (const [kind, head] of [['next', TODO_NEXT_HEAD], ['from', '할 일 패널의 이 일부터 진행해 주세요: '], ['one', '할 일 패널의 이 일 하나만 진행해 주세요: ']] as const)
    if (text.startsWith(head)) return { kind, items: [text.slice(head.length).split('\n')[0]] }
  if (text.startsWith('할 일 패널의 남은 일을 위에서부터 차례로 모두 진행해 주세요.'))
    return { kind: 'all', items: text.split('\n').flatMap((l) => (l.startsWith('- ') ? [l.slice(2)] : [])) }
  return null
}

const TODO_ASK_TITLE = { ask: () => '할 일 정리 부탁', one: () => '이 일만 하기', from: () => '이 일부터 하고 이어서 하기', next: () => '하던 일 끝나면 이 일 이어서 하기', all: (n: number) => `남은 일 ${n}개 차례로 하기` }

/** A request from the to-do panel in the conversation (REQ-F-780): what was asked, not the instructions around it. */
export function TodoAskCard({ ask, className = '' }: { ask: TodoAsk; className?: string }) {
  return (
    <div className={`todo-ask ${className}`}>
      <div className="todo-ask-head">
        <Icon name="list" />
        <b>{TODO_ASK_TITLE[ask.kind](ask.items.length)}</b>
      </div>
      {ask.items.length ? (
        <ul>
          {ask.items.map((t, i) => (
            <li key={i}>
              <Icon name="play" />
              <TodoText text={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * To-dos the person took off the panel (REQ-F-784), kept on the session so every device, and a list Claude sends
 * again, leave them out. They are gone at once; the session's own list takes over once it carries the change.
 */
export function useTodoHidden(s: Session | null) {
  const saved = s?.todoHidden ?? []
  const [pending, setPending] = useState<string[] | null>(null)
  const savedKey = saved.join('\n')
  useEffect(() => setPending((p) => (p && p.join('\n') === savedKey ? null : p)), [savedKey])
  const hidden = new Set(pending ?? saved)
  const save = async (keys: string[]) => {
    if (!s) return false
    setPending(keys)
    try {
      await sessionPost(s, 'settings', { todoHidden: keys })
      return true
    } catch (e) {
      setPending(null)
      toast(errorText(e), { tone: 'bad' })
      return false
    }
  }
  const remove = async (t: Todo) => {
    const key = todoKey(t.text)
    const before = [...hidden]
    if (await save([...before.filter((k) => k !== key), key])) toast('할 일에서 뺐어요', { action: { label: '되돌리기', run: () => void save(before) } })
  }
  return { visible: (items: Todo[]) => (hidden.size ? items.filter((t) => !hidden.has(todoKey(t.text))) : items), remove: (t: Todo) => void remove(t) }
}

/** Whether the panel is open: remembered on this device, and opened by the topbar's 할 일 button. */
export const todoPanelPref = () => getPref('todoPanel', true)
export const setTodoPanelPref = (on: boolean) => setPref('todoPanel', on)

/**
 * The session's to-do list beside the conversation on a wide screen (REQ-F-778), as Claude updates it. With nothing
 * listed yet it offers to ask Claude for one from the work so far. A narrow screen has `Todos` above the input
 * instead (CSS).
 */
export function TodoPanel({ items, onClose, onAsk, onRun, onRemove, disabled, noTool }: { items: Todo[]; onClose: () => void; onAsk: () => Promise<boolean>; onRun: (text: string) => void; onRemove: (t: Todo) => void; disabled?: string; noTool?: boolean }) {
  // Asked and not answered yet: the list that was there when asking, to see when a new one arrives.
  const [asked, setAsked] = useState<Todo[] | null>(null)
  const waiting = asked !== null && asked === items
  const ask = async () => {
    setAsked(items)
    if (!(await onAsk())) setAsked(null)
  }
  const done = items.filter((t) => t.status === 'completed').length
  const left = items.length - done
  return (
    <aside className="todo-panel" aria-label="할 일">
      <div className="todo-panel-head">
        <Icon name="list" />
        <b>할 일</b>
        {items.length ? <span>{done === items.length ? '모두 완료' : `${done}/${items.length}`}</span> : null}
        {left ? <IconButton icon="play" label={`남은 일 ${left}개 모두 하기`} disabled={!!disabled} onClick={() => onRun(todoRunAll(items))} /> : null}
        <IconButton icon="close" label="할 일 닫기" onClick={onClose} />
      </div>
      {items.length ? (
        <>
          <div className="todo-bar" aria-hidden>
            <i style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
          <TodoList items={items} onRun={disabled ? undefined : (t) => onRun(todoRunOne(t))} onRemove={onRemove} />
        </>
      ) : (
        <p className="todo-empty">
          아직 할 일 목록이 없어요. 지금까지 한 일과 남은 일을 Claude 에게 정리해 달라고 할 수 있어요.
          {noTool ? ' 이 세션은 할 일 도구가 생기기 전에 떠서, 누르면 세션을 다시 열어 도구를 붙인 뒤 부탁해요.' : null}
        </p>
      )}
      <div className="todo-foot">
        {waiting ? (
          <span className="todo-wait">
            <Spinner /> 정리하는 중…
          </span>
        ) : (
          <Button size="sm" tone={items.length ? 'ghost' : 'primary'} icon={items.length ? 'refresh' : 'sparkle'} disabled={!!disabled} title={disabled} onClick={() => void ask()}>
            {items.length ? '다시 정리' : '지금까지 한 일로 정리'}
          </Button>
        )}
      </div>
    </aside>
  )
}

export function Todos({ items, onRemove }: { items: Todo[]; onRemove: (t: Todo) => void }) {
  const [open, setOpen] = useState(false)
  if (!items.length || items.every((t) => t.status === 'completed')) return null
  const done = items.filter((t) => t.status === 'completed').length
  const now = items.find((t) => t.status === 'in_progress')
  return (
    <div className="todos">
      <button type="button" className="todos-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="list" />
        <b>{now ? inline(now.active || now.text) : '할 일'}</b>
        <span>
          {done}/{items.length}
        </span>
        <Icon name="up" className={`chev-flip${open ? ' chev-flip-open' : ''}`} />
      </button>
      <Collapse open={open}>
        <TodoList items={items} onRemove={onRemove} />
      </Collapse>
    </div>
  )
}

/** `value`: what is written after the bar instead of the percentage (a size). `low`: a small value is the bad one. */
type GaugeProps = { label: string; pct: number; title?: string; value?: string; warn?: number; bad?: number; low?: boolean; onClick?: () => void }
const gaugeLevel = ({ pct, warn = 60, bad = 85, low }: GaugeProps) => (low ? (pct < bad ? 'high' : pct < warn ? 'mid' : '') : pct >= bad ? 'high' : pct >= warn ? 'mid' : '')

function Gauge(p: GaugeProps) {
  const { label, pct, title, value, onClick } = p
  const level = gaugeLevel(p)
  const body = (
    <>
      {label}
      <span className="gauge-bar">
        <i style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </span>
      {value ?? `${Math.round(pct)}%`}
    </>
  )
  return onClick ? (
    <button type="button" className={`gauge gauge-link ${level}`} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={`gauge ${level}`} title={title}>
      {body}
    </span>
  )
}

/** `onOpenMd`: the session file's gauge opens it (like the AGENTS.md chip). */
const contextPct = (s: Session) => {
  const u = s.state.usage
  return u?.context != null ? u.context : s.state.context ? Number(String(s.state.context).replace(/[^\d.]/g, '')) : null
}

/** Whether any gauge is at its red level (the same lines as below): a phone, which folds the gauges, says so on 더보기. */
export function gaugesHigh(s: Session) {
  const u = s.state.usage
  const ctx = contextPct(s)
  return (
    (ctx != null && ctx >= 85) ||
    (u?.fiveHour ?? 0) >= 85 ||
    (u?.week ?? 0) >= 85 ||
    (s.state.size ?? 0) >= 0.9 * 100 * 1024 * 1024 ||
    (!!s.state.sessionMd && s.state.sessionMd >= (s.state.mdMax || 20_000))
  )
}

/** The cache gauge's levels: a long session reads 95–99% of its context from the cache. A new session's first
 * call writes everything, so it is not judged before a few calls. */
const CACHE_WARN = 90
const CACHE_BAD = 75
const CACHE_JUDGED = 5

/** `fold`: only the context and the gauges past their first line show; the calm rest are behind one +N button. */
export function Gauges({ s, onOpenMd, onOpenCache, fold }: { s: Session; onOpenMd?: () => void; onOpenCache?: () => void; fold?: boolean }) {
  const [all, setAll] = useState(false)
  const u = s.state.usage
  const ctx = contextPct(s)
  const parts: (GaugeProps & { key: string })[] = []
  if (ctx != null && !Number.isNaN(ctx)) parts.push({ key: 'c', label: '컨텍스트', pct: ctx })
  const c = s.state.cache
  if (c) parts.push({ key: 'k', label: '캐시', pct: c.hit, low: true, warn: c.calls >= CACHE_JUDGED ? CACHE_WARN : 0, bad: c.calls >= CACHE_JUDGED ? CACHE_BAD : 0, value: `${Math.round(c.hit)}%`, title: `컨텍스트의 ${c.hit}% 를 캐시에서 읽었어요 · 마지막 컨텍스트 ${tokens(c.ctx)} · 누르면 자세히`, onClick: onOpenCache })
  if (u?.fiveHour != null) parts.push({ key: '5', label: '5시간', pct: u.fiveHour, title: u.fiveHourResetsAt ? `${clock(u.fiveHourResetsAt)} 에 다시 차요` : undefined })
  if (u?.week != null) parts.push({ key: 'w', label: '주간', pct: u.week, title: u.weekResetsAt ? `${clock(u.weekResetsAt)} 에 다시 차요` : undefined })
  // The conversation's size (its .jsonl): from 50MB a light copy is worth it, at 100MB input is refused.
  if (s.state.size) parts.push({ key: 't', label: '대화 기록', pct: (s.state.size / (100 * 1024 * 1024)) * 100, warn: 50, bad: 90, value: bytes(s.state.size), title: `대화 기록(.jsonl) ${bytes(s.state.size)} · 50MB 부터 가벼운 복제를 권해요, 100MB 에서 입력을 막아요` })
  // The session's own hand-over file (kept up to date at each compaction); a light copy hands over up to mdMax
  // (a tenth of the context window: 20KB at 200k, 100KB at 1M).
  // Only once there is one: an empty "없음" gauge on every session says nothing.
  if (s.state.sessionMd) {
    const name = s.state.mdFile || 'SESSION.md'
    const max = s.state.mdMax || 20_000
    parts.push({ key: 'm', label: name, pct: (s.state.sessionMd / max) * 100, warn: 75, bad: 100, value: s.state.sessionMd ? bytes(s.state.sessionMd) : '없음', title: `${name} ${s.state.sessionMd ? bytes(s.state.sessionMd) : '아직 없음'} · 컨텍스트를 압축할 때 그 요약으로 채워져요. ${Math.round(max / 1000)}KB 가 넘으면 가벼운 복제 때 줄여요(컨텍스트 창의 10분의 1). 누르면 내용을 봐요`, onClick: onOpenMd })
  }
  if (!parts.length) return null
  const shown = fold && !all ? parts.filter((p) => p.key === 'c' || gaugeLevel(p)) : parts
  const hidden = parts.length - shown.length
  return (
    <div className="gauges">
      {shown.map(({ key, ...p }) => (
        <Gauge key={key} {...p} />
      ))}
      {hidden ? (
        <button type="button" className="gauge gauge-link gauge-more" title={parts.filter((p) => !shown.includes(p)).map((p) => p.label).join(' · ')} onClick={() => setAll(true)}>
          +{hidden}
        </button>
      ) : fold && all ? (
        <button type="button" className="gauge gauge-link gauge-more" onClick={() => setAll(false)}>
          접기
        </button>
      ) : null}
    </div>
  )
}

let options: Promise<Options> | null = null
const getOptions = () => (options ??= get<Options>('/api/options').catch((e) => ((options = null), Promise.reject(e))))

/** 권한 모드 from the session's settings: 전부 허용 that asks nothing is asked about first (REQ-F-796). */
async function setMode(s: Session, mode: string) {
  if (mode === 'allowAll' && !(await confirmAllowAll(false))) return
  await act(() => command(s, 'mode', mode), '권한 모드를 바꿨어요')
}

export function SettingsSheet({ s, open, onClose }: { s: Session; open: boolean; onClose: () => void }) {
  const [opts, setOpts] = useState<Options | null>(null)
  useEffect(() => {
    if (open) getOptions().then(setOpts, () => {})
  }, [open])
  const model = s.launchModel || s.model
  const mode = s.state.autoAllow ? (s.state.allowAll ? 'allowAll' : 'autoAllow') : (s.state.mode ?? 'default')
  return (
    <Sheet open={open} onClose={onClose} title="세션 설정">
      {!opts ? (
        <Spinner />
      ) : (
        <>
          <Field label="모델" hint="Claude Code 가 이 맥의 기본값으로도 저장해요">
            <select className="input" value={opts.models.some((m) => m.value === model) ? model : ''} onChange={(e) => act(() => command(s, 'model', e.target.value), '모델을 바꿨어요')}>
              {!opts.models.some((m) => m.value === model) ? <option value="">{modelName(model) || '알 수 없음'}</option> : null}
              {opts.models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="생각 수준 (effort)">
            <Segmented label="effort" value={s.state.effort ?? ''} options={opts.efforts.map((e) => ({ value: e, label: e }))} onChange={(v) => act(() => command(s, 'effort', v), `effort ${v}`)} />
          </Field>
          <Field label="권한 모드" hint={<AllowHint mode={mode} />}>
            <select className={`input${mode === 'allowAll' ? ' input-allow-all' : ''}`} value={mode} onChange={(e) => void setMode(s, e.target.value)}>
              {opts.modes.map((m) => (
                <option key={m.value} value={m.value} className={m.value === 'allowAll' ? 'opt-allow-all' : undefined}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="setting-line">
            <span className="grow">
              <b style={{ fontSize: 'var(--fs-medium)' }}>싱크할 때 자동 push</b>
              <Help>
                main·develop·master 가 아닌 브랜치를 올려 둬요(강제 push 없음)
              </Help>
            </span>
            <Switch label="자동 push" checked={s.autoPush} onChange={(on) => act(() => sessionPost(s, 'settings', { autoPush: on }), on ? '자동 push 를 켰어요' : '자동 push 를 껐어요')} />
          </div>
          <FolderInfo s={s} />
        </>
      )}
    </Sheet>
  )
}

function FolderInfo({ s }: { s: Session }) {
  const repos = s.folder?.repos ?? []
  return (
    <dl className="kv">
      <dt>폴더</dt>
      <dd className="mono">{shortPath(s.cwd, s.home, 6)}</dd>
      <dt>모델</dt>
      <dd>
        {modelName(s.launchModel || s.model)} · {s.state.effort ?? '?'} · {MODE_NAMES[s.state.mode ?? ''] ?? s.state.mode ?? '?'}
      </dd>
      <dt>싱크</dt>
      <dd>
        {s.lines}줄{s.syncedAt ? ` · ${clock(s.syncedAt)}` : ''}
      </dd>
      {repos.map((r, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <dt>{r.dir ? shortPath(r.dir, s.home, 2) : '저장소'}</dt>
          <dd className="mono" style={{ fontSize: 'var(--fs-small)' }}>
            {r.branch ?? '(detached)'} @ {r.sha?.slice(0, 8)}
            {r.pushError ? <span style={{ color: 'var(--red)' }}> · push 실패: {r.pushError}</span> : null}
          </dd>
        </span>
      ))}
      {s.moves.length ? (
        <>
          <dt>옮긴 기록</dt>
          <dd>{s.moves.length}번 · 마지막 {clock(s.moves.at(-1)!.at)}</dd>
        </>
      ) : null}
      {s.state.turnAt && s.state.phase === 'busy' ? (
        <>
          <dt>이번 턴</dt>
          <dd>{duration(Date.now() - s.state.turnAt)}째</dd>
        </>
      ) : null}
    </dl>
  )
}

export function ScreenSheet({ s, open, onClose }: { s: Session; open: boolean; onClose: () => void }) {
  const screen = useStore((st) => st.screens[s.id])
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true)
    const r = await act(() => get<{ ok: true; text: string }>(`/api/sessions/${s.id}/screen`))
    if (r) setText(r.text)
    setLoading(false)
  }
  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.id])
  const keys = (k: string[]) => act(() => sessionPost(s, 'key', { keys: k })).then(() => setTimeout(load, 400))
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="터미널 화면"
      wide
      footer={
        <div className="hstack">
          <Button size="sm" icon="refresh" busy={loading} onClick={load}>
            다시 읽기
          </Button>
          <span className="grow" />
          {['Up', 'Down', 'Enter', 'Escape', 'Tab'].map((k) => (
            <Button key={k} size="sm" onClick={() => keys([k])}>
              {k === 'Escape' ? 'Esc' : k === 'Up' ? '↑' : k === 'Down' ? '↓' : k}
            </Button>
          ))}
        </div>
      }
    >
      <pre className="screen-pre">{(text ?? screen ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/gm, '') || (loading ? '읽는 중…' : '(빈 화면)')}</pre>
      <p className="muted" style={{ fontSize: 'var(--fs-small)' }}>
        모르는 확인 창이 떠 있을 때 키를 직접 보낼 수 있어요.
      </p>
    </Sheet>
  )
}

/** `file`: 'session' shows the session's own SESSION.md instead of the folder's AGENTS.md / CLAUDE.md. */
const CACHE_EVENT: Record<CacheUsage['events'][number]['kind'], string> = {
  start: '세션을 열어서',
  cold: '1시간 넘게 쉬어 캐시가 식어서',
  idle: '5분 넘게 쉬어 캐시가 식어서',
  model: '모델을 바꿔서',
  compact: '컨텍스트를 압축해서',
  other: '도구·설정이 바뀌어서',
}

/** The prompt cache of a session (REQ-F-773): what it read, what it wrote again and why. */
export function CacheSheet({ s, open, onClose }: { s: Session; open: boolean; onClose: () => void }) {
  const c = s.state.cache
  return (
    <Sheet open={open} onClose={onClose} title="캐시">
      {!c ? (
        <p className="muted">아직 센 호출이 없어요.</p>
      ) : (
        <div className="cache-sheet">
          <p>
            이 대화는 모델을 부를 때마다 컨텍스트 전체를 다시 보내요. 캐시에서 읽은 부분은 값이 싸고(입력 단가의 약 1/10~1/20), 다시 쓴 부분은 입력 단가보다 비싸요(1.25~2배). 그래서 <b>컨텍스트가 클수록, 다시 쓸수록</b> 많이 들어요.
          </p>
          <dl className="cache-nums">
            <dt>캐시에서 읽음</dt>
            <dd>
              {tokens(c.read)} <span className="muted">({c.hit}%)</span>
            </dd>
            <dt>캐시에 씀</dt>
            <dd>{tokens(c.write)}</dd>
            <dt>캐시 없이 읽음</dt>
            <dd>{tokens(c.input)}</dd>
            <dt>Claude 가 쓴 글</dt>
            <dd>{tokens(c.output)}</dd>
            <dt>호출</dt>
            <dd>
              {c.calls.toLocaleString()}번 · 한 번에 평균 {tokens((c.read + c.write + c.input) / c.calls)}
            </dd>
            <dt>마지막 컨텍스트</dt>
            <dd>{tokens(c.ctx)}</dd>
          </dl>
          <h4>컨텍스트를 다시 쓴 때 (최근 {c.events.length}번)</h4>
          {c.events.length ? (
            <ul className="cache-events">
              {c.events
                .slice()
                .reverse()
                .map((e) => (
                  <li key={`${e.at}-${e.tokens}`}>
                    <b>{tokens(e.tokens)}</b> {CACHE_EVENT[e.kind] ?? CACHE_EVENT.other}
                    {e.kind === 'cold' || e.kind === 'idle' ? ` (${duration(e.gap)} 쉼)` : ''} <span className="muted">· {ago(e.at)}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">없어요.</p>
          )}
          <p className="muted">이 대화 기록(.jsonl) 기준이에요. 서브에이전트의 호출은 따로라 넣지 않았어요.</p>
        </div>
      )}
    </Sheet>
  )
}

export function DocSheet({ s, open, onClose, file }: { s: Session; open: boolean; onClose: () => void; file?: 'session' }) {
  const [doc, setDoc] = useState<{ name: string; path: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setDoc(null)
    setError(null)
    get<{ ok: true; name: string; path: string; content: string }>(`/api/sessions/${s.id}/agentsmd${file ? `?file=${file}` : ''}`).then(setDoc, (e) => setError(e.message))
  }, [open, s.id, file])
  return (
    <Sheet open={open} onClose={onClose} title={doc?.name ?? (file === 'session' ? s.state.mdFile || 'SESSION.md' : 'AGENTS.md')} wide>
      {error ? <p className="muted">{error}</p> : doc ? <Markdown text={doc.content} /> : <Spinner />}
    </Sheet>
  )
}

export interface Links {
  prs: { url: string; label: string; state: string; number: number }[]
  /** Mentioned PRs past `limit`, not looked up yet. */
  more?: number
}

const PR_PAGE = 8

export function useLinks(s: Session, limit = PR_PAGE) {
  const [links, setLinks] = useState<Links | null>(null)
  const key = `${s.id}|${(s.folder?.repos ?? []).map((r) => r.pr?.url ?? '').join(',')}|${Math.floor(s.seq / 50)}|${limit}`
  useEffect(() => {
    let live = true
    get<Links>(`/api/sessions/${s.id}/links?limit=${limit}`).then((r) => live && setLinks(r), () => {})
    return () => {
      live = false
    }
  }, [key, s.id, limit])
  return links
}

// GitHub's colours: open green, merged violet, closed red.
const prTone = (state: string) => (state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'bad' : state === 'OPEN' ? 'ok' : undefined)
// The folded chip: green while any is open, else the colour they all share.
const foldTone = (prs: Links['prs']) => (prs.some((p) => p.state === 'OPEN') ? 'ok' : prs.every((p) => p.state === prs[0].state) ? prTone(prs[0].state) : undefined)
const PR_STATE: Record<string, string> = { MERGED: '병합됨', CLOSED: '닫힘', OPEN: '열림' }

/**
 * One PR is its own chip; more fold into one "PR n" chip whose menu lists them (the most recently mentioned first), so
 * the composer stays one row. The menu shows 8 at first; 더 보기 asks for 8 more and opens the menu again.
 */
export function PrChips({ s }: { s: Session }) {
  const [limit, setLimit] = useState(PR_PAGE)
  const links = useLinks(s, limit)
  const prs = links?.prs ?? []
  const more = links?.more ?? 0
  const [reopenAt, setReopenAt] = useState<HTMLElement | null>(null)
  // The state goes before the title, not in the hint: a long title would squeeze the hint to "병…".
  const items: MenuEntry[] = prs.map((p) => ({
    label: (
      <>
        {PR_STATE[p.state] ? <span className={`pr-state pr-state-${prTone(p.state) ?? 'open'}`}>{PR_STATE[p.state]}</span> : null}
        {p.label}
      </>
    ),
    icon: 'pr',
    onSelect: () => open(p.url, '_blank', 'noopener'),
  }))
  const menu = (at: HTMLElement) =>
    openMenu(more ? [...items, 'sep', { label: `더 보기 (${more}개 남음)`, icon: 'down', onSelect: () => (setReopenAt(at), setLimit((l) => l + PR_PAGE)) }] : items, at, `PR ${prs.length + more}`)
  // The next page came: the menu again, under the same chip.
  useEffect(() => {
    if (reopenAt && links && (prs.length >= limit || !more)) {
      if (reopenAt.isConnected) menu(reopenAt)
      setReopenAt(null)
    }
  })
  if (!prs.length) return null
  if (prs.length === 1 && !more) {
    const p = prs[0]
    return (
      <Chip icon="pr" tone={prTone(p.state)} onClick={() => open(p.url, '_blank', 'noopener')} title={p.label}>
        {p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label}
      </Chip>
    )
  }
  return (
    <Chip icon="pr" tone={foldTone(prs)} onClick={(e) => menu(e.currentTarget)} title={prs.map((p) => p.label).join('\n')}>
      PR {prs.length + more}
    </Chip>
  )
}
