// Start a session: which Mac, which folder (picked by browsing that Mac's folders), what to say first, and
// optionally the model, effort and permission mode.
import { useEffect, useRef, useState } from 'react'
import { ApiError, errorText, get } from '../lib/api'
import { defaultFolder, folderStamp } from '../lib/folder'
import { getPref, setPref } from '../lib/local'
import { back, go } from '../lib/router'
import { hostIcon, KINDS } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import type { Options } from '../lib/types'
import { Badge, Button, Empty, Field, Icon, IconButton, NO_AUTOFILL, Segmented, Spinner, Switch, useWide } from '../kit'
import { AdoptList, presetAdopt } from './adopt-list'
import { confirmLaunchMode } from '../components/auto-allow-confirm'
import { StateWait, useStateLoaded } from '../components/state-wait'
import { confirmDialog, toast } from '../kit/overlay'
import { openSession, sendMessage } from '../lib/builtin-actions'
import { dispatch, isCancel } from '../lib/actions'
import { shrinkImage } from '../lib/image'
import { uploadVideo, VIDEO_MAX, VIDEO_TYPES, type SentVideo } from '../lib/video'

interface Dirs {
  ok: true
  path: string
  parent?: string | null
  dirs: { name: string; git: boolean }[]
}

export function NewSessionPage() {
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const loaded = useStateLoaded()
  const wide = useWide()
  const online = hosts.filter((h) => h.online)
  // `/new?host=<id>` picks the Mac (a prepared list of its conversations to carry on comes with it).
  const [hostId, setHostId] = useState<string>(() => /[?&]host=([\w-]+)/.exec(location.search)?.[1] ?? getPref('newHost', ''))
  const host = online.find((h) => h.id === hostId) ?? online[0]
  // The folder last started in on this device, offered as a chip; the form itself starts in a new default folder.
  const recent = getPref('newCwd', '')
  const [cwd, setCwd] = useState<string>(() => recent || '~')
  // 기본 폴더 (REQ-F-763): <기본 폴더>/<그룹>/<MMDD>-<id>, made when it starts. Until the folder is edited or picked.
  const [auto, setAuto] = useState(true)
  const [stamp] = useState(folderStamp)
  const [folderPrefs, setFolderPrefs] = useState<{ base?: string; noGroup?: string }>({})
  const [dirs, setDirs] = useState<Dirs | null>(null)
  const [dirsError, setDirsError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  // Pictures and videos for the first message (REQ-F-828), as the session's box takes them: 8 pictures, 3 videos.
  const [images, setImages] = useState<{ data: string; name: string }[]>([])
  const [videos, setVideos] = useState<{ file: File; pct: number | null }[]>([])
  const file = useRef<HTMLInputElement>(null)
  const [opts, setOpts] = useState<Options | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [mode, setMode] = useState('')
  // Claude in Chrome (the person's signed-in Chrome): on unless turned off for this session.
  const [chrome, setChrome] = useState(true)
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  // `/new?group=<id>` (a group's menu, 이 그룹에 새 세션): the new session goes in that group.
  const groups = useStore((s) => s.state?.groups.groups ?? NONE)
  const [groupId, setGroupId] = useState(() => /[?&]group=([\w-]+)/.exec(location.search)?.[1] ?? '')
  const group = groups.find((g) => g.id === groupId)
  const folder = auto ? defaultFolder(folderPrefs.base, folderPrefs.noGroup, group?.name, stamp) : cwd
  const [tab, setTab] = useState<'new' | 'adopt'>(() => (presetAdopt().length || location.search.includes('adopt') ? 'adopt' : 'new'))
  // The Claude account on that Mac (설정 → Claude 계정): asked only when it has more than one; the last pick is kept.
  const accounts = host?.accounts ?? []
  const [accountPick, setAccountPick] = useState<string>(() => getPref('newAccount', ''))
  const account = accounts.find((a) => a.id === accountPick && a.loggedIn !== false)?.id ?? ''

  useEffect(() => {
    get<Options>('/api/options').then(setOpts, () => {})
    // The person's defaults (설정 → 새 세션·복제 기본값) are where the form starts; a choice made here already stays.
    get<{ model: string; effort: string; mode: string; folderBase?: string; folderNoGroup?: string }>('/api/prefs/launch').then(
      (d) => (setModel((x) => x || d.model), setEffort((x) => x || d.effort), setMode((x) => x || d.mode), setFolderPrefs({ base: d.folderBase, noGroup: d.folderNoGroup })),
      () => {},
    )
  }, [])
  // What the closed "모델 · effort · 권한 모드" button says it will start with.
  const chosen = [opts?.models.find((m) => m.value === model)?.label ?? model, effort, opts?.modes.find((m) => m.value === mode)?.label.split(' · ')[0] ?? mode].filter(Boolean).join(' · ')
  // Only the answer to the latest request counts: a slow first listing must not overwrite a folder picked since.
  const asked = useRef(0)
  const browse = async (path: string) => {
    if (!host) return
    const n = ++asked.current
    setDirsError(null)
    try {
      const r = await get<Dirs>(`/api/hosts/${host.id}/dirs?path=${encodeURIComponent(path)}`)
      if (n !== asked.current) return
      setDirs(r)
      setCwd(r.path)
    } catch (e) {
      if (n === asked.current) setDirsError(errorText(e))
    }
  }
  const pick = (path: string) => {
    setAuto(false)
    setCwd(path)
    void browse(path)
  }
  useEffect(() => {
    if (host && !auto) void browse(cwd || '~')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id])

  const addFiles = async (files: FileList | File[]) => {
    const vids = [...files].filter((f) => f.type.startsWith('video/'))
    if (vids.length) {
      const ok = vids.filter((f) => VIDEO_TYPES.includes(f.type) && f.size <= VIDEO_MAX)
      if (ok.length < vids.length) toast(`mp4·mov·webm 영상, ${VIDEO_MAX / 1024 / 1024}MB 까지 보낼 수 있어요`)
      if (videos.length + ok.length > 3) toast('영상은 한 번에 3개까지 보낼 수 있어요')
      setVideos((now) => [...now, ...ok.map((f) => ({ file: f, pct: null }))].slice(0, 3))
    }
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    if (images.length + list.length > 8) toast('그림은 한 번에 8장까지 보낼 수 있어요')
    const made = await Promise.all(list.slice(0, 8 - images.length).map((f) => shrinkImage(f).catch(() => null)))
    setImages((now) => [...now, ...made.filter((x): x is { data: string; name: string } => !!x)].slice(0, 8))
  }
  const attached = images.length + videos.length > 0

  const start = async (retry = false) => {
    if (!host) return
    // 전부 허용: allowed without asking from the first request on. Said before it starts, not after.
    if (!retry && !(await confirmLaunchMode(mode))) return
    // The default folder is always new: made without asking. A folder typed or picked is asked about.
    const create = retry || auto
    setBusy(true)
    try {
      // With pictures or videos the session starts empty (named after the words) and the first message goes the way
      // the session's box sends one: videos up first, then words, pictures and videos together. The Mac holds a
      // message said while the session is still starting and hands it over once it is up.
      const first = attached ? { prompt: '', title: prompt } : { prompt }
      const r = await dispatch('session.create', { hostId: host.id, cwd: folder, ...first, model, effort, mode, create, ...(group ? { group: group.id } : {}), ...(chrome ? {} : { chrome: false }), ...(account ? { account } : {}) })
      if (isCancel(r)) return setBusy(false)
      setPref('newHost', host.id)
      setPref('newAccount', account)
      if (!auto) setPref('newCwd', cwd)
      if (attached) {
        try {
          const sent: SentVideo[] = []
          for (const [i, v] of videos.entries()) sent.push(await uploadVideo(`/api/sessions/${encodeURIComponent(r.sid)}/upload`, v.file, (pct) => setVideos((now) => now.map((x, j) => (j === i ? { ...x, pct } : x)))))
          await sendMessage(r.sid, prompt.trim(), images, sent)
        } catch (e) {
          // The session is there already: it opens, and what did not go is said.
          toast(`세션은 띄웠지만 첫 메시지를 보내지 못했어요: ${errorText(e)}`, { tone: 'bad' })
        }
      }
      openSession(r.sid, 'new', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.data.missing && !create) {
        setBusy(false)
        if (await confirmDialog('그 폴더가 없어요. 만들까요?', { text: cwd, ok: '만들고 시작' })) return start(true)
        return
      }
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }

  if (!online.length)
    return (
      <div className="main">
        <div className="topbar">
          {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
          <div className="topbar-title">
            <b>새 세션</b>
          </div>
        </div>
        {!loaded ? <StateWait /> : <Empty icon="laptop" title="연결된 맥이 없어요" action={<Button onClick={() => go({ name: 'hosts' })}>맥 연결하는 방법</Button>}>
          세션은 맥에서 돌아요. 그 맥의 브라우저에 이 사이트가 열려 있어야 해요.
        </Empty>}
      </div>
    )

  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>새 세션</b>
          <span>{host ? `${host.name}에서 시작해요` : ''}</span>
        </div>
      </div>
      <div className="scroll">
        <div className="page">
          {online.length > 1 ? (
            <Field label="기기">
              <div className="hstack">
                {online.map((h) => (
                  <Button key={h.id} tone={h.id === host?.id ? 'soft' : 'plain'} icon={hostIcon(h.kind)} onClick={() => (setHostId(h.id), setPref('newHost', h.id))}>
                    {h.name} <span className="muted" style={{ fontWeight: 400 }}>{KINDS[h.kind] ?? ''}</span>
                  </Button>
                ))}
              </div>
            </Field>
          ) : null}
          {tab === 'new' && accounts.length > 1 ? (
            <Field label="Claude 계정" hint="로그인이 필요한 계정은 설정 → Claude 계정에서 먼저 로그인해요">
              <div className="hstack" style={{ flexWrap: 'wrap' }}>
                {accounts.map((a) => (
                  <Button key={a.id} tone={a.id === account ? 'soft' : 'plain'} icon="user" disabled={a.loggedIn === false} onClick={() => setAccountPick(a.id)}>
                    {a.name}
                    {a.loggedIn === false ? <span className="muted" style={{ fontWeight: 400 }}> 로그인 필요</span> : null}
                  </Button>
                ))}
              </div>
            </Field>
          ) : null}
          <div style={{ marginBottom: 16 }}>
            <Segmented
              label="시작 방법"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'new', label: '새로 시작' },
                { value: 'adopt', label: '맥의 대화 이어 가기' },
              ]}
            />
          </div>
          {tab === 'adopt' && host ? <AdoptList hostId={host.id} /> : null}
          {tab === 'new' ? (
          <>
          {group ? (
            <div className="hstack" style={{ marginBottom: 12 }}>
              <Badge tone="violet">
                <Icon name="group" /> {group.name}
              </Badge>
              <span className="muted grow" style={{ fontSize: 'var(--fs-small)' }}>
                이 그룹에 넣어요
              </span>
              <Button size="sm" tone="ghost" onClick={() => setGroupId('')}>
                그룹 없이
              </Button>
            </div>
          ) : null}
          <Field label="폴더" hint={auto ? '새 폴더를 만들어 시작해요. 기본 폴더는 설정 → 새 세션에서 바꿔요' : '눌러서 들어가고, 이 폴더에서 시작해요. 없는 폴더를 적으면 만들지 물어요'}>
            <input className="input mono" value={folder} onChange={(e) => ((asked.current += 1), setAuto(false), setCwd(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && browse(cwd)} spellCheck={false} autoCapitalize="off" />
          </Field>
          <div className="folder-list" style={{ marginTop: -8, marginBottom: 16 }}>
            {auto ? (
              <div className="folder-item muted" style={{ flexWrap: 'wrap' }}>
                <Icon name="folder" /> <span className="grow">새 폴더예요</span>
                {recent ? (
                  <Button size="sm" tone="ghost" onClick={() => pick(recent)}>
                    최근: <span className="mono">{recent}</span>
                  </Button>
                ) : null}
                <Button size="sm" tone="ghost" onClick={() => pick(recent || '~')}>
                  폴더 고르기
                </Button>
              </div>
            ) : dirsError ? (
              <div className="folder-item muted">
                <span className="grow">폴더를 읽지 못했어요 · {dirsError}</span>
                <Button size="sm" icon="refresh" onClick={() => void browse(cwd || '~')}>
                  다시 시도
                </Button>
              </div>
            ) : !dirs ? (
              <div className="folder-item">
                <Spinner size={14} />
              </div>
            ) : (
              <>
                {dirs.parent ? (
                  <button type="button" className="folder-item" onClick={() => browse(dirs.parent!)}>
                    <Icon name="back" /> ..
                  </button>
                ) : null}
                {dirs.dirs.length ? (
                  dirs.dirs.map((d) => (
                    <button key={d.name} type="button" className="folder-item" onClick={() => browse(`${dirs.path.replace(/\/$/, '')}/${d.name}`)}>
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
          <Field label="첫 메시지" hint="비워 두면 세션만 띄워요. 사진·영상은 붙여 넣거나 끌어 놓아도 돼요">
            <textarea
              className="input"
              {...NO_AUTOFILL}
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="무엇을 할까요?"
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && start()}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
                if (files.length) (e.preventDefault(), void addFiles(files))
              }}
              onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
              onDrop={(e) => {
                if (!e.dataTransfer.files.length) return
                e.preventDefault()
                void addFiles(e.dataTransfer.files)
              }}
            />
          </Field>
          <div className="hstack" style={{ flexWrap: 'wrap', alignItems: 'flex-start', marginTop: -8, marginBottom: 16 }}>
            <Button size="sm" tone="ghost" icon="image" disabled={busy} onClick={() => file.current?.click()}>
              사진·영상 붙이기
            </Button>
            <input ref={file} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (e.target.files && void addFiles(e.target.files), (e.target.value = ''))} />
            {attached ? (
              <div className="attach-row" style={{ paddingTop: 6 }}>
                {videos.map((v, i) => (
                  <span key={`v${i}`} className="attach attach-video">
                    <span className="attach-video-name">🎬 {v.file.name}</span>
                    <span className="muted">{v.pct === null ? `${(v.file.size / 1024 / 1024).toFixed(1)}MB` : `올리는 중 ${v.pct}%`}</span>
                    {busy ? null : (
                      <button type="button" aria-label="빼기" onClick={() => setVideos(videos.filter((_, j) => j !== i))}>
                        <Icon name="close" />
                      </button>
                    )}
                  </span>
                ))}
                {images.map((im, i) => (
                  <span key={i} className="attach">
                    <img src={im.data} alt={im.name} />
                    {busy ? null : (
                      <button type="button" aria-label="빼기" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                        <Icon name="close" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {more && opts ? (
            <>
              <Field label="모델">
                <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">이 맥의 기본값</option>
                  {opts.models.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="생각 수준 (effort)">
                <select className="input" value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">기본값</option>
                  {opts.efforts.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="Claude in Chrome" hint="켜 두면 이 세션이 맥의 Chrome(로그인된 사이트 포함)을 쓸 수 있어요. 여러 세션이 같은 Chrome 확장을 나눠 써요">
                <Switch label="Claude in Chrome 연동" checked={chrome} onChange={setChrome} />
              </Field>
              <Field label="권한 모드">
                <select className={`input${mode === 'allowAll' ? ' input-allow-all' : ''}`} value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="">기본값</option>
                  {opts.modes.map((m) => (
                    <option key={m.value} value={m.value} className={m.value === 'allowAll' ? 'opt-allow-all' : undefined}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <Button tone="ghost" size="sm" icon="settings" onClick={() => setMore(true)} style={{ marginBottom: 16 }}>
              모델 · effort · 권한 모드{chosen ? <span className="muted" style={{ fontWeight: 400 }}>{` — ${chosen}`}</span> : null}
            </Button>
          )}
          <Button tone="primary" size="lg" block busy={busy} onClick={() => start()}>
            시작
          </Button>
          </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
