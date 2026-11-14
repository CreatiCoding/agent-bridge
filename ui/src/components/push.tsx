// Web push: a push carries nothing; it wakes the service worker (/sw.js), which asks the server what to say.
// In the iOS app there is no web push: 앱 알림 (REQ-F-774) asks the app for the system's permission and its APNs
// device token through webkit.messageHandlers.push, and the page registers that token with the server.
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { Switch } from '../kit'
import { toast } from '../kit/overlay'
import { featureOn } from '../lib/features'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function b64(key: string) {
  const s = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** What the app says (ios/Bridge/BridgeApp.swift): the system's notification permission and, once given, the token. */
interface AppPush {
  permission: 'granted' | 'denied' | 'notDetermined' | 'provisional' | 'ephemeral'
  token?: string
  env?: 'production' | 'sandbox'
  device?: 'iphone' | 'ipad'
  error?: string
}
type Bridge = { webkit?: { messageHandlers?: { push?: { postMessage(m: unknown): void } } }; bridgePush?: (id: number, m: AppPush) => void }
const appHandler = () => (window as unknown as Bridge).webkit?.messageHandlers?.push
export const inAppPush = () => !!appHandler()

let nextAsk = 1
const waiting = new Map<number, (m: AppPush) => void>()
/** Asks the app: `status` answers at once, `enable` after the person answers the system's question. */
function askApp(action: 'status' | 'enable'): Promise<AppPush> {
  const w = window as unknown as Bridge
  w.bridgePush ??= (id, m) => {
    waiting.get(id)?.(m)
    waiting.delete(id)
  }
  const id = nextAsk++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    // The system question waits for the person; registering with Apple then takes a moment.
    setTimeout(() => waiting.get(id) && (waiting.delete(id), resolve({ permission: 'notDetermined', error: '앱이 답하지 않았어요. 다시 시도해 주세요' })), action === 'enable' ? 120_000 : 5_000)
    appHandler()?.postMessage({ action, id })
  })
}

/** Signing out in the app: this phone stops getting that person's notifications. */
export async function appPushOff() {
  if (!inAppPush()) return
  const s = await askApp('status')
  if (s.token) await post('/api/push/apns', { token: s.token, off: true }).catch(() => {})
}

function AppPushToggle() {
  const [on, setOn] = useState<boolean | null>(null)
  const [ready, setReady] = useState(true)
  useEffect(() => {
    askApp('status').then(async (s) => {
      const r = await get<{ on: boolean; apns: boolean }>(`/api/push/apns?token=${encodeURIComponent(s.token ?? '')}`).catch(() => null)
      setReady(r?.apns ?? true)
      setOn(s.permission === 'granted' && !!r?.on)
    })
  }, [])
  const toggle = async (want: boolean) => {
    try {
      if (want) {
        const s = await askApp('enable')
        if (s.permission === 'denied') return toast('알림이 꺼져 있어요. iPhone 설정 → Agent Bridge → 알림에서 켜 주세요', { tone: 'bad' })
        if (!s.token || !s.env || !s.device) return toast(s.error || '알림을 켜지 못했어요. 다시 시도해 주세요', { tone: 'bad' })
        const r = await post<{ ok: true; apns: boolean }>('/api/push/apns', { token: s.token, env: s.env, device: s.device })
        setReady(r.apns)
        setOn(true)
        toast('이 기기로 앱 알림을 보내요')
      } else {
        const s = await askApp('status')
        if (s.token) await post('/api/push/apns', { token: s.token, off: true })
        setOn(false)
        toast('이 기기 알림을 껐어요')
      }
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  return (
    <div className="stack" style={{ gap: 2 }}>
      <label className="hstack" style={{ fontSize: 'var(--fs-small)' }}>
        <Switch label="이 기기로 앱 알림" checked={!!on} onChange={toggle} />
        이 기기로 앱 알림
      </label>
      {on && !ready ? <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>서버에 푸시 키가 없어서 아직 알림이 오지 않아요</span> : null}
    </div>
  )
}

/**
 * When a push goes out (REQ-F-866), in the words the settings show under the switch. Kept here beside the switch so a
 * change to the server's triggers (server/agentmsg.go, delegate.go, tidy.go, notices.go pushTo) is changed here too.
 */
export const PUSH_WHEN = [
  '답해야 세션이 움직일 때: 권한 요청·질문·플랜 승인·터미널 확인. 5분 동안 답이 없으면 한 번 더(권한 요청은 10분에도)',
  '관리자 비밀번호(sudo)가 필요할 때, 맥에 시스템 허락 창이 떴을 때',
  '세션 정리 예고와 하루 요약',
  '기기의 Claude 로그인이 3일 안에 끝날 때(계정·만료일마다 한 번)',
] as const
export const PUSH_NOT = '답을 마친 것, 백그라운드 작업이 끝난 것, 다른 맥에 일을 맡긴 것은 알리지 않아요. 그 대화를 열어 두었으면 알리지 않고, 이 페이지를 보고 있으면(45초 안) 푸시를 건너뛰어요. 권한 요청·시스템 허락 창·Claude 로그인 만료는 그래도 보내요.'

/** The list under the switch in Settings → 화면·알림: what makes a push. */
export function PushWhen() {
  return (
    <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
      알림이 오는 때
      <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
        {PUSH_WHEN.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {PUSH_NOT}
    </div>
  )
}

export function PushToggle() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (inAppPush() || !supported()) return setOn(null)
    navigator.serviceWorker.getRegistration('/').then(async (reg) => setOn(!!(await reg?.pushManager.getSubscription())), () => setOn(false))
  }, [])
  if (inAppPush()) return <AppPushToggle />
  if (!featureOn('webpush')) return null // web push off on this server (REQ-F-812); app push stays
  if (on === null && !supported()) return <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>이 브라우저는 웹 푸시를 못 받아요 (폰은 홈 화면에 추가한 뒤)</span>
  const toggle = async (want: boolean) => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      await navigator.serviceWorker.ready
      if (want) {
        if ((await Notification.requestPermission()) !== 'granted') return toast('알림 권한이 꺼져 있어요. 브라우저 설정에서 켜 주세요', { tone: 'bad' })
        const { key } = await get<{ key: string }>('/api/push/key')
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) })
        await post('/api/push/subscribe', { endpoint: sub.endpoint })
        setOn(true)
        toast('이 기기로 알림을 보내요')
      } else {
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          await post('/api/push/subscribe', { endpoint: sub.endpoint, off: true })
          await sub.unsubscribe()
        }
        setOn(false)
        toast('이 기기 알림을 껐어요')
      }
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  return (
    <label className="hstack" style={{ fontSize: 'var(--fs-small)' }}>
      <Switch label="이 기기로 웹 푸시" checked={!!on} onChange={toggle} />
      이 기기로 웹 푸시
    </label>
  )
}
