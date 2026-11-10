// 설정 → 이 기기 → 영어 답 번역 (REQ-F-896, REQ-F-897): the switch, which translator this device uses and what it
// can do, and the one-time language download (a press, since the system's sheet and Chrome's download both need one).
// A browser with neither translator uses one of the person's Macs (macOS 26, its language pack).
import { useEffect, useState } from 'react'
import { Button, Switch } from '../kit'
import { errorText } from '../lib/api'
import { engine, macStatus, setTranslateOn, useTranslateOn, type Status } from '../lib/translate'

const SAY: Record<Status, string> = {
  installed: '이 기기에서 바로 번역해요. 인터넷이 없어도 돼요.',
  download: '처음 한 번 영어→한국어 언어를 받아야 해요(인터넷). 받은 뒤에는 기기 안에서만 번역해요.',
  unsupported: '이 기기는 영어→한국어 기기 안 번역을 지원하지 않아요.',
}

function macNote(s: Status, host?: string) {
  const at = host ? `맥 "${host}"` : '맥'
  if (s === 'installed') return `이 브라우저에는 번역기가 없어 ${at}의 언어팩으로 번역해요. 번역 서비스로는 보내지 않아요.`
  if (s === 'download') return `${at}에 영어·한국어 언어팩이 없어요. 그 맥의 시스템 설정 → 일반 → 언어 및 지역 → 번역 언어에서 받아 주세요.`
  return `${at}은 언어팩 번역을 지원하지 않아요(macOS 26 이상).`
}

export function TranslateSetting() {
  const on = useTranslateOn()
  const local = engine()
  const [status, setStatus] = useState<Status | 'checking' | 'getting'>('checking')
  const [mac, setMac] = useState<string>('맥 확인 중…')
  const check = () => {
    setMac('맥 확인 중…')
    macStatus()
      .then((a) => setMac(macNote(a.status, a.host)))
      .catch((e) => setMac(errorText(e)))
  }
  useEffect(() => {
    if (!local) return check()
    local
      .status()
      .then(setStatus)
      .catch(() => setStatus('unsupported'))
  }, [])
  const get = () => {
    if (!local) return
    setStatus('getting')
    local
      .prepare()
      .then(setStatus)
      .catch(() => setStatus('download'))
  }
  const note = !local ? mac : status === 'checking' ? '번역기 확인 중…' : status === 'getting' ? '언어 받는 중…' : SAY[status]
  return (
    <div className="hstack" data-translate={local?.kind ?? 'mac'}>
      <div className="grow" style={{ fontSize: 'var(--fs-medium)' }}>
        영어 답을 한국어로 보기
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          답에 영어 문장이 섞여 오면 그 줄만 한국어로 바꿔 보여요. 코드·경로·링크는 그대로 두고, 답 아래 원문 보기로 영어를 볼 수 있어요. {note}
        </div>
        {on && local && status === 'download' ? (
          <Button size="sm" onClick={get} style={{ marginTop: 6 }}>
            언어 받기
          </Button>
        ) : null}
        {on && !local ? (
          <Button size="sm" onClick={check} style={{ marginTop: 6 }}>
            다시 확인
          </Button>
        ) : null}
      </div>
      <Switch label="영어 답을 한국어로 보기" checked={on} onChange={setTranslateOn} />
    </div>
  )
}
