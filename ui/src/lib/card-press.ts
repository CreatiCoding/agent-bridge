// What a press on a decision card shows while its answer travels (REQ-F-876). The answer is a plain POST and the card
// only closes when the Mac's next state comes down the page's stream: on a phone whose link stalls, the POST could
// wait with no end and the stream brings nothing, so the press looked ignored.

/** How long a press waits for the server before the buttons come back with a note to press again. */
export const ANSWER_WAIT_MS = 12_000
/** A page link down at least this long is said on the card (the same as the status line, REQ-F-874). */
export const CARD_LINK_DOWN_MS = 3_000

export const LATE = Symbol('late')

/** The promise's value, or LATE when it has not settled within ms. The request itself goes on. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

export const LATE_NOTE = '답이 서버에 닿았는지 확인하지 못했어요 (연결이 느려요). 카드가 그대로면 다시 눌러 주세요'

/**
 * The line under a card's options: the page link being down comes first (nothing the Mac does shows until it is back),
 * then a sent answer the Mac has not shown pressed yet.
 */
export function pressNote(a: { sent: string | null; link: string; downSince: number | null; now: number }): string | null {
  if (a.link !== 'live' && a.downSince && a.now - a.downSince >= CARD_LINK_DOWN_MS) return '페이지 연결이 끊겨 다시 잇는 중이에요 · 누른 답은 연결되면 보여요'
  if (a.sent) return `보냈어요 (${a.sent}) · 맥이 누르는 중`
  return null
}
