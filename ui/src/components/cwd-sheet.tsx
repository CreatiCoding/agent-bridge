// 작업 폴더 바꾸기 (REQ-F-785): the same conversation, opened again on the same Mac in another folder. The folder is
// typed, picked by browsing that Mac's folders, or a new default one (<기본 폴더>/<그룹>/<MMDD>-<id>, REQ-F-763).
import { useEffect, useRef, useState } from 'react'
import { ApiError, errorText, get, post } from '../lib/api'
import { defaultFolder, folderStamp } from '../lib/folder'
import { folderPath } from '../lib/format'
import { titleOf } from '../lib/sessions'
import { useStore } from '../lib/store'
import type { Session } from '../lib/types'
import { Badge, Button, Field, Icon, Spinner } from '../kit'
import { confirmDialog, Sheet, toast } from '../kit/overlay'

/** Opens the sheet for a session from anywhere (its ⋯ menu, the path in its header). */
export const openCwd = (s: Session) => dispatchEvent(new CustomEvent('cb-cwd', { detail: s.id }))

interface Dirs {
  ok: true
  path: string
  parent?: string | null
  dirs: { name: string; git: boolean }[]
}

export function CwdSheet() {
  const [sid, setSid] = useState<string | null>(null)
  useEffect(() => {
    const f = (e: Event) => setSid((e as CustomEvent<string>).detail)
    addEventListener('cb-cwd', f)
    return () => removeEventListener('cb-cwd', f)
  }, [])
  const s = useStore((st) => (sid ? st.state?.sessions.find((x) => x.id === sid) : undefined))
  const groups = useStore((st) => st.state?.groups.groups)
  const [cwd, setCwd] = useState('')
  const [dirs, setDirs] = useState<Dirs | null>(null)
  const [dirsError, setDirsError] = useState<string | null>(null)
  // Picked from the default rule: always new, made without asking.
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  // A listing is on its way (a typed path shows none until Enter).
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)
  const close = () => (setSid(null), setBusy(false))

  const browse = async (path: string) => {
    if (!s) return
    const n = ++asked.current
    setDirsError(null)
    setLoading(true)
    try {
      const r = await get<Dirs>(`/api/hosts/${s.hostId}/dirs?path=${encodeURIComponent(path)}`)
      if (n !== asked.current) return
      setDirs(r)
      setCwd(r.path)
      setFresh(false)
    } catch (e) {
      if (n === asked.current) setDirsError(errorText(e))
    }
    if (n === asked.current) setLoading(false)
  }
  // Each opening starts at the session's folder.
  const [opened, setOpened] = useState<string | null>(null)
  if (s && opened !== s.id) {
    setOpened(s.id)
    setCwd(folderPath(s.cwd, s.home))
    setDirs(null)
    setFresh(false)
  }
  if (!s && opened) setOpened(null)
  useEffect(() => {
    if (s) void browse(folderPath(s.cwd, s.home))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  const newDefault = async () => {
    if (!s) return
    asked.current += 1
    const prefs = await get<{ folderBase?: string; folderNoGroup?: string }>('/api/prefs/launch').catch(() => ({}) as { folderBase?: string; folderNoGroup?: string })
    const group = groups?.find((g) => g.items.includes(s.id))
    setCwd(defaultFolder(prefs.folderBase, prefs.folderNoGroup, group?.name, folderStamp()))
    setFresh(true)
    setDirs(null)
    setDirsError(null)
    setLoading(false)
  }

  const submit = async () => {
    if (!s) return
    const to = cwd.trim()
    if (!/^(\/|~(\/|$))/.test(to)) return toast('작업 폴더는 / 또는 ~ 로 시작하는 경로여야 해요', { tone: 'bad' })
    if (to.replace(/\/+$/, '') === folderPath(s.cwd, s.home)) return toast('지금 작업 폴더예요', { tone: 'bad' })
    setBusy(true)
    // A folder typed by hand that is not there is asked about; the agent makes it when the session opens there.
    if (!fresh) {
      try {
        await get<Dirs>(`/api/hosts/${s.hostId}/dirs?path=${encodeURIComponent(to)}`)
      } catch (e) {
        const missing = e instanceof ApiError && /없어요/.test(errorText(e))
        if (!missing) return (setBusy(false), toast(errorText(e), { tone: 'bad' }))
        if (!(await confirmDialog('그 폴더가 없어요. 만들까요?', { text: to, ok: '만들고 바꾸기' }))) return setBusy(false)
      }
    }
    try {
      toast('작업 폴더를 바꾸는 중이에요…')
      const r = await post<{ ok: true; warnings?: string[] }>(`/api/sessions/${s.id}/cwd`, { cwd: to })
      toast(r.warnings?.length ? `작업 폴더를 바꿨어요 · 확인할 것: ${r.warnings.join(' / ')}` : '작업 폴더를 바꿨어요')
      close()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      setBusy(false)
    }
  }

  const busyNow = s?.state.phase === 'busy'
  return (
    <Sheet
      open={!!s}
      onClose={close}
      title="작업 폴더 바꾸기"
      footer={
        <div className="dialog-buttons">
          <Button onClick={close}>취소</Button>
          <Button tone="primary" busy={busy} disabled={!cwd.trim() || busyNow} onClick={() => void submit()}>
            이 폴더로 바꾸기
          </Button>
        </div>
      }
    >
      {s ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <b>{titleOf(s)}</b> 의 대화를 그대로 두고, 같은 맥에서 고른 폴더로 다시 열어요. 원래 폴더의 파일은 옮기지 않아요.
            {busyNow ? ' 지금 작업 중이라 턴이 끝난 뒤에 바꿀 수 있어요.' : ''}
          </p>
          <Field label="폴더" hint={fresh ? '새 폴더를 만들어 열어요' : '눌러서 들어가고, 이 폴더로 바꿔요. 없는 폴더를 적으면 만들지 물어요'}>
            <input
              className="input mono"
              value={cwd}
              onChange={(e) => ((asked.current += 1), setLoading(false), setDirs(null), setFresh(false), setCwd(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void browse(cwd)}
              spellCheck={false}
              autoCapitalize="off"
              aria-label="작업 폴더"
            />
          </Field>
          <div className="hstack" style={{ gap: 8, marginTop: -8, marginBottom: 8, flexWrap: 'wrap' }}>
            <Button size="sm" tone="ghost" icon="plus" onClick={() => void newDefault()}>
              새 기본 폴더
            </Button>
            <Button size="sm" tone="ghost" icon="folder" onClick={() => void browse(folderPath(s.cwd, s.home))}>
              지금 폴더
            </Button>
          </div>
          <div className="folder-list">
            {fresh ? (
              <div className="folder-item muted">
                <Icon name="folder" /> <span className="grow">새 폴더예요 · 기본 폴더는 설정 → 새 세션에서 바꿔요</span>
              </div>
            ) : dirsError ? (
              <div className="folder-item muted">
                <span className="grow">폴더를 읽지 못했어요 · {dirsError}</span>
              </div>
            ) : !dirs ? (
              <div className={`folder-item${loading ? '' : ' muted'}`}>{loading ? <Spinner size={14} /> : 'Enter 를 누르면 이 폴더 안을 보여요'}</div>
            ) : (
              <>
                {dirs.parent ? (
                  <button type="button" className="folder-item" onClick={() => void browse(dirs.parent!)}>
                    <Icon name="back" /> ..
                  </button>
                ) : null}
                {dirs.dirs.length ? (
                  dirs.dirs.map((d) => (
                    <button key={d.name} type="button" className="folder-item" onClick={() => void browse(`${dirs.path.replace(/\/$/, '')}/${d.name}`)}>
                      <Icon name={d.git ? 'fork' : 'folder'} /> <span className="grow">{d.name}</span>
                      {d.git ? <Badge>git</Badge> : null}
                    </button>
                  ))
                ) : (
                  <div className="folder-item muted">하위 폴더가 없어요</div>
                )}
              </>
            )}
          </div>
        </>
      ) : null}
    </Sheet>
  )
}
