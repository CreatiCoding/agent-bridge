// 디스크 관리 (REQ-F-801): how full the host's disk is, the caches that can be cleared (each is made again by its own
// tool), and its home folder by size, where an item can be moved to the Trash. The agent decides what each action may
// touch; this page only names a cache id or a path inside the home folder. The host's owner only.
import { useState } from 'react'
import { errorText, post } from '../lib/api'
import { bytes, type SysUse } from '../lib/format'
import { Button, CardHead, Icon, IconButton, Row, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'

interface Cache {
  id: string
  title: string
  where: string[]
  size: number | null
  irreversible: boolean
}
interface Info {
  disk: { total: number; used: number; avail: number; pct: number } | null
  caches: Cache[]
  trash: string
}
interface Item {
  name: string
  path: string
  kind: 'dir' | 'file' | 'link'
  size: number | null
  trashable: boolean
  why?: string
  guarded?: boolean
  partial?: boolean
}
interface Scan {
  path: string
  parent: string | null
  count: number
  items: Item[]
}

const disk = (hostId: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/api/hosts/${hostId}/disk`, body)

/** A thin bar for a share of something, 0–100. */
function Bar({ pct, tone }: { pct: number; tone?: 'amber' | 'red' }) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'amber' ? 'var(--amber)' : 'var(--accent)'
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }} aria-hidden>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: color }} />
    </div>
  )
}

export function DiskBox({ hostId, online, sys }: { hostId: string; online: boolean; sys?: SysUse | null }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const raw = info?.disk ?? sys?.disk ?? null
  const d = raw && raw.pct != null && raw.total != null ? { pct: raw.pct, total: raw.total, avail: raw.avail ?? 0 } : null

  async function load() {
    setBusy('info')
    try {
      setInfo((await disk(hostId, { op: 'info' })) as unknown as Info)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  async function open(path: string) {
    setBusy(`scan:${path}`)
    try {
      setScan((await disk(hostId, { op: 'scan', path })) as unknown as Scan)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  async function clean(c: Cache) {
    const ok = await confirmDialog(`${c.title}${c.size ? ` ${bytes(c.size)}` : ''} 를 비울까요?`, {
      text: c.irreversible ? '휴지통에 있는 것은 되살릴 수 없게 지워져요.' : `${c.where.join(', ')} 안을 비워요. 다음에 쓸 때 그 도구가 다시 내려받아요.`,
      ok: '비우기',
      danger: true,
    })
    if (!ok) return
    setBusy(`clean:${c.id}`)
    try {
      const r = (await disk(hostId, { op: 'clean', id: c.id })) as { freed?: number; size?: number }
      toast(`${c.title}: ${bytes(r.freed ?? 0)} 비웠어요`)
      setInfo((i) => (i ? { ...i, caches: i.caches.map((x) => (x.id === c.id ? { ...x, size: r.size ?? 0 } : x)) } : i))
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  async function trash(it: Item) {
    const ok = await confirmDialog(`${it.name} 을 휴지통으로 옮길까요?`, {
      text: `${it.path}${it.size != null ? ` · ${bytes(it.size)}` : ''}. 휴지통에서 되살릴 수 있어요. 공간은 휴지통을 비워야 늘어요.`,
      ok: '휴지통으로',
      danger: true,
    })
    if (!ok) return
    setBusy(`trash:${it.path}`)
    try {
      await disk(hostId, { op: 'trash', path: it.path })
      toast('휴지통으로 옮겼어요 · 위의 "휴지통" 을 비우면 공간이 늘어요')
      setScan((s) => (s ? { ...s, items: s.items.filter((x) => x.path !== it.path) } : s))
      setInfo(null)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }

  const top = Math.max(1, ...(scan?.items ?? []).map((x) => x.size ?? 0))
  const cacheTotal = (info?.caches ?? []).filter((c) => !c.irreversible).reduce((a, c) => a + (c.size ?? 0), 0)
  return (
    <section className="card-box">
      <CardHead title="디스크 관리" help="비워도 다시 만들어지는 캐시를 비우고, 홈 폴더에서 큰 것을 찾아 휴지통으로 옮겨요. 휴지통으로 옮긴 것은 되살릴 수 있고, 휴지통을 비워야 공간이 늘어요." />
      {d ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <b>{Math.round(d.pct)}% 사용</b>
            <span className="muted">
              {bytes(d.avail)} 남음 / {bytes(d.total)}
            </span>
          </div>
          <Bar pct={d.pct} tone={d.pct >= 95 ? 'red' : d.pct >= 85 ? 'amber' : undefined} />
        </div>
      ) : null}
      {!online ? (
        <p className="muted" style={{ fontSize: 'var(--fs-small)', margin: 0 }}>
          기기가 연결돼 있을 때 쓸 수 있어요.
        </p>
      ) : !info ? (
        <Button icon="search" busy={busy === 'info'} disabled={!!busy} onClick={load}>
          {busy === 'info' ? '크기를 재는 중(1분쯤)' : '비울 수 있는 공간 보기'}
        </Button>
      ) : (
        <>
          <h3 style={{ margin: '8px 0 0', fontSize: 'var(--fs-medium)' }}>캐시{cacheTotal ? ` · ${bytes(cacheTotal)}` : ''}</h3>
          {info.caches.length ? (
            info.caches.map((c) => (
              <Row
                key={c.id}
                left={<Icon name={c.irreversible ? 'trash' : 'folder'} />}
                title={c.title}
                sub={`${c.size == null ? '크기를 읽지 못함' : bytes(c.size)} · ${c.where.join(', ')}`}
                right={
                  <Button size="sm" tone="danger" busy={busy === `clean:${c.id}`} disabled={!!busy || !c.size} onClick={() => clean(c)}>
                    비우기
                  </Button>
                }
              />
            ))
          ) : (
            <p className="muted" style={{ margin: 0 }}>비울 캐시가 없어요.</p>
          )}
          <div className="hstack" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--fs-medium)' }}>큰 폴더</h3>
            {!scan ? (
              <Button size="sm" icon="folder" busy={busy === 'scan:~'} disabled={!!busy} onClick={() => open('~')}>
                홈 폴더 열기
              </Button>
            ) : null}
          </div>
          {scan ? (
            <>
              <div className="hstack" style={{ gap: 6 }}>
                {scan.parent ? <IconButton icon="up" label="위 폴더로" disabled={!!busy} onClick={() => open(scan.parent!)} /> : null}
                <code style={{ fontSize: 'var(--fs-small)', wordBreak: 'break-all' }}>{scan.path}</code>
                {busy?.startsWith('scan:') ? <Spinner /> : null}
              </div>
              {scan.items.map((it) => (
                <Row
                  key={it.path}
                  left={<Icon name={it.kind === 'dir' ? 'folder' : it.kind === 'link' ? 'link' : 'doc'} />}
                  title={it.name}
                  sub={
                    <span className="stack" style={{ gap: 4 }}>
                      <span>
                        {it.guarded ? 'macOS 가 지키는 폴더 · 재지 않음' : it.partial ? '안에 보호 폴더가 있어 열어서 봐요' : it.size == null ? '크기를 읽지 못함' : bytes(it.size)}
                        {!it.trashable && it.why && !it.guarded ? ` · ${it.why}` : ''}
                      </span>
                      {it.size ? <Bar pct={(100 * it.size) / top} /> : null}
                    </span>
                  }
                  onClick={it.kind === 'dir' && !it.guarded && !busy ? () => open(it.path) : undefined}
                  right={it.trashable ? <IconButton icon="trash" label={`${it.name} 휴지통으로`} disabled={!!busy} onClick={(e) => (e.stopPropagation(), trash(it))} /> : null}
                />
              ))}
              {scan.count > scan.items.length ? <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>큰 것부터 {scan.items.length}개만 보여요(모두 {scan.count}개).</p> : null}
            </>
          ) : null}
        </>
      )}
    </section>
  )
}
