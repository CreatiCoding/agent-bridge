// The start guide: from nothing to a first session (처음 시작), or several Claude accounts on one Mac (멀티 계정).
// Each step checks itself off from what the server already knows (a Mac online, sessions, the Slack
// plugin on and an account linked); a step nothing can see is ticked by the person and remembered in this browser.
// /guide (server) is the address to hand to someone: signed in it lands here, otherwise on web/start.html.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { get } from '../lib/api'
import { getPref, setPref } from '../lib/local'
import { back, go, type GuidePath } from '../lib/router'
import { NONE, useStore } from '../lib/store'
import type { Me } from '../lib/types'
import { Badge, Button, Icon, IconButton, LoadError, Segmented, Spinner, useWide } from '../kit'
import { StateWait, useStateLoaded } from '../components/state-wait'
import { toast } from '../kit/overlay'
import { Copy } from './hosts'
import { PluginSheet, promptText, type Plugin } from './settings'

type Path = GuidePath

/** Steps the person ticks themselves, kept in this browser only. */
function useTicks() {
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => getPref('guideTicks', {}))
  const tick = (key: string, on: boolean) =>
    setTicks((t) => {
      const next = { ...t, [key]: on }
      setPref('guideTicks', next)
      return next
    })
  return [ticks, tick] as const
}

function Step({ n, title, done, optional, time, open, onToggle, status, children }: { n: number; title: string; done: boolean; optional?: boolean; time?: string; open: boolean; onToggle: () => void; status?: ReactNode; children: ReactNode }) {
  return (
    <section className={`guide-step${done ? ' done' : ''}${open ? ' open' : ''}`}>
      <button type="button" className="guide-step-head" aria-expanded={open} onClick={onToggle}>
        <span className="guide-num">{done ? <Icon name="check" /> : n}</span>
        <span className="grow">
          <b>{title}</b>
          {status ? <span className="guide-status">{status}</span> : null}
        </span>
        {done ? <Badge tone="green">끝</Badge> : optional ? <Badge>선택</Badge> : time ? <Badge tone="blue">{time}</Badge> : null}
        <Icon name={open ? 'up' : 'down'} />
      </button>
      {open ? <div className="guide-step-body">{children}</div> : null}
    </section>
  )
}

function Tick({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <Button size="sm" icon={on ? 'undo' : 'check'} tone={on ? undefined : 'primary'} onClick={() => onChange(!on)}>
      {on ? '다시 할래요' : label}
    </Button>
  )
}

function MacStep({ origin }: { origin: string }) {
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const off = hosts.filter((h) => !h.online)
  return (
    <>
      <ol className="guide-list">
        <li>
          연결할 맥의 터미널에 붙여 넣어요. 필요한 것을 확인하고 에이전트를 백그라운드 서비스로 설치해요.
          <Copy text={`curl -fsSL ${origin}/install.sh | bash`} />
        </li>
        <li>
          그 맥의 Chrome 에 이 사이트를 열어 두세요. <b>열린 탭이 맥과 서버를 이어요.</b> 탭을 모두 닫으면 끊겨요.
        </li>
        <li>Chrome 이 "로컬 네트워크의 기기에 연결" 을 물으면 허용해요.</li>
      </ol>
      {off.length ? (
        <p className="guide-warn">
          <Icon name="warn" />
          <span>
            {off.map((h) => h.name).join(', ')} 이(가) 끊겨 있어요. 그 맥의 Chrome 에서 이 사이트를 열어 주세요. 그래도 안 되면 <a href="/recovery">문제가 생겼을 때</a> 를 보세요.
          </span>
        </p>
      ) : null}
      <div className="hstack">
        <Button size="sm" icon="laptop" onClick={() => go({ name: 'hosts' })}>
          기기 화면
        </Button>
      </div>
    </>
  )
}

/** The Slack plugin's own steps (server/plugins/slack.mjs `help`), the AI prompt, and the token sheet. */
function SlackStep({ slack, onSaved }: { slack: Plugin; onSaved: (list: Plugin[]) => void }) {
  const [sheet, setSheet] = useState(false)
  const steps = slack.help.filter((h) => /^\d/.test(h.title))
  const trouble = slack.help.find((h) => !/^\d/.test(h.title))
  const on = slack.status.state === 'on'
  const copy = (text: string, note: string) => navigator.clipboard?.writeText(text).then(() => toast(note))
  return (
    <>
      <p className="guide-note">세션을 Slack 전용 채널에서도 이어서 할 수 있어요. 한 세션은 한 번에 한 곳(브릿지 또는 Slack)에서만 작업하고, 메뉴와 스레드의 버튼으로 옮겨요.</p>
      {slack.prompt ? (
        <div className="guide-ai">
          <div className="hstack" style={{ alignItems: 'flex-start' }}>
            <Icon name="sparkle" />
            <div className="grow">
              <b>{slack.prompt.label}</b>
              <p className="muted" style={{ margin: '2px 0 8px', fontSize: 'var(--fs-small)' }}>
                {slack.prompt.about} 아래 1~4단계 중 토큰 복사만 빼고 대신 해요.
              </p>
              <Button size="sm" tone="primary" icon="copy" onClick={() => copy(promptText(slack), '프롬프트를 복사했어요. AI 에게 붙여 넣으세요')}>
                프롬프트 복사
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <ol className="guide-list">
        {steps.map((h) => (
          <li key={h.title}>
            <b>{h.title.replace(/^\d+\.\s*/, '')}</b>
            <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
              {h.text}
            </div>
            {h.link || h.copy ? (
              <div className="hstack" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {h.link ? (
                  <Button size="sm" icon="link" onClick={() => open(h.link?.url, '_blank', 'noopener')}>
                    {h.link.label}
                  </Button>
                ) : null}
                {h.copy ? (
                  <Button size="sm" icon="copy" onClick={() => copy(h.copy?.text ?? '', '복사했어요')}>
                    {h.copy.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {trouble ? (
        <details className="guide-more">
          <summary>{trouble.title}</summary>
          <p className="muted">{trouble.text}</p>
        </details>
      ) : null}
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <Button tone={on ? undefined : 'primary'} icon="key" onClick={() => setSheet(true)}>
          {slack.added ? '토큰·채널 고치기' : '토큰 넣기'}
        </Button>
        {slack.added ? <Badge tone={on ? 'green' : slack.status.state === 'error' ? 'red' : 'grey'}>{slack.enabled ? slack.status.note || slack.status.state : '꺼져 있어요'}</Badge> : null}
      </div>
      {sheet ? <PluginSheet p={slack} onClose={() => setSheet(false)} onSaved={onSaved} /> : null}
    </>
  )
}

export function GuidePage({ me, path }: { me: Me | null; path: Path }) {
  const wide = useWide()
  const origin = me?.origin ?? location.origin
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const sessions = useStore((s) => s.state?.sessions ?? NONE)
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [ticks, tick] = useTicks()
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  // Coming back from Slack or the Mac's terminal: the plugin's state may have moved on.
  // A failed read is said, with 다시 시도: an empty list in its place left the Slack step spinning for ever.
  const [pluginsErr, setPluginsErr] = useState<unknown>(null)
  const load = useCallback(
    () =>
      void get<{ plugins: Plugin[] }>('/api/plugins').then(
        (r) => (setPlugins(r.plugins), setPluginsErr(null)),
        (e) => setPluginsErr(e ?? true),
      ),
    [],
  )
  // The steps are drawn once what decides them has arrived: drawn before, they showed "0/N" with the first step
  // open, then folded as the state came in (a layout shift of up to 0.31 on a phone).
  const loaded = useStateLoaded()
  const ready = loaded && (plugins != null || !!pluginsErr)
  useEffect(() => {
    load()
    addEventListener('focus', load)
    return () => removeEventListener('focus', load)
  }, [load])

  const slack = plugins?.find((p) => p.id === 'slack')
  const online = hosts.filter((h) => h.online)
  const live = sessions.filter((s) => !s.closed)
  // 멀티 계정: the accounts added beside each Mac's main one, and those signed in.
  const added = hosts.flatMap((h) => (h.accounts ?? []).filter((a) => !a.main).map((a) => ({ ...a, host: h.name })))
  const signedIn = added.filter((a) => a.loggedIn)
  const slackOn = slack?.status.state === 'on'
  const linked = (slack?.status.linked ?? 0) > 0

  interface S {
    key: string
    title: string
    done: boolean
    optional?: boolean
    time?: string
    status?: ReactNode
    body: ReactNode
  }
  const mac: S = {
    key: 'mac',
    title: '맥 연결하기',
    done: online.length > 0,
    time: '약 2분',
    status: hosts.length ? `${online.length ? `연결됨: ${online.map((h) => h.name).join(', ')}` : '연결된 맥이 아직 없어요'}` : null,
    body: <MacStep origin={origin} />,
  }
  const slackStep: S = {
    key: 'slack',
    title: 'Slack 에서도 쓰기',
    done: slackOn && linked,
    optional: true,
    time: '약 5분',
    status: slack ? (slackOn ? (linked ? '켜짐 · 내 Slack 계정 연결됨' : '켜짐 · 채널에 글을 써서 내 Slack 계정을 연결하세요') : slack.added ? slack.status.note || '꺼져 있어요' : null) : null,
    body: slack ? <SlackStep slack={slack} onSaved={setPlugins} /> : pluginsErr ? <LoadError what="Slack 연결 상태를" error={pluginsErr} onRetry={load} /> : <Spinner />,
  }
  const accountSteps: S[] = [
    mac,
    {
      key: 'acc-add',
      title: '계정 더하고 로그인하기',
      done: signedIn.length > 0,
      time: '약 2분',
      status: added.length ? added.map((a) => `${a.host} · ${a.name}${a.loggedIn ? '' : ' (로그인 필요)'}`).join(', ') : null,
      body: (
        <>
          <ol className="guide-list">
            <li>
              설정 → <b>Claude 계정</b> 에서 맥의 <b>계정 추가</b> 를 누르고 이름(예: 회사, 개인)을 적어요.
            </li>
            <li>
              <b>로그인 페이지 열기</b> 로 Claude 로그인 페이지를 열고 그 계정으로 로그인해요. 폰에서 열어도 돼요. 맥에 브라우저가 뜨지 않아요.
            </li>
            <li>로그인이 끝나면 나오는 코드를 복사해 그 화면의 칸에 붙여 넣고 확인을 눌러요.</li>
          </ol>
          <p className="guide-note">계정마다 로그인·사용량 한도·대화 기록이 따로예요. 한 계정의 한도가 차면 다른 계정으로 옮겨서 이어 갈 수 있어요.</p>
          <Button size="sm" tone="primary" icon="user" disabled={!online.length} onClick={() => go({ name: 'settings', tab: 'accounts' })}>
            Claude 계정 설정
          </Button>
        </>
      ),
    },
    {
      key: 'acc-use',
      title: '계정을 골라 세션 쓰기',
      done: live.some((s) => !!s.account),
      time: '1분',
      status: live.some((s) => !!s.account) ? `다른 계정 세션 ${live.filter((s) => !!s.account).length}개` : null,
      body: (
        <>
          <ol className="guide-list">
            <li>
              새 세션 화면의 <b>Claude 계정</b> 에서 고르면 그 계정으로 시작해요. 계정이 둘 이상인 맥에서만 보여요.
            </li>
            <li>
              쓰던 세션은 세션 메뉴(⋯)의 <b>다른 계정으로 옮기기</b> 로 같은 대화 그대로 넘겨요. 맥을 옮길 때처럼 마지막으로 싱크한 뒤 그 계정에서 이어서 열어요.
            </li>
            <li>다른 맥으로 옮길 때 받는 맥에 계정이 여럿이면 어느 계정에서 열지 물어요.</li>
          </ol>
          <Button size="sm" tone="primary" icon="plus" disabled={!online.length} onClick={() => go({ name: 'new' })}>
            새 세션
          </Button>
        </>
      ),
    },
    {
      key: 'acc-know',
      title: '같이 쓰는 것과 따로인 것',
      done: !!ticks.accKnow,
      body: (
        <>
          <ul className="guide-list">
            <li>
              <b>모든 계정이 같이 써요</b>: <code>settings.json</code>, <code>CLAUDE.md</code>, 스킬, 명령, 에이전트, 플러그인. 기본 계정 폴더(<code>~/.claude</code>)의 것을 링크해서, 고치면 모든 계정에 바로 들어가요.
            </li>
            <li>
              <b>계정을 더할 때 한 번 복사해요</b>: MCP 서버, 폴더 신뢰, 처음 화면 설정. 기본 계정에서 바꿨으면 그 계정의 <b>공유 설정 맞추기</b> 로 다시 가져와요(그 계정 세션이 쉬고 있을 때).
            </li>
            <li>
              <b>계정마다 따로예요</b>: 로그인, 사용량 한도, 대화 기록, 입력 기록. 계정 폴더는 맥의 에이전트 폴더 안 <code>accounts</code> 에 있어요.
            </li>
            <li>
              <b>계정을 옮길 때 같이 가요</b>: 대화 전체(jsonl), 되감기용 파일 사본, 그 폴더의 자동 메모리(받는 계정에 없는 파일만), 작업 폴더의 <code>SESSION.md</code>·<code>CLAUDE.md</code>(폴더째 그대로).
            </li>
          </ul>
          <Tick on={!!ticks.accKnow} onChange={(on) => tick('accKnow', on)} label="읽었어요" />
        </>
      ),
    },
  ]
  const steps: S[] =
    path === 'accounts'
      ? accountSteps
      : [
          mac,
          {
            key: 'first',
            title: '첫 세션 띄우기',
            done: live.length > 0,
            time: '1분',
            status: live.length ? `세션 ${live.length}개` : null,
            body: (
              <>
                <ol className="guide-list">
                  <li>+ (새 세션) 를 눌러 맥과 폴더를 고르고 첫 메시지를 보내요.</li>
                  <li>맥의 터미널에서 이미 쓰던 Claude Code 대화가 있으면 "맥의 대화 이어 가기" 에서 골라 같은 대화로 이어서 열 수 있어요.</li>
                  <li>권한을 물으면 화면에 카드가 떠요. 답하면 맥의 터미널에 그대로 전해져요.</li>
                </ol>
                <div className="hstack">
                  <Button size="sm" tone="primary" icon="plus" disabled={!online.length} onClick={() => go({ name: 'new' })}>
                    새 세션
                  </Button>
                  {!online.length ? <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>맥을 먼저 연결해 주세요</span> : null}
                </div>
              </>
            ),
          },
          {
            key: 'phone',
            title: '폰에서도 열기',
            done: !!ticks.phone,
            optional: true,
            body: (
              <>
                <ol className="guide-list">
                  <li>기기 화면의 "QR 만들기" 를 폰 카메라로 찍으면 폰이 이 계정으로 로그인돼요.</li>
                  <li>폰 브라우저의 "홈 화면에 추가" 로 앱처럼 쓸 수 있어요.</li>
                  <li>설정 → 이 기기 에서 알림을 켜면 권한 요청과 답이 폰으로 와요.</li>
                </ol>
                <div className="hstack" style={{ flexWrap: 'wrap' }}>
                  <Button size="sm" icon="qr" onClick={() => go({ name: 'hosts' })}>
                    QR 만들기
                  </Button>
                  <Button size="sm" icon="bell" onClick={() => go({ name: 'settings', tab: 'device' })}>
                    알림 설정
                  </Button>
                  <Tick on={!!ticks.phone} onChange={(on) => tick('phone', on)} label="했어요" />
                </div>
              </>
            ),
          },
          slackStep,
        ]

  const firstOpen = steps.find((s) => !s.done && !s.optional)?.key ?? steps.find((s) => !s.done)?.key
  const isOpen = (s: S) => opened[s.key] ?? s.key === firstOpen
  const needed = steps.filter((s) => !s.optional)
  const doneCount = needed.filter((s) => s.done).length
  const all = doneCount === needed.length

  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>시작 가이드</b>
          <span>{ready ? `${doneCount}/${needed.length} 단계 끝` : '불러오는 중'}</span>
        </div>
        <IconButton icon="link" label="이 가이드 링크 복사" onClick={() => navigator.clipboard?.writeText(`${origin}/guide${path === 'start' ? '' : `/${path}`}`).then(() => toast('가이드 링크를 복사했어요. 로그인 전에도 열려요'))} />
      </div>
      <div className="scroll">
        <div className="page stack">
          <div className="guide-intro">
            <Segmented<Path>
              label="가이드 고르기"
              value={path}
              onChange={(p) => go({ name: 'guide', path: p }, { replace: true })}
              options={[
                { value: 'start', label: '처음 시작해요' },
                { value: 'accounts', label: '멀티 계정' },
              ]}
            />
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 'var(--fs-medium)' }}>
              {path === 'accounts'
                ? '맥 한 대에서 Claude 계정을 여러 개 쓰고, 세션을 대화 그대로 다른 계정으로 옮겨요. 계정마다 설정 폴더가 따로라 로그인과 사용량 한도가 나뉘어요.'
                : '맥 한 대를 연결하고 첫 세션을 띄우기까지 5분이면 돼요. 끝난 단계는 저절로 체크돼요.'}
            </p>
            <div className="guide-bar" role="progressbar" aria-label="가이드 진행" aria-valuemin={0} aria-valuemax={needed.length} aria-valuenow={doneCount}>
              <span style={{ width: `${(doneCount / needed.length) * 100}%` }} />
            </div>
          </div>
          {!ready ? (
            <StateWait />
          ) : all ? (
            <div className="guide-done">
              <Icon name="check" />
              <span className="grow">{path === 'accounts' ? '계정을 나눠 쓸 준비가 끝났어요.' : '준비 끝! 왼쪽 목록에서 세션을 골라 이어서 하세요.'}</span>
              <Button size="sm" onClick={() => go({ name: 'home' })}>
                세션 목록
              </Button>
            </div>
          ) : null}
          {ready && steps.map((s, i) => (
            <Step key={s.key} n={i + 1} title={s.title} done={s.done} optional={s.optional} time={s.time} status={s.status} open={isOpen(s)} onToggle={() => setOpened((o) => ({ ...o, [s.key]: !isOpen(s) }))}>
              {s.body}
            </Step>
          ))}
          <p className="muted" style={{ fontSize: 'var(--fs-small)', textAlign: 'center' }}>
            막히면 <a href="/recovery">문제가 생겼을 때</a> · 세션에서 다른 도구를 쓰려면 <a href="/guide/mcp">MCP 연결 가이드</a>
          </p>
        </div>
      </div>
    </div>
  )
}
