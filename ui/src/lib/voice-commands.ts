// 음성 명령 (REQ-F-789): said at the edges of one phrase (what is spoken between pauses), as the Mac wrote it.
// At its start, a pane of 분할 화면 ("두 번째 세션", "2번 칸") moves what follows to that pane; at its end, "전송" sends
// and "리셋" forgets what was gathered. Anywhere else the same words are only words.

export type VoiceEnd = 'send' | 'reset'

export interface VoiceCommand {
  /** The pane named at the start (1-based), when there are panes and it is one of them. */
  pane: number | null
  /** The phrase without the words that were commands. */
  text: string
  end: VoiceEnd | null
}

const ORDINAL: Record<string, number> = { 첫: 1, 두: 2, 둘: 2, 세: 3, 셋: 3 }
// 첫 번째 · 두번째 · 둘째 · 2번 · 2번째, then 세션 or 칸, then what may join it to the rest (에, 으로, a comma).
const PANE = /^\s*(?:(첫|두|둘|세|셋)\s*(?:번\s*)?째|([1-3])\s*번\s*(?:째)?)\s*(?:세션|칸)(?:에게|에서|으로|에|로)?\s*[,.:;!?~]*\s*/
// The last word, alone (not the end of a longer word), with what Korean may add to it and the punctuation after.
const END = /(?:^|[\s,.!?])(전송|리셋)(?:\s*(?:해\s*줘|해요|해|하기))?\s*[.!?。~]*\s*$/

export function voiceCommand(said: string, panes = 0): VoiceCommand {
  let text = said.trim()
  let pane: number | null = null
  const p = panes > 0 ? PANE.exec(text) : null
  if (p) {
    const no = p[1] ? ORDINAL[p[1]] : Number(p[2])
    if (no >= 1 && no <= panes) {
      pane = no
      text = text.slice(p[0].length)
    }
  }
  let end: VoiceEnd | null = null
  const e = END.exec(text)
  if (e) {
    end = e[1] === '전송' ? 'send' : 'reset'
    text = text.slice(0, e.index).replace(/[\s,]+$/, '')
  } else if ((end = alone(text))) text = ''
  return { pane, text: text.trim(), end }
}

// Said alone, a short word is the command the Mac misheard (1.282): one jamo off (천송, 전성, 리셧), or a word it was
// seen to write instead (순종 for 전송, 리스트 for 리셋). Never inside a longer phrase.
const HEARD: Record<VoiceEnd, string[]> = { send: ['순종'], reset: ['리스트'] }
const WORD: Record<VoiceEnd, string> = { send: '전송', reset: '리셋' }

function alone(text: string): VoiceEnd | null {
  const w = text.replace(/[\s.,!?~。]/g, '')
  if (!/^[가-힣]{2,3}$/.test(w) || text.trim().includes(' ')) return null
  for (const end of ['send', 'reset'] as VoiceEnd[]) if (HEARD[end].includes(w) || jamoOff(w, WORD[end]) <= 1) return end
  return null
}

/** How many jamo two Hangul words of the same length differ by (another length: far). */
function jamoOff(a: string, b: string): number {
  if (a.length !== b.length) return 99
  let n = 0
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i) - 0xac00
    const y = b.charCodeAt(i) - 0xac00
    n += Number(Math.floor(x / 588) !== Math.floor(y / 588)) + Number(Math.floor((x % 588) / 28) !== Math.floor((y % 588) / 28)) + Number(x % 28 !== y % 28)
  }
  return n
}
