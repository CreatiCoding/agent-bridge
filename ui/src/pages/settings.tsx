// What a person sets for their own bridge: the default prompt every session starts with, notifications on
// this device, the theme, plugins (each with its own settings), and the way to the site's other pages.
import { lazy, Suspense, useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { CHANGES, type ChangeKind } from '../lib/changes'
import { applyIcons, getIcons, getTheme, setTheme, type Theme } from '../lib/local'
import { back, go, href, type SettingsTab } from '../lib/router'
import { shownName, type IconPrefs, type Me, type Options } from '../lib/types'
import { Badge, Button, CardHead, Empty, Field, Icon, IconButton, LoadError, NO_AUTOFILL, Segmented, Spinner, Switch, useWide } from '../kit'
import { chooseDialog, Sheet, toast } from '../kit/overlay'
import { inHomeApp, safariHref } from '../lib/safari'
import { appVersion } from '../lib/app-version'
import { kbDebugOn, setKbDebug } from '../lib/kbdebug'
import { PushToggle } from '../components/push'
import { SlackPlaces } from '../components/slack-places'
import { AccountsPanel } from './accounts'
import { VoiceSettings } from './voice-settings'
import { featureOn, type Feature } from '../lib/features'

export interface Plugin {
  id: string
  name: string
  about: string
  /** `pick`: the label of a button that lists what the field can be (Slack: the channels its bot is in). */
  /** `prefix`: what the value starts with (the server checks it, and puts two swapped values back). */
  /** `kind: 'places'`: not typed but set with buttons (Slack: a folder for each Mac, and the Mac to use first). */
  fields: { key: string; label: string; placeholder?: string; secret?: boolean; required?: boolean; pick?: string; prefix?: string; kind?: 'places' }[]
  help: { title: string; text: string; link?: { label: string; url: string }; copy?: { label: string; text: string } }[]
  prompt?: { label: string; about: string; text: string }
  added: boolean
  enabled: boolean
  config: Record<string, string>
  /** `linked`: Slack members who linked their account (the Slack plugin). */
  status: { state: string; note: string; linked?: number }
}

/** A plugin's AI prompt with this site's address in it. */
export const promptText = (p: Plugin) => (p.prompt?.text ?? '').replaceAll('{origin}', location.origin)

export function PluginSheet({ p, onClose, onSaved }: { p: Plugin; onClose: () => void; onSaved: (list: Plugin[]) => void }) {
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, f.secret ? '' : (p.config[f.key] ?? '')])))
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  // Asked with what is typed so far: a token need not be saved before the list can be had.
  const pick = async (key: string, label: string) => {
    setPicking(key)
    try {
      const r = await post<{ ok: true; choices: { value: string; label: string; hint?: string }[] }>(`/api/plugins/${p.id}/choices`, { key, config })
      const v = await chooseDialog(label, r.choices)
      if (v) {
        setConfig((c) => ({ ...c, [key]: v }))
        setPicked((x) => ({ ...x, [key]: r.choices.find((c) => c.value === v)?.label ?? v }))
      }
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setPicking(null)
  }
  const save = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await post<{ ok: true; note: string; plugins: Plugin[] }>(`/api/plugins/${p.id}`, body)
      toast(r.note)
      onSaved(r.plugins)
      onClose()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title={p.name}
      wide
      footer={
        <div className="dialog-buttons">
          {p.added ? (
            <Button tone="danger" onClick={() => save({ remove: true })}>
              빼기
            </Button>
          ) : null}
          <span className="grow" />
          <Button tone="primary" busy={busy} onClick={() => save({ enabled: true, config })}>
            저장하고 켜기
          </Button>
        </div>
      }
    >
      <p className="muted">{p.about}</p>
      {p.id === 'slack' && !location.pathname.startsWith('/guide') ? (
        <p className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          처음이면 <a href="/guide">시작 가이드</a> 의 Slack 단계가 더 자세해요. 앱과 채널 만들기를 AI 에게 맡기는 방법도 있어요.
        </p>
      ) : null}
      {p.fields.map((f) =>
        f.kind === 'places' ? (
          // Not a <label> (Field): a tap on a row's text would press the first button inside it.
          <div key={f.key} className="field" role="group" aria-labelledby={`pf-${f.key}`}>
            <span className="field-label" id={`pf-${f.key}`}>
              {f.label}
            </span>
            <SlackPlaces value={config[f.key] ?? ''} fallback={config.cwd ?? ''} onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))} />
          </div>
        ) : (
        <Field key={f.key} label={`${f.label}${f.required ? '' : ' (선택)'}`} hint={f.secret && p.config[f.key] ? '저장돼 있어요. 바꿀 때만 적으세요' : picked[f.key] ? `고른 것: ${picked[f.key]}` : undefined}>
          <div className="hstack" style={{ gap: 6 }}>
            <input className="input mono grow" type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder} value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            {f.pick ? (
              <Button size="sm" icon="list" busy={picking === f.key} onClick={(e) => (e.preventDefault(), void pick(f.key, f.label))}>
                {f.pick}
              </Button>
            ) : null}
          </div>
        </Field>
        ),
      )}
      {p.help?.length ? (
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600, margin: '8px 0' }}>처음 설정하는 방법</summary>
          <div className="stack">
            {p.help.map((h, i) => (
              <div key={i}>
                <b>{h.title}</b>
                <p style={{ margin: '4px 0' }}>{h.text}</p>
                <div className="hstack">
                  {h.link ? (
                    <Button size="sm" icon="link" onClick={() => open(h.link!.url, '_blank', 'noopener')}>
                      {h.link.label}
                    </Button>
                  ) : null}
                  {h.copy ? (
                    <Button size="sm" icon="copy" onClick={() => navigator.clipboard?.writeText(h.copy!.text).then(() => toast('복사했어요'))}>
                      {h.copy.label}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {p.prompt ? (
              <div>
                <b>{p.prompt.label}</b>
                <p className="muted" style={{ margin: '4px 0' }}>
                  {p.prompt.about}
                </p>
                <Button size="sm" icon="copy" onClick={() => navigator.clipboard?.writeText(promptText(p)).then(() => toast('프롬프트를 복사했어요'))}>
                  프롬프트 복사
                </Button>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </Sheet>
  )
}

/** The model, effort and permission mode a new session and a copy start with. Empty = not set. */
export interface Launch {
  model: string
  effort: string
  mode: string
  folderBase: string
  folderNoGroup: string
}

/**
 * 새 세션·복제 기본값: what a new session starts with (the form can still change it for one session), and what a
 * copy (복제·가벼운 복제) starts with instead of the original's. A value left at "지정 안 함" is not set: a new
 * session then takes the Mac's own default, a copy the original's.
 */
function LaunchDefaults({ opts, initial }: { opts: Options | null; initial: Launch }) {
  const [v, setV] = useState<Launch>(initial)
  const [saving, setSaving] = useState(false)
  if (!opts) return <p className="muted">목록을 읽지 못했어요.</p>
  // A saved model the list no longer offers is still shown, so saving does not silently drop it.
  const models = opts.models.some((m) => m.value === v.model) || !v.model ? opts.models : [...opts.models, { label: v.model, value: v.model }]
  return (
    <>
      <Field label="모델">
        <select className="input" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })}>
          <option value="">지정 안 함</option>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="생각 수준 (effort)">
        <select className="input" value={v.effort} onChange={(e) => setV({ ...v, effort: e.target.value })}>
          <option value="">지정 안 함</option>
          {opts.efforts.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <Field
        label="권한 모드"
        hint={
          v.mode === 'allowAll' ? (
            <span className="allow-all-text">🔴 모든 새 세션과 복제가 위험한 호출까지 하나도 묻지 않고 실행해요. 시작할 때마다 한 번 더 물어요.</span>
          ) : v.mode === 'autoAllow' ? (
            '⚠️ 모든 새 세션과 복제가 확인 없이 명령을 실행해요(위험한 호출만 물어요). 시작할 때마다 한 번 더 물어요.'
          ) : undefined
        }
      >
        <select className={`input${v.mode === 'allowAll' ? ' input-allow-all' : ''}`} value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
          <option value="">지정 안 함</option>
          {opts.modes.map((m) => (
            <option key={m.value} value={m.value} className={m.value === 'allowAll' ? 'opt-allow-all' : undefined}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="기본 폴더" hint={`새 세션은 ${v.folderBase || '~/bridge/works'}/<그룹>/<월일>-<id> 를 새로 만들어 시작해요. 모든 맥에 같이 적용돼요(~ 는 그 맥의 홈)`}>
        <input className="input mono" {...NO_AUTOFILL} value={v.folderBase} onChange={(e) => setV({ ...v, folderBase: e.target.value })} placeholder="~/bridge/works" spellCheck={false} autoCapitalize="off" />
      </Field>
      <Field label="그룹이 없을 때" hint="그룹 없이 만든 세션이 들어가는 폴더 이름">
        <input className="input" {...NO_AUTOFILL} value={v.folderNoGroup} onChange={(e) => setV({ ...v, folderNoGroup: e.target.value })} placeholder="기타" />
      </Field>
      <div className="hstack" style={{ justifyContent: 'flex-end' }}>
        <Button
          tone="primary"
          busy={saving}
          onClick={async () => {
            setSaving(true)
            try {
              const r = await post<{ ok: true; note: string } & Launch>('/api/prefs/launch', v)
              setV({ model: r.model, effort: r.effort, mode: r.mode, folderBase: r.folderBase, folderNoGroup: r.folderNoGroup })
              toast(r.note)
            } catch (e) {
              toast(errorText(e), { tone: 'bad' })
            }
            setSaving(false)
          }}
        >
          저장
        </Button>
      </div>
    </>
  )
}

/**
 * 아이콘 (REQ-F-728): the size and how much of the box the drawing fills, kept with the account. A choice shows at
 * once; if saving fails it goes back to what was saved.
 */
function IconSettings({ initial }: { initial: IconPrefs }) {
  const [v, setV] = useState<IconPrefs>(initial)
  const pick = async (next: IconPrefs) => {
    const was = v
    setV(next)
    applyIcons(next)
    try {
      await post('/api/prefs/icons', next)
    } catch (e) {
      setV(was)
      applyIcons(was)
      toast(errorText(e), { tone: 'bad' })
    }
  }
  return (
    <div className="stack">
      <div className="hstack" style={{ gap: 10, flexWrap: 'wrap' }} aria-hidden="true">
        {['list', 'settings', 'search', 'copy', 'trash', 'eye', 'phone', 'close'].map((n) => (
          <Icon key={n} name={n} />
        ))}
      </div>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-medium)' }}>크기</span>
        <Segmented label="아이콘 크기" value={String(v.size)} onChange={(s) => void pick({ ...v, size: Number(s) })} options={['14', '16', '18', '20', '22', '24'].map((s) => ({ value: s, label: s === '18' ? '18 기본' : s }))} />
      </div>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-medium)' }}>채움</span>
        <Segmented
          label="아이콘 채움"
          value={String(v.fill)}
          onChange={(f) => void pick({ ...v, fill: Number(f) })}
          options={[
            { value: '0.87', label: '예전' },
            { value: '1', label: '기본' },
            { value: '1.09', label: '크게' },
            { value: '1.17', label: '아주 크게' },
          ]}
        />
      </div>
    </div>
  )
}

/** Keep a Changelog's sections, in its order. */
const CHANGE_KINDS: { kind: ChangeKind; label: string; tone: 'green' | 'blue' | 'amber' | 'grey' | 'red' }[] = [
  { kind: 'added', label: 'Added', tone: 'green' },
  { kind: 'changed', label: 'Changed', tone: 'blue' },
  { kind: 'fixed', label: 'Fixed', tone: 'amber' },
  { kind: 'removed', label: 'Removed', tone: 'grey' },
  { kind: 'security', label: 'Security', tone: 'red' },
]

/** 변경 기록 (REQ-F-744): one box per release (SPEC version), its changes grouped by kind. */
function ChangeLog() {
  return (
    <>
      {CHANGES.map((r) => (
        <section key={r.version} className="card-box release" aria-label={`v${r.version}`}>
          <div className="release-head">
            <b className="mono">v{r.version}</b>
            <span className="muted">{r.date}</span>
            <span className="grow" />
            {r.commit ? <code className="release-commit">{r.commit}</code> : null}
          </div>
          {CHANGE_KINDS.map(({ kind, label, tone }) => {
            const list = r.changes.filter((c) => c.kind === kind)
            return list.length ? (
              <div key={kind} className="release-group">
                <Badge tone={tone}>{label}</Badge>
                <ul className="change-list">
                  {list.map((c, i) => (
                    <li key={i}>
                      {c.scope.map((s) => (
                        <code key={s} className="change-scope">
                          {s}
                        </code>
                      ))}{' '}
                      {c.text}
                      {c.refs?.length ? <span className="change-refs">{c.refs.join(' · ')}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          })}
        </section>
      ))}
    </>
  )
}

/** 버전 (REQ-F-765): the web page's SPEC 판, and in the iOS app its version and build (from the User-Agent). */
function Versions() {
  const app = appVersion()
  const row = (label: string, value: string) => (
    <div className="hstack">
      <span className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
        {label}
      </span>
      <code className="mono">{value}</code>
    </div>
  )
  return (
    <section className="card-box">
      <CardHead title="버전" help="웹 화면은 지금 불러온 판이에요(설정 → 변경 기록의 맨 위). iOS 앱 버전은 앱 안에서 열었을 때만 보여요." />
      <div className="stack">
        {row('웹 화면', `v${CHANGES[0].version}`)}
        {app ? row('iOS 앱', `${app.version} (${app.build})`) : null}
      </div>
    </section>
  )
}

interface SkillsRepo {
  /** The person's own; empty when none is set. */
  repo: string
  /** None of one's own, and the server's SKILLS_REPO is read instead. */
  fallback: boolean
  /** The GitHub login the repo's owner must match; null for Apple and demo accounts. */
  login: string | null
  auth: 'app' | 'token' | null
  on: boolean
}

/** 스킬 저장소 (REQ-F-792): the person's own GitHub repo /skills reads, `owner/repo` with owner = their login. */
function SkillsRepoBox() {
  const [v, setV] = useState<SkillsRepo | null | undefined>(undefined)
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => get<SkillsRepo>('/api/prefs/skills').then((x) => (setV(x), setRepo(x.repo)), () => setV(null))
  useEffect(() => void load(), [])
  if (v === undefined) return null
  if (!v) return <LoadError what="스킬 저장소를" onRetry={() => void load()} />
  const t = repo.trim()
  const shape = !t || /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(t)
  const mine = !t || !v.login || t.split('/')[0].toLowerCase() === v.login.toLowerCase()
  const save = async (next: string) => {
    setBusy(true)
    try {
      const r = await post<SkillsRepo>('/api/prefs/skills', { repo: next })
      setV(r)
      setRepo(r.repo)
      toast(r.repo ? (r.on ? '저장했어요' : '저장했어요 · 서버에 읽을 권한이 없어 아직 꺼져 있어요') : '비웠어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  const status = !shape
    ? 'owner/repo 형식으로 적어 주세요'
    : !mine
      ? `내 GitHub 계정(${v.login})의 저장소만 넣을 수 있어요`
      : v.on
        ? v.fallback
          ? '서버 기본 저장소를 읽고 있어요'
          : `켜짐 · ${v.auth === 'app' ? 'GitHub App' : '토큰'}으로 읽어요`
        : v.repo
          ? '꺼짐 · 서버에 읽을 권한이 없어요'
          : '꺼짐'
  return (
    <section className="card-box stack">
      <CardHead title="스킬 저장소" help="/skills 가 읽는 내 GitHub 저장소(owner/repo)예요. 내 GitHub 계정의 저장소만 넣을 수 있고, 나에게만 보여요." />
      {v.login ? (
        <>
          <div className="hstack" style={{ gap: 6 }}>
            <input className="input mono grow" aria-label="스킬 저장소" placeholder={`${v.login}/skills`} autoComplete="off" spellCheck={false} value={repo} disabled={busy} onChange={(e) => setRepo(e.target.value)} />
            <Button size="sm" busy={busy} disabled={!shape || !mine || t === v.repo} onClick={() => void save(t)}>
              저장
            </Button>
            {v.repo ? (
              <Button size="sm" disabled={busy} onClick={() => void save('')}>
                비우기
              </Button>
            ) : null}
          </div>
          <span className="muted" style={{ fontSize: 'var(--fs-small)' }} role="status">
            {status}
          </span>
        </>
      ) : (
        <span className="muted">GitHub 로 로그인한 계정만 정할 수 있어요.</span>
      )}
    </section>
  )
}

/**
 * 계정 삭제 (REQ-F-770): what goes and what stays is said first, and the login name must be typed to go on. The
 * demo account is only put back to where it starts.
 */
function DeleteAccount({ me }: { me: Me | null }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  // An Apple account (REQ-F-772) has no name of its own to type, so it types 삭제.
  const apple = !!me?.user.apple
  const login = apple ? '삭제' : (me?.user.login ?? '')
  const demo = !!me?.demo
  const right = !!login && typed.trim().toLowerCase() === login.toLowerCase()
  const close = () => (setOpen(false), setTyped(''))
  const run = async () => {
    setBusy(true)
    try {
      await post('/api/account/delete', { login: typed.trim() })
      if (demo) {
        toast('데모를 처음 상태로 되돌렸어요')
        close()
        location.href = '/'
      } else location.replace('/')
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const li = (t: string) => <li style={{ margin: '4px 0' }}>{t}</li>
  return (
    <section className="card-box">
      <CardHead title="계정 삭제" help="이 서버에 있는 내 계정과 기록을 지워요. 되돌릴 수 없어요." />
      <Button tone="danger" icon="trash" onClick={() => setOpen(true)}>
        계정 삭제
      </Button>
      <Sheet
        open={open}
        onClose={close}
        title="계정을 삭제할까요?"
        footer={
          <>
            <Button onClick={close}>취소</Button>
            <Button tone="danger" disabled={!right} busy={busy} onClick={run}>
              {demo ? '데모 되돌리기' : '영구 삭제'}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ fontSize: 'var(--fs-medium)' }}>
          {demo ? (
            <p style={{ margin: 0 }}>심사용 데모 계정이에요. 지우지 않고 데모 맥·세션·그룹·설정을 처음 상태로 되돌려요.</p>
          ) : (
            <>
              <div>
                <b>서버에서 지우는 것</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {li(apple ? '계정 정보(Apple 계정 번호·이름 또는 이메일)와 접근 요청 기록' : '계정 정보(GitHub 이름·표시 이름·아바타)와 접근 요청 기록')}
                  {apple ? li('Apple 로그인 연결: Apple 에 토큰 취소를 요청해 Apple ID 설정의 "Apple로 로그인" 목록에서 이 앱이 빠져요') : null}
                  {li('모든 기기의 로그인(모두 로그아웃돼요)')}
                  {li('세션 정보(제목·상태·통계), 보낸 영상, 예전에 서버에 남아 있던 대화 기록')}
                  {li('설정·기본 프롬프트·그룹, 알림, 웹 푸시 구독')}
                  {li('플러그인 설정과 Slack 연결')}
                  {li('연결한 맥 기록과 연동: 맥의 연동 탭·에이전트가 더는 이 서버에 붙지 못해요')}
                </ul>
              </div>
              <div>
                <b>지우지 않는 것</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {li('맥에서 도는 Claude 세션, 맥의 대화 파일·화면 기록과 작업 폴더. 맥에서 직접 관리해요')}
                  {li('보낸 문제 제보: 처리를 위해 보낸 날부터 90일 동안 남고 그 뒤 자동으로 지워져요')}
                  {apple ? null : li('이름 고정 기록(로그인 이름과 GitHub id): 다른 GitHub 계정이 이 이름을 가져가지 못하게 남겨요. 같은 GitHub 계정으로 다시 로그인하면 새 계정으로 시작해요')}
                </ul>
              </div>
            </>
          )}
          <Field label={apple ? <>확인하려면 <b>{login}</b> 라고 입력해 주세요</> : <>확인하려면 로그인 이름 <b>{login}</b> 을 입력해 주세요</>}>
            <input className="input" {...NO_AUTOFILL} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={login} aria-label={apple ? '확인 문구' : '로그인 이름'} onKeyDown={(e) => e.key === 'Enter' && right && !busy && run()} />
          </Field>
        </div>
      </Sheet>
    </section>
  )
}

// The 운영 tab's code is its own file, fetched only when an admin opens the tab.
const AdminPanel = lazy(() => import('./admin').then((m) => ({ default: m.AdminPanel })))

// `short`: the label on a phone, where all the tabs share one row (styles.css .page-tab-short).
const TABS: { id: SettingsTab; label: string; short?: string; icon: string; admin?: true; feature?: Feature }[] = [
  { id: 'launch', label: '새 세션', icon: 'plus' },
  { id: 'prompt', label: '프롬프트', icon: 'doc' },
  { id: 'accounts', label: 'Claude 계정', short: '계정', icon: 'user' },
  { id: 'device', label: '이 기기', icon: 'phone' },
  // The only plugin is Slack; the tab goes with features.slack (REQ-F-812).
  { id: 'plugins', label: '플러그인', icon: 'plugin', feature: 'slack' },
  { id: 'voice', label: '음성', icon: 'mic', feature: 'voice' },
  { id: 'admin', label: '운영', icon: 'shield', admin: true },
  { id: 'changes', label: '변경 기록', icon: 'clock' },
  { id: 'more', label: '더 보기', icon: 'list' },
]

export function SettingsPage({ me, tab }: { me: Me | null; tab: SettingsTab }) {
  const wide = useWide()
  const [prompt, setPrompt] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [editing, setEditing] = useState<Plugin | null>(null)
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [kbDebug, setKbDebugState] = useState(kbDebugOn)
  const [opts, setOpts] = useState<Options | null | undefined>(undefined)
  const [launch, setLaunch] = useState<Launch | null>(null)
  // A read that fails is shown as failed, with 다시 시도, never as an empty value: an empty prompt or "지정 안 함"
  // standing in for one that could not be read was saved over the real one with the next 저장.
  const [errs, setErrs] = useState<Partial<Record<'prompt' | 'plugins' | 'opts' | 'launch', unknown>>>({})
  const load = (part: 'prompt' | 'plugins' | 'opts' | 'launch') => {
    setErrs((x) => ({ ...x, [part]: undefined }))
    const fail = (e: unknown) => setErrs((x) => ({ ...x, [part]: e ?? true }))
    if (part === 'prompt') get<{ text: string }>('/api/prefs/prompt').then((r) => setPrompt(r.text ?? ''), fail)
    if (part === 'plugins') get<{ plugins: Plugin[] }>('/api/plugins').then((r) => setPlugins(r.plugins), fail)
    if (part === 'opts') get<Options>('/api/options').then(setOpts, fail)
    if (part === 'launch') get<Launch>('/api/prefs/launch').then(setLaunch, fail)
  }
  useEffect(() => {
    load('prompt')
    load('plugins')
    load('opts')
    load('launch')
  }, [])
  // Drawn once everything has arrived (or failed): drawn piece by piece, each card grew as its part came in and
  // pushed the cards below it down (a layout shift of 0.44 on a phone).
  const ready = (prompt != null || !!errs.prompt) && (plugins != null || !!errs.plugins) && (opts !== undefined || !!errs.opts) && (launch != null || !!errs.launch)
  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>설정</b>
          <span>{me ? shownName(me) : ''}</span>
        </div>
      </div>
      {/* Tabs (REQ-F-708): one part of the settings at a time, so nothing is far down a long page. Each tab has its
          own address (/settings/<tab>), so a link can open the right one. */}
      <div className="page-tabs" role="tablist" aria-label="설정">
        {TABS.filter((t) => (!t.admin || me?.admin) && (!t.feature || featureOn(t.feature))).map((t) => (
          <a key={t.id} role="tab" aria-selected={tab === t.id} className={`page-tab${tab === t.id ? ' on' : ''}`} href={href({ name: 'settings', tab: t.id })} onClick={(e) => (e.preventDefault(), go({ name: 'settings', tab: t.id }, { replace: true }))}>
            <Icon name={t.icon} />
            {t.short ? (
              <>
                <span className="page-tab-long">{t.label}</span>
                <span className="page-tab-short">{t.short}</span>
              </>
            ) : (
              <span>{t.label}</span>
            )}
          </a>
        ))}
      </div>
      <div className="scroll">
        {!ready ? (
          <div className="page-wait" role="status" aria-label="불러오는 중">
            <Spinner />
          </div>
        ) : (
        <div className="page stack">
          {tab === 'launch' ? (
          <section className="card-box">
            <CardHead title="새 세션·복제 기본값" help="새 세션은 이 값으로 시작해요(새 세션 화면에서 그 세션만 바꿀 수 있어요). 복제·가벼운 복제도 이 값으로 띄워요. 지정 안 한 항목은 새 세션이면 맥의 기본값, 복제면 원래 세션의 값을 따라요." />
            {errs.opts || errs.launch ? (
              <LoadError what="선택지를" error={errs.opts || errs.launch} onRetry={() => (errs.opts && load('opts'), errs.launch && load('launch'))} />
            ) : (
              <LaunchDefaults opts={opts ?? null} initial={launch!} />
            )}
          </section>
          ) : null}
          {tab === 'prompt' ? (
          <section className="card-box">
            <CardHead title="기본 프롬프트" help="모든 세션의 시스템 프롬프트에 덧붙여요. 저장하면 열린 세션을 새로고침해 바로 적용하고, 일하던 세션은 다시 뜬 뒤 하던 작업을 이어가요." />
            {errs.prompt ? (
              <LoadError what="저장된 프롬프트를" error={errs.prompt} onRetry={() => load('prompt')} />
            ) : prompt == null ? (
              <Spinner />
            ) : (
              <>
                <textarea className="input" {...NO_AUTOFILL} rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="예: 한국어로 답해 줘. 커밋 전에 테스트를 돌려 줘." />
                <div className="hstack" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                  <Button
                    tone="primary"
                    busy={saving}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        toast((await post<{ ok: true; note: string }>('/api/prefs/prompt', { text: prompt })).note)
                      } catch (e) {
                        toast(errorText(e), { tone: 'bad' })
                      }
                      setSaving(false)
                    }}
                  >
                    저장
                  </Button>
                </div>
              </>
            )}
          </section>
          ) : null}
          {tab === 'accounts' ? <AccountsPanel /> : null}
          {tab === 'device' ? (
          <section className="card-box">
            <div className="stack">
              <PushToggle />
              <div className="hstack">
                <span style={{ fontSize: 'var(--fs-medium)' }}>화면</span>
                <Segmented
                  label="화면"
                  value={theme}
                  onChange={(t) => (setTheme(t), setThemeState(t))}
                  options={[
                    { value: 'auto', label: '시스템' },
                    { value: 'light', label: '밝게' },
                    { value: 'dark', label: '어둡게' },
                  ]}
                />
              </div>
              <div className="hstack">
                <div className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
                  화면 진단 표시
                  <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
                    세션 화면 위에 키보드·입력창 위치 숫자를 작게 띄워요. 화면이 어긋날 때 원인을 찾는 용도예요(이 기기에만)
                  </div>
                </div>
                <Switch label="화면 진단 표시" checked={kbDebug} onChange={(v) => (setKbDebug(v), setKbDebugState(v))} />
              </div>
              {inHomeApp() ? (
                <div className="hstack">
                  <div className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
                    Safari로 열기
                    <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
                      홈 화면 앱은 켤 때마다 마이크 허용을 다시 물어요. Safari는 한 번 허용하면 기억해요. 처음 한 번은 Safari에서 로그인해야 해요.
                    </div>
                  </div>
                  <a className="btn" href={safariHref()} style={{ color: 'inherit', textDecoration: 'none' }}>
                    열기
                  </a>
                </div>
              ) : null}
            </div>
          </section>
          ) : null}
          {tab === 'device' ? <Versions /> : null}
          {tab === 'device' ? (
          <section className="card-box">
            <CardHead title="아이콘" help="계정에 저장돼요. 이 계정으로 연 모든 기기에 같이 적용돼요. 채움은 아이콘 칸 안에서 그림이 차지하는 정도예요." />
            <IconSettings initial={getIcons()} />
          </section>
          ) : null}
          {tab === 'plugins' && featureOn('slack') ? (
          <section className="card-box">
            {errs.plugins ? (
              <LoadError what="플러그인 목록을" error={errs.plugins} onRetry={() => load('plugins')} />
            ) : !plugins ? (
              <Spinner />
            ) : !plugins.length ? (
              <Empty icon="plugin" title="쓸 수 있는 플러그인이 없어요">
                서버에 등록된 플러그인이 생기면 여기서 켜고 끌 수 있어요.
              </Empty>
            ) : (
              plugins.map((p) => (
                <div key={p.id} className="hstack" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                  <div className="grow">
                    <b>{p.name}</b> {p.added ? <Badge tone={p.status.state === 'on' ? 'green' : p.status.state === 'error' ? 'red' : 'grey'}>{p.enabled ? (p.status.state === 'on' ? '켜짐' : p.status.note || p.status.state) : '꺼짐'}</Badge> : null}
                    {/* A phone keeps it to one line; the whole of it is in the plugin's sheet. */}
                    <div className="muted plugin-about" style={{ fontSize: 'var(--fs-small)' }} title={p.about}>
                      {p.about}
                    </div>
                  </div>
                  {p.added ? (
                    <Switch
                      label={`${p.name} 켜기`}
                      checked={p.enabled}
                      onChange={(on) =>
                        post<{ ok: true; note: string; plugins: Plugin[] }>(`/api/plugins/${p.id}`, { enabled: on }).then(
                          (r) => (setPlugins(r.plugins), toast(r.note)),
                          (e) => toast(errorText(e), { tone: 'bad' }),
                        )
                      }
                    />
                  ) : null}
                  <Button size="sm" onClick={() => setEditing(p)}>
                    {p.added ? '설정' : '추가'}
                  </Button>
                </div>
              ))
            )}
          </section>
          ) : null}
          {tab === 'voice' && featureOn('voice') ? <VoiceSettings /> : null}
          {/* 운영 (REQ-F-741): its own tab, shown to admins; anyone else who opens /settings/admin is told so. */}
          {tab === 'admin' ? (
            me?.admin ? (
              <Suspense
                fallback={
                  <div className="page-wait" role="status" aria-label="불러오는 중">
                    <Spinner />
                  </div>
                }
              >
                <AdminPanel />
              </Suspense>
            ) : (
              <Empty icon="shield" title="운영자만 볼 수 있어요" />
            )
          ) : null}
          {/* 변경 기록 (REQ-F-744): for everyone, newest release first. */}
          {tab === 'changes' ? <ChangeLog /> : null}
          {/* What used to fill the list's ⋯ menu: the other pages of the site, kept here so the menu stays short. */}
          {tab === 'more' ? (
          <section className="card-box">
            <nav className="link-list" aria-label="다른 화면">
              {[
                { icon: 'laptop', label: '기기', hint: '맥 연결·상태·로그', to: href({ name: 'hosts' }) },
                { icon: 'folder', label: '디스크 관리', hint: '기기별 캐시·worktree·큰 폴더', to: href({ name: 'disk' }) },
                { icon: 'chart', label: '사용 통계', hint: '일한 시간·PR', to: href({ name: 'stats' }) },
                { icon: 'chart', label: '성능 리포트', hint: '화면별 점수·개선 기록', to: href({ name: 'quality' }) },
                ...(featureOn('skills') ? [{ icon: 'sparkle', label: '스킬', hint: '골라서 설치', to: '/skills' }] : []),
                { icon: 'info', label: '시작 가이드', hint: '처음 시작 · 멀티 계정', to: href({ name: 'guide', path: 'start' }) },
                { icon: 'shield', label: '개인정보 처리방침', hint: '저장하는 것·보관·제3자', to: '/privacy' },
                // AGPL-3.0 section 13 (REQ-F-791): the source of what this server runs.
                ...(me?.source ? [{ icon: 'link', label: '소스 코드', hint: 'AGPL-3.0', to: me.source }] : []),
              ].map((x) => (
                <a key={x.label} className="link-row" href={x.to}>
                  <Icon name={x.icon} />
                  <span className="grow">{x.label}</span>
                  {/* A phone shows the names alone: the hints made 시작 가이드 break over two lines. */}
                  {wide ? <span className="muted">{x.hint}</span> : null}
                  <Icon name="forward" />
                </a>
              ))}
            </nav>
          </section>
          ) : null}
          {/* The demo account has no GitHub login, and the demo refuses this call. */}
          {tab === 'more' && me && !me.demo && featureOn('skills') ? <SkillsRepoBox /> : null}
          {tab === 'more' ? <DeleteAccount me={me} /> : null}
        </div>
        )}
      </div>
      {editing ? <PluginSheet p={editing} onClose={() => setEditing(null)} onSaved={setPlugins} /> : null}
    </div>
  )
}
