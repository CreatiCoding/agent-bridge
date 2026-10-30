// The conversations a Mac already has that no bridge session holds (started in a terminal or by another tool):
// pick one, or several, to carry them on here, each in its own folder, as the same conversation.
// `/new?adopt=<id>,<id>…` opens this list with those already picked (a prepared move of many at once).
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { ago, bytes, shortPath } from '../lib/format'
import { go } from '../lib/router'
import { Badge, Button, Empty, Icon, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { openSession } from '../lib/builtin-actions'

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
}

/** The ids the address asked for. */
export const presetAdopt = () => (/[?&]adopt=([\w,-]+)/.exec(location.search)?.[1] ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x))

export function AdoptList({ hostId }: { hostId: string }) {
  const preset = presetAdopt()
  const [list, setList] = useState<{ home: string; conversations: Conversation[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preset))
  const [run, setRun] = useState<{ done: number; failed: { title: string; error: string }[]; total: number; now: string } | null>(null)
  const [reads, setReads] = useState(0)
  useEffect(() => {
    setList(null)
    setError(null)
    get<{ ok: true; home: string; conversations: Conversation[] }>(`/api/hosts/${hostId}/recent${preset.length ? `?include=${preset.join(',')}` : ''}`).then(setList, (e) => setError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, reads])

  const nameOf = (c: Conversation) => c.title || c.first || '(제목 없음)'
  // The conversation's own title or first words; never the placeholder the list shows for one without either.
  const adoptOne = (c: Conversation) => post<{ ok: true; id: string }>(`/api/hosts/${hostId}/adopt`, { conv: c.conv, cwd: c.cwd, title: c.title || c.first })

  const adopt = async (c: Conversation) => {
    const ok = await confirmDialog('이 대화를 bridge 에서 이어 갈까요?', {
      text: `${nameOf(c)}\n${c.cwd}\n\n${c.active ? '⚠️ 1분 안에 이 대화에 쓰인 기록이 있어요. 다른 터미널이나 도구에서 아직 쓰는 중이라면 그쪽을 먼저 끝내세요. 같은 대화를 둘이 쓰면 기록이 엇갈려요.\n\n' : ''}그 폴더에서 claude --resume 으로 열어요. 지금까지의 대화도 함께 보여요.`,
      ok: '이어 가기',
      danger: c.active,
    })
    if (!ok) return
    setRun({ done: 0, failed: [], total: 1, now: nameOf(c) })
    try {
      const r = await adoptOne(c)
      openSession(r.id, 'adopt', { replace: true })
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      setRun(null)
    }
  }

  // Several, one after another: each waits for its session to start before the next begins.
  const adoptPicked = async (items: Conversation[]) => {
    const active = items.filter((c) => c.active).length
    const ok = await confirmDialog(`${items.length}개 대화를 bridge 에서 이어 갈까요?`, {
      text: `하나씩 차례로 그 폴더에서 claude --resume 으로 열어요.${active ? `\n\n⚠️ ${active}개는 1분 안에 쓰인 기록이 있어요. 다른 곳에서 쓰는 중이면 그쪽을 먼저 끝내세요.` : ''}`,
      ok: `${items.length}개 이어 가기`,
      danger: active > 0,
    })
    if (!ok) return
    const failed: { title: string; error: string }[] = []
    for (const [i, c] of items.entries()) {
      setRun({ done: i, failed: [...failed], total: items.length, now: nameOf(c) })
      try {
        await adoptOne(c)
      } catch (e) {
        failed.push({ title: nameOf(c), error: errorText(e) })
      }
    }
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

  return (
    <div className="stack">
      {run ? (
        <div className="banner" style={{ background: run.done < run.total ? 'var(--blue-soft)' : run.failed.length ? 'var(--red-soft)' : 'var(--green-soft)' }}>
          {run.done < run.total ? <Spinner size={16} /> : <Icon name={run.failed.length ? 'warn' : 'check'} />}
          <div className="banner-body">
            {run.done < run.total ? (
              <>
                {run.done + 1}/{run.total} 가져오는 중 · {run.now}
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
      </div>
      {!shown.length ? (
        <Empty icon="search" title="이어 갈 대화가 없어요">
          bridge 밖에서 시작한 Claude Code 대화가 여기에 보여요.
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
              {!c.exists ? <Badge tone="red">폴더 없음</Badge> : c.active ? <Badge tone="amber">쓰는 중</Badge> : null}
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
        최근 80개까지 보여요. 이미 bridge 세션인 대화는 빠져 있어요. 줄을 누르면 하나만 바로 이어 가요.
      </p>
      <Button tone="ghost" size="sm" icon="refresh" onClick={() => setReads((n) => n + 1)}>
        다시 읽기
      </Button>
    </div>
  )
}
