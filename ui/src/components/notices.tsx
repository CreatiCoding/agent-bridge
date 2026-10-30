// What happened in sessions the person was not looking at: decisions waiting, background work that ended.
import { post } from '../lib/api'
import { ago } from '../lib/format'
import { NONE, useStore } from '../lib/store'
import { Button, Empty, Icon, IconButton } from '../kit'
import { Sheet } from '../kit/overlay'
import { act } from './session-menu'
import { PushToggle } from './push'
import { openSession } from '../lib/builtin-actions'

export function NoticeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notices = useStore((s) => s.state?.notices ?? NONE)
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="알림"
      footer={
        <div className="hstack">
          <PushToggle />
          <span className="grow" />
          {notices.length ? (
            <Button size="sm" tone="ghost" onClick={() => act(() => post('/api/notices/dismiss', {}))}>
              모두 지우기
            </Button>
          ) : null}
        </div>
      }
    >
      {!notices.length ? (
        <Empty icon="bell" title="새 알림이 없어요">
          결정이 필요하거나 백그라운드 작업이 끝나면 여기에 떠요.
        </Empty>
      ) : (
        notices.map((n) => (
          <div key={n.id} className="notice-item">
            <Icon name={n.tone === 'fail' ? 'warn' : n.tone === 'ok' ? 'check' : 'bell'} />
            <button
              type="button"
              className="grow"
              style={{ border: 0, background: 'none', textAlign: 'left', padding: 0 }}
              onClick={() => {
                onClose()
                if (n.sid) openSession(n.sid, 'notice')
                void post('/api/notices/dismiss', { id: n.id })
              }}
            >
              <b>{n.title}</b> <span className="muted" style={{ fontSize: 'var(--fs-xsmall)' }}>{ago(n.at)}</span>
              <p>{n.text.replace(/\*([^*]+)\*/g, '$1')}</p>
            </button>
            <IconButton icon="close" label="지우기" onClick={() => act(() => post('/api/notices/dismiss', { id: n.id }))} />
          </div>
        ))
      )}
    </Sheet>
  )
}
