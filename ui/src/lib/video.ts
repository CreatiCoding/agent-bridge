// Videos sent as they are, before the message or report that names them (REQ-F-761, REQ-F-735).

/** A video sent before its message: the server's id and the name it kept. */
export type SentVideo = { id: string; name: string }
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
export const VIDEO_MAX = 500 * 1024 * 1024

/** One video up to the server (`url`) as it is, saying how far it has got (fetch cannot). */
export function uploadVideo(url: string, file: File, onPct: (pct: number) => void): Promise<SentVideo> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', `${url}?${new URLSearchParams({ name: file.name })}`)
    x.setRequestHeader('Content-Type', file.type)
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
