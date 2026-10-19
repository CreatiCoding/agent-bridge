// 관리자 권한 (REQ-F-764). A session on one of the person's Macs wants root (`:sudo`, or sudo run by Claude): the
// Mac's admin password is asked here, on top of whatever is open, and kept on that Mac for 5 minutes. While it is
// open a small bar says so, with a way to close it now.
import { useEffect, useState } from 'react'
import { errorText, post } from '../lib/api'
import { useStore } from '../lib/store'
import type { Host } from '../lib/types'
import { Button, Icon } from '../kit'
import { Sheet, toast } from '../kit/overlay'

const left = (until: number) => {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function SudoGate() {
  const hosts = useStore((s) => s.state?.hosts)
  const asking = hosts?.find((h) => h.sudo?.asks.length) ?? null
  const open = (hosts ?? []).filter((h) => (h.sudo?.until ?? 0) > Date.now())
  const [, tick] = useState(0)
  useEffect(() => {
    if (!open.length) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [open.length])
  return (
    <>
      {asking ? <SudoAsk key={asking.id} host={asking} /> : null}
      {open.length ? (
        <div className="sudo-bar" role="status">
          {open.map((h) => (
            <span key={h.id} className="sudo-bar-item">
              <Icon name="key" />
              {h.name} 관리자 권한 {left(h.sudo!.until)}
              <button type="button" className="sudo-bar-close" onClick={() => post(`/api/hosts/${h.id}/sudo`, { off: true }).then(() => toast('관리자 권한을 닫았어요'), (e) => toast(errorText(e), { tone: 'bad' }))}>
                닫기
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  )
}

function SudoAsk({ host }: { host: Host }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [pw])
  const asks = host.sudo?.asks ?? []
  const cancel = () => post(`/api/hosts/${host.id}/sudo`, { cancel: true }).catch((e) => toast(errorText(e), { tone: 'bad' }))
  const submit = async () => {
    if (!pw || busy) return
    setBusy(true)
    try {
      await post(`/api/hosts/${host.id}/sudo`, { password: pw })
      setPw('')
      toast(`${host.name} 의 관리자 권한을 5분 열었어요`)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }
  return (
    <Sheet
      open
      onClose={cancel}
      title="관리자 비밀번호"
      footer={
        <div className="dialog-buttons">
          <Button onClick={cancel}>취소</Button>
          <Button tone="primary" busy={busy} disabled={!pw} onClick={submit}>
            5분 열기
          </Button>
        </div>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        <b>{host.name}</b> 에서 관리자 권한(sudo)으로 실행하려고 해요. 그 맥의 로그인 비밀번호를 넣으면 5분 동안 다시 묻지 않아요. 비밀번호는 그 맥의 메모리에만 있다가 지워져요.
      </p>
      <ul className="sudo-asks">
        {asks.map((a) => (
          <li key={a.id}>
            <span className="sudo-ask-title">{a.title || '세션'}</span>
            {a.what ? <code>{a.what}</code> : null}
          </li>
        ))}
      </ul>
      <input className="input" type="password" autoFocus autoComplete="off" value={pw} placeholder="맥 로그인 비밀번호" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()} aria-label="맥 로그인 비밀번호" />
      {error ? <p className="lock-error">{error}</p> : null}
    </Sheet>
  )
}
