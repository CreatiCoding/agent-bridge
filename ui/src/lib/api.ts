// Requests to the bridge server. Every change is JSON from this origin (the server refuses anything else).
// A failure is an Error whose message is the server's own sentence, ready to show.
import { sessionOfPath, setToken, tokenOf } from './locks'
import { authHeader, openDeep, sealBody } from './trust'

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, raw = false): Promise<T> {
  let res: Response
  const sid = sessionOfPath(path)
  const token = sid ? tokenOf(sid) : null
  // Words for a Mac that seals are sealed before they are signed: the signature names the sealed text (REQ-S-095).
  if (body !== undefined) body = await sealBody(method, path, body).catch(() => body)
  // A request that makes a paired Mac act carries this device's signature (REQ-S-091).
  const auth = method === 'GET' ? null : await authHeader(method, path, body).catch(() => null)
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Lock': token } : {}), ...(auth ? { 'X-Bridge-Auth': auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, '서버에 닿지 못했어요. 연결을 확인해 주세요')
  }
  if (res.status === 401) {
    location.reload()
    throw new ApiError(401, '로그인이 필요해요')
  }
  const type = res.headers.get('content-type') ?? ''
  // A JSON answer that cannot be read (cut off on a weak link) is a failure, not an empty answer:
  // an empty object here reached callers as missing fields (REQ-F-859).
  const unread = Symbol()
  const rawBody = type.includes('application/json') ? await res.json().catch(() => unread) : {}
  if (rawBody === unread) throw new ApiError(res.ok ? 0 : res.status, '서버 답을 다 받지 못했어요. 다시 시도해 주세요')
  // A sealing Mac's words come back as pieces: opened here for every caller (REQ-S-095).
  // A caller that must tell a sealed piece from plain text (getSealed) opens what it needs itself.
  const data = !raw && JSON.stringify(rawBody).includes('⟦bt') ? await openDeep(rawBody).catch(() => rawBody) : rawBody
  // Some routes answer 200 with ok:false and a note (the ones the vendored page used); treat both alike.
  // A lock token that no longer works (the server restarted, or the lock changed) is dropped: the page asks again.
  if (res.status === 423 && sid && token) setToken(sid, null)
  if (!res.ok || data?.ok === false) {
    const message = String(data?.error ?? data?.note ?? `요청이 실패했어요 (${res.status})`)
    throw new ApiError(res.ok ? 400 : res.status, message, data)
  }
  return data as T
}

export const get = <T>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal)
/** A GET whose sealed pieces are left as they came (the caller checks they are sealed, then opens them). */
export const getSealed = <T>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal, true)
export const post = <T = { ok: true; note?: string }>(path: string, body: unknown = {}) => call<T>('POST', path, body)
export const del = <T = { ok: true }>(path: string) => call<T>('DELETE', path)

/**
 * A picture (or any file) from a route, as a Blob, through the same door as every other request: this origin's
 * cookie, the session's lock token, the login check. An <img src> sends none of the headers, so behind a proxy that
 * wants one, or on a locked session, the browser drew nothing (REQ-F-890). `fresh` skips the browser's cache (a retry).
 */
export async function getBlob(path: string, fresh = false, signal?: AbortSignal): Promise<Blob> {
  const sid = sessionOfPath(path)
  const token = sid ? tokenOf(sid) : null
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: fresh ? 'reload' : 'default', headers: token ? { 'X-Lock': token } : {}, signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, '서버에 닿지 못했어요. 연결을 확인해 주세요')
  }
  if (res.status === 401) {
    location.reload()
    throw new ApiError(401, '로그인이 필요해요')
  }
  if (res.status === 423 && sid && token) setToken(sid, null)
  if (!res.ok) {
    // Only the failure's sentence is read; an answer cut off leaves the plain one.
    const data: Record<string, unknown> | null = (res.headers.get('content-type') ?? '').includes('application/json') ? await res.json().catch(() => null) : null
    throw new ApiError(res.status, String(data?.error ?? `요청이 실패했어요 (${res.status})`), data ?? {})
  }
  return res.blob()
}

export const errorText =(e: unknown) => (e instanceof Error ? e.message : String(e))
