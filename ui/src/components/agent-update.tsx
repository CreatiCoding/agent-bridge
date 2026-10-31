// 새 버전 안내 (REQ-F-832). A Mac that takes new agents only at night holds one it has received until then; this asks
// once whether to put it in now. "나중에" leaves it for this page load, "하루 동안 안 보기" for a day on this browser,
// both for every Mac and every build: a new deploy does not bring it back (1.379).
import { useState } from 'react'
import { useStore } from '../lib/store'
import type { Host } from '../lib/types'
import { AGENT_UPDATE_SNOOZE_MS, getAgentSnooze, setAgentSnooze } from '../lib/local'
import { Button } from '../kit'
import { Sheet, toast } from '../kit/overlay'
import { errorText, post } from '../lib/api'

/** "나중에" was pressed in this page load. */
let later = false

/** The first Mac holding a new agent the person may want now: online, waiting for its window; none while put off. */
export function waitingUpdate(hosts: Host[] | undefined, snoozeUntil: number, now: number, putOff = later): Host | null {
  if (putOff || snoozeUntil > now) return null
  for (const h of hosts ?? []) {
    const p = h.update?.pending
    if (!h.online || !p || p.now || h.update?.mode !== 'night') continue
    return h
  }
  return null
}

export function AgentUpdatePrompt() {
  const hosts = useStore((s) => s.state?.hosts)
  const [, redraw] = useState(0)
  const host = waitingUpdate(hosts, getAgentSnooze(), Date.now())
  const [busy, setBusy] = useState(false)
  if (!host?.update?.pending) return null
  const { build } = host.update.pending
  const { from, to } = host.update
  const putOff = () => {
    later = true
    redraw((n) => n + 1)
  }
  const snooze = () => {
    setAgentSnooze(Date.now() + AGENT_UPDATE_SNOOZE_MS)
    putOff()
  }
  const go = async () => {
    setBusy(true)
    await updateNow(host.id)
    setBusy(false)
    putOff()
  }
  return (
    <Sheet
      open
      onClose={putOff}
      title="새 버전이 있어요"
      footer={
        <div className="dialog-buttons">
          <Button tone="ghost" onClick={snooze}>
            하루 동안 안 보기
          </Button>
          <Button onClick={putOff}>나중에</Button>
          <Button tone="primary" busy={busy} onClick={() => void go()}>
            지금 업데이트
          </Button>
        </div>
      }
    >
      <p style={{ marginTop: 0 }}>
        <b>{host.name}</b> 이 에이전트 새 버전({build})을 받아 뒀어요. 그대로 두면 그 맥의 시각으로 <b>{from}~{to}시</b> 사이에 바꿔요{host.update.skipBusy ? '(그때 작업 중인 세션이 있으면 다음 날로)' : ''}.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        지금 바꾸면 에이전트가 몇 초 동안 다시 시작해요. 세션은 그대로 이어지지만, 그 사이에 쓰던 화면은 잠깐 끊긴 것처럼 보일 수 있어요. 바꾸는 시간은 맥 화면의 자동 업데이트에서 고칠 수 있어요.
      </p>
    </Sheet>
  )
}

/** 지금 업데이트 (REQ-F-832): the Mac puts the new agent it holds in place now. */
export async function updateNow(hostId: string) {
  try {
    await post(`/api/hosts/${hostId}/update`, { now: true })
    toast('새 버전으로 바꾸는 중이에요. 몇 초 뒤 다시 연결돼요')
    return true
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
    return false
  }
}
