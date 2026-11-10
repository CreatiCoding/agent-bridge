// 영어 답 번역 (REQ-F-896): an answer that came in English is shown in Korean, translated on this device only.
// Two on-device translators: the iOS app's (Apple Translation, through webkit.messageHandlers.translate) and desktop
// Chrome's Translator API. Where the browser has neither, one of the person's Macs translates with macOS's language
// pack (REQ-F-897, POST /api/translate, macOS 26). Nothing is sent to a translation service.
// Only English prose lines change. Fenced code, inline code, links and paths are kept byte for byte: they are held
// out as ⟦n⟧ marks, and a line whose marks do not all come back whole keeps its English.
import { useEffect, useState, useSyncExternalStore } from 'react'

const KEY = 'cb2.translate'
/** On unless turned off in 설정 → 이 기기, per browser. */
export const translateOn = () => {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}
export const setTranslateOn = (on: boolean) => {
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
  } catch {}
  dispatchEvent(new Event('cb-translate'))
}
const watchOn = (cb: () => void) => (addEventListener('cb-translate', cb), () => removeEventListener('cb-translate', cb))
export const useTranslateOn = () => useSyncExternalStore(watchOn, translateOn)

/** Inline code, links and paths: kept out of the translation. */
const KEEP = /`[^`\n]+`|https?:\/\/[^\s)>\]]+|\[[^\]\n]*\]\([^)\n]*\)|(?<![\w/])(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.(?:tsx?|mjs|jsx?|go|swift|md|json|ya?ml|sh)\b/g
/** A line's Markdown start (heading, list, quote, task box): kept as it is. */
const LEAD = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*)(.*)$/

/** Mostly English prose: at least three English words and no Korean, once code and links are out. */
export function isEnglish(line: string) {
  const prose = line.replace(KEEP, ' ')
  if (/[가-힣ㄱ-ㆎ]/.test(prose)) return false
  const words = prose.match(/[A-Za-z][a-z']+/g) ?? []
  return words.length >= 3 && words.join('').length >= 12
}

export type Piece = { lead: string; body: string; kept: string[] }

/** Splits an answer into what stays (null) and the English lines to translate, outside ``` fences and tables. */
export function englishPieces(md: string): { lines: string[]; pieces: (Piece | null)[] } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let fence = ''
  const pieces = lines.map((line): Piece | null => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = ''
      return null
    }
    if (f) {
      fence = f[1]
      return null
    }
    if (/^\s*\|/.test(line) || !isEnglish(line)) return null
    const [, lead, rest] = LEAD.exec(line) as RegExpExecArray
    const kept: string[] = []
    const body = rest.replace(KEEP, (m) => `⟦${kept.push(m) - 1}⟧`)
    return { lead, body, kept }
  })
  return { lines, pieces }
}

/** The Korean put back with its marks; null when a mark went missing or came back twice (the English stays). */
export function restore(p: Piece, ko: string): string | null {
  if (!ko.trim()) return null
  for (let i = 0; i < p.kept.length; i++) if (ko.split(`⟦${i}⟧`).length !== 2) return null
  if (/⟦\d+⟧/.test(ko.replace(/⟦(\d+)⟧/g, (m, n) => (Number(n) < p.kept.length ? '' : m)))) return null
  return p.lead + ko.replace(/⟦(\d+)⟧/g, (_, n) => p.kept[Number(n)])
}

export type Status = 'installed' | 'download' | 'unsupported'
type Engine = { kind: 'app' | 'chrome' | 'mac'; status(): Promise<Status>; prepare(): Promise<Status>; run(texts: string[]): Promise<string[]> }
/** Asking a Mac (REQ-F-897): host is the session's own Mac, asked first. Left out for a Mac paired with this device. */
export type MacOpt = { host?: string }

export type MacAnswer = { ok: true; status: Status; texts?: string[]; host?: string }
/** A Mac that could not translate is not asked again for a minute. */
let macDownUntil = 0
async function askMac(texts: string[], host?: string): Promise<MacAnswer> {
  const { post } = await import('./api')
  return post<MacAnswer>('/api/translate', { texts, ...(host ? { host } : {}) })
}
export const macStatus = () => askMac([])

type AppAnswer = { status?: Status; texts?: string[]; error?: string }
type AppBridge = {
  webkit?: { messageHandlers?: { translate?: { postMessage(m: unknown): void } } }
  bridgeTranslate?: (id: number, m: AppAnswer) => void
}
let nextId = 1
const waiting = new Map<number, (m: AppAnswer) => void>()
function askApp(texts: string[], prepare = false, wait = 30_000): Promise<AppAnswer> {
  const w = globalThis as unknown as AppBridge
  const h = w.webkit?.messageHandlers?.translate
  if (!h) return Promise.reject(new Error('no app'))
  w.bridgeTranslate ??= (id, m) => {
    waiting.get(id)?.(m)
    waiting.delete(id)
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    // The download sheet waits on the person.
    const timer = setTimeout(() => waiting.delete(id) && reject(new Error('앱이 답하지 않았어요')), prepare ? 600_000 : wait)
    waiting.set(id, (m) => (clearTimeout(timer), resolve(m)))
    h.postMessage({ id, texts, prepare })
  })
}

type ChromeTranslator = { translate(t: string): Promise<string> }
type ChromeApi = {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>
}
const pair = { sourceLanguage: 'en', targetLanguage: 'ko' }
let chromeOne: Promise<ChromeTranslator> | null = null
const chromeStatus = (a: string): Status => (a === 'available' ? 'installed' : a === 'downloadable' || a === 'downloading' ? 'download' : 'unsupported')

/** This device's translator; a Mac when the browser has none and mac is given; or null. */
export function engine(mac?: MacOpt | null): Engine | null {
  const g = globalThis as unknown as AppBridge & { Translator?: ChromeApi }
  if (g.webkit?.messageHandlers?.translate)
    return {
      kind: 'app',
      status: async () => (await askApp([])).status ?? 'unsupported',
      prepare: async () => (await askApp([], true)).status ?? 'unsupported',
      run: async (texts) => {
        const a = await askApp(texts)
        if (!a.texts) throw new Error(a.error ?? a.status ?? '번역 못 함')
        return a.texts
      },
    }
  const T = g.Translator
  if (T?.availability)
    return {
      kind: 'chrome',
      status: async () => chromeStatus(await T.availability(pair)),
      // create() downloads the model; Chrome lets it start only from a press.
      prepare: async () => {
        chromeOne = T.create(pair)
        await chromeOne
        return chromeStatus(await T.availability(pair))
      },
      run: async (texts) => {
        if (chromeStatus(await T.availability(pair)) !== 'installed') throw new Error('download')
        chromeOne ??= T.create(pair)
        const t = await chromeOne
        return Promise.all(texts.map((s) => t.translate(s)))
      },
    }
  if (mac)
    return {
      kind: 'mac',
      status: async () => (await askMac([], mac.host)).status,
      prepare: async () => (await askMac([], mac.host)).status,
      run: async (texts) => {
        if (Date.now() < macDownUntil) throw new Error('mac')
        try {
          const a = await askMac(texts, mac.host)
          if (a.status !== 'installed' || !a.texts) throw new Error(a.status)
          return a.texts
        } catch (e) {
          macDownUntil = Date.now() + 60_000
          throw e
        }
      },
    }
  return null
}

const done = new Map<string, string>()
const going = new Map<string, Promise<string>>()

/** The answer with its English lines in Korean; the same text when there is nothing to change or it fails. */
export function translateAnswer(md: string, mac?: MacOpt | null): Promise<string> {
  const hit = done.get(md)
  if (hit !== undefined) return Promise.resolve(hit)
  const on = going.get(md)
  if (on) return on
  const e = engine(mac)
  const { lines, pieces } = englishPieces(md)
  const todo = pieces.flatMap((p, i) => (p ? [i] : []))
  if (!e || !todo.length) return Promise.resolve(md)
  const p = e
    .run(todo.map((i) => (pieces[i] as Piece).body))
    .then((ko) => {
      const out = [...lines]
      todo.forEach((i, j) => {
        const line = restore(pieces[i] as Piece, ko[j] ?? '')
        if (line != null) out[i] = line
      })
      return out.join('\n')
    })
    .then(
      (r) => {
        going.delete(md)
        if (done.size > 300) done.delete(done.keys().next().value as string)
        done.set(md, r)
        return r
      },
      // Not kept: a language pack downloaded later, or a Mac that comes back, translates it next time.
      () => (going.delete(md), md),
    )
  going.set(md, p)
  return p
}

/** What to show for an answer: the Korean once it is ready (the English until then) and whether it changed. */
export function useKorean(md: string, active: boolean, mac?: MacOpt | null) {
  const on = useTranslateOn() && active
  const want = on && englishPieces(md).pieces.some(Boolean) && !!engine(mac)
  const [ko, setKo] = useState<string | null>(() => (want ? done.get(md) ?? null : null))
  useEffect(() => {
    if (!want) return setKo(null)
    let live = true
    setKo(done.get(md) ?? null)
    translateAnswer(md, mac).then((r) => live && setKo(r))
    return () => {
      live = false
    }
  }, [md, want])
  const changed = want && ko != null && ko !== md
  return { text: changed ? (ko as string) : md, changed, busy: want && ko == null }
}
