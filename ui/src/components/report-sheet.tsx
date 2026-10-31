// 제보: a small chat with the service desk. The person writes what went wrong and adds pictures and videos; the page sends
// its own account of itself (debug.ts) with it, and the server adds the Macs' state and logs (REQ-F-735).
import { Fragment, useRef, useState } from 'react'
import { del, errorText, get, post } from '../lib/api'
import { clientDebug } from '../lib/debug'
import { ago } from '../lib/format'
import { shrinkImage } from '../lib/image'
import { uploadVideo, VIDEO_MAX, VIDEO_TYPES, type SentVideo } from '../lib/video'
import { Badge, Button, Icon, IconButton, LoadError, Spinner } from '../kit'
import { confirmDialog, Sheet, toast } from '../kit/overlay'
import { linkClick } from '../lib/builtin-actions'

/** Opens the report sheet from anywhere (the app rail, the phone's menu). */
export const openReport = () => dispatchEvent(new Event('cb-report'))

type Said = { text: string; images: string[]; videos: string[] }
/** One of the person's earlier reports (REQ-F-739). */
type Past = { id: string; at: number; text: string; images: string[]; videos?: SentVideo[]; status: 'new' | 'fixing' }
const MAX_IMAGES = 8
const MAX_VIDEOS = 3

export function ReportSheet({ open, onClose, sid }: { open: boolean; onClose: () => void; sid: string | null }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<{ data: string; name: string }[]>([])
  // Videos go up as they are when the report is sent; pct is how far that has got.
  const [videos, setVideos] = useState<{ file: File; pct: number | null }[]>([])
  const [sent, setSent] = useState<Said[]>([])
  const [busy, setBusy] = useState(false)
  const [peek, setPeek] = useState(false)
  const [past, setPast] = useState<Past[] | null | undefined>(undefined)
  const [history, setHistory] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  // Each opening is a new report: what was sent the last time the sheet was open is in 지난 제보 now. Reset while
  // rendering the opening, not in an effect, so the last report's bubbles never show for a frame.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setSent([])
      setText('')
      setImages([])
      setVideos([])
      setPeek(false)
      setHistory(false)
      setPast(undefined)
    }
  }
  const loadPast = () => (setPast(undefined), get<{ reports: Past[] }>('/api/reports').then((x) => setPast(x.reports), () => setPast(null)))
  const showHistory = () => (setHistory(true), void loadPast())
  const remove = async (r: Past) => {
    if (!(await confirmDialog('이 제보를 지울까요?', { text: '목록에서 사라지고 되돌릴 수 없어요.', ok: '지우기', danger: true }))) return
    try {
      await del(`/api/reports/${r.id}`)
      setPast((list) => list?.filter((x) => x.id !== r.id))
      toast('제보를 지웠어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }

  const add = async (files: FileList | File[]) => {
    const vids = [...files].filter((f) => f.type.startsWith('video/'))
    if (vids.length) {
      const ok = vids.filter((f) => VIDEO_TYPES.includes(f.type) && f.size <= VIDEO_MAX)
      if (ok.length < vids.length) toast(`mp4·mov·webm 영상, ${VIDEO_MAX / 1024 / 1024}MB 까지 붙일 수 있어요`)
      if (videos.length + ok.length > MAX_VIDEOS) toast(`영상은 ${MAX_VIDEOS}개까지 붙일 수 있어요`)
      setVideos((now) => [...now, ...ok.map((file) => ({ file, pct: null }))].slice(0, MAX_VIDEOS))
    }
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    if (images.length + list.length > MAX_IMAGES) toast(`그림은 ${MAX_IMAGES}장까지 붙일 수 있어요`)
    const made = await Promise.all(list.slice(0, MAX_IMAGES - images.length).map((f) => shrinkImage(f).catch(() => null)))
    setImages((now) => [...now, ...made.filter((x): x is { data: string; name: string } => !!x)].slice(0, MAX_IMAGES))
  }
  const empty = !text.trim() && !images.length && !videos.length
  const submit = async () => {
    if (empty || busy) return
    setBusy(true)
    try {
      // The videos first, one by one with how far each has got; the report names them once all are up.
      const up: SentVideo[] = []
      for (const [i, v] of videos.entries()) up.push(await uploadVideo('/api/reports/upload', v.file, (pct) => setVideos((now) => now.map((x, j) => (j === i ? { ...x, pct } : x)))))
      await post('/api/reports', { text: text.trim(), images, videos: up.map((v) => ({ id: v.id })), sid, client: clientDebug(sid) })
      setSent((s) => [...s, { text: text.trim(), images: images.map((i) => i.data), videos: up.map((v) => v.name) }])
      setText('')
      setImages([])
      setVideos([])
      toast('제보되었습니다', { tone: 'ok' })
    } catch (e) {
      setVideos((now) => now.map((x) => ({ ...x, pct: null })))
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={history ? '지난 제보' : '문제 제보'}
      className="report-sheet"
      footer={
        history ? (
          <Button onClick={() => setHistory(false)}>새 제보 쓰기</Button>
        ) : (
        <div
          className="report-input"
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={(e) => e.dataTransfer.files.length && (e.preventDefault(), void add(e.dataTransfer.files))}
        >
          {images.length || videos.length ? (
            <div className="attach-row">
              {videos.map((v, i) => (
                <span key={`v${i}`} className="attach attach-video">
                  <span className="attach-video-name"><Icon name="play" className="inline-icon" />{v.file.name}</span>
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
                  <button type="button" aria-label="빼기" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                    <Icon name="close" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="report-row">
            <IconButton icon="image" label="사진·영상 붙이기" onClick={() => file.current?.click()} />
            <textarea
              className="input"
              rows={2}
              value={text}
              placeholder="무엇이 이상했나요?"
              aria-label="제보 내용"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const pics = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
                if (pics.length) (e.preventDefault(), void add(pics))
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void submit())}
            />
            <Button tone="primary" busy={busy} disabled={empty} onClick={() => void submit()}>
              제출
            </Button>
          </div>
          <input ref={file} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (e.target.files && void add(e.target.files), (e.target.value = ''))} />
        </div>
        )
      }
    >
      {history ? (
        <PastList list={past} onRetry={() => void loadPast()} onRemove={(r) => void remove(r)} />
      ) : (
      <div className="report-chat">
        <div className="report-msg desk">
          <Icon name="support" />
          <p>무엇이 이상했나요? 화면을 찍은 사진이나 영상과 함께 알려 주시면 살펴보고 고칠게요.</p>
        </div>
        {sent.map((s, i) => (
          <Fragment key={i}>
            <div className="report-msg me">
              {s.images.length ? (
                <span className="report-pics">
                  {s.images.map((src, j) => (
                    <img key={j} src={src} alt="" />
                  ))}
                </span>
              ) : null}
              {s.videos.map((name, j) => (
                <p key={`v${j}`}>🎬 {name}</p>
              ))}
              {s.text ? <p>{s.text}</p> : null}
            </div>
            <div className="report-msg desk">
              <Icon name="check" />
              <p>제보되었습니다. 고마워요!</p>
            </div>
          </Fragment>
        ))}
        <p className="report-keep">
          <Icon name="clock" />
          <span>제보 글·그림·영상·진단 정보는 처리를 위해 90일 동안 보관하고 자동으로 지워요. 계정을 지워도 그 기간 동안 남아요.</span>
        </p>
        <button type="button" className="report-peek" aria-expanded={peek} onClick={() => setPeek(!peek)}>
          <Icon name="info" />
          <span className="grow">기기·브라우저 정보, 보던 세션, 맥 상태와 최근 로그를 함께 보내요</span>
          <Icon name="forward" className={`chev${peek ? ' chev-open' : ''}`} />
        </button>
        {peek ? <pre className="report-debug">{JSON.stringify(clientDebug(sid), null, 2)}</pre> : null}
        <button type="button" className="report-peek" onClick={showHistory}>
          <Icon name="clock" />
          <span className="grow">지난 제보 보기</span>
          <Icon name="forward" className="chev" />
        </button>
      </div>
      )}
    </Sheet>
  )
}

/** 지난 제보: the person's own reports, newest first, each with its words, pictures, videos and a remove button. */
function PastList({ list, onRetry, onRemove }: { list: Past[] | null | undefined; onRetry: () => void; onRemove: (r: Past) => void }) {
  if (list === undefined) return <Spinner />
  if (!list) return <LoadError what="지난 제보를" onRetry={onRetry} />
  if (!list.length) return <p className="muted report-none">아직 보낸 제보가 없어요.</p>
  return (
    <div className="report-past">
      {list.map((r) => (
        <div key={r.id} className="report-past-item">
          <div className="report-past-head">
            <Badge tone={r.status === 'new' ? 'amber' : 'blue'}>{r.status === 'new' ? '접수됨' : '고치는 중'}</Badge>
            <span className="grow muted">{ago(r.at)}</span>
            <IconButton icon="trash" label="이 제보 지우기" onClick={() => onRemove(r)} />
          </div>
          {r.text ? <p className="report-text">{r.text}</p> : null}
          {r.images.length ? (
            <span className="report-pics">
              {r.images.map((name) => (
                <a key={name} href={`/api/reports/${r.id}/img/${name}`} target="_blank" rel="noreferrer" onClick={linkClick(`/api/reports/${r.id}/img/${name}`, 'report')}>
                  <img src={`/api/reports/${r.id}/img/${name}`} alt="" />
                </a>
              ))}
            </span>
          ) : null}
          {r.videos?.length ? (
            <span className="report-videos">
              {r.videos.map((v) => (
                <video key={v.id} src={`/api/reports/${r.id}/video/${v.id}`} controls preload="metadata" aria-label={v.name} />
              ))}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
