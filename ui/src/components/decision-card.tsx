// A decision the terminal is waiting for, with the choices that are on screen right now. A press sends the
// option's number; the Mac presses it only if that dialog is still up (agent/agent.mjs answerCard).
import { useRef, useState } from 'react'
import { Markdown } from '../lib/markdown'
import type { Card, Session } from '../lib/types'
import { Button, Icon } from '../kit'
import { act, command, inSlack } from './session-menu'
import { dispatch } from '../lib/actions'

export const CARD_LABEL: Record<string, string> = { permission: '권한 요청', question: '질문', plan: '플랜 승인', dialog: '터미널 확인', keyed: '터미널 확인', stuck: '지시 대기' }

function ToolDetail({ tool }: { tool: NonNullable<Card['tool']> }) {
  const input = (tool.input ?? {}) as Record<string, unknown>
  const name = tool.name
  if (name === 'Bash' && typeof input.command === 'string') return <pre>{input.command}</pre>
  if ((name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
    const edits = (Array.isArray(input.edits) ? input.edits : [input]) as { old_string?: string; new_string?: string }[]
    return (
      <>
        <div className="mono" style={{ fontSize: 'var(--fs-small)', marginBottom: 4 }}>
          {String(input.file_path)}
        </div>
        <pre>
          {edits.map((e, i) => (
            <span key={i}>
              {String(e.old_string ?? '')
                .split('\n')
                .map((l, j) => (
                  <span key={`o${j}`} className="d-del">
                    - {l}
                    {'\n'}
                  </span>
                ))}
              {String(e.new_string ?? '')
                .split('\n')
                .map((l, j) => (
                  <span key={`n${j}`} className="d-add">
                    + {l}
                    {'\n'}
                  </span>
                ))}
            </span>
          ))}
        </pre>
      </>
    )
  }
  if (name === 'Write' && typeof input.file_path === 'string')
    return (
      <>
        <div className="mono" style={{ fontSize: 'var(--fs-small)', marginBottom: 4 }}>
          {String(input.file_path)}
        </div>
        <pre>{String(input.content ?? '').slice(0, 4000)}</pre>
      </>
    )
  return <pre>{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
}

export function DecisionCard({ session, card, closed, result, compact }: { session: Session; card: Card; closed: boolean; result?: string; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [plan, setPlan] = useState(false)
  // A second press on the same card within a moment would answer the next dialog: hold the buttons briefly.
  const last = useRef(0)
  const answer = async (n: number | 'esc' | 'enter') => {
    if (Date.now() - last.current < 1500) return
    last.current = Date.now()
    setBusy(String(n))
    // The card as it is drawn; an old agent's option without a kind is "other" (allowing is "not deny").
    const o = typeof n === 'number' ? card.options?.find((x) => x.n === n) : undefined
    const option = n === 'esc' ? { n, label: 'Esc', kind: 'deny' } : n === 'enter' ? { n, label: '확정', kind: 'other' } : { n, label: o?.label ?? '', kind: o?.kind ?? 'other' }
    await act(() => dispatch('permission.answer', { sid: session.id, known: true, card: { id: card.id, kind: card.kind, ...(card.title ? { title: card.title } : {}), ...(card.tool ? { tool: card.tool } : {}) }, option }))
    setBusy(null)
  }
  const label = CARD_LABEL[card.kind] ?? '응답 대기'
  // Worked on in Slack: the card is answered there, and shown here as it is.
  const away = inSlack(session)
  if (card.auto)
    return (
      <div className="note">
        <Icon name="shield" />
        <span>
          자동 허용 · {card.tool?.name ? <b>{card.tool.name}</b> : null} {card.title}
        </span>
      </div>
    )
  if (closed)
    return (
      <div className="dcard closed">
        <div className="dcard-head">
          <Icon name="check" />
          {label}
          {card.tool?.name ? ` · ${card.tool.name}` : ''}
        </div>
        <div className="dcard-title">{card.header ? `${card.header} · ` : ''}{card.title}</div>
        {/* Kept after the answer too: "Do you want to proceed? · 허용" alone does not say what was allowed. */}
        {card.tool ? (
          <div className="dcard-detail compact">
            <ToolDetail tool={card.tool} />
          </div>
        ) : null}
        <div className="dcard-done">{result || '답함'}</div>
      </div>
    )
  const options = card.options ?? []
  return (
    <div className="dcard open" role="group" aria-label={label}>
      <div className="dcard-head">
        <Icon name={card.kind === 'permission' ? 'shield' : card.kind === 'plan' ? 'doc' : card.kind === 'stuck' ? 'pause' : 'info'} />
        {label}
        {card.tool?.name ? ` · ${card.tool.name}` : ''}
        {card.header ? ` · ${card.header}` : ''}
      </div>
      <div className="dcard-title">{card.title}</div>
      {card.description ? <div className="dcard-desc">{card.description}</div> : null}
      {/* Shown in the pop-up too: "Do you want to proceed?" says nothing until the command or file is there. */}
      {card.tool ? (
        <div className={`dcard-detail${compact ? ' compact' : ''}`}>
          <ToolDetail tool={card.tool} />
        </div>
      ) : null}
      {card.plan ? (
        plan || !compact ? (
          <div className="dcard-plan">
            <Markdown text={card.plan} />
          </div>
        ) : (
          <div className="dcard-foot">
            <Button size="sm" icon="doc" onClick={() => setPlan(true)}>
              플랜 보기
            </Button>
          </div>
        )
      ) : null}
      {card.kind === 'stuck' ? (
        <div className="dcard-foot">
          <Button tone="primary" icon="play" busy={busy === 'go'} disabled={away} onClick={() => (setBusy('go'), act(() => command(session, 'continue')).finally(() => setBusy(null)))}>
            계속해
          </Button>
          <span className="muted" style={{ fontSize: 'var(--fs-small)', alignSelf: 'center' }}>
            또는 아래에 새 지시를 쓰세요
          </span>
        </div>
      ) : (
        <div className="dcard-options">
          {options.map((o) => {
            const kind = o.kind ?? 'other'
            const cls = kind === 'deny' ? 'deny' : kind.startsWith('allow') ? 'allow' : ''
            return (
              <button key={o.n} type="button" className={`opt ${cls}${card.kind === 'permission' && kind === 'allow-once' ? ' primary' : ''}`} disabled={!!busy || away} onClick={() => answer(o.n)}>
                <span>
                  {card.kind !== 'keyed' ? `${o.n}. ` : ''}
                  {o.label}
                </span>
                {o.description ? <small>{o.description}</small> : null}
              </button>
            )
          })}
          <div className="hstack" style={{ marginTop: 2 }}>
            {card.multi ? (
              <Button tone="primary" size="sm" icon="check" busy={busy === 'enter'} disabled={away} onClick={() => answer('enter')}>
                확정
              </Button>
            ) : null}
            <Button size="sm" tone="ghost" busy={busy === 'esc'} disabled={away} onClick={() => answer('esc')}>
              Esc 로 닫기
            </Button>
            {away ? (
              <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
                Slack 스레드에서 답해 주세요
              </span>
            ) : null}
            {!away && (card.kind === 'question' || card.kind === 'plan') ? (
              <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
                아래에 글을 쓰면 그 글이 답이 돼요
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
