// 퀵 제보 (REQ-F-870): what is on the clipboard, read in one press and sent as a report as it is.
// Pure on purpose (the clipboard is passed in) so the unit test can hand it a pretend one.

/** The most pictures one quick report carries, as the report sheet. */
export const QUICK_MAX_IMAGES = 8
/** The server keeps the first 20,000 characters of a report. */
export const QUICK_MAX_TEXT = 20_000

type ClipItem = { types: readonly string[]; getType: (type: string) => Promise<Blob> }
type Clip = { read?: () => Promise<ClipItem[]>; readText?: () => Promise<string> }

export type ClipContent = { text: string; files: File[] }

/**
 * Reads the text and the pictures on the clipboard. read() where the browser has it (iOS Safari and WebKit show
 * their own 붙여넣기 bubble first), readText() otherwise. Throws when the browser has neither or says no.
 */
export async function readClipboard(clip: Clip | undefined): Promise<ClipContent> {
  if (clip?.read) {
    const files: File[] = []
    const texts: string[] = []
    for (const item of await clip.read()) {
      const img = item.types.find((t) => t.startsWith('image/'))
      if (img && files.length < QUICK_MAX_IMAGES) files.push(new File([await item.getType(img)], `clipboard-${files.length + 1}.${img.split('/')[1]}`, { type: img }))
      if (item.types.includes('text/plain')) {
        const t = (await (await item.getType('text/plain')).text()).trim()
        if (t) texts.push(t)
      }
    }
    return { text: texts.join('\n\n').slice(0, QUICK_MAX_TEXT), files }
  }
  if (clip?.readText) return { text: (await clip.readText()).trim().slice(0, QUICK_MAX_TEXT), files: [] }
  throw new Error('이 브라우저는 클립보드를 읽을 수 없어요')
}
