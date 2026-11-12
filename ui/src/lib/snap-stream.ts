// 스냅샷 조각 받기 (REQ-F-906, REQ-S-110, 1.526): a snapshot asked for in pieces. The Mac sends the drawing it kept
// on its disk (gen 0) and then the one drawn now (gen 1), each as pieces of about 128 K characters, each sealed on its own for
// this device when it is paired with that Mac; the server only passes them on (GET …/snapshot/<reqId>?from=n). Every
// piece must be of this session, of this very request (rid, made here), of the drawing under way, in order; the last
// one of a drawing carries the SHA-256 of the whole. Anything else and the whole request is thrown away.
import { ApiError, getSealed, post } from './api'
import { b64u, findText, loadTrust, openFromHost, pairedWith, sealUrlFor } from './trust'
import { BROKEN, SnapAssembler, type SnapDraw } from './snap-pieces'

export type { SnapDraw }

/** What snapshotStream ends with: the drawings came (`fresh`: the one drawn now too), or the Mac's own failure. */
export type SnapEnd = { kind: 'stream'; fresh: boolean; error?: string } | { kind: 'whole'; answer: Record<string, unknown>; paired: boolean }
/** A sealed address longer than this would not fit in a signature the server keeps (server AUTH_TOKEN_MAX). */
const SEALED_URL_MAX = 3600

/**
 * Asks the session's Mac for a snapshot of url in pieces and hands each drawing to onDraw as it comes. A server or an
 * agent before 1.526 answers whole: that answer comes back as `whole` for the caller to read as before.
 */
export async function snapshotStream(sid: string, hostId: string | null, url: string, onDraw: (d: SnapDraw) => void, signal?: AbortSignal): Promise<SnapEnd> {
  await loadTrust().catch(() => {})
  const paired = !!hostId && pairedWith(hostId)
  const rid = b64u(crypto.getRandomValues(new Uint8Array(16)))
  const ask = (u: string) => post<Record<string, unknown>>(`/api/sessions/${sid}/snapshot`, { url: u, parts: true, rid })
  let p: Record<string, unknown>
  // A paired Mac gets the address sealed, and never plain: a server could say anything (a 409, a broken piece) to get
  // it plain, so nothing here falls back to sending it plain (REQ-S-110).
  const sealedUrl = paired && hostId ? await sealUrlFor(hostId, sid, url) : url
  if (paired && sealedUrl.length > SEALED_URL_MAX) throw new Error('주소가 너무 길어 봉인해 보낼 수 없어요. 브라우저로 열어 주세요')
  try {
    p = await ask(sealedUrl)
  } catch (e) {
    if (paired && e instanceof ApiError && e.data?.code === 'snap-old') throw new Error('그 맥의 에이전트가 1.526 전이라 봉인한 주소를 열지 못해요. 에이전트가 업데이트된 뒤 다시 열어 주세요')
    throw e
  }
  const stream = typeof p.stream === 'string' && /^[0-9a-f-]{36}$/.test(p.stream) ? p.stream : null
  if (!stream) return { kind: 'whole', answer: p, paired }
  const asm = new SnapAssembler(sid, rid, paired)
  let from = 0
  for (;;) {
    if (signal?.aborted) throw new DOMException('그만둠', 'AbortError')
    const r = await getSealed<{ from: number; parts: unknown[]; done?: boolean; end?: { ok?: boolean; error?: unknown } }>(`/api/sessions/${sid}/snapshot/${stream}?from=${from}`, signal)
    if (r.from !== from || !Array.isArray(r.parts)) throw new Error(`${BROKEN} (조각 번호)`)
    for (const part of r.parts) {
      let text: string | null = null
      if (paired) {
        // A paired Mac's pieces are sealed, each opened with that Mac's key, for this session, from the Mac ('m').
        const o = hostId ? await openFromHost(hostId, part) : null
        if (o && o.d === 'm' && o.s === sid && typeof o.v === 'string') text = o.v
        if (text === null) throw new Error(typeof part === 'string' ? `${BROKEN} (봉인을 풀지 못함)` : `${BROKEN} (봉인되지 않은 조각)`)
      } else {
        const plain = part && typeof part === 'object' ? (part as { plain?: unknown }).plain : undefined
        if (typeof plain !== 'string') throw new Error(typeof part === 'string' ? '이 기기에서는 풀 수 없는 스냅샷이에요: 이 기기에 그 맥의 열쇠가 없어요' : `${BROKEN} (조각 모양)`)
        text = plain
      }
      const d = await asm.add(text)
      // A drawing of another address (a signature of an earlier click sent along with this request) is not this page.
      if (d && d.asked !== url) throw new Error(`${BROKEN} (다른 주소의 그림)`)
      if (d) onDraw(d)
    }
    from += r.parts.length
    if (r.done) {
      const ok = r.end?.ok === true
      if (ok && !asm.done.has(1)) throw new Error(`${BROKEN} (조각이 모자람)`)
      if (ok) return { kind: 'stream', fresh: true }
      const why = (hostId ? await findText(hostId, r.end?.error) : typeof r.end?.error === 'string' ? r.end.error : undefined) ?? '맥에서 페이지를 그리지 못했어요'
      return { kind: 'stream', fresh: false, error: why }
    }
  }
}
