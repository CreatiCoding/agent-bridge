// 익스텐션 on the settings page (REQ-F-827): each person turns the server's extensions on and off (설정 → 플러그인);
// admins see why one did not load, what the pages reported, and data left by extensions taken out (운영).
import { useEffect, useState } from 'react'
import { Button, CardHead, Switch } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { askConsent, cleanLeftover, ConsentText, extLeftovers, listExtensions, revokeConsent, type ExtInfo } from '../lib/ext-host'
import { clock } from '../lib/format'

export function ExtSettings() {
  const [list, setList] = useState<ExtInfo[] | null>(null)
  const load = () => listExtensions().then(setList, () => setList([]))
  useEffect(() => void load(), [])
  if (!list?.length) return null
  return (
    <section className="card-box">
      <CardHead title="익스텐션" help="이 서버의 운영자가 설치한 확장 기능이에요. 켜면 당신의 권한으로 동작하고, 적힌 주소로 요청을 보낼 수 있어요. 바꾸면 화면을 다시 불러와요." />
      <div className="stack" style={{ gap: 12 }}>
        {list.map((x) => (
          <div key={x.id} className="hstack" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div className="grow">
              <ConsentText x={x} />
              {x.loadError ? <div className="muted">불러오지 못했어요: {x.loadError}</div> : null}
            </div>
            <Switch
              checked={x.consented}
              disabled={!!x.loadError}
              label={`${x.name} 켜기`}
              onChange={async (on) => {
                if (on ? await askConsent(x) : await revokeConsent(x).then(() => true, () => false)) location.reload()
              }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

export function ExtAdmin() {
  const [list, setList] = useState<ExtInfo[] | null>(null)
  const [left, setLeft] = useState<string[]>([])
  const load = () => (listExtensions().then(setList, () => setList([])), extLeftovers().then(setLeft, () => setLeft([])))
  useEffect(() => void load(), [])
  if (!list?.length && !left.length) return null
  return (
    <section className="card-box">
      <CardHead title="익스텐션" help="bridge.yaml 의 extensions. 고치려면 파일을 바꾸고 서버를 다시 시작하세요." />
      <div className="stack" style={{ gap: 10 }}>
        {(list ?? []).map((x) => (
          <div key={x.id}>
            <b>{x.name}</b> <span className="muted">{x.id} · v{x.version} · {x.hash}</span>
            {x.loadError ? <div style={{ color: 'var(--red)' }}>불러오지 못함: {x.loadError}</div> : null}
            {x.errors?.length ? (
              <details>
                <summary>화면 오류 {x.errors.length}건</summary>
                {x.errors
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <pre key={i} className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-small)' }}>
                      {clock(e.at)} {e.message}
                      {e.stack ? `\n${e.stack}` : ''}
                    </pre>
                  ))}
              </details>
            ) : null}
          </div>
        ))}
        {left.map((id) => (
          <div key={id} className="hstack">
            <span className="grow">빠진 익스텐션 {id} 의 데이터가 남아 있어요</span>
            <Button
              size="sm"
              tone="danger"
              onClick={async () => {
                if (!(await confirmDialog(`${id} 의 데이터를 지울까요?`, { text: '서버 범위와 모든 사람의 값·비밀값을 지워요. 되돌릴 수 없어요.', ok: '지우기', danger: true }))) return
                toast((await cleanLeftover(id)) ? '지웠어요' : '지우지 못했어요')
                void load()
              }}
            >
              정리
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
