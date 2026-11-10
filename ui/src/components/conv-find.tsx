// 세션 찾기 (REQ-F-895): under the session list, while its search box has words. The list itself only looks at a
// session's name, first message, folder and last words (REQ-F-113); this asks every Mac to look inside the
// conversations (Enter) or to have `claude -p` pick the sessions that fit (⌘Enter / Ctrl+Enter). Never per key: each
// search reads every transcript, and the AI one costs usage.
// The Macs this device is paired with get the words sealed, in a request of their own; the others get them plain
// in another, and while a paired Mac is asked only when the person chooses it (REQ-S-102, lib/trust findTargets).
import { type ReactNode, useSyncExternalStore } from 'react'
import { ApiError, errorText, postSealed } from '../lib/api'
import { openSession } from '../lib/builtin-actions'
import { titleOf } from '../lib/sessions'
import { getStore, useStore } from '../lib/store'
import { findOpen, findPlainBody, findQh, findSealedBody, findTargets, findText, pairedWith } from '../lib/trust'
import { Icon, Row, SectionHeader, Spinner } from '../kit'

type Mode = 'text' | 'ai'
type HostState = 'ok' | 'offline' | 'noanswer' | 'error' | 'refused' | 'skipped'
interface HostAnswer {
  id: string
  name?: string
  state: HostState
  error?: string
  partial?: boolean
  searched?: number
  total?: number
  shown?: number
  hits?: Record<string, unknown>[]
}
interface Found {
  sid: string
  hostId: string
  closed: boolean
  at: number
  n?: number
  snips?: string[]
  why?: string
  rank: number
  /** From a Mac this device is not paired with: plain, as the server passed it. */
  plain?: boolean
}
interface FindState {
  mode: Mode
  q: string
  busy: boolean
  error?: string
  rows: Found[]
  hosts: HostAnswer[]
  dropped: number
  /** The Macs not paired with this device, not asked yet (a sealed search went to the paired ones). */
  plainLeft: string[]
  plainBusy?: boolean
}

export const FIND_Q_MIN = 2
export const FIND_Q_MAX = 500

// Kept outside the list (like its search text): a phone draws the list anew on coming back from a session.
let st: FindState | null = null
let seq = 0
const subs = new Set<() => void>()
const set = (v: FindState | null) => ((st = v), subs.forEach((f) => f()))
const useFind = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => st)

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const AI_KEY = mac ? '⌘Enter' : 'Ctrl+Enter'

type Answer = { hosts?: HostAnswer[] }

/**
 * One answer as this page may believe it: only the Macs it asked, each row checked (findOpen), each Mac's message
 * opened with its own key. `seen`: the sessions already found by a paired Mac, which a plain row cannot claim.
 */
async function take(r: Answer, asked: string[] | null, want: { op: Mode; qh: string; fn: string }, seen: Set<string>) {
  const rows: Found[] = []
  const hosts: HostAnswer[] = []
  let dropped = 0
  const known = new Map((getStore().state?.sessions ?? []).map((s) => [s.id, s.hostId]))
  for (const h of r.hosts ?? []) {
    if (typeof h?.id !== 'string' || (asked && !asked.includes(h.id))) continue
    const paired = pairedWith(h.id)
    hosts.push({ ...h, hits: undefined, error: await findText(h.id, h.error) })
    for (const [k, hit] of (h.hits ?? []).entries()) {
      const sid = typeof hit.sid === 'string' ? hit.sid : ''
      // A plain row for a session a paired Mac has (by what it found, or by the list), or another Mac's: not believed.
      const owner = known.get(sid)
      const claimed = !paired && (seen.has(sid) || (owner !== undefined && (owner !== h.id || pairedWith(owner))))
      const v = sid && !claimed ? await findOpen(h.id, want, hit) : null
      if (!v) {
        dropped++
        continue
      }
      rows.push({ sid, hostId: h.id, closed: hit.closed === true, at: typeof hit.at === 'number' ? hit.at : 0, n: v.n, snips: v.snips, why: v.why, rank: v.rank ?? k, plain: !paired })
    }
  }
  return { rows, hosts, dropped }
}

// Found words: the newest conversation first. Picks: each Mac's order, the best of every Mac before the next.
const order = (mode: Mode, rows: Found[]) => rows.sort((a, b) => (mode === 'text' ? b.at - a.at : a.rank - b.rank))

/** Asks the Macs (REQ-F-895). A newer search makes an older answer moot. */
export async function convFind(mode: Mode, text: string) {
  const q = text.trim()
  if (q.length < FIND_Q_MIN || q.length > FIND_Q_MAX) return
  if (st?.busy && st.mode === 'ai' && mode === 'ai') return
  const my = ++seq
  set({ mode, q, busy: true, rows: [], hosts: [], dropped: 0, plainLeft: [] })
  try {
    const listed = (getStore().state?.hosts ?? []).map((h) => h.id)
    const t = await findTargets(listed)
    const qh = await findQh(q)
    let got: Awaited<ReturnType<typeof take>>
    let plainLeft: string[] = []
    if (t.missing) {
      // Paired Macs, none of them listed: send nothing (a server hiding them must not get the words plain).
      if (my === seq) set({ mode, q, busy: false, rows: [], hosts: [], dropped: 0, plainLeft: t.plain, error: '이 기기와 짝지은 맥이 맥 목록에 없어 찾지 않았어요' })
      return
    }
    if (t.direct) {
      const r = await postSealed<Answer>('/api/find', await findPlainBody(mode, q))
      got = await take(r, null, { op: mode, qh, fn: '' }, new Set())
    } else {
      const { body, fn } = await findSealedBody(mode, q, t.sealed)
      const r = await postSealed<Answer>('/api/find', body)
      got = await take(r, t.sealed, { op: mode, qh, fn }, new Set())
      plainLeft = t.plain
    }
    if (my === seq) set({ mode, q, busy: false, rows: order(mode, got.rows), hosts: got.hosts, dropped: got.dropped, plainLeft })
  } catch (e) {
    if (my === seq) set({ mode, q, busy: false, rows: [], hosts: [], dropped: 0, plainLeft: [], error: e instanceof ApiError ? e.message : errorText(e) })
  }
}

/** The person chose to search the Macs not paired with this device too: their words go plain, by themselves. */
export async function convFindPlain() {
  const cur = st
  if (!cur || cur.busy || cur.plainBusy || !cur.plainLeft.length) return
  const my = seq
  const asked = cur.plainLeft
  set({ ...cur, plainBusy: true })
  try {
    const r = await postSealed<Answer>('/api/find', await findPlainBody(cur.mode, cur.q, asked))
    const got = await take(r, asked, { op: cur.mode, qh: '', fn: '' }, new Set(cur.rows.map((x) => x.sid)))
    if (my === seq && st) set({ ...st, plainBusy: false, plainLeft: [], rows: order(cur.mode, [...st.rows, ...got.rows]), hosts: [...st.hosts, ...got.hosts], dropped: st.dropped + got.dropped })
  } catch (e) {
    if (my === seq && st) set({ ...st, plainBusy: false, error: e instanceof ApiError ? e.message : errorText(e) })
  }
}

const HOST_SAYS: Record<Exclude<HostState, 'ok'>, string> = {
  offline: '연결 안 됨',
  noanswer: '답 없음',
  error: '찾지 못함',
  refused: '서명이 없어 맥이 거절함',
  skipped: '보낼 글이 없음',
}

/** The words of a snippet with what was searched marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const low = text.toLowerCase()
  const k = q.toLowerCase()
  const out: ReactNode[] = []
  let at = 0
  for (let i = low.indexOf(k); i >= 0 && k; i = low.indexOf(k, at)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + k.length)}</mark>)
    at = i + k.length
  }
  out.push(text.slice(at))
  return <>{out}</>
}

export function ConvFind({ q }: { q: string }) {
  const f = useFind()
  const state = useStore((s) => s.state)
  const text = q.trim()
  if (text.length < FIND_Q_MIN) return null
  const sessions = new Map((state?.sessions ?? []).map((s) => [s.id, s]))
  const hostName = new Map((state?.hosts ?? []).map((h) => [h.id, h.name]))
  const multiHost = (state?.hosts.length ?? 0) > 1
  const mine = f && f.q === text ? f : null
  const tooLong = text.length > FIND_Q_MAX
  return (
    <div className="conv-find" aria-live="polite">
      <SectionHeader title="더 찾기" />
      <Row
        className="conv-find-act"
        left={<Icon name="search" />}
        title="대화 내용에서 찾기"
        sub="각 맥이 대화 기록에서 이 글을 찾아요"
        right={<kbd>Enter</kbd>}
        onClick={tooLong || mine?.busy ? undefined : () => void convFind('text', text)}
      />
      <Row
        className="conv-find-act"
        left={<Icon name="sparkle" />}
        title="AI 로 찾기"
        sub="맥에서 claude -p 를 한 번 돌려 관련 세션을 골라요 · 몇 초 걸려요"
        right={<kbd>{AI_KEY}</kbd>}
        onClick={tooLong || mine?.busy ? undefined : () => void convFind('ai', text)}
      />
      {tooLong ? <div className="conv-find-note">찾는 글은 {FIND_Q_MAX}자까지예요</div> : null}
      {mine?.busy ? (
        <div className="conv-find-note">
          <Spinner size={14} /> {mine.mode === 'ai' ? 'AI 가 세션을 고르는 중…' : '대화 기록에서 찾는 중…'}
        </div>
      ) : null}
      {mine && !mine.busy ? (
        <>
          <SectionHeader title={`${mine.mode === 'ai' ? 'AI 가 고른 세션' : '대화 내용에서 찾음'} · ${mine.rows.length}`} />
          {mine.error ? <div className="conv-find-note conv-find-error">{mine.error}</div> : null}
          {!mine.error && !mine.rows.length ? <div className="conv-find-note">{mine.mode === 'ai' ? '관련 있어 보이는 세션이 없어요' : '이 글이 나온 세션이 없어요'}</div> : null}
          {mine.rows.map((r) => {
            const s = sessions.get(r.sid)
            const where = [multiHost || r.plain ? hostName.get(r.hostId) : '', r.plain && mine.hosts.some((h) => pairedWith(h.id)) ? '짝짓지 않은 맥' : '', r.closed ? '끝난 세션' : '', r.n ? `${r.n}번` : ''].filter(Boolean).join(' · ')
            return (
              <Row
                key={`${r.hostId}:${r.sid}`}
                className="conv-find-hit"
                title={s ? titleOf(s) : `세션 ${r.sid.slice(0, 8)}`}
                sub={
                  <>
                    {where ? <span className="conv-find-where">{where}</span> : null}
                    {r.snips?.slice(0, 2).map((x, i) => (
                      <span key={i} className="conv-find-snip">
                        <Marked text={x} q={mine.q} />
                      </span>
                    ))}
                    {r.why ? <span className="conv-find-snip">{r.why}</span> : null}
                  </>
                }
                onClick={() => openSession(r.sid, 'find')}
              />
            )
          })}
          {mine.hosts
            .filter((h) => h.state !== 'ok' || h.partial)
            .map((h) => (
              <div key={h.id} className="conv-find-note">
                {h.name || hostName.get(h.id) || '맥'}: {h.state === 'ok' ? `시간·파일 한도로 일부만 찾았어요 (${h.searched ?? 0}/${h.total ?? 0}개)` : HOST_SAYS[h.state] ?? h.state}
                {h.state !== 'ok' && h.error ? ` · ${h.error}` : ''}
              </div>
            ))}
          {mine.dropped ? <div className="conv-find-note">맥이 봉인한 결과로 확인하지 못한 {mine.dropped}개는 뺐어요</div> : null}
          {mine.plainLeft.length ? (
            <>
              <div className="conv-find-note">
                이 기기와 짝짓지 않은 맥 {mine.plainLeft.length}대({mine.plainLeft.map((h) => hostName.get(h) || h.slice(0, 8)).join(', ')})에서는 찾지 않았어요. 거기서 찾으면 찾는 글이 서버에 그대로 보이고, 서버는 위 결과가 같은 글로 찾은 것이라는 것도 알 수 있어요.
              </div>
              <Row
                className="conv-find-act"
                left={mine.plainBusy ? <Spinner size={14} /> : <Icon name="search" />}
                title="짝짓지 않은 맥에서도 찾기"
                sub="찾는 글을 평문으로 보내요"
                onClick={mine.plainBusy ? undefined : () => void convFindPlain()}
              />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
