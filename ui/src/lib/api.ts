// Requests to the bridge server. Every change is JSON from this origin (the server refuses anything else).
// A failure is an Error whose message is the server's own sentence, ready to show.
import { sessionOfPath, setToken, tokenOf } from './locks'

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  const sid = sessionOfPath(path)
  const token = sid ? tokenOf(sid) : null
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Lock': token } : {}) },
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
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : {}
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
export const post = <T = { ok: true; note?: string }>(path: string, body: unknown = {}) => call<T>('POST', path, body)
export const del = <T = { ok: true }>(path: string) => call<T>('DELETE', path)

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
