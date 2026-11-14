// Claude 로그인 갱신 (REQ-F-910): when each Claude account on a Mac signs out by itself (claude auth status
// loginExpiresAt), and signing it in again from the phone. The Mac starts `claude auth login --claudeai` in a
// terminal of its own, this shows the address it printed, and the code the sign-in page gives (`<code>#<state>`) is
// pasted back whole. Asking again starts a new sign-in: the last address stops working, so only the new one is shown.
// The code is kept in the input alone (no React state, so it is in no attribute), and the input is emptied once sent.
import { useEffect, useRef, useState } from 'react'
import { errorText, post } from '../lib/api'
import type { Account } from '../lib/types'
import { Badge, Button, Icon, NO_AUTOFILL } from '../kit'
import { toast } from '../kit/overlay'
import { copyText, linkClick } from '../lib/builtin-actions'

type Reply = { ok: true; accounts: Account[]; url?: string; id?: string; notes?: string[]; same?: boolean | null }
export const accountCall = (hostId: string, body: Record<string, unknown>) => post<Reply>(`/api/hosts/${hostId}/accounts`, body)

const DAY = 86_400_000
/** From this many ms before the end a sign-in is shown as a warning (7 days); the phone is told at 3 (server). */
export const LOGIN_WARN_MS = 7 * DAY
/** What the Mac accepts as a pasted code (agent/accounts.mjs safeLoginCode). */
const CODE_SHAPE = /^[A-Za-z0-9_\-#.~]{8,512}$/

/** When an account's sign-in ends, said for a row: the date, the days left, and how loud. Null when not known. */
export function expiryOf(a: Pick<Account, 'expiresAt' | 'loggedIn'>, now = Date.now()): { text: string; tone: 'red' | 'amber' | 'grey' } | null {
  if (!a.expiresAt || !a.loggedIn) return null
  const date = new Date(a.expiresAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
  const left = a.expiresAt - now
  if (left <= 0) return { text: `로그인이 끝났어요 (${date})`, tone: 'red' }
  const days = Math.ceil(left / DAY)
  return { text: `${date}까지 로그인 (${days}일 남음)`, tone: left <= LOGIN_WARN_MS ? 'amber' : 'grey' }
}

/** The loudest of a host's accounts (the main one first on a tie), for the host list. */
export function hostLoginLine(accounts: Account[] | undefined, now = Date.now()) {
  const order = { red: 0, amber: 1, grey: 2 }
  let best: { a: Account; e: { text: string; tone: 'red' | 'amber' | 'grey' } } | null = null
  for (const a of accounts ?? []) {
    if (a.external) continue
    if (a.loggedIn === false) return { text: `${a.main ? 'Claude' : a.name} 로그인 필요`, tone: 'red' as const }
    const e = expiryOf(a, now)
    if (e && (!best || order[e.tone] < order[best.e.tone])) best = { a, e }
  }
  if (!best) return null
  return { text: best.a.main ? `Claude ${best.e.text}` : `${best.a.name}: ${best.e.text}`, tone: best.e.tone }
}

/**
 * The renewal for one account: a button, then the address and the code input, then how it went. `onAccounts` gets
 * the Mac's list after each step. `label` is the button's word (로그인 갱신, or 로그인 when signed out).
 */
export function LoginRenew({ hostId, account, onAccounts, label, autoStart }: { hostId: string; account: Account; onAccounts?: (list: Account[]) => void; label?: string; autoStart?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [filled, setFilled] = useState(false)
  const [bad, setBad] = useState('')
  const [result, setResult] = useState<{ same: boolean | null; expiresAt?: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const startedAt = useRef(0)
  // The Mac closed that sign-in (30 minutes passed, or it restarted): its address no longer works.
  const closed = !!url && !busy && !account.signingIn && Date.now() - startedAt.current > 15_000
  useEffect(() => {
    if (!closed) return
    setUrl(null)
    clearCode()
    toast('그 맥의 로그인 창이 닫혔어요. 다시 하려면 로그인 갱신을 눌러 새 주소를 받아 주세요', { tone: 'bad' })
  }, [closed])
  const clearCode = () => {
    if (input.current) input.current.value = ''
    setFilled(false)
  }
  const call = async (op: string, extra: Record<string, unknown> = {}) => {
    setBusy(op)
    try {
      const r = await accountCall(hostId, { op, id: account.id, ...extra })
      onAccounts?.(r.accounts)
      return r
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      return null
    } finally {
      setBusy('')
    }
  }
  const start = async () => {
    setResult(null)
    setBad('')
    clearCode()
    const r = await call('login')
    startedAt.current = Date.now()
    setUrl(r?.url ?? null)
  }
  const send = async () => {
    const code = input.current?.value.trim() ?? ''
    if (!CODE_SHAPE.test(code)) return setBad('코드 모양이 아니에요. 승인 뒤 나온 코드를 그대로(#… 까지) 붙여 넣어 주세요')
    setBad('')
    clearCode()
    // Back to "just started", so the closing of the terminal on the Mac below is not taken for a timeout.
    startedAt.current = Date.now()
    const r = await call('code', { code })
    // Sent or not, that sign-in's terminal is closed on the Mac: a new try starts with a new address.
    setUrl(null)
    if (!r) return
    const now = r.accounts.find((x) => x.id === account.id)
    setResult({ same: r.same ?? null, expiresAt: now?.expiresAt })
    toast(r.same === false ? '로그인했어요. 그런데 다른 계정이에요' : '로그인했어요', r.same === false ? { tone: 'bad' } : undefined)
  }
  const cancel = () => {
    void call('cancel')
    setUrl(null)
    clearCode()
  }
  // A new account (계정 추가) goes straight on to its sign-in, once: also when its row came before the flag.
  const didAuto = useRef(false)
  useEffect(() => {
    if (autoStart && !didAuto.current) (didAuto.current = true), void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart])
  const newExpiry = result?.expiresAt ? expiryOf({ expiresAt: result.expiresAt, loggedIn: true }) : null

  return (
    <div className="stack" style={{ gap: 8 }}>
      {!url ? (
        <div>
          <Button size="sm" tone={account.loggedIn === false ? 'primary' : undefined} icon="key" busy={busy === 'login'} onClick={start}>
            {label ?? (account.loggedIn === false ? '로그인' : '로그인 갱신')}
          </Button>
        </div>
      ) : (
        <div className="account-login stack">
          <ol className="guide-list" style={{ margin: 0 }}>
            <li>
              <b>로그인 페이지 열기</b> 를 눌러 <b>{account.name}</b> 에 쓰던 Claude 계정으로 승인해요. 폰에서 열어도 돼요.
            </li>
            <li>승인 뒤 나온 코드를 통째로 복사해 아래 칸에 붙여 넣어요.</li>
          </ol>
          <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
            <a className="btn btn-primary btn-sm" href={url} target="_blank" rel="noreferrer noopener" onClick={linkClick(url, 'accounts')}>
              <Icon name="link" />
              <span>로그인 페이지 열기</span>
            </a>
            <Button size="sm" onClick={() => copyText(url, 'link').then((ok) => ok && toast('로그인 주소를 복사했어요'))}>
              주소 복사
            </Button>
            <Button size="sm" icon="refresh" busy={busy === 'login'} disabled={busy === 'code'} onClick={start} title="새 로그인을 띄워요. 지금 주소는 더 이상 쓸 수 없어요">
              새 주소 받기
            </Button>
          </div>
          <div className="hstack" style={{ gap: 6 }}>
            <input
              ref={input}
              className="input grow"
              {...NO_AUTOFILL}
              onChange={(e) => setFilled(!!e.target.value.trim())}
              onKeyDown={(e) => e.key === 'Enter' && filled && void send()}
              placeholder="승인 후 나온 코드 붙여넣기"
              aria-label="로그인 코드"
            />
            <Button size="sm" tone="primary" disabled={!filled} busy={busy === 'code'} onClick={send}>
              확인
            </Button>
            <Button size="sm" disabled={busy === 'code'} onClick={cancel}>
              취소
            </Button>
          </div>
          {bad ? (
            <p style={{ margin: 0, color: 'var(--red)', fontSize: 'var(--fs-small)' }}>{bad}</p>
          ) : null}
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
            30분 안에 코드를 넣지 않으면 그 맥의 로그인 창이 닫혀요. 그때는 새 주소를 받아 주세요.
          </p>
        </div>
      )}
      {result ? (
        result.same === false ? (
          <div className="banner" role="alert" style={{ background: 'var(--red-soft)', fontSize: 'var(--fs-large)' }}>
            <Icon name="warn" />
            <div className="banner-body">
              <b>다른 계정으로 로그인됐어요.</b> 갱신 전과 다른 Claude 계정이에요. 이 계정으로 도는 세션과 서비스가 다른 계정의 사용량·요금제로 바뀌어요. 원래 계정이 맞다면 <b>로그인 갱신</b> 을 다시 눌러 원래 계정으로 승인해 주세요.
            </div>
          </div>
        ) : (
          <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
            {result.same === true ? <Badge tone="green">같은 계정</Badge> : null}
            <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
              로그인했어요{newExpiry ? ` · ${newExpiry.text}` : ''}
            </span>
          </div>
        )
      ) : null}
    </div>
  )
}

/** 기기 화면의 "Claude 로그인": each of the Mac's own accounts, its end date and its renewal. */
export function ClaudeLoginBox({ hostId, accounts, online }: { hostId: string; accounts: Account[]; online: boolean }) {
  // The list comes from the page's state: the server sends it again after each step.
  const shown = accounts.filter((a) => !a.external)
  if (!shown.length) return null
  return (
    <section className="card-box">
      <h2 className="card-head" style={{ marginTop: 0 }}>
        Claude 로그인
      </h2>
      <div className="stack" style={{ gap: 0 }}>
        {shown.map((a) => {
          const e = expiryOf(a)
          return (
            <div key={a.id} className="account-row stack" style={{ gap: 6 }}>
              <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
                <b>{a.name}</b>
                {a.loggedIn === false ? <Badge tone="red">로그인 필요</Badge> : e?.tone === 'red' ? <Badge tone="red">만료됨</Badge> : e?.tone === 'amber' ? <Badge tone="amber">곧 만료</Badge> : a.loggedIn ? <Badge tone="green">로그인됨</Badge> : null}
                {a.renewedAt && a.sameAccount === false ? <Badge tone="red">다른 계정으로 로그인됨</Badge> : a.renewedAt && a.sameAccount ? <Badge tone="green">같은 계정</Badge> : null}
              </div>
              <div className="muted" style={{ fontSize: 'var(--fs-small)', ...(e && e.tone !== 'grey' ? { color: e.tone === 'red' ? 'var(--red)' : 'var(--amber)', fontWeight: 600 } : {}) }}>
                {a.loggedIn === null ? '로그인 상태를 확인하는 중' : a.loggedIn === false ? '로그인돼 있지 않아요. 세션이 로그인 화면에서 멈춰요' : (e?.text ?? `로그인됨${a.method ? ` · ${a.method}` : ''} (만료일을 알 수 없어요)`)}
              </div>
              {online ? <LoginRenew hostId={hostId} account={a} /> : null}
            </div>
          )
        })}
      </div>
      {!online ? (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 'var(--fs-small)' }}>
          이 기기가 연결되면 로그인을 갱신할 수 있어요.
        </p>
      ) : null}
    </section>
  )
}
