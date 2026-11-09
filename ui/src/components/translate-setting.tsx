// 설정 → 이 기기 → 영어 답 번역 (REQ-F-896): the switch, what this device's translator can do, and the one-time
// language download (a press, since the system's sheet and Chrome's download both need one).
import { useEffect, useState } from 'react'
import { Button, Switch } from '../kit'
import { engine, setTranslateOn, useTranslateOn, type Status } from '../lib/translate'

const SAY: Record<Status, string> = {
  installed: '이 기기에서 바로 번역해요. 인터넷이 없어도 돼요.',
  download: '처음 한 번 영어→한국어 언어를 받아야 해요(인터넷). 받은 뒤에는 기기 안에서만 번역해요.',
  unsupported: '이 기기는 영어→한국어 기기 안 번역을 지원하지 않아요.',
}

export function TranslateSetting() {
  const on = useTranslateOn()
  const e = engine()
  const [status, setStatus] = useState<Status | 'checking' | 'getting'>('checking')
  useEffect(() => {
    if (!e) return
    e.status()
      .then(setStatus)
      .catch(() => setStatus('unsupported'))
  }, [])
  const get = () => {
    if (!e) return
    setStatus('getting')
    e.prepare()
      .then(setStatus)
      .catch(() => setStatus('download'))
  }
  const note = !e
    ? '이 브라우저에는 기기 안 번역기가 없어요. iOS 앱(iOS 18 이상)이나 데스크톱 Chrome 에서 돼요. 답은 바깥 번역 서비스로 보내지 않아요.'
    : status === 'checking'
      ? '번역기 확인 중…'
      : status === 'getting'
        ? '언어 받는 중…'
        : SAY[status]
  return (
    <div className="hstack" data-translate={e?.kind ?? 'none'}>
      <div className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
        영어 답을 한국어로 보기
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          답에 영어 문장이 섞여 오면 그 줄만 이 기기 안에서 한국어로 바꿔 보여요. 코드·경로·링크는 그대로 두고, 답 아래 원문 보기로 영어를 볼 수 있어요. {note}
        </div>
        {e && on && status === 'download' ? (
          <Button size="sm" onClick={get} style={{ marginTop: 6 }}>
            언어 받기
          </Button>
        ) : null}
      </div>
      <Switch label="영어 답을 한국어로 보기" checked={on} onChange={setTranslateOn} />
    </div>
  )
}
