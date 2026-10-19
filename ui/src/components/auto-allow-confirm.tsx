// Before a session starts in 전부 허용 (every permission request allowed without asking): say so, and say where the
// default that chose it is changed.
import { get } from '../lib/api'
import { cancelDialog, confirmDialog } from '../kit/overlay'

export const confirmAutoAllow = () =>
  confirmDialog('전부 허용 모드로 시작됩니다.', {
    text: (
      <>
        권한 요청을 묻지 않고 모두 허용해요. 만약 기본값을 변경하려면{' '}
        <a href="/settings" onClick={() => cancelDialog()}>
          여기
        </a>
        로 가서 바꿔주세요.
      </>
    ),
    ok: '확인',
    danger: true,
  })

/** A copy (복제·가벼운 복제) starts with the person's defaults: when that is 전부 허용, ask first. True = go on. */
export async function confirmCopyMode(): Promise<boolean> {
  const d = await get<{ mode: string }>('/api/prefs/launch').catch(() => null)
  return d?.mode === 'autoAllow' ? confirmAutoAllow() : true
}
