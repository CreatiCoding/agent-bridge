// 대화 모드 (REQ-F-907): the rules that need no model. Each one answers for sure when it can and says 'unsure'
// otherwise; only then is the Mac's model asked (a model call costs time, so the plain cases never wait for one).

export type Sure<T> = T | 'unsure'

/** Words that mean more is coming: fillers and joining words said on their own at the end. */
const MORE_WORDS = new Set(['음', '어', '으음', '그', '저', '저기', '아', '그리고', '근데', '그런데', '그래서', '그러니까', '그러면', '그럼', '또', '또는', '혹은', '아니면', '왜냐하면', '그리고요', '및', '예를', '만약'])
/** Endings that join a clause to the next one, or particles a sentence cannot stop on. Longest first. */
const MORE_ENDS = ['는데', '은데', '던데', '려고', '으려고', '다가', '지만', '거나', '든지', '면서', '도록', '으면', '해서', '에서', '으로', '한테', '께서', '이랑', '하고', '고', '서', '면', '며', '랑', '을', '를', '이', '가', '은', '는', '에', '로', '와', '과', '의', '도']
/** Endings a spoken sentence stops on. */
const DONE_ENDS = ['요', '다', '까', '죠', '줘', '줄래', '자', '래', '네', '지', '냐', '니', '해', '봐', '거든', '군', '구나', '세요', '시오', '라', '야', '임', '음', '함', '됨', 'ok', 'OK']
/** Endings that are either (니까 "because" or a question, 게 "so that" or "let it be", a lone 어/아). */
const BOTH_ENDS = ['니까', '게', '어', '아']

/** The last word, punctuation off (the Mac's tidying puts a full stop after every phrase, so a full stop says nothing). */
const lastWord = (t: string) => {
  const w = t.trim().replace(/[.,!…~\s"'”’)]+$/u, '').split(/\s+/)
  return w[w.length - 1] ?? ''
}

/**
 * Has the person finished what they wanted to say, judged from the words alone after a quiet while? 'done' sends,
 * 'more' waits longer, 'unsure' asks the model.
 */
export function turnEnd(text: string): Sure<'done' | 'more'> {
  const t = text.trim()
  if (!t) return 'more'
  if (/\?\s*$/.test(t)) return 'done'
  const w = lastWord(t)
  if (!w) return 'unsure'
  if (MORE_WORDS.has(w)) return 'more'
  if (!/[가-힣]$/.test(w)) return /^(ok|okay|yes|no|done|go)$/i.test(w) ? 'done' : 'unsure'
  for (const e of BOTH_ENDS) if (w.endsWith(e) && w.length > 1 && !DONE_ENDS.some((d) => d.length > e.length && w.endsWith(d))) return 'unsure'
  // The longest ending that fits decides ("해서" is more, "해" is done; "고요" is done, "고" is more).
  let best: { len: number; v: 'done' | 'more' } | null = null
  for (const e of DONE_ENDS) if (w.endsWith(e) && (!best || e.length > best.len)) best = { len: e.length, v: 'done' }
  for (const e of MORE_ENDS) if (w.endsWith(e) && (!best || e.length > best.len)) best = { len: e.length, v: 'more' }
  // A one-syllable word ending in a particle-like letter ("이", "가") is a word of its own, not a particle.
  if (best?.v === 'more' && w.length === best.len && w.length === 1) return 'unsure'
  return best?.v ?? 'unsure'
}

/** How long the quiet must be before the words are judged, and the longest wait for more. */
export const TURN = { quietMs: 1200, moreMs: 3000, afterMs: 6000 }


/**
 * The part of an answer worth reading aloud, as sentences: code blocks, tables, links' addresses, paths and marks
 * left out. 'unsure' when little speakable is left of a long answer, or what is left is mostly not Korean: then the
 * Mac's model says it in a line instead.
 */
export function speakable(md: string): Sure<string[]> {
  const out: string[] = []
  let fence = false
  let dropped = 0
  let total = 0
  for (const raw of md.split('\n')) {
    total += raw.trim().length
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence
      continue
    }
    if (fence || /^\s*\|/.test(raw) || /^\s*[-=*_]{3,}\s*$/.test(raw)) {
      dropped += raw.trim().length
      continue
    }
    let l = raw
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      // Inline code: a short word is read ("npm test" is said), anything longer or with a slash is left out.
      .replace(/`([^`]*)`/g, (_, c: string) => (c.length <= 16 && !/[/\\{}()<>=;]/.test(c) ? c : ''))
      .replace(/(?<![\w/])(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+/g, '')
      .replace(/\*\*|__|\*|_(?=\S)|(?<=\S)_|~~/g, '')
      .replace(/[→←↑↓⇒•·]/g, ' ')
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!l) continue
    out.push(...sentences(l))
  }
  const said = out.join(' ')
  const hangul = (said.match(/[가-힣]/g) ?? []).length
  const letters = (said.match(/[A-Za-z가-힣]/g) ?? []).length
  if (!said) return total > 0 ? 'unsure' : []
  if (letters && hangul / letters < 0.5) return 'unsure'
  if (total > 200 && said.length < total * 0.2 && dropped > said.length) return 'unsure'
  return out
}

/** A line cut into sentences at . ! ? … (a full stop inside a number or a name stays). */
export function sentences(line: string): string[] {
  return line
    .split(/(?<=[.!?…])\s+(?=\S)/u)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
}

/**
 * The sentences of an answer that has not been read yet, as it grows (a message at a time): each new message is
 * read whole once it is in. `seen` keeps the ids read, so a message drawn again is not read twice.
 */
export class ReadQueue {
  private seen = new Set<string>()
  /** The ids of answers already there when 대화 모드 began: never read. */
  skip(ids: Iterable<string>) {
    for (const id of ids) this.seen.add(id)
  }
  take(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    return true
  }
}

/**
 * Is a sound heard while the answer is being read the person starting to speak? Sure after `sureMs` of sound;
 * before that only when the browser's recogniser has heard a word in it (a knock or a train is not words).
 */
export const BARGE = { duckMs: 150, sureMs: 600, duckTo: 0.25 }
export function bargeIn(loudMs: number, heardWords: boolean): 'none' | 'duck' | 'stop' {
  if (loudMs >= BARGE.sureMs || (loudMs >= BARGE.duckMs && heardWords)) return 'stop'
  if (loudMs >= BARGE.duckMs) return 'duck'
  return 'none'
}

/**
 * Is a phrase heard while the answer was read just the answer itself, back through the microphone (a speaker with
 * no echo cancelling)? Sure when most of its letters, in order, are in what was read just now.
 */
export function isEcho(heard: string, read: string): boolean {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '')
  const h = norm(heard)
  const r = norm(read)
  if (h.length < 4 || !r) return false
  // Longest common subsequence over the heard letters (short strings: a phrase and the last few sentences).
  let prev = new Array<number>(r.length + 1).fill(0)
  for (let i = 1; i <= h.length; i++) {
    const cur = new Array<number>(r.length + 1).fill(0)
    for (let j = 1; j <= r.length; j++) cur[j] = h[i - 1] === r[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    prev = cur
  }
  return prev[r.length] / h.length >= 0.7
}

/** base64 to bytes (the Mac's sound comes as base64 in JSON). */
export function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
