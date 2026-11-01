// 설정 → 이 기기 → 맥 짝짓기 (REQ-S-090): pair this browser with a Mac that does not trust the server, see the
// devices it has, and remove one. The Mac decides everything: this card only asks it and shows what it says.
import { useEffect, useState } from 'react'
import { errorText, post } from '../lib/api'
import { useStore } from '../lib/store'
import { deviceId, forgetHost, listedOn, loadTrust, onTrustChange, pairedWith, refreshKeys, startPairing, supported } from '../lib/trust'
import type { Host } from '../lib/types'
import { Badge, Button, CardHead } from '../kit'
import { chooseDialog, toast } from '../kit/overlay'

const MODE_LABEL = { off: '꺼짐', warn: '경고만', enforce: '서명 필수' } as const

function defaultName() {
  const ua = navigator.userAgent
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '기기'
  const app = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '브라우저'
  return `${what} ${app}`
}

const ask = (hostId: string) => (body: Record<string, unknown>) => post<Record<string, unknown>>(`/api/hosts/${hostId}/trust`, body)

function HostRow({ h }: { h: Host }) {
  const t = h.trust
  const [sas, setSas] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mine = pairedWith(h.id)
  const listed = listedOn(h)
  const me = deviceId()

  const pair = async () => {
    setBusy(true)
    try {
      const p = await startPairing(h.id, defaultName(), ask(h.id))
      setSas(p.sas)
      const until = Date.now() + 3 * 60_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const s = await p.poll()
        if (s === 'ok') return toast('짝지었어요 · 이제 이 기기에서 보내는 명령에 서명이 붙어요', { tone: 'ok' })
        if (s === 'no') return toast('맥에서 짝짓기를 거절했거나 숫자가 달랐어요', { tone: 'bad' })
        if (Date.now() > until) return toast('시간이 지나 짝짓기를 그만뒀어요', { tone: 'bad' })
      }
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    } finally {
      setSas(null)
      setBusy(false)
    }
  }

  const remove = async (id: string, name: string) => {
    const self = id === me
    const ok = await chooseDialog(`${name} 을(를) 해제할까요?`, [{ value: 'yes', label: '해제', danger: true }], self ? '이 기기예요. 해제하면 이 맥에 명령을 보낼 수 없게 돼요(서명 필수일 때).' : '해제한 기기는 다음 키부터 이 맥의 내용을 읽지 못해요.')
    if (ok !== 'yes') return
    try {
      await post(`/api/hosts/${h.id}/trust`, { op: 'remove', id })
      if (self) await forgetHost(h.id)
      else await refreshKeys(h.id, ask(h.id)).catch(() => {})
      toast('해제했어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }

  return (
    <div className="stack" style={{ gap: 8, paddingBlock: 8, borderTop: '1px solid var(--line)' }}>
      <div className="hstack">
        <div className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
          {h.name} {t ? <Badge tone={t.mode === 'enforce' ? 'green' : t.mode === 'warn' ? 'amber' : 'grey'}>{MODE_LABEL[t.mode]}</Badge> : <Badge>지원 안 함</Badge>}{' '}
          {mine && listed ? <Badge tone="blue">이 기기와 짝지음</Badge> : mine ? <Badge tone="red">맥 목록에 없음</Badge> : null}
          {t?.fp ? <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>맥 지문 {t.fp}</div> : null}
        </div>
        {t && t.mode !== 'off' && !mine ? (
          <Button size="sm" busy={busy} disabled={!h.online || !supported()} onClick={() => void pair()}>
            짝짓기
          </Button>
        ) : null}
      </div>
      {sas ? (
        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontSize: 28, fontVariantNumeric: 'tabular-nums', letterSpacing: 4 }}>
            {sas.slice(0, 3)} {sas.slice(3)}
          </div>
          <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
            {h.name} 의 터미널에서 <code>trust pair</code> 가 묻는 칸에 이 여섯 자리를 입력하세요. 맥이 같은 숫자를 보여 주면 짝지어져요. 이 숫자를 맥 말고 다른 곳(채팅 등)에 적지 마세요.
          </div>
        </div>
      ) : null}
      {t && t.mode !== 'off' && !mine && !sas ? (
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          {t.window ? '맥에서 짝짓기 창이 열려 있어요.' : <>먼저 그 맥 터미널에서 <code>node ~/.claude-bridge/agent.mjs trust pair</code> 를 실행하세요.</>}
        </div>
      ) : null}
      {t && t.mode === 'off' ? (
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          서버를 믿지 않는 모드는 그 맥에서만 켤 수 있어요: <code>node ~/.claude-bridge/agent.mjs trust mode enforce</code>
        </div>
      ) : null}
      {t?.devices?.length ? (
        <div className="stack" style={{ gap: 4 }}>
          {t.devices.map((d) => (
            <div key={d.id} className="hstack" style={{ fontSize: 'var(--fs-small)' }}>
              <span className="grow">
                {d.name}
                {d.id === me ? ' (이 기기)' : ''} <span className="muted">· {new Date(d.at).toLocaleDateString()} 짝지음{d.used ? ` · ${new Date(d.used).toLocaleString()} 마지막 사용` : ''}</span>
              </span>
              {mine ? (
                <Button size="sm" tone="danger" onClick={() => void remove(d.id, d.name)}>
                  해제
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TrustPanel() {
  const hosts = useStore((s) => s.state?.hosts ?? [])
  const [, bump] = useState(0)
  useEffect(() => {
    void loadTrust()
    return onTrustChange(() => bump((n) => n + 1))
  }, [])
  const list = hosts.filter((h) => h.kind !== 'demo')
  return (
    <section className="card-box">
      <CardHead
        title="맥 짝짓기 (서버를 믿지 않는 맥)"
        help="짝지은 맥은 이 기기가 서명한 명령만 따르고, 맥에서 나가는 대화 내용은 짝지은 기기만 읽어요. 서버가 털려도 그 맥에 지시를 보낼 수 없게 하는 선택 모드예요. 이 페이지의 코드는 서버가 내려주므로, 서버가 바뀐 코드를 내려주는 동안 이 기기에서 한 조작까지 막지는 못해요."
      />
      {!supported() ? <div className="muted">이 브라우저는 기기 키를 만들 수 없어요(WebCrypto·IndexedDB 필요).</div> : null}
      {list.length ? list.map((h) => <HostRow key={h.id} h={h} />) : <div className="muted">연결된 맥이 없어요.</div>}
    </section>
  )
}
