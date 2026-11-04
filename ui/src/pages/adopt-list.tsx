// The conversations a Mac already has that no bridge session holds (started in a terminal or by another tool):
// pick one, or several, to carry them on here, each in its own folder, as the same conversation.
// `/new?adopt=<id>,<id>…` opens this list with those already picked (a prepared move of many at once).
import { SlotActions } from '../components/slot-parts'
import { useEffect, useRef, useState } from 'react'
import { errorText, get, getSealed, post } from '../lib/api'
import { ADOPT_WAIT_MS, adoptControl, adoptEach, AdoptLeft, AdoptWaitStopped, type AdoptControl, type AdoptWait } from '../lib/adopt-wait'
import { ago, bytes, shortPath } from '../lib/format'
import { go } from '../lib/router'
import { Badge, Button, Empty, Icon, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { openSession } from '../lib/builtin-actions'
import { NONE, useStore } from '../lib/store'
import { openSealed, openText, sealsTo } from '../lib/trust'
import { getPref, setPref } from '../lib/local'
import { CodexModeFields } from '../components/codex-mode'
import { codexAllowed, codexModeLabel } from '../lib/codex-mode'
import { openHandoff } from '../components/codex-handoff'

interface Conversation {
  conv: string
  cwd: string
  title: string
  first: string
  last: string
  mtime: number
  size: number
  active: boolean
  exists: boolean
  /** The Claude account whose folder has it ('' the main one); a linked folder's are taken in that folder. */
  account?: string
  /** A sealing Mac's {conv, cwd, title, first, runner?} in one sealed piece (1.412). */
  bound?: string
  /** 'codex' for a Codex conversation (REQ-F-853); none for Claude Code's. */
  runner?: string
}

type Listed = { ok: true; home: string; conversations: Conversation[] }

/**
 * A sealing Mac's list as the Mac sent it (1.412): each row's id, folder and title come from its one sealed piece, so
 * a server cannot put one conversation's title on another's id or folder, and a row without that piece is left out.
 * The adopt the person signs names these conv·cwd.
 */
export async function boundList(r: Listed): Promise<Listed & { dropped: number }> {
  const out: Conversation[] = []
  for (const c of r.conversations ?? []) {
    const b = await openSealed(c.bound)
    let w: { conv?: unknown; cwd?: unknown; title?: unknown; first?: unknown; runner?: unknown } | null = null
    try {
      w = b ? JSON.parse(b) : null
    } catch {}
    if (!w || typeof w.conv !== 'string' || !/^[0-9a-f-]{36}$/.test(w.conv) || typeof w.cwd !== 'string') continue
    // The runner is the sealed piece's too: a server cannot make a Claude Code conversation a Codex one or back.
    out.push({ ...c, conv: w.conv, cwd: w.cwd, title: String(w.title ?? ''), first: String(w.first ?? ''), runner: w.runner === 'codex' ? 'codex' : undefined, last: await openText(String(c.last ?? '')) })
  }
  return { ...r, conversations: out, dropped: (r.conversations?.length ?? 0) - out.length }
}

/** The ids the address asked for. */
export const presetAdopt = () => (/[?&]adopt=([\w,-]+)/.exec(location.search)?.[1] ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x))

const convInfo = (c: Conversation) => ({ conv: c.conv, cwd: c.cwd, runner: (c as { runner?: string }).runner ?? 'claude', title: c.title || c.first, exists: c.exists })

export function AdoptList({ hostId }: { hostId: string }) {
  const preset = presetAdopt()
  const [list, setList] = useState<{ home: string; conversations: Conversation[]; dropped?: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preset))
  const [run, setRun] = useState<{ done: number; failed: { title: string; error: string }[]; total: number; now: string } | null>(null)
  const [reads, setReads] = useState(0)
  const host = useStore((s) => s.state?.hosts ?? NONE).find((h) => h.id === hostId)
  const accounts = host?.accounts ?? NONE
  // 한 번에 넘기기 (REQ-F-861): a Claude Code conversation goes straight on in Codex where this Mac has it.
  const hasCodex = !!host?.runners?.some((r) => r.id === 'codex')
  const accountOf = (c: Conversation) => (c.account ? (accounts.find((a) => a.id === c.account) ?? null) : null)
  useEffect(() => {
    setList(null)
    setError(null)
    const path = `/api/hosts/${hostId}/recent${preset.length ? `?include=${preset.join(',')}` : ''}`
    const load = sealsTo(hostId) ? getSealed<Listed>(path).then(boundList) : get<Listed>(path)
    load.then(setList, (e) => setError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, reads])

  const nameOf = (c: Conversation) => c.title || c.first || '(제목 없음)'
  // The conversation's own title or first words; never the placeholder the list shows for one without either.
  // A Codex conversation opens in the sandbox and approval picked here (REQ-F-854), not codex's default alone: one
  // another tool ran as workspace-write would otherwise come back read-only.
  const [codexPick, setCodexPick] = useState<string>(() => getPref('newCodexMode', ''))
  const codexMode = codexAllowed(codexPick)
  const pickCodex = (v: string) => (setCodexPick(v), setPref('newCodexMode', v))
  // 쓰는 중이면 기다렸다 가져오기 (REQ-F-867): a conversation another tool is still using is tried again until it is
  // free (at most ADOPT_WAIT_MS), with a banner and a stop button, instead of a toast that sends the person back.
  const [wait, setWait] = useState<AdoptWait | null>(null)
  // 기다리지 않기 skips the one being waited on; leaving the page ends the whole run (kept apart, never reset).
  // Made in the effect so StrictMode's trial unmount cannot leave a stopped one behind; each run holds its own.
  const ctlRef = useRef(adoptControl())
  useEffect(() => {
    const c = (ctlRef.current = adoptControl())
    return () => c.leave()
  }, [])
  const postAdopt = (c: Conversation) => post<{ ok: true; id: string }>(`/api/hosts/${hostId}/adopt`, { conv: c.conv, cwd: c.cwd, title: c.title || c.first, ...(c.runner === 'codex' ? { runner: 'codex', ...(codexMode ? { codexMode } : {}) } : {}) })
  const adoptOne = async (c: Conversation, ctl: AdoptControl) => {
    try {
      return await ctl.one(() => postAdopt(c), { message: errorText, onWait: (w) => void (ctl.left() || setWait(w)) })
    } finally {
      if (!ctl.left()) setWait(null)
    }
  }
  const failed = (e: unknown) => {
    if (e instanceof AdoptLeft) return
    if (e instanceof AdoptWaitStopped) toast('가져오기를 멈췄어요')
    else toast(errorText(e), { tone: 'bad' })
    setRun(null)
  }
  const resumeOf = (c: Conversation) => (c.runner === 'codex' ? 'codex resume' : 'claude --resume')
  const busyNote = `다른 터미널이나 도구에서 아직 쓰는 중이면 그쪽이 끝날 때까지 기다렸다가(최대 ${ADOPT_WAIT_MS / 60_000}분) 가져와요. 그쪽을 닫으면 더 빨라요.`

  const adopt = async (c: Conversation) => {
    const ok = await confirmDialog('이 대화를 bridge 에서 이어 갈까요?', {
      text: `${nameOf(c)}\n${c.cwd}\n\n${c.active ? `1분 안에 이 대화에 쓰인 기록이 있어요. ${busyNote} 같은 대화를 둘이 쓰면 기록이 엇갈려요.\n\n` : ''}그 폴더에서 ${resumeOf(c)} 으로 열어요. 지금까지의 대화도 함께 보여요.`,
      ok: '이어 가기',
      danger: c.active,
    })
    if (!ok) return
    setRun({ done: 0, failed: [], total: 1, now: nameOf(c) })
    try {
      const r = await adoptOne(c, ctlRef.current)
      openSession(r.id, 'adopt', { replace: true })
    } catch (e) {
      failed(e)
    }
  }

  // 한 번에 넘기기 (REQ-F-861): bring it over as a bridge session, then the Codex sheet asks it for the hand-over
  // summary once it is up and starts the Codex session in the same folder when the summary comes. One press for what
  // took 이어 가기 → ⋯ Codex 로 이어서 작업 → 요약 만들기 → Codex 세션 시작.
  const toCodex = async (c: Conversation) => {
    const ok = await confirmDialog('이 대화를 Codex 로 이어 갈까요?', {
      text: `${nameOf(c)}\n${c.cwd}\n\n${c.active ? `1분 안에 이 대화에 쓰인 기록이 있어요. ${busyNote}\n\n` : ''}claude --resume 으로 가져와 Claude 에게 인계 요약을 받고, 요약이 오면 같은 폴더에 Codex 세션을 바로 시작해요. Claude 대화도 bridge 세션으로 남아요.`,
      ok: 'Codex 로 이어 가기',
      danger: c.active,
    })
    if (!ok) return
    setRun({ done: 0, failed: [], total: 1, now: nameOf(c) })
    try {
      const r = await adoptOne(c, ctlRef.current)
      openSession(r.id, 'adopt', { replace: true })
      openHandoff(r.id, { auto: true })
    } catch (e) {
      failed(e)
    }
  }

  // Several, one after another: each waits for its session to start before the next begins.
  const adoptPicked = async (items: Conversation[]) => {
    const active = items.filter((c) => c.active).length
    const ok = await confirmDialog(`${items.length}개 대화를 bridge 에서 이어 갈까요?`, {
      text: `하나씩 차례로 그 폴더에서 ${items.some((c) => c.runner === 'codex') ? '실행기에 맞게 claude --resume 또는 codex resume' : 'claude --resume'} 으로 열어요.${active ? `\n\n${active}개는 1분 안에 쓰인 기록이 있어요. ${busyNote}` : ''}`,
      ok: `${items.length}개 이어 가기`,
      danger: active > 0,
    })
    if (!ok) return
    const note = (f: { item: Conversation; error: unknown }[]) => f.map(({ item, error }) => ({ title: nameOf(item), error: error instanceof AdoptWaitStopped ? '기다리기를 멈췄어요' : errorText(error) }))
    const ctl = ctlRef.current
    const r = await adoptEach(items, ctl, (c) => adoptOne(c, ctl), (i, f) => setRun({ done: i, failed: note(f), total: items.length, now: nameOf(items[i]) }))
    // Left the list page: the run is over and the page is gone, so nothing more is shown or sent.
    if (r.left) return
    const failed = note(r.failed)
    setRun({ done: items.length, failed, total: items.length, now: '' })
    setPicked(new Set(failed.length ? items.filter((c) => failed.some((f) => f.title === nameOf(c))).map((c) => c.conv) : []))
    toast(failed.length ? `${items.length - failed.length}개를 가져왔고 ${failed.length}개는 못 가져왔어요` : `${items.length}개를 모두 가져왔어요`, { tone: failed.length ? 'bad' : 'ok' })
    setReads((n) => n + 1)
  }

  if (error) return <Empty icon="warn" title="대화 목록을 읽지 못했어요">{error}</Empty>
  if (!list)
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 32 }}>
        <Spinner />
      </div>
    )
  const byId = new Map(list.conversations.map((c) => [c.conv, c]))
  const missing = preset.filter((id) => !byId.has(id) && !(run?.done === run?.total))
  const q2 = q.trim().toLowerCase()
  // What was asked for by id comes first.
  const ordered = [...preset.map((id) => byId.get(id)).filter((c): c is Conversation => !!c), ...list.conversations.filter((c) => !preset.includes(c.conv))]
  const shown = ordered.filter((c) => !q2 || [c.title, c.first, c.last, c.cwd].some((x) => x.toLowerCase().includes(q2)))
  const chosen = ordered.filter((c) => picked.has(c.conv) && c.exists)
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? (p.delete(id), new Set(p)) : new Set(p.add(id))))
  const running = !!run && run.done < run.total
  // Which program each conversation is in, once the list has more than Claude Code's.
  const mixed = list.conversations.some((c) => c.runner === 'codex')

  return (
    <div className="stack">
      {run ? (
        <div className="banner" style={{ background: run.done < run.total ? 'var(--blue-soft)' : run.failed.length ? 'var(--red-soft)' : 'var(--green-soft)' }}>
          {run.done < run.total ? <Spinner size={16} /> : <Icon name={run.failed.length ? 'warn' : 'check'} />}
          <div className="banner-body">
            {run.done < run.total ? (
              <>
                {run.done + 1}/{run.total} 가져오는 중 · {run.now}
                {wait ? (
                  <>
                    <div style={{ fontSize: 'var(--fs-small)' }}>
                      다른 도구(터미널 등)가 이 대화를 아직 쓰고 있어요. 끝나면 바로 가져와요 · {wait.tries}번 확인함 · 최대 {Math.ceil(wait.leftMs / 60_000)}분 더 기다려요
                    </div>
                    <div className="banner-actions">
                      <Button size="sm" onClick={() => ctlRef.current.skip()}>
                        기다리지 않기
                      </Button>
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <>
                {run.total - run.failed.length}/{run.total} 가져왔어요.
                {run.failed.map((f, i) => (
                  <div key={i} style={{ fontSize: 'var(--fs-small)' }}>
                    ✕ {f.title}: {f.error}
                  </div>
                ))}
                <div className="banner-actions">
                  <Button size="sm" onClick={() => go({ name: 'home' })}>
                    목록으로
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {list.dropped ? (
        <div className="banner">
          <Icon name="warn" />
          <div className="banner-body">봉인되지 않은 항목 {list.dropped}개는 뺐어요. 맥의 에이전트를 업데이트했는지 봐 주세요.</div>
        </div>
      ) : null}
      {mixed ? (
        <details className="card" style={{ padding: 12 }}>
          <summary>Codex 대화를 열 모드{` · ${codexModeLabel(codexMode) || 'Codex 기본값'}`}</summary>
          <div style={{ marginTop: 12 }}>
            <CodexModeFields value={codexMode} onChange={pickCodex} />
          </div>
        </details>
      ) : null}
      {missing.length ? (
        <div className="banner">
          <Icon name="warn" />
          <div className="banner-body">고른 대화 중 {missing.length}개는 이 맥에 없거나 이미 bridge 세션이에요.</div>
        </div>
      ) : null}
      <div className="hstack">
        <input className="search grow" type="search" placeholder="제목·내용·폴더 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" tone="ghost" onClick={() => setPicked(chosen.length === shown.filter((c) => c.exists).length ? new Set() : new Set(shown.filter((c) => c.exists).map((c) => c.conv)))}>
          {chosen.length && chosen.length === shown.filter((c) => c.exists).length ? '모두 풀기' : '모두 고르기'}
        </Button>
        {/* adopt-list.* (REQ-F-865): the host, and what is shown and picked (each: conv, cwd, runner, title). */}
        <SlotActions slot="adopt-list.toolbar" ctx={{ hostId, shown: shown.map(convInfo), picked: chosen.map(convInfo) }} />
      </div>
      {!shown.length ? (
        <Empty icon="search" title="이어 갈 대화가 없어요">
          bridge 밖에서 시작한 Claude Code·Codex 대화가 여기에 보여요.
        </Empty>
      ) : (
        <div className="folder-list" style={{ maxHeight: 'none' }}>
          {shown.map((c) => (
            <div key={c.conv} className={`folder-item adopt-item${picked.has(c.conv) ? ' picked' : ''}`}>
              <button type="button" role="checkbox" aria-checked={picked.has(c.conv)} aria-label={`${nameOf(c)} 고르기`} className={`pick${picked.has(c.conv) ? ' on' : ''}`} disabled={!c.exists || running} onClick={() => toggle(c.conv)}>
                {picked.has(c.conv) ? <Icon name="check" /> : null}
              </button>
              <button type="button" className="adopt-main" disabled={!c.exists || running} onClick={() => adopt(c)}>
                <span className="adopt-title">{nameOf(c)}</span>
                <span className="adopt-sub">
                  {shortPath(c.cwd, list.home)} · {ago(c.mtime)} · {bytes(c.size)}
                </span>
                {c.last && c.last !== c.first ? <span className="adopt-sub">마지막: {c.last}</span> : null}
              </button>
              {hasCodex && c.runner !== 'codex' && c.exists ? (
                <Button size="sm" tone="ghost" icon="forward" className="adopt-codex" disabled={running} aria-label={`${nameOf(c)} 을 Codex 로 이어 가기`} onClick={() => toCodex(c)}>
                  Codex 로
                </Button>
              ) : null}
              {mixed ? <Badge tone={c.runner === 'codex' ? 'blue' : undefined}>{c.runner === 'codex' ? 'Codex' : 'Claude Code'}</Badge> : null}
              {accountOf(c) ? <Badge>{accountOf(c)?.name}</Badge> : null}
              {!c.exists ? <Badge tone="red">폴더 없음</Badge> : c.active ? <Badge tone="amber">쓰는 중</Badge> : null}
              <SlotActions slot="adopt-list.row.actions" ctx={{ hostId, conversation: convInfo(c) }} max={1} />
            </div>
          ))}
        </div>
      )}
      {chosen.length ? (
        <Button tone="primary" size="lg" block busy={running} onClick={() => adoptPicked(chosen)}>
          고른 {chosen.length}개 이어 가기
        </Button>
      ) : null}
      <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>
        최근 80개(Codex 는 40개)까지 보여요. 이미 bridge 세션인 대화는 빠져 있어요. 줄을 누르면 하나만 바로 이어 가요.{hasCodex ? ' "Codex 로"는 요약을 받아 같은 폴더의 Codex 세션으로 한 번에 넘겨요.' : ''}
      </p>
      <Button tone="ghost" size="sm" icon="refresh" onClick={() => setReads((n) => n + 1)}>
        다시 읽기
      </Button>
    </div>
  )
}
