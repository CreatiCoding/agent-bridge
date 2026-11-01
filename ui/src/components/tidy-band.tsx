// 세션 정리 예고 (REQ-F-835, REQ-F-839): a session whose claude is about to be taken down for want of a person's
// input says so at the top of its page, with a way to keep it this time or for good.
import { clock } from '../lib/format'
import type { Session } from '../lib/types'
import { Button, Icon } from '../kit'
import { act, sessionPost } from './session-menu'

export function TidyBand({ s }: { s: Session }) {
  if (!s.tidyStopAt || s.closed || s.keepAlive) return null
  return (
    <div className="banner" role="status" style={{ background: 'var(--hover)' }}>
      <Icon name="info" />
      <div className="banner-body">
        💤 사람 입력이 없어 {clock(s.tidyStopAt)}에 claude 를 내려요. 대화는 남고 글을 보내면 이어서 열려요.
        <div className="banner-actions">
          <Button size="sm" tone="primary" onClick={() => void act(() => sessionPost(s, 'settings', { tidyKeep: true }), '이번엔 유지해요')}>
            유지
          </Button>
          <Button size="sm" onClick={() => void act(() => sessionPost(s, 'settings', { keepAlive: true }), '이 세션은 자동으로 내리지 않아요')}>
            자동 종료 안 함
          </Button>
        </div>
      </div>
    </div>
  )
}
