// Pictures from the server's routes, fetched through getBlob and drawn from a blob: address (REQ-F-890).
// An img element pointed straight at a route skips the request headers every other call carries, so behind a proxy that wants one the
// picture never came. One address is fetched once and shared: a thumbnail and its zoomed view use the same blob,
// which is let go 30 s after the last one stops showing it.
import { type ImgHTMLAttributes, useEffect, useRef, useState } from 'react'
import { getBlob } from './api'

type Held = { src: string; url: Promise<string>; refs: number; timer?: ReturnType<typeof setTimeout> }
const held = new Map<string, Held>()
const RELEASE_MS = 30_000

/** Only this server's routes need the trip; data:, blob: and other addresses are drawn as they are. */
export const viaFetch = (src: string | null | undefined): src is string => !!src && src.startsWith('/api/')

function acquire(src: string, fresh: boolean): Held {
  let h = held.get(src)
  // A retry asks again even when a blob is held: the held one may be bytes that are not a picture (a sign-in page
  // a proxy answered with 200). Who still shows the old one keeps it until they let go.
  if (!h || fresh) {
    const e: Held = { src, url: getBlob(src, fresh).then((b) => URL.createObjectURL(b)), refs: 0 }
    // A failure is not kept: the next try asks again.
    e.url.catch(() => held.get(src) === e && held.delete(src))
    held.set(src, (h = e))
  }
  clearTimeout(h.timer)
  h.refs++
  return h
}

function release(h: Held) {
  if (--h.refs > 0) return
  h.timer = setTimeout(() => {
    if (h.refs > 0) return
    if (held.get(h.src) === h) held.delete(h.src)
    h.url.then(URL.revokeObjectURL, () => {})
  }, RELEASE_MS)
}

/** True once the element has come near the screen (600 px), like loading="lazy". */
function useNear<T extends Element>(on: boolean) {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(!on)
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === 'undefined') return void (near || setNear(true))
    const o = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '600px' })
    o.observe(ref.current)
    return () => o.disconnect()
  }, [near])
  return [ref, near] as const
}

/**
 * The address to draw `src` from: a blob: address for a server route once it came, the address itself otherwise.
 * `attempt` above 0 asks again past the browser's cache. `failed` is true when the route did not answer a picture.
 */
export function useImageSrc(src: string | null | undefined, attempt = 0, wait = false): { url: string | null; failed: boolean } {
  const fetchIt = viaFetch(src)
  const key = `${src}#${attempt}`
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({ key: '', url: null, failed: false })
  useEffect(() => {
    if (!fetchIt || wait) return
    let live = true
    const h = acquire(src, attempt > 0)
    h.url.then(
      (url) => live && setState({ key, url, failed: false }),
      () => live && setState({ key, url: null, failed: true }),
    )
    return () => {
      live = false
      release(h)
    }
  }, [fetchIt, src, attempt, wait, key])
  if (!fetchIt) return { url: src ?? null, failed: false }
  return state.key === key ? state : { url: null, failed: false }
}

type ApiImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & { src: string; attempt?: number; onError?: () => void }

/**
 * An <img> for a server route. While the picture is coming it holds its place (an empty img of the same class);
 * `loading="lazy"` waits until it is near the screen. `onError` fires when the route failed or the bytes are not a picture.
 */
export function ApiImg({ src, attempt = 0, onError, loading, ...rest }: ApiImgProps) {
  const [ref, near] = useNear<HTMLImageElement>(loading === 'lazy' && viaFetch(src))
  const { url, failed } = useImageSrc(src, attempt, !near)
  const told = useRef('')
  useEffect(() => {
    if (failed && told.current !== `${src}#${attempt}`) (told.current = `${src}#${attempt}`), onError?.()
  }, [failed, src, attempt, onError])
  return <img ref={ref} {...rest} src={url ?? undefined} data-loading={url ? undefined : ''} onError={() => onError?.()} />
}
