// 새 세션 기본 폴더 (REQ-F-763): the same path server/folder.mjs makes for a session handed over from another Mac.

export const FOLDER_BASE = '~/bridge/works'
export const FOLDER_NO_GROUP = '기타'

/** A group's name as one folder: no slashes, no leading dot, spaces as -, at most 40. */
export const folderPart = (name: string | undefined) =>
  String(name ?? '')
    .replace(/[/\\:\0\n\r\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')

/** The date and short id part, picked once per form so the path does not change while it is open. */
export function folderStamp(now = new Date()) {
  const day = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const id = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${day}-${id}`
}

export const defaultFolder = (base: string | undefined, noGroup: string | undefined, group: string | undefined, stamp: string) =>
  `${(base || FOLDER_BASE).replace(/\/$/, '')}/${folderPart(group) || folderPart(noGroup) || FOLDER_NO_GROUP}/${stamp}`
