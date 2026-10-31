// The Macs: how to connect one, how each is doing (checks, link, agent), and its log.
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { ago, batteryLine, batteryLow, bytes, hostBattery, clock, duration, shortPath, sysLine, type SysUse } from '../lib/format'
import { back, go } from '../lib/router'
import { hostIcon, KINDS } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import type { Me, Session, UpdatePolicy } from '../lib/types'
import { Button, CardHead, Empty, Help, Icon, IconButton, PhoneFold, Row, Segmented, Spinner, Switch, useWide } from '../kit'
import { toast } from '../kit/overlay'
import { qrSvg } from '../../../web/qr.js'
import { StateWait, useStateLoaded } from '../components/state-wait'
import { featureOn } from '../lib/features'
import { copyText, openSession } from '../lib/builtin-actions'
import { updateNow } from '../components/agent-update'

export function Copy({ text }: { text: string }) {
  return (
    <div className="codebox">
      <button type="button" className="codebox-copy" style={{ opacity: 1 }} onClick={() => copyText(text, 'code').then((ok) => ok && toast('복사했어요'))}>
        <Icon name="copy" />
        <span>복사</span>
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function PhoneLogin() {
  const [qr, setQr] = useState<{ url: string; exp: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  // The code works once and only until exp: count it down, and let the person make a fresh one at any time.
  useEffect(() => {
    if (!qr) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [qr])
  const make = async () => {
    setBusy(true)
    try {
      const r = await post<{ url: string; exp: number }>('/api/qr', {})
      setNow(Date.now())
      setQr(r)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }
  const left = qr ? Math.max(0, Math.ceil((qr.exp - now) / 1000)) : 0
  return (
    <section className="card-box">
      <CardHead title="폰에서 열기" medium help="폰 카메라로 찍으면 폰이 이 계정으로 로그인돼요. 5분 동안 한 번만 쓸 수 있어요." />
      {qr ? (
        <div className="stack" style={{ alignItems: 'flex-start' }}>
          <div className={`qr${left ? '' : ' qr-expired'}`} dangerouslySetInnerHTML={{ __html: qrSvg(qr.url, 200) }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="muted" style={{ fontSize: 'var(--fs-small)', fontVariantNumeric: 'tabular-nums' }}>
              {left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 남음` : '만료됐어요'}
            </span>
            <Button size="sm" icon="refresh" tone={left ? 'plain' : 'primary'} busy={busy} onClick={make}>
              새 QR
            </Button>
          </div>
        </div>
      ) : (
        <Button icon="qr" busy={busy} onClick={make}>
          QR 만들기
        </Button>
      )}
    </section>
  )
}

/**
 * A host with no browser of its own (a Linux server, REQ-F-798): a one-time sign-in address for its headless browser,
 * handed over in that host's terminal. It signs in only a headless browser, so opening it here does nothing.
 */
function ServerLink() {
  const [code, setCode] = useState<{ url: string; exp: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!code) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [code])
  const make = async () => {
    setBusy(true)
    try {
      setCode(await post<{ url: string; exp: number }>('/api/qr', { headless: true }))
      setNow(Date.now())
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }
  const left = code ? Math.max(0, Math.ceil((code.exp - now) / 1000)) : 0
  return (
    <section className="card-box">
      <CardHead title="화면 없는 기기 연결" medium help="리눅스 서버처럼 브라우저 탭을 열어 둘 수 없는 기기는 에이전트가 헤드리스 브라우저(Chrome 또는 Chromium)로 연동해요. 그 브라우저를 이 계정으로 로그인시키는 주소예요. 5분 동안 한 번 쓸 수 있어요." />
      <ol style={{ paddingLeft: 20, margin: 0 }} className="stack">
        <li>
          그 기기의 터미널에서 설치해요. 리눅스는 systemd 사용자 서비스로 설치돼요.
          <Copy text={`curl -fsSL ${location.origin}/install.sh | bash`} />
        </li>
        <li>
          로그인 주소를 만들어 그 기기의 터미널에서 넘겨요.
          {code && left ? (
            <>
              <Copy text={`node ~/.claude-bridge/agent.mjs headless '${code.url}'`} />
              <span className="muted" style={{ fontSize: 'var(--fs-small)', fontVariantNumeric: 'tabular-nums' }}>
                {`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 남음`}
              </span>
            </>
          ) : (
            <div>
              <Button size="sm" icon="key" busy={busy} onClick={make}>
                {code ? '새 주소 만들기' : '로그인 주소 만들기'}
              </Button>
            </div>
          )}
        </li>
      </ol>
    </section>
  )
}

// A session's state in words (the raw phase was shown: "ended", "busy").
const PHASE: Record<string, string> = { starting: '뜨는 중', busy: '작업 중', waiting: '응답 대기', idle: '쉬는 중', ended: '끝남', dead: '멈춤' }

export function HostsPage({ me }: { me: Me | null }) {
  const wide = useWide()
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const loaded = useStateLoaded()
  const origin = me?.origin ?? location.origin
  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>기기</b>
        </div>
      </div>
      <div className="scroll">
        <div className="page stack">
          {hosts.length ? (
            <section>
              {hosts.map((h) => (
                <Row
                  key={h.id}
                  left={<Icon name={hostIcon(h.kind)} />}
                  title={h.name}
                  sub={
                    <>
                      {`${KINDS[h.kind] ?? '기타'} · ${h.online ? (h.stale ? '응답 없음' : `연결됨${h.rtt ? ` · ${h.rtt}ms` : ''}`) : `끊김 · ${ago(h.lastSeen)}`}${h.problem ? ` · ${h.problem}` : ''}`}
                      {(() => {
                        const bat = hostBattery(h)
                        return bat ? (
                          <>
                            {' · '}
                            <span style={batteryLow(bat.b) && !bat.at ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{`${batteryLine(bat.b)}${bat.at ? ` (${ago(bat.at)})` : ''}`}</span>
                          </>
                        ) : null
                      })()}
                    </>
                  }
                  right={<span className={`dot dot-${h.online ? (h.stale || h.problems ? 'amber' : 'green') : 'grey'}`} />}
                  onClick={() => go({ name: 'host', id: h.id })}
                  chevron
                />
              ))}
            </section>
          ) : !loaded ? (
            <StateWait />
          ) : (
            <Empty icon="laptop" title="연결된 맥이 없어요" />
          )}
          {/* With a Mac already there, a phone folds how to connect one and the QR (opened when there is none). */}
          <PhoneFold icon="laptop" title="맥 연결하기" hint="설치 명령" open={loaded && !hosts.length}>
          <section className="card-box">
            <h2 style={{ marginTop: 0 }}>맥 연결하기</h2>
            <ol style={{ paddingLeft: 20, margin: 0 }} className="stack">
              <li>
                맥의 터미널에서 한 번 실행해요. 필요한 것을 확인하고, 에이전트를 백그라운드 서비스로 설치해요.
                <Copy text={`curl -fsSL ${origin}/install.sh | bash`} />
              </li>
              <li>그 맥의 Chrome 에 이 사이트를 열어 두세요. 열려 있는 탭이 맥과 서버를 이어요. 탭을 모두 닫으면 끊겨요.</li>
              <li>Chrome 이 "로컬 네트워크의 기기에 연결" 을 물으면 허용해요.</li>
            </ol>
            <p className="muted" style={{ fontSize: 'var(--fs-small)' }}>
              문제가 생기면 <a href="/recovery">문제가 생겼을 때</a> · <a href="/bridge">연동 상태 페이지</a>
            </p>
          </section>
          </PhoneFold>
          {featureOn('background') ? (
            <PhoneFold icon="key" title="화면 없는 기기 연결" hint="리눅스 서버">
              <ServerLink />
            </PhoneFold>
          ) : null}
          {/* A header-only server closes the QR sign-in too (REQ-F-816): other devices come in through the proxy. */}
          {featureOn('background') ? (
            <PhoneFold icon="qr" title="폰에서 열기" hint="QR 로그인">
              <PhoneLogin />
            </PhoneFold>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface Awake {
  idle: boolean
  idleActive: boolean
  lid: boolean
  lidActive: boolean
  lidReady: boolean
  kind: string
}

/** Whether the host may sleep: idle sleep (any Mac) and lid sleep (a MacBook). Set here, kept by the agent. */
function AwakeBox({ hostId, kind, awake, online }: { hostId: string; kind: string; awake: Awake | undefined; online: boolean }) {
  const [busy, setBusy] = useState<'idle' | 'lid' | null>(null)
  const [shown, setShown] = useState<{ idle: boolean; lid: boolean } | null>(null)
  const idle = shown?.idle ?? awake?.idle ?? false
  const lid = shown?.lid ?? awake?.lid ?? false
  const set = async (which: 'idle' | 'lid', on: boolean) => {
    setBusy(which)
    try {
      const r = await post<{ ok: true; idle: boolean; lid: boolean }>(`/api/hosts/${hostId}/awake`, { [which]: on })
      setShown({ idle: r.idle, lid: r.lid })
      toast(which === 'idle' ? (r.idle ? '잠자기를 막았어요' : '잠자기를 다시 허용했어요') : r.lid ? '덮개를 닫아도 켜 둬요' : '덮개를 닫으면 잠들게 되돌렸어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  const laptop = kind === 'macbook'
  return (
    <section className="card-box">
      <CardHead title="잠자기" help="맥이 잠들면 세션이 멈추고 웹과 끊겨요. 화면만 꺼지는 것은 괜찮아요." />
      <div className="setting-line">
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>잠자기 막기</b>
          <Help>
            에이전트가 켜져 있는 동안 쓰지 않아도 잠들지 않아요(화면은 꺼질 수 있어요)
          </Help>
        </span>
        <Switch label="잠자기 막기" checked={idle} disabled={!online || busy !== null} onChange={(on) => set('idle', on)} />
      </div>
      {laptop ? (
        <>
          <div className="setting-line">
            <span className="grow">
              <b style={{ fontSize: 'var(--fs-medium)' }}>덮개를 닫아도 켜 두기</b>
              <Help>
                덮개를 닫아도 잠들지 않아요(닫으면 화면은 꺼요). 닫은 채 가방에 넣으면 뜨거워질 수 있어요. 에이전트가 꺼지면 원래대로 돌아가요
              </Help>
            </span>
            <Switch label="덮개를 닫아도 켜 두기" checked={lid} disabled={!online || busy !== null} onChange={(on) => set('lid', on)} />
          </div>
          {awake && !awake.lidReady ? (
            <div className="banner">
              <Icon name="key" />
              <div className="banner-body">
                처음 한 번은 그 맥의 터미널에서 설정해야 해요(관리자 비밀번호를 물어요). pmset 의 잠자기 끄기·켜기만 비밀번호 없이 허용해요.
                <Copy text="node ~/.claude-bridge/agent.mjs awake setup" />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {online ? null : <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>맥이 연결돼 있을 때 바꿀 수 있어요.</p>}
    </section>
  )
}

interface Feature {
  id: string
  title: string
  state: 'ok' | 'warn' | 'fail' | 'off'
  detail: string
  fix?: string
  action?: 'background-restart' | 'awake-apply' | 'check' | 'restart' | 'rekey'
}

const ACTION_LABEL: Record<NonNullable<Feature['action']>, string> = { 'background-restart': '다시 띄우기', 'awake-apply': '다시 적용', check: '다시 점검', restart: '다시 시작', rekey: '키 바꾸기' }

/** What each switchable part does, shown when pointing at its name (the row itself says only where it stands). */
const FEATURE_HELP: Record<string, string> = {
  background: '에이전트가 이 맥의 Chrome 을 화면 없이(헤드리스) 띄워 연동 페이지를 늘 열어 둬요. 탭을 열어 두지 않아도 연결돼요. 켜 둔 동안 메모리를 수백 MB 써요',
  awake: '맥이 잠들면 세션이 멈추고 웹과 끊겨요. 켜 두면 에이전트가 켜져 있는 동안 쓰지 않아도 잠들지 않아요(화면은 꺼질 수 있어요)',
  lid: '덮개를 닫아도 잠들지 않아요(닫으면 화면은 꺼요). 닫은 채 가방에 넣으면 뜨거워질 수 있어요. 에이전트가 꺼지면 원래대로 돌아가요',
}

/**
 * Each part of the agent, where it stands, what it repaired by itself, and a button to repair now. The parts that
 * can be turned on and off (헤드리스 연동 모드, 잠자기 막기, 덮개를 닫아도 켜 두기) carry their switch on the same row,
 * so each shows once.
 */
/** When this Mac's sessions compact their context on their own (REQ-F-775): '' leaves it to Claude Code. */
const COMPACT_CHOICES = ['', '200000', '400000', '600000'] as const

function CompactBox({ hostId, window, online }: { hostId: string; window: number | null; online: boolean }) {
  const [shown, setShown] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const now = shown === undefined ? window : shown
  const value = (COMPACT_CHOICES as readonly string[]).includes(String(now ?? '')) ? String(now ?? '') : ''
  const set = async (v: string) => {
    setBusy(true)
    try {
      const r = await post<{ ok: true; window: number | null }>(`/api/hosts/${hostId}/compact`, { window: v ? Number(v) : null })
      setShown(r.window)
      toast(r.window ? `컨텍스트가 ${Math.round(r.window / 1000)}k 토큰이 되면 압축해요` : 'Claude Code 설정대로 압축해요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  return (
    <section className="card-box">
      <CardHead
        title="자동 압축 시점"
        help="Claude 는 부를 때마다 컨텍스트 전체를 다시 읽어요. 그래서 컨텍스트를 작게 두면 한도를 덜 써요. 대신 압축할 때 앞의 자세한 내용은 요약으로 바뀌어요."
      />
      <div className="setting-line">
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>컨텍스트가 이만큼 차면 압축</b>
          <Help>이 맥에서 새로 열거나 다시 여는 세션부터 적용돼요. 기본은 이 맥의 Claude Code 설정을 따라요(1M 모델이면 거의 다 찰 때)</Help>
        </span>
      </div>
      <fieldset disabled={!online || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <Segmented label="자동 압축 시점" value={value} options={COMPACT_CHOICES.map((c) => ({ value: c, label: c ? `${Number(c) / 1000}k` : '기본' }))} onChange={(v) => void set(v)} />
      </fieldset>
      {online ? null : <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>맥이 연결돼 있을 때 바꿀 수 있어요.</p>}
    </section>
  )
}

/** 0~23 as the hours a night window may start or end at. */
const HOURS = Array.from({ length: 24 }, (_, i) => i)

/**
 * When this Mac takes a new agent (REQ-F-832): only at night (the default, 4~6 o'clock on that Mac's clock) or as
 * soon as one arrives, and 지금 업데이트 for one already taken.
 */
function UpdateBox({ hostId, policy, online }: { hostId: string; policy: UpdatePolicy; online: boolean }) {
  const [shown, setShown] = useState<Pick<UpdatePolicy, 'mode' | 'from' | 'to' | 'skipBusy'> | null>(null)
  const [busy, setBusy] = useState(false)
  const now = shown ?? policy
  const set = async (next: Pick<UpdatePolicy, 'mode' | 'from' | 'to' | 'skipBusy'>) => {
    if (next.from === next.to) return toast('시작과 끝 시간이 같으면 안 돼요', { tone: 'bad' })
    setBusy(true)
    try {
      const r = await post<{ ok: true } & Pick<UpdatePolicy, 'mode' | 'from' | 'to' | 'skipBusy'>>(`/api/hosts/${hostId}/update`, next)
      setShown({ mode: r.mode, from: r.from, to: r.to, skipBusy: r.skipBusy })
      toast(r.mode === 'always' ? '새 버전을 받는 대로 바꿔요' : `새 버전은 ${r.from}~${r.to}시 사이에 바꿔요${r.skipBusy ? '. 작업 중인 세션이 있으면 다음 날로 미뤄요' : ''}`)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  return (
    <section className="card-box">
      <CardHead title="자동 업데이트" help="새 버전으로 바꿀 때 에이전트가 몇 초 동안 다시 시작해요. 세션은 그대로 이어지지만, 작업 중에는 끊긴 것처럼 보일 수 있어서 기본은 새벽에만 바꿔요." />
      {policy.off ? (
        <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>
          이 맥은 --no-auto-update 로 켜져 있어 새 버전을 받지 않아요.
        </p>
      ) : (
        <>
          <fieldset disabled={!online || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <Segmented
              label="업데이트 방식"
              value={now.mode}
              options={[
                { value: 'night', label: '정해진 시간에만' },
                { value: 'always', label: '받는 대로' },
              ]}
              onChange={(mode) => void set({ ...now, mode })}
            />
            {now.mode === 'night' ? (
              <div className="hstack" style={{ flexWrap: 'wrap', gap: 8 }}>
                <select className="input" style={{ width: 'auto' }} aria-label="시작 시각" value={now.from} onChange={(e) => void set({ ...now, from: Number(e.target.value) })}>
                  {HOURS.map((x) => (
                    <option key={x} value={x}>{`${x}시`}</option>
                  ))}
                </select>
                <span>부터</span>
                <select className="input" style={{ width: 'auto' }} aria-label="끝 시각" value={now.to} onChange={(e) => void set({ ...now, to: Number(e.target.value) })}>
                  {HOURS.map((x) => (
                    <option key={x} value={x}>{`${x}시`}</option>
                  ))}
                </select>
                <span>사이에 바꿔요 (이 맥의 시각)</span>
              </div>
            ) : null}
            {now.mode === 'night' ? (
              <div className="setting-line">
                <span className="grow">
                  <b style={{ fontSize: 'var(--fs-medium)' }}>작업 중인 세션이 있으면 다음 날로</b>
                  <Help>그 시간에 일하는 세션이 있으면 모두 쉴 때까지 기다려요. 끝날 때까지 쉬지 않으면 그날은 건너뛰고 다음 날 같은 시간에 다시 해요</Help>
                </span>
                <Switch label="작업 중인 세션이 있으면 다음 날로" checked={now.skipBusy} onChange={(skipBusy) => void set({ ...now, skipBusy })} />
              </div>
            ) : null}
          </fieldset>
          {policy.pending ? (
            <div className="setting-line">
              <span className="grow">
                <b style={{ fontSize: 'var(--fs-medium)' }}>새 버전 {policy.pending.build} 을 받아 뒀어요</b>
                <Help>{policy.pending.now ? '곧 바꿔요' : `${ago(policy.pending.at)} 받았어요. 지금 바꾸면 에이전트가 몇 초 다시 시작하고, 세션은 그대로 이어져요`}</Help>
              </span>
              <Button size="sm" tone="primary" disabled={!online || policy.pending.now} onClick={() => void updateNow(hostId)}>
                지금 업데이트
              </Button>
            </div>
          ) : null}
        </>
      )}
      {online ? null : <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>맥이 연결돼 있을 때 바꿀 수 있어요.</p>}
    </section>
  )
}


/** Whether this Mac takes work a session on another of the person's Macs hands over (REQ-F-760). */
function DelegateBox({ hostId, on }: { hostId: string; on: boolean }) {
  const [shown, setShown] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = shown ?? on
  const set = async (v: boolean) => {
    setBusy(true)
    try {
      await post(`/api/hosts/${hostId}/delegate`, { on: v })
      setShown(v)
      toast(v ? '다른 맥의 일을 받아요' : '다른 맥의 일을 받지 않아요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  return (
    <section className="card-box">
      <CardHead title="다른 맥에 맡기기" help="다른 맥의 세션이 이 맥에 Claude 세션을 열어 일을 맡길 수 있어요(서브에이전트처럼). 맡긴 세션의 허용 정책을 따라가고, 맡긴 세션이 멈추거나 닫히면 같이 멈춰요." />
      <div className="setting-line">
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>다른 맥의 일 받기</b>
          <Help>끄면 다른 맥의 세션이 이 맥에 일을 맡길 수 없어요. 이 맥의 세션이 다른 맥에 맡기는 것은 그대로예요</Help>
        </span>
        <Switch label="다른 맥의 일 받기" checked={checked} disabled={busy} onChange={(v) => void set(v)} />
      </div>
    </section>
  )
}

/** On a header-only server (REQ-F-816) the agent's own words for the headless link ("켜세요") do not hold: it does not
 * know the server, so the page says how to turn it off instead. */
const NO_BG_ON = '헤더 로그인만 쓰는 서버라 헤드리스 연동을 쓸 수 없어요. 꺼 주세요. 끌 수 없으면 그 맥을 다시 시작하거나 헤드리스 Chrome 을 끝낸 뒤, 그 맥의 Chrome 에서 프록시를 거쳐 이 사이트를 열어 끄세요'
const NO_BG = '헤더 로그인만 쓰는 서버라 쓰지 않아요'

function StatusBox({ hostId, features, repairs, online, background, awake }: { hostId: string; features: Feature[]; repairs: { at: number; id: string; text: string; ok: boolean }[]; online: boolean; background: Background | undefined; awake: Awake | undefined }) {
  const wide = useWide()
  const bgOff = !featureOn('background')
  const [busy, setBusy] = useState<string | null>(null)
  // A switch shows what was asked until the next status says otherwise.
  const [shown, setShown] = useState<{ background?: boolean; awake?: boolean; lid?: boolean }>({})
  const on: Record<string, boolean | undefined> = {
    background: shown.background ?? background?.on,
    awake: shown.awake ?? awake?.idle,
    lid: shown.lid ?? awake?.lid,
  }
  const toggle = async (id: string, want: boolean) => {
    setBusy(`switch-${id}`)
    try {
      if (id === 'background') {
        const r = await post<{ ok: true; on: boolean }>(`/api/hosts/${hostId}/background`, { on: want })
        setShown((s) => ({ ...s, background: r.on }))
        toast(r.on ? '헤드리스 연동 모드를 켰어요. 잠시 뒤 연결돼요' : '헤드리스 연동 모드를 껐어요')
      } else {
        const which = id === 'awake' ? 'idle' : 'lid'
        const r = await post<{ ok: true; idle: boolean; lid: boolean }>(`/api/hosts/${hostId}/awake`, { [which]: want })
        setShown((s) => ({ ...s, awake: r.idle, lid: r.lid }))
        toast(which === 'idle' ? (r.idle ? '잠자기를 막았어요' : '잠자기를 다시 허용했어요') : r.lid ? '덮개를 닫아도 켜 둬요' : '덮개를 닫으면 잠들게 되돌렸어요')
      }
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  const run = async (action: string) => {
    setBusy(action)
    try {
      toast((await post<{ ok: true; note: string }>(`/api/hosts/${hostId}/heal`, { action })).note)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  const tone = (st: Feature['state']) => (st === 'ok' ? 'green' : st === 'warn' ? 'amber' : st === 'fail' ? 'red' : 'grey')
  return (
    <section className="card-box">
      <CardHead title="에이전트 상태" help="에이전트가 1분마다 스스로 살펴보고, 고칠 수 있는 것은 혼자 고쳐요." />
      <div className="feature-list">
        {features.map((f0) => {
          const f = bgOff && f0.id === 'background' ? { ...f0, detail: on.background ? NO_BG_ON : NO_BG, fix: undefined, action: undefined } : f0
          return (
          <div key={f.id} className="feature-row">
            <span className={`dot dot-${tone(f.state)}`} />
            <span className="grow">
              <b title={FEATURE_HELP[f.id]}>{f.title}</b> <span className="muted">· {f.state === 'off' ? '꺼짐' : f.state === 'ok' ? '정상' : f.state === 'warn' ? '확인 필요' : '문제'}</span>
              {/* A PC points at the name for what it does; a phone has ⓘ. */}
              {!wide && FEATURE_HELP[f.id] ? <Help>{FEATURE_HELP[f.id]}</Help> : null}
              <br />
              <span className="feature-detail">{f.detail}</span>
              {f.fix && f.state !== 'ok' ? <Copy text={f.fix} /> : null}
            </span>
            {f.action && f.state !== 'off' ? (
              <Button size="sm" busy={busy === f.action} disabled={!online || !!busy} onClick={() => run(f.action!)}>
                {ACTION_LABEL[f.action]}
              </Button>
            ) : null}
            {/* Header-only: the headless switch can only be turned off. */}
            {f.id in FEATURE_HELP && !(bgOff && f.id === 'background' && !on.background) ? <Switch label={f.title} checked={on[f.id] ?? f.state !== 'off'} disabled={!online || !!busy} onChange={(v) => toggle(f.id, v)} /> : null}
          </div>
          )
        })}
      </div>
      {online ? null : <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: '8px 0 0' }}>맥이 연결돼 있을 때 바꿀 수 있어요.</p>}
      {repairs.length ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--fs-medium)' }}>자동 복구 기록 · {repairs.length}</summary>
          {repairs.map((r, i) => (
            <div key={i} className={`logline ${r.ok ? '' : 'warn'}`}>
              <span className="t">{new Date(r.at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="grow">{r.text}</span>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  )
}

interface Background {
  on: boolean
  running: boolean
  connected: boolean
  chrome: boolean
  since: number | null
  restarts: number
  error: string | null
}

/** 헤드리스 연동 모드: the agent keeps a headless browser on this site's bridge page, so no tab has to stay open. */
function BackgroundBox({ hostId, state, online }: { hostId: string; state: Background | undefined; online: boolean }) {
  const [busy, setBusy] = useState(false)
  const [on, setOn] = useState<boolean | null>(null)
  const checked = on ?? state?.on ?? false
  const bgOff = !featureOn('background')
  if (bgOff && !checked) return null
  const set = async (want: boolean) => {
    setBusy(true)
    try {
      const r = await post<{ ok: true; on: boolean }>(`/api/hosts/${hostId}/background`, { on: want })
      setOn(r.on)
      toast(r.on ? '헤드리스 연동 모드를 켰어요. 잠시 뒤 연결돼요' : '헤드리스 연동 모드를 껐어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  const status = !state ? null : !state.chrome ? 'Chrome 이 없어요' : !state.on ? null : state.connected ? `연결됨 · ${state.since ? `${ago(state.since)}부터` : ''}` : state.running ? '띄우는 중이거나 연결을 기다리는 중' : '꺼져 있음'
  return (
    <section className="card-box">
      <h2 style={{ marginTop: 0 }}>헤드리스 연동 모드</h2>
      <div className="setting-line">
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>헤드리스 연동 모드</b>
          <Help>
            에이전트가 이 맥의 Chrome 을 화면 없이(헤드리스) 띄워 연동 페이지를 늘 열어 둬요. 탭을 열어 두지 않아도 연결돼요. 켜 둔 동안 메모리를 수백 MB 써요
          </Help>
        </span>
        <Switch label="헤드리스 연동 모드" checked={checked} disabled={!online || busy} onChange={set} />
      </div>
      {status ? <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: '0 0 6px' }}>{status}</p> : null}
      {state?.error || bgOff ? (
        <div className="banner">
          <Icon name="warn" />
          <div className="banner-body">{bgOff ? NO_BG_ON : state?.error}</div>
        </div>
      ) : null}
      {online ? null : <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>{bgOff ? '끄려면 그 맥의 Chrome 에서 프록시를 거쳐 이 사이트를 연 뒤 끄세요.' : '켜려면 그 맥의 브라우저에서 이 사이트를 한 번 열어 연결해 주세요.'}</p>}
    </section>
  )
}

interface Detail {
  host: { id: string; name: string; kind: string; online: boolean; user: string; home: string; info: { version: string; build: string; node: string; os: string } | null; updateBlocked?: boolean; outdated: boolean; latest?: string; takesWork?: boolean; update?: UpdatePolicy | null }
  link: { connectedAt: number | null; disconnectedAt: number | null; connects: number; rtt: number | null }
  health: null | { version: string; uptime: number; tools?: { zeropty?: string | null; tmux?: string | null }; checks: { id: string; level: string; title: string; detail: string; fix?: string }[]; load: number; memFree: number; memTotal: number; sys?: SysUse | null; rss: number; keepAwake: boolean; compactWindow?: number | null; awake?: Awake; background?: Background; features?: Feature[]; repairs?: { at: number; id: string; text: string; ok: boolean }[]; at: number; lastCommand?: { t: string; at: number } | null }
  page: null | { visible: string; queue: number; ua: string; upFail: number; agentReconnects: number; at: number }
  sessions: { id: string; title: string; cwd: string; state: Session['state']; mux?: 'zeropty' | 'tmux' | null; serverLines: number; agentLines: number | null; behind: number | null; syncedAt: number | null; pushError: string | null }[]
}
interface LogEntry {
  ts: number
  src: string
  level: string
  area: string
  sid?: string
  text: string
}

export function HostPage({ id, sid }: { id: string; sid?: string }) {
  const wide = useWide()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [level, setLevel] = useState<'' | 'warn'>('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const load = () => {
      get<Detail>(`/api/hosts/${id}/status`).then((d) => live && (setDetail(d), setError(null)), (e) => live && setError(errorText(e)))
      get<{ entries: LogEntry[] }>(`/api/hosts/${id}/logs?${new URLSearchParams({ ...(sid ? { sid } : {}), ...(level ? { level } : {}) })}`).then((r) => live && setLogs(r.entries), () => {})
    }
    load()
    const t = setInterval(load, 10_000)
    return () => ((live = false), clearInterval(t))
  }, [id, sid, level])
  const h = detail?.host
  // A Linux host (REQ-F-798): what only macOS has is not offered for it.
  const linux = !!h?.info?.os?.startsWith('Linux')
  // Not one of mine: an operator looking at (and switching) someone else's Mac. Its owner is shown instead of its kind.
  const others = useStore((s) => !!s.state && !s.state.hosts.some((x) => x.id === id))
  return (
    <div className="main">
      <div className="topbar">
        {!wide || sid ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>{h?.name ?? '기기'}</b>
          <span>{sid ? '이 세션의 로그' : h ? `${others ? `${h.user} 의 맥` : (KINDS[h.kind] ?? '기타')} · ${h.online ? '연결됨' : '끊김'}` : ''}</span>
        </div>
        {h?.online ? (
          <Button size="sm" icon="refresh" onClick={() => post(`/api/hosts/${id}/check`, {}).then(() => toast('다시 점검해요'), (e) => toast(errorText(e), { tone: 'bad' }))}>
            다시 점검
          </Button>
        ) : null}
      </div>
      <div className="scroll">
        <div className="page stack">
          {error ? <Empty icon="warn" title="불러오지 못했어요">{error}</Empty> : !detail ? <Spinner /> : null}
          {detail && !sid ? (
            <>
              {(detail.health?.checks ?? []).filter((c) => c.level !== 'ok').map((c) => (
                <div key={c.id} className="banner" style={c.level === 'fail' ? { background: 'var(--red-soft)' } : undefined}>
                  <Icon name="warn" />
                  <div className="banner-body">
                    <b>{c.title}</b> · {c.detail}
                    {c.fix ? <Copy text={c.fix} /> : null}
                  </div>
                </div>
              ))}
              {h && detail.health?.features ? (
                <StatusBox key={`st-${h.id}`} hostId={h.id} features={detail.health.features} repairs={detail.health.repairs ?? []} online={h.online} background={detail.health.background} awake={detail.health.awake} />
              ) : h ? (
                // An agent too old to report its parts: the switches in their own boxes, as before.
                <>
                  <BackgroundBox key={`bg-${h.id}`} hostId={h.id} state={detail.health?.background} online={h.online} />
                  {linux ? null : <AwakeBox key={`awake-${h.id}`} hostId={h.id} kind={h.kind} awake={detail.health?.awake} online={h.online} />}
                  {featureOn('sessionMove') ? <DelegateBox key={`dg-${h.id}`} hostId={h.id} on={h.takesWork !== false} /> : null}
                </>
              ) : null}
              {h && !others ? <Row left={<Icon name="folder" />} title="디스크 관리" sub="캐시·머지된 worktree·큰 폴더 정리는 디스크 관리 메뉴에서 기기별로 한 번에 봐요" onClick={() => go({ name: 'disk' })} chevron /> : null}
              {linux ? (
                <div className="banner">
                  <Icon name="info" />
                  <div className="banner-body">
                    리눅스 기기예요. 맥에서만 되는 기능은 여기서 꺼져 있어요: 잠자기 막기, 덮개를 닫아도 켜 두기, macOS 허락 창 알림. 브라우저 탭 대신 헤드리스 연동 모드로 연결돼요.
                  </div>
                </div>
              ) : null}
              {h ? <CompactBox key={`cw-${h.id}`} hostId={h.id} window={detail.health?.compactWindow ?? null} online={h.online} /> : null}
              {h?.update ? <UpdateBox key={`up-${h.id}`} hostId={h.id} policy={h.update} online={h.online} /> : null}
              {h?.outdated && !h.update?.pending ? (
                <div className="banner">
                  <Icon name="info" />
                  <div className="banner-body">에이전트가 서버와 다른 버전이에요. 세션이 모두 쉴 때 스스로 바꿔요. 안 바뀌면 그 맥에서 설치 명령을 다시 실행하세요.</div>
                </div>
              ) : null}
              <section className="card-box">
                <dl className="kv">
                  <dt>연결</dt>
                  <dd>
                    {h?.online ? `${detail.link.connectedAt ? `${ago(detail.link.connectedAt)}부터` : ''} · ${detail.link.connects}번째 연결${detail.link.rtt != null ? ` · 왕복 ${detail.link.rtt}ms` : ''}` : `끊김${detail.link.disconnectedAt ? ` · ${ago(detail.link.disconnectedAt)}` : ''}`}
                  </dd>
                  <dt>에이전트</dt>
                  <dd>
                    {h?.info ? `${h.info.version} · build ${h.info.build}${h.latest ? (h.updateBlocked ? ` (최신 ${h.latest} 아님 · 서버가 서명 문제로 업데이트를 보내지 않음)` : h.outdated ? ` (최신 ${h.latest} 아님)` : ' (최신)') : ''} · node ${h.info.node}` : '-'}
                    {detail.health ? ` · 켜진 지 ${duration(detail.health.uptime)} · 메모리 ${bytes(detail.health.rss)}` : ''}
                    {detail.health?.tools?.zeropty ? ` · zeropty ${detail.health.tools.zeropty}` : ''}
                  </dd>
                  {detail.health ? (
                    <>
                      <dt>맥</dt>
                      <dd>
                        {detail.health.sys ? sysLine(detail.health.sys) : `부하 ${detail.health.load.toFixed(2)} · 여유 메모리 ${bytes(detail.health.memFree)} / ${bytes(detail.health.memTotal)}`}
                        {detail.health.keepAwake ? ' · 잠들지 않게 함' : ''}
                      </dd>
                      {detail.health.sys?.battery ? (
                        <>
                          <dt>배터리</dt>
                          <dd style={batteryLow(detail.health.sys.battery) ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{batteryLine(detail.health.sys.battery, true)}</dd>
                        </>
                      ) : null}
                      <dt>점검</dt>
                      <dd>
                        {detail.health.checks.map((c) => (
                          <span key={c.id} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
                            <span className={`dot dot-${c.level === 'ok' ? 'green' : c.level === 'warn' ? 'amber' : 'red'}`} style={{ display: 'inline-block', marginRight: 4 }} />
                            {c.title}
                          </span>
                        ))}
                      </dd>
                    </>
                  ) : null}
                  {detail.page ? (
                    <>
                      <dt>연동 탭</dt>
                      <dd>
                        {detail.page.visible === 'visible' ? '앞에 보임' : '백그라운드'} · 밀린 메시지 {detail.page.queue} · 재시도 {detail.page.upFail + detail.page.agentReconnects}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </section>
              {detail.sessions.length ? (
                <section className="card-box">
                  <h2 style={{ marginTop: 0 }}>세션</h2>
                  {detail.sessions.map((s) => (
                    <Row
                      key={s.id}
                      title={s.title || shortPath(s.cwd, h?.home)}
                      sub={`${PHASE[s.state.phase] ?? s.state.phase}${s.mux ? ` · ${s.mux}` : ''} · 사본 ${s.serverLines}줄${s.behind ? ` · ${s.behind}줄 밀림` : ''}${s.syncedAt ? ` · ${clock(s.syncedAt)}` : ''}${s.pushError ? ` · push 실패: ${s.pushError}` : ''}`}
                      onClick={() => openSession(s.id, 'host')}
                      chevron
                    />
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
          {/* The log waits for the status: drawn first, it would be pushed down when the status boxes arrive. */}
          {detail || error ? <section>
            <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>로그</h2>
              <Segmented label="수준" value={level} onChange={setLevel} options={[{ value: '', label: '모두' }, { value: 'warn', label: '경고 이상' }]} />
            </div>
            {!logs ? (
              <Spinner />
            ) : !logs.length ? (
              <p className="muted">로그가 없어요</p>
            ) : (
              <div>
                {[...logs].reverse().map((e, i) => (
                  <div key={i} className={`logline ${e.level}`}>
                    <span className="t" title={new Date(e.ts).toLocaleString('ko-KR')}>
                      {new Date(e.ts).toLocaleTimeString('ko-KR', { hour12: false })}
                    </span>
                    <span className="grow">
                      <span className="t">{e.src === 'agent' ? '' : `${e.src} `}</span>
                      {e.area ? <b className="log-area">{e.area}</b> : null}
                      {e.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section> : null}
        </div>
      </div>
    </div>
  )
}
