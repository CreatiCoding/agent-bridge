// A decision waiting in a session the person is not looking at is asked here, on top of whatever is open.
// One the open session handed work to is asked in its conversation instead (DelegateAsks). Each card is asked once; closing it leaves the card in its conversation. One worked on in Slack is asked there.
import { useState } from 'react'
import { go } from '../lib/router'
import { titleOf } from '../lib/sessions'
import { useStore } from '../lib/store'
import { Button } from '../kit'
import { Sheet } from '../kit/overlay'
import { DecisionCard } from './decision-card'

/** `current`: the session on screen, or the panes of 분할 화면 (each asks its own in its conversation). */
export function PermissionModal({ current }: { current: string | string[] | null }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const shown = current == null ? [] : Array.isArray(current) ? current : [current]
  const s = useStore((st) => st.state?.sessions.find((x) => !x.closed && !shown.includes(x.id) && !(x.delegatedBy && shown.includes(x.delegatedBy)) && x.card?.open && !x.locked && x.seat?.where !== 'slack' && !x.card.auto && x.card.kind !== 'stuck' && !closed.has(x.card.id)) ?? null)
  if (!s?.card) return null
  const close = () => setClosed((c) => new Set(c).add(s.card!.id))
  return (
    <Sheet
      open
      onClose={close}
      title={titleOf(s)}
      footer={
        <div className="dialog-buttons">
          <Button onClick={close}>나중에</Button>
          <Button tone="soft" onClick={() => (close(), go({ name: 'session', id: s.id }))}>
            대화로 가기
          </Button>
        </div>
      }
    >
      <DecisionCard session={s} card={s.card} closed={false} compact />
    </Sheet>
  )
}
