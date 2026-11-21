// 로컬로 바꾸기 버튼 (REQ-F-926): on a PC's app rail, when this browser is on one of the person's Macs (its agent
// answers with the key this browser keeps), one press switches that Mac to its own local server, as
// `local --full on` at its terminal does: the agent cuts the site, starts the signed Mac build and hands back a
// one-time link, which this page opens. Asked of the agent at 127.0.0.1 directly, never through the site's server.
import { useState } from 'react'
import { agentInfo } from '../../../web/relay.js'
import { IconButton } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { localServer } from '../lib/features'
import { useStore } from '../lib/store'
import { useLocalHost } from './local-preview'

/** The build may be fetched first (up to 200 MB) and the server started: a few minutes at most. */
const WAIT_MS = 5 * 60_000

export function RailLocalFull() {
  const here = useLocalHost()
  const host = useStore((s) => (here ? s.state?.hosts.find((h) => h.id === here) : undefined))
  const [busy, setBusy] = useState(false)
  // Only a Mac of mine that is linked now, and never on the local server's own screen (it has its way back).
  if (localServer() || !host || !host.online || host.info?.os?.startsWith('Linux')) return null
  const run = async () => {
    const ok = await confirmDialog(`이 맥(${host.name})을 로컬로 바꿀까요?`, {
      text: '이 맥이 사이트 연결을 끊고 맥 자신의 서버로 같은 화면을 띄워요. 이 브라우저는 그 화면으로 넘어가요. 휴대폰 등 다른 기기에서는 이 맥이 끊긴 것으로 보여요. 사이트로 돌아오려면 로컬 화면의 맥 정보에서 "사이트로 돌아가기"를 눌러요.',
      ok: '로컬로 바꾸기',
    })
    if (!ok) return
    const a = agentInfo() as { port: number; key: string } | null
    if (!a) return toast('이 맥의 연동 정보가 없어요', { tone: 'bad' })
    setBusy(true)
    toast('로컬로 바꾸는 중이에요. 맥용 서버를 처음 받으면 1~2분 걸려요', { ms: 8000 })
    try {
      const r = await fetch(`http://127.0.0.1:${a.port}/localfull/on`, { method: 'POST', headers: { 'X-Bridge-Key': a.key }, signal: AbortSignal.timeout(WAIT_MS) })
      const j = (await r.json().catch(() => ({}))) as { link?: string; error?: string }
      // Only the local server's own address is opened, whatever else an answer says.
      if (r.ok && typeof j.link === 'string' && /^http:\/\/127\.0\.0\.1:\d{4,5}\/#t=[A-Za-z0-9_-]{43}$/.test(j.link)) {
        location.assign(j.link)
        return
      }
      toast(j.error ? `바꾸지 못했어요: ${j.error}` : `바꾸지 못했어요 (${r.status})`, { tone: 'bad' })
    } catch (e) {
      toast(`맥에 닿지 못했어요: ${(e as Error).message}`, { tone: 'bad' })
    }
    setBusy(false)
  }
  return <IconButton icon="laptop" label={busy ? '로컬로 바꾸는 중…' : `이 맥(${host.name})을 로컬로 바꾸기`} disabled={busy} aria-busy={busy} onClick={() => void run()} />
}
