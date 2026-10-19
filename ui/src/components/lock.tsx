// Locking a session with a password, unlocking it in this tab, and the screen a locked session shows.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { errorText, post } from '../lib/api'
import { dropLog } from '../lib/cache'
import { proofOf, setToken, tokenOf } from '../lib/locks'
import type { Session } from '../lib/types'
import { Button, Icon } from '../kit'
import { promptDialog, toast } from '../kit/overlay'

/** Whether this tab holds the key to a session (re-read when a tab unlocks or locks again). */
export function useUnlocked(sid: string) {
  return useSyncExternalStore(
    (f) => (addEventListener('cb-unlock', f), () => removeEventListener('cb-unlock', f)),
    () => !!tokenOf(sid),
  )
}

const MIN = 4

export async function lockSession(s: Session) {
  const pw = await promptDialog('세션 잠그기', { text: `이 세션의 대화·화면·알림 내용을 비밀번호로 가려요. 다른 기기와 탭에서는 비밀번호를 물어요. 비밀번호를 잊으면 풀 수 없어요. (${MIN}자 이상)`, placeholder: '비밀번호', ok: '다음' })
  if (pw == null) return
  if (pw.length < MIN) return toast(`비밀번호는 ${MIN}자 이상이어야 해요`, { tone: 'bad' })
  const again = await promptDialog('비밀번호 확인', { placeholder: '한 번 더', ok: '잠그기' })
  if (again == null) return
  if (again !== pw) return toast('두 비밀번호가 달라요', { tone: 'bad' })
  try {
    const r = await post<{ ok: true; token: string; note: string }>(`/api/sessions/${s.id}/lock`, { proof: await proofOf(pw) })
    setToken(s.id, r.token)
    void dropLog(s.id)
    toast(r.note)
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
  }
}

export async function clearLock(s: Session) {
  const pw = await promptDialog('잠금 없애기', { text: '비밀번호를 넣으면 잠금을 없애요. 모든 기기에서 다시 내용이 보여요.', placeholder: '비밀번호', ok: '잠금 없애기' })
  if (pw == null) return
  try {
    toast((await post<{ ok: true; note: string }>(`/api/sessions/${s.id}/lockclear`, { proof: await proofOf(pw) })).note)
    setToken(s.id, null)
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
  }
}

/** Locked again in this tab: the key is dropped, the conversation goes from the screen. */
export const relock = (s: Session) => (setToken(s.id, null), toast('이 탭에서 다시 잠갔어요'))

export function LockScreen({ s }: { s: Session }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [pw])
  const unlock = async () => {
    if (!pw) return
    setBusy(true)
    try {
      const r = await post<{ ok: true; token: string | null }>(`/api/sessions/${s.id}/unlock`, { proof: await proofOf(pw) })
      setToken(s.id, r.token)
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }
  return (
    <div className="lock-screen">
      <span className="empty-icon">
        <Icon name="key" />
      </span>
      <p className="empty-title">잠긴 세션이에요</p>
      <p className="muted" style={{ margin: 0 }}>
        비밀번호를 넣으면 이 탭에서 열려요. 탭을 닫으면 다시 잠겨요.
      </p>
      <input className="input" type="password" autoFocus value={pw} placeholder="비밀번호" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && unlock()} aria-label="비밀번호" />
      {error ? <p className="lock-error">{error}</p> : null}
      <Button tone="primary" block busy={busy} disabled={!pw} onClick={unlock}>
        열기
      </Button>
    </div>
  )
}
