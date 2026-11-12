// 스냅샷 조각 맞추기 (REQ-F-906, REQ-S-110, 1.526): the pieces of one snapshot request put back together and checked
// as they come, apart from the requests themselves (lib/snap-stream) so that tests run it as it is.

/** One drawing as it came, or as much of it as came (`complete` false: the start of its HTML, no pictures yet). */
export interface SnapDraw {
  gen: 0 | 1
  complete: boolean
  url: string
  asked: string
  width: number
  via: string
  /** When the Mac drew it (ms), for 저장된 화면 · n분 전. */
  at: number
  big: Record<string, unknown>
  css: Record<string, string>
  html: string
  images: Record<string, string>
  /** Whether it came sealed (pictures are then never fetched through the server). */
  sealed: boolean
}

export const BROKEN = '내용이 깨졌어요'
const PIECES_MAX = 240

type Piece = { kind: 'snappart'; sid: string; rid: string; gen: 0 | 1; n: number; of: number; hash?: string; body: string }

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

/** The head line of a payload and as much of its HTML as is there, or null before the head line is whole. */
function readPayload(text: string, complete: boolean): Omit<SnapDraw, 'gen' | 'complete' | 'sealed'> | null {
  const i = text.indexOf('\n')
  if (i < 0) return null
  let head: Record<string, unknown>
  try {
    head = JSON.parse(text.slice(0, i))
  } catch {
    throw new Error(`${BROKEN} (머리 줄)`)
  }
  const hl = head.hl
  if (!Number.isInteger(hl) || (hl as number) < 0) throw new Error(`${BROKEN} (길이)`)
  const html = text.slice(i + 1, i + 1 + (hl as number))
  let images: Record<string, string> = {}
  if (complete) {
    if (text[i + 1 + (hl as number)] !== '\n') throw new Error(`${BROKEN} (본문 끝)`)
    try {
      const v = JSON.parse(text.slice(i + 2 + (hl as number)))
      if (v && typeof v === 'object' && !Array.isArray(v)) images = v
    } catch {
      throw new Error(`${BROKEN} (그림)`)
    }
  }
  const obj = <T,>(v: unknown, d: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : d)
  return {
    url: typeof head.url === 'string' ? head.url : '',
    asked: typeof head.asked === 'string' ? head.asked : '',
    width: typeof head.width === 'number' ? head.width : 0,
    via: typeof head.via === 'string' ? head.via.slice(0, 20) : '',
    at: typeof head.at === 'number' ? head.at : 0,
    big: obj(head.big, {}),
    css: obj(head.css, {}),
    html,
    images,
  }
}

/**
 * The pieces of one request put back together, checked as they come. add(text) takes a piece as opened (its JSON)
 * and returns the drawing it makes: the first time a drawing can be drawn (its head line is whole), and again when it
 * is complete and its hash holds. Throws BROKEN on anything out of place.
 */
export class SnapAssembler {
  private gen = -1
  private of = 0
  private got = 0
  private parts: string[] = []
  private shown = false
  readonly done: Set<number> = new Set()
  private sid: string
  private rid: string
  private sealed: boolean
  constructor(sid: string, rid: string, sealed: boolean) {
    this.sid = sid
    this.rid = rid
    this.sealed = sealed
  }
  async add(text: string): Promise<SnapDraw | null> {
    let q: Piece
    try {
      q = JSON.parse(text)
    } catch {
      throw new Error(`${BROKEN} (조각을 읽지 못함)`)
    }
    if (!q || q.kind !== 'snappart' || q.sid !== this.sid || q.rid !== this.rid) throw new Error(`${BROKEN} (다른 요청의 조각)`)
    if ((q.gen !== 0 && q.gen !== 1) || !Number.isInteger(q.n) || !Number.isInteger(q.of) || q.of < 1 || q.of > PIECES_MAX || typeof q.body !== 'string') throw new Error(`${BROKEN} (조각 모양)`)
    if (q.gen !== this.gen) {
      // A new drawing: only after the one before it is whole, and never back to an earlier one.
      if (q.gen < this.gen || (this.gen >= 0 && !this.done.has(this.gen))) throw new Error(`${BROKEN} (조각이 빠짐)`)
      Object.assign(this, { gen: q.gen, of: q.of, got: 0, parts: [], shown: false })
    }
    if (q.n !== this.got || q.of !== this.of) throw new Error(`${BROKEN} (조각 순서: ${q.n}번, 기다린 것 ${this.got}번)`)
    this.parts.push(q.body)
    this.got++
    const last = this.got === this.of
    // Joined only when it is read: at the end, and until the drawing has been shown once (a join per piece of a big
    // page would copy it over and over).
    if (!last && this.shown) return null
    const whole = this.parts.join('')
    if (last) {
      if (typeof q.hash !== 'string') throw new Error(`${BROKEN} (전체 해시 없음)`)
      const h = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(whole)))
      if (h !== q.hash) throw new Error(`${BROKEN} (전체 해시가 다름)`)
      this.done.add(q.gen)
      this.parts = []
      const p = readPayload(whole, true)
      if (!p) throw new Error(`${BROKEN} (머리 줄 없음)`)
      return { ...p, gen: q.gen, complete: true, sealed: this.sealed }
    }
    const p = readPayload(whole, false)
    if (!p) return null
    this.shown = true
    return { ...p, gen: q.gen, complete: false, sealed: this.sealed }
  }
}
