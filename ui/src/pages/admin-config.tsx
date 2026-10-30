// 설정 파일 (REQ-F-810): move an environment-only server to bridge.yaml from the admin page. The export holds
// references to the server's variables, never their values, so it means what the environment means today.
import { useEffect, useState } from 'react'
import { ApiError, errorText, get, post } from '../lib/api'
import { ago } from '../lib/format'
import { Button, Icon, Row } from '../kit'
import { Sheet, toast } from '../kit/overlay'

interface Diff { key: string; env: string; file: string; envValue: string; refEnv: boolean; envSet: boolean; warn: boolean }
interface Status {
  path: string
  named: boolean
  state: 'none' | 'empty' | 'zero' | 'file' | 'dir' | 'error'
  start: { path: string; state: string }
  diff: Diff[]
  error: { at: number; version: string; path: string; errors: string[] } | null
  exportable: boolean
  saveable: boolean
  masked?: string
}
/** A host to turn the headless link off on before a file turns auth.headerOnly on (REQ-F-816). */
interface HeaderOnlyHost { name: string; lastSeen?: number; state: 'on' | 'unknown' | 'server'; at?: number; note: string }
interface Check { ok: boolean; state?: string; errors: string[]; diff: Diff[]; unsubstituted?: string[]; headerOnlyHosts?: HeaderOnlyHost[] }

const STATE: Record<Status['state'], string> = {
  none: '없음 · 환경변수만 씀',
  empty: '빈 파일(주석만) · 환경변수만 씀',
  zero: '빈 파일(마운트를 뺀 흔적) · 환경변수만 씀',
  file: '있음',
  dir: '파일 자리가 폴더예요',
  error: '읽지 못함',
}

/** A check's result as lines: errors first, then the keys whose value differs from the environment alone. */
function CheckView({ c }: { c: Check }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <b style={{ color: c.ok ? 'var(--green)' : 'var(--red)' }}>{c.ok ? '검사 통과' : '검사 실패'}</b>
      {c.errors.map((e, i) => (
        <div key={i} className="mono" style={{ fontSize: 'var(--fs-small)' }}>{e}</div>
      ))}
      {c.unsubstituted?.length ? <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>치환하지 않은 이름: {c.unsubstituted.join(', ')}</div> : null}
      {c.ok && !c.diff.length ? <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>환경변수만 썼을 때와 달라지는 값이 없어요.</div> : null}
      {c.diff.map((d) => (
        <div key={d.key} style={{ fontSize: 'var(--fs-small)' }}>
          <code>{d.key}</code> = {d.file || '(비어 있음)'} <span className="muted">(환경변수 {d.env} = {d.envValue || '(없음)'})</span>
          {d.warn ? <div style={{ color: 'var(--amber)' }}>환경변수를 고쳐도 반영되지 않아요. 이 키는 파일 값이 쓰여요.</div> : null}
        </div>
      ))}
      {c.headerOnlyHosts?.length ? (
        <div style={{ fontSize: 'var(--fs-small)', color: 'var(--amber)' }}>
          <b>헤더 로그인만 받기 전에 이 기기들의 헤드리스 연동을 끄세요</b>
          {c.headerOnlyHosts.map((h, i) => (
            <div key={i}>
              {h.name} · {h.note}
              {h.at || h.lastSeen ? <span className="muted"> ({new Date((h.at ?? h.lastSeen)!).toLocaleString('ko-KR')})</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const checkOf = (e: unknown): Check | null => (e instanceof ApiError && Array.isArray(e.data?.errors) ? (e.data as unknown as Check) : null)

function ConfigSheet({ s, onClose, onChanged }: { s: Status; onClose: () => void; onChanged: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paste, setPaste] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  useEffect(() => {
    if (!s.exportable) return
    // The export is text/yaml, not JSON, so it is fetched as text.
    fetch('/api/admin/config/export', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`내보내기 실패 (${r.status})`))))
      .then(setText, (e) => toast(errorText(e), { tone: 'bad' }))
  }, [s.exportable])
  const runCheck = async (yaml?: string) => {
    setBusy(true)
    try {
      setCheck(await post<Check>('/api/admin/config/check', yaml === undefined ? {} : { yaml }))
    } catch (e) {
      const c = checkOf(e)
      if (c) setCheck(c)
      else toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  const save = async () => {
    setBusy(true)
    try {
      const r = await post<{ ok: true; path: string; check: Check; next: string }>('/api/admin/config/save', {})
      setCheck(r.check)
      toast(`${r.path} 에 저장했어요. ${r.next}`, { ms: 6000 })
      onChanged()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  const download = () => {
    if (!text) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }))
    a.download = 'bridge.yaml'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <Sheet open onClose={onClose} title="설정 파일 (bridge.yaml)" wide>
      <div className="stack">
        {s.exportable ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              지금 환경변수로 만든 설정 파일이에요. 값 대신 환경변수 참조만 들어 있어서, 이 파일을 넣어도 동작이 그대로이고 환경변수를 고치면 지금처럼 반영돼요. 비밀값은 들어 있지 않아요.
            </p>
            <pre className="report-debug" style={{ maxHeight: 260, overflow: 'auto' }}>{text ?? '만드는 중…'}</pre>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              <Button size="sm" icon="copy" disabled={!text} onClick={() => text && navigator.clipboard?.writeText(text).then(() => toast('복사했어요'))}>
                복사
              </Button>
              <Button size="sm" disabled={!text} onClick={download}>
                내려받기
              </Button>
              {s.saveable ? (
                <Button size="sm" tone="primary" busy={busy} onClick={save}>
                  이 서버에 저장
                </Button>
              ) : null}
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
              권하는 길: Dokploy 의 파일 마운트로 <code>{s.path}</code> 에 넣고(내용은 위의 복사), 아래 "붙여 넣고 검사" 로 확인한 뒤 다시 배포하세요. "이 서버에 저장" 은 마운트 없이 데이터 볼륨에 쓰는 길이라, 그 파일은 컨테이너 터미널로만 고칠 수 있어요. 어느 쪽이든 같은 뜻의 환경변수는 지우지 마세요(되돌릴 때 필요해요).
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>
              이미 설정 파일이 있어요(<code>{s.path}</code>). 내보내기는 표의 네 키만 만들어서, 붙여 넣으면 지금 파일의 다른 설정이 사라지므로 주지 않아요. 아래는 비밀처럼 보이는 값과 주소의 경로를 가린 내용이에요.
            </p>
            {s.masked ? <pre className="report-debug" style={{ maxHeight: 260, overflow: 'auto' }}>{s.masked}</pre> : null}
            <div>
              <Button size="sm" busy={busy} onClick={() => void runCheck()}>
                지금 파일 검사
              </Button>
            </div>
          </>
        )}
        <label className="field" style={{ margin: 0 }}>
          <span className="field-label">붙여 넣고 검사 (저장하지 않아요)</span>
          <textarea className="input mono" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="고친 bridge.yaml 내용" />
        </label>
        <div>
          <Button size="sm" busy={busy} disabled={!paste.trim()} onClick={() => void runCheck(paste)}>
            붙여 넣고 검사
          </Button>
        </div>
        {check ? <CheckView c={check} /> : null}
      </div>
    </Sheet>
  )
}

/** The settings file's state on the admin page, its warnings, and the sheet that moves the server to it. */
export function ConfigBox() {
  const [s, setS] = useState<Status | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const load = () => get<Status>('/api/admin/config').then(setS, () => setS(null))
  useEffect(() => void load(), [])
  if (s === undefined) return null
  if (s === null) return <div className="muted">설정 파일 상태를 불러오지 못했어요.</div>
  const warns = s.diff.filter((d) => d.warn)
  return (
    <div className="stack" style={{ gap: 8 }}>
      {s.error ? (
        <div className="banner" style={{ background: 'var(--red-soft)' }}>
          <Icon name="warn" />
          <div className="banner-body">
            <b>새 설정으로 시작하지 못했어요</b> <span className="muted">({ago(s.error.at)}, 서버 {s.error.version})</span>
            {s.error.errors.map((e, i) => (
              <div key={i} className="mono">{e}</div>
            ))}
            <div className="muted">지금 떠 있는 서버는 전 설정 그대로 일하고 있어요. 파일을 고친 뒤 다시 배포하세요.</div>
          </div>
        </div>
      ) : null}
      {warns.map((d) => (
        <div key={d.key} className="banner">
          <Icon name="warn" />
          <div className="banner-body">
            환경변수 <code>{d.env}</code> 를 고쳐도 반영되지 않아요. <code>bridge.yaml</code> 의 <code>{d.key}</code> 가 쓰여요. 되돌리면 이 값이 환경변수 값({d.envValue || '없음'})으로 돌아가요.
          </div>
        </div>
      ))}
      <Row
        title="설정 파일 (bridge.yaml)"
        sub={`${STATE[s.state]} · ${s.path}${s.start.path && s.start.state === 'file' ? ' · 이번 시작에 읽음' : ''}`}
        right={
          <Button size="sm" onClick={() => setOpen(true)}>
            {s.exportable ? '설정 파일로 내보내기' : '보기·검사'}
          </Button>
        }
      />
      {open ? <ConfigSheet s={s} onClose={() => setOpen(false)} onChanged={() => void load()} /> : null}
    </div>
  )
}
