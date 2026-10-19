// Where a Slack session starts, set with buttons: a folder for each Mac (picked by browsing that Mac's folders, or a
// new one, made when the session starts) and the Mac to use first. Kept in the plugin's `places` value as JSON.
import { useEffect, useRef, useState } from 'react'
import { errorText, get } from '../lib/api'
import { hostIcon } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import { Badge, Button, Icon, Spinner } from '../kit'
import { promptDialog } from '../kit/overlay'

export interface Places {
  main?: string
  dirs?: Record<string, string>
}

export const parsePlaces = (v: string): Places => {
  try {
    const p = JSON.parse(v || '{}')
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

interface Dirs {
  path: string
  parent?: string | null
  dirs: { name: string; git: boolean }[]
}

/** One Mac's folders, to walk into and pick from. */
function FolderBrowse({ hostId, from, onPick }: { hostId: string; from: string; onPick: (path: string) => void }) {
  const [dirs, setDirs] = useState<Dirs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(0)
  const browse = async (path: string) => {
    const n = ++asked.current
    setError(null)
    try {
      const r = await get<Dirs>(`/api/hosts/${hostId}/dirs?path=${encodeURIComponent(path)}`)
      if (n === asked.current) setDirs(r)
    } catch (e) {
      // A folder not made yet: start from home instead.
      if (n === asked.current) path !== '~' ? void browse('~') : setError(errorText(e))
    }
  }
  useEffect(() => {
    void browse(from || '~')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])
  const here = dirs?.path ?? ''
  return (
    <div className="folder-list places-browse">
      {error ? (
        <div className="folder-item muted">폴더를 읽지 못했어요 · {error}</div>
      ) : !dirs ? (
        <div className="folder-item">
          <Spinner size={14} />
        </div>
      ) : (
        <>
          <div className="places-here">
            <span className="mono grow">{here}</span>
            <Button
              size="sm"
              icon="plus"
              onClick={async () => {
                const name = (await promptDialog('새 폴더', { text: `${here} 안에 만들어요. 세션을 띄울 때 만들어져요.`, placeholder: '폴더 이름', ok: '이 폴더로' }))?.trim()
                if (name && !name.includes('/')) onPick(`${here.replace(/\/$/, '')}/${name}`)
              }}
            >
              새 폴더
            </Button>
            <Button size="sm" tone="primary" onClick={() => onPick(here)}>
              여기로
            </Button>
          </div>
          {dirs.parent ? (
            <button type="button" className="folder-item" onClick={() => browse(dirs.parent!)}>
              <Icon name="back" /> ..
            </button>
          ) : null}
          {dirs.dirs.length ? (
            dirs.dirs.map((d) => (
              <button key={d.name} type="button" className="folder-item" onClick={() => browse(`${here.replace(/\/$/, '')}/${d.name}`)}>
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
  )
}

/** The `places` field of the Slack plugin: a row for each Mac with 폴더 고르기 and 기본. */
export function SlackPlaces({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const [open, setOpen] = useState<string | null>(null)
  const p = parsePlaces(value)
  const set = (next: Places) => onChange(JSON.stringify(next))
  // With no Mac chosen, a session goes to the first connected one; shown so.
  const main = hosts.some((h) => h.id === p.main) ? p.main : undefined
  if (!hosts.length) return <p className="muted">연결한 맥이 없어요.</p>
  return (
    <div className="places">
      {hosts.map((h) => {
        const dir = p.dirs?.[h.id]
        return (
          <div key={h.id} className="places-row">
            <div className="places-head">
              <Icon name={hostIcon(h.kind)} />
              <div className="grow places-text">
                <b>
                  {h.name}
                  {!h.online ? <span className="muted"> · 꺼짐</span> : null}
                </b>
                <span className="muted places-dir">
                  <span className="mono">{dir || fallback || '~'}</span>
                  {dir ? null : ' · 기본 폴더'}
                </span>
              </div>
            </div>
            <div className="places-actions">
              <Button size="sm" tone={main === h.id ? 'soft' : 'plain'} icon={main === h.id ? 'check' : undefined} aria-pressed={main === h.id} aria-label={`${h.name} 를 기본 맥으로`} onClick={() => set({ ...p, main: main === h.id ? undefined : h.id })}>
                기본
              </Button>
              <Button size="sm" icon="folder" disabled={!h.online} aria-label={`${h.name} 폴더 고르기`} aria-expanded={open === h.id} onClick={() => setOpen(open === h.id ? null : h.id)}>
                폴더 고르기
              </Button>
              {dir ? (
                <Button size="sm" tone="ghost" icon="close" aria-label={`${h.name} 폴더 지우기`} onClick={() => set({ ...p, dirs: Object.fromEntries(Object.entries(p.dirs ?? {}).filter(([k]) => k !== h.id)) })} />
              ) : null}
            </div>
            {open === h.id ? (
              <FolderBrowse
                hostId={h.id}
                from={dir || fallback || '~'}
                onPick={(path) => {
                  set({ ...p, dirs: { ...(p.dirs ?? {}), [h.id]: path } })
                  setOpen(null)
                }}
              />
            ) : null}
          </div>
        )
      })}
      <p className="muted places-note">기본 맥이 켜져 있으면 거기에, 아니면 켜진 다른 맥에 띄워요. 폴더가 없으면 만들어요.</p>
    </div>
  )
}
