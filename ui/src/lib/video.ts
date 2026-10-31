// Videos and other files sent as they are, before the message or report that names them (REQ-F-761, REQ-F-735, REQ-F-830).
import { toast } from '../kit/overlay'

/** A video or file sent before its message: the server's id and the name it kept. */
export type SentVideo = { id: string; name: string }
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
/** One upload, video or file (REQ-F-830). */
export const UPLOAD_MAX = 512 * 1024 * 1024
export const VIDEO_MAX = UPLOAD_MAX
/** Videos and files together, in one message. */
export const UPLOADS = 3
export const isVideo = (f: { type: string }) => VIDEO_TYPES.includes(f.type)

/**
 * What of the dropped or picked files goes up as it is (REQ-F-830): everything but pictures, which are shrunk
 * and ride in the message. Too big or empty ones are left, saying so; `have` are the ones already attached.
 */
export function uploadable(files: File[], have: number): File[] {
  const all = files.filter((f) => !f.type.startsWith('image/'))
  const ok = all.filter((f) => f.size > 0 && f.size <= UPLOAD_MAX)
  if (ok.length < all.length) toast(`파일은 하나에 ${UPLOAD_MAX / 1024 / 1024}MB 까지 보낼 수 있어요`)
  if (have + ok.length > UPLOADS) toast(`영상·파일은 한 번에 ${UPLOADS}개까지 보낼 수 있어요`)
  return ok
}

/**
 * One video or file up to the server (`url`) as it is, saying how far it has got (fetch cannot). A video goes
 * with its own type; any other file as application/octet-stream, a type no form on another site can send.
 */
export function uploadVideo(url: string, file: File, onPct: (pct: number) => void): Promise<SentVideo> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', `${url}?${new URLSearchParams({ name: file.name })}`)
    x.setRequestHeader('Content-Type', isVideo(file) ? file.type : 'application/octet-stream')
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.floor((e.loaded / e.total) * 100))
    x.onload = () => {
      let j: { ok?: boolean; id?: string; name?: string; error?: string } = {}
      try {
        j = JSON.parse(x.responseText)
      } catch {}
      if (x.status === 200 && j.id) resolve({ id: j.id, name: j.name ?? file.name })
      else reject(new Error(j.error || `HTTP ${x.status}`))
    }
    x.onerror = () => reject(new Error('연결이 끊겼어요'))
    x.send(file)
  })
}
