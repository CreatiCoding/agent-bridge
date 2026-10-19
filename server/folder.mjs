// 새 세션 기본 폴더 (REQ-F-763): <base>/<group>/<MMDD>-<6 hex>, made when the session starts. The base is the same on
// every Mac (~ is each Mac's own home). ui/src/lib/folder.ts makes the same path for the new-session form.
import crypto from 'node:crypto'

export const FOLDER_BASE = '~/bridge/works'
export const FOLDER_NO_GROUP = '기타'

/** The base as kept, or '' when it is not a folder one may start from: ~ or / first, no .., at most 200. */
export function cleanFolderBase(v) {
  const s = String(v ?? '').trim().replace(/(.)\/+$/, '$1')
  return s.length <= 200 && /^(~|\/)/.test(s) && !/(^|\/)\.\.(\/|$)/.test(s) && !/[\0\n\r]/.test(s) ? s : ''
}

/** A group's name as one folder: no slashes, no leading dot, spaces as -, at most 40. */
export const folderPart = (name) =>
  String(name ?? '')
    .replace(/[/\\:\0\n\r\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')

export function defaultFolder({ base, noGroup, group }, now = new Date(), id = crypto.randomBytes(3).toString('hex')) {
  const day = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `${(cleanFolderBase(base) || FOLDER_BASE).replace(/\/$/, '')}/${folderPart(group) || folderPart(noGroup) || FOLDER_NO_GROUP}/${day}-${id}`
}
