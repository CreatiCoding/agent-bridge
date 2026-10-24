// Before a session starts in 전부 허용 (every permission request allowed without asking): say so, and say where the
// default that chose it is changed. 안전한 전부 허용 still asks about risky calls (REQ-F-759); 전부 허용 (allowAll,
// REQ-F-796) asks about nothing, so it is said in red.
import { get } from '../lib/api'
import type { Session } from '../lib/types'
import { cancelDialog, confirmDialog } from '../kit/overlay'

const toSettings = (
  <>
    만약 기본값을 변경하려면{' '}
    <a href="/settings" onClick={() => cancelDialog()}>
      여기
    </a>
    로 가서 바꿔주세요.
  </>
)

export const confirmAutoAllow = () =>
  confirmDialog('안전한 전부 허용 모드로 시작됩니다.', {
    text: <>권한 요청을 묻지 않고 허용해요. 위험한 호출(폴더 밖 삭제·강제 push·sudo·비밀 파일)만 물어요. {toSettings}</>,
    ok: '확인',
    danger: true,
  })

export const confirmAllowAll = (start = true) =>
  confirmDialog(start ? '🔴 전부 허용 모드로 시작됩니다.' : '🔴 전부 허용으로 바꿀까요?', {
    text: <>위험한 호출(폴더 밖 삭제·강제 push·sudo·비밀 파일)까지 하나도 묻지 않고 바로 허용해요. 이 세션이 맡기거나 복제한 세션도 같이 그래요. {start ? toSettings : null}</>,
    ok: start ? '확인' : '바꾸기',
    danger: true,
  })

/** Whichever of the two `mode` is, asked before it starts. True = go on. */
export const confirmLaunchMode = (mode: string) => (mode === 'allowAll' ? confirmAllowAll() : mode === 'autoAllow' ? confirmAutoAllow() : Promise.resolve(true))

/** The policy a session runs with, as a launch mode ('' when it asks as the terminal does). */
export const allowModeOf = (s: Session) => (s.state.autoAllow || s.autoAllow ? (s.state.allowAll || s.allowAll ? 'allowAll' : 'autoAllow') : '')

/**
 * A copy (복제·가벼운 복제) keeps the original's 전부 허용 as it is (REQ-F-796): chosen for it already, not asked
 * again. An original that asks starts it with the person's defaults: when that is a 전부 허용, ask first. True = go on.
 */
export async function confirmCopyMode(s: Session): Promise<boolean> {
  if (allowModeOf(s)) return true
  const d = await get<{ mode: string }>('/api/prefs/launch').catch(() => null)
  return confirmLaunchMode(d?.mode ?? '')
}

/** What the session's 권한 모드 means when it is one of the two 전부 허용. */
export function AllowHint({ mode }: { mode: string }) {
  if (mode === 'allowAll') return <span className="allow-all-text">🔴 전부 허용: 위험한 호출(폴더 밖 삭제·강제 push·sudo·비밀 파일)까지 묻지 않고 바로 허용해요. 맡기거나 복제한 세션도 같아요</span>
  return <>안전한 전부 허용: 권한 요청을 에이전트가 바로 허용하고 대화에 남겨요. 위험한 호출만 물어요. 설정에 남는 '다시 묻지 않기' 는 누르지 않아요</>
}
