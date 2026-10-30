// 설정 → Claude 계정: the Claude accounts on each of the person's Macs (agent/accounts.mjs). An account is a Claude
// Code config folder of its own, so it has its own sign-in and its own conversations; settings, CLAUDE.md, skills,
// plugins and MCP servers are the main account's. Signing in happens here: the Mac starts `claude auth login`, this
// page shows its sign-in address, and the code the sign-in page gives is pasted back.
import { useEffect, useState } from 'react'
import { errorText, post } from '../lib/api'
import { href } from '../lib/router'
import { hostIcon } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import type { Account, Host } from '../lib/types'
import { Badge, Button, CardHead, Empty, Icon, NO_AUTOFILL, Spinner } from '../kit'
import { confirmDialog, promptDialog, toast } from '../kit/overlay'
import { copyText, linkClick } from '../lib/builtin-actions'

type Reply = { ok: true; accounts: Account[]; url?: string; id?: string }
const call = (hostId: string, body: Record<string, unknown>) => post<Reply>(`/api/hosts/${hostId}/accounts`, body)

/** What a row says under the account's name. */
export function accountLine(a: Account) {
  if (a.signingIn) return '로그인하는 중'
  if (a.loggedIn === null) return '로그인 상태를 확인하는 중'
  if (!a.loggedIn) return '로그인돼 있지 않아요'
  return [a.email, a.plan ? `${a.plan} 요금제` : a.method].filter(Boolean).join(' · ') || '로그인됨'
}

export function AccountsPanel() {
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  return (
    <>
      <section className="card-box">
        <CardHead
          title="Claude 계정"
          help="맥마다 Claude 계정을 여러 개 둘 수 있어요. 계정마다 로그인과 대화 기록이 따로이고, 설정·CLAUDE.md·스킬·플러그인·MCP 는 기본 계정 것을 같이 써요. 세션 메뉴의 '다른 계정으로 옮기기' 로 대화를 그대로 다른 계정에 넘겨요."
        />
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
          처음이면 <a href={href({ name: 'guide', path: 'accounts' })}>멀티 계정 가이드</a> 를 따라 해 보세요.
        </p>
      </section>
      {!hosts.length ? (
        <section className="card-box">
          <Empty icon="laptop" title="연결한 맥이 없어요">
            맥을 연결하면 그 맥의 Claude 계정을 여기서 관리해요.
          </Empty>
        </section>
      ) : (
        hosts.map((h) => <HostAccounts key={h.id} host={h} />)
      )}
    </>
  )
}

function HostAccounts({ host }: { host: Host }) {
  const [list, setList] = useState<Account[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // The sign-in in progress: which account, and the address the Mac printed.
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null)
  const [code, setCode] = useState('')
  // An agent from before accounts says nothing about them, and would not answer the list either.
  const supported = !!host.accounts
  useEffect(() => {
    if (!host.online || !supported) return
    call(host.id, { op: 'list' }).then((r) => setList(r.accounts), () => {})
  }, [host.id, host.online, supported])
  const accounts = list ?? host.accounts ?? []

  const run = async (op: string, id: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(`${op}:${id}`)
    try {
      const r = await call(host.id, { op, id, ...extra })
      setList(r.accounts)
      if (done) toast(done)
      return r
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      return null
    } finally {
      setBusy(null)
    }
  }
  const startLogin = async (id: string) => {
    const r = await run('login', id)
    if (r?.url) (setLogin({ id, url: r.url }), setCode(''))
  }
  const add = async () => {
    const name = await promptDialog('Claude 계정 추가', { placeholder: '계정 이름 (예: 회사, 개인)', ok: '추가', text: '이 맥에 새 계정 폴더를 만들고 바로 로그인을 시작해요.' })
    if (!name?.trim()) return
    const r = await run('add', '', { name: name.trim() }, '계정을 더했어요. 이어서 로그인해 주세요')
    if (r?.id) await startLogin(r.id)
  }
  const rename = async (a: Account) => {
    const name = await promptDialog('계정 이름 바꾸기', { value: a.name, ok: '바꾸기' })
    if (name?.trim()) await run('rename', a.id, { name: name.trim() }, '이름을 바꿨어요')
  }
  const logout = async (a: Account) => {
    const warn = a.sessions ? `이 계정으로 도는 세션 ${a.sessions}개는 다시 로그인할 때까지 답하지 못해요.` : '다시 쓰려면 로그인을 다시 해야 해요.'
    if (await confirmDialog(`${a.name} 에서 로그아웃할까요?`, { text: warn, ok: '로그아웃', danger: true })) await run('logout', a.id, {}, '로그아웃했어요')
  }
  const remove = async (a: Account) => {
    if (await confirmDialog(`${a.name} 계정을 뺄까요?`, { text: '로그아웃하고 이 맥의 계정 목록에서 빼요. 계정 폴더(대화 기록)는 지우지 않고 에이전트 폴더의 accounts-removed 에 옮겨 둬요.', ok: '빼기', danger: true }))
      await run('remove', a.id, {}, '계정을 뺐어요')
  }
  const sync = (a: Account) => run('sync', a.id, {}, 'MCP 서버와 폴더 신뢰 설정을 기본 계정에서 다시 가져왔어요')
  const sendCode = async () => {
    if (!login) return
    const r = await run('code', login.id, { code: code.trim() }, '로그인했어요')
    if (r) (setLogin(null), setCode(''))
  }

  return (
    <section className="card-box">
      <div className="hstack" style={{ marginBottom: 8 }}>
        <Icon name={hostIcon(host.kind)} />
        <b className="grow">{host.name}</b>
        {host.online && supported ? (
          <Button size="sm" icon="plus" busy={busy === 'add:'} onClick={add}>
            계정 추가
          </Button>
        ) : null}
      </div>
      {!host.online ? (
        <p className="muted" style={{ margin: 0 }}>
          이 맥이 연결돼 있지 않아요. 연결되면 계정을 관리할 수 있어요.
        </p>
      ) : !supported ? (
        <p className="muted" style={{ margin: 0 }}>
          이 맥의 에이전트가 새 버전으로 바뀌면 계정을 관리할 수 있어요. 보통 몇 분 안에 저절로 바뀌어요.
        </p>
      ) : !accounts.length ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ gap: 0 }}>
          {accounts.map((a) => (
            <div key={a.id} className="account-row">
              <div className="hstack" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                <div className="grow" style={{ minWidth: 180 }}>
                  <b>{a.name}</b> {a.main ? <Badge>기본</Badge> : null} {a.loggedIn === false ? <Badge tone="amber">로그인 필요</Badge> : a.loggedIn ? <Badge tone="green">로그인됨</Badge> : null}
                  <div className="muted" style={{ fontSize: 'var(--fs-small)', overflowWrap: 'anywhere' }}>
                    {accountLine(a)}
                    {a.sessions ? ` · 세션 ${a.sessions}개` : ''}
                  </div>
                </div>
                <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {a.loggedIn ? (
                    <Button size="sm" busy={busy === `logout:${a.id}`} onClick={() => logout(a)}>
                      로그아웃
                    </Button>
                  ) : (
                    <Button size="sm" tone="primary" icon="key" busy={busy === `login:${a.id}`} onClick={() => startLogin(a.id)}>
                      로그인
                    </Button>
                  )}
                  <Button size="sm" icon="edit" onClick={() => rename(a)}>
                    이름
                  </Button>
                  {!a.main ? (
                    <>
                      <Button size="sm" icon="refresh" busy={busy === `sync:${a.id}`} onClick={() => sync(a)} title="MCP 서버와 폴더 신뢰 설정을 기본 계정에서 다시 가져와요">
                        공유 설정 맞추기
                      </Button>
                      <Button size="sm" icon="trash" busy={busy === `remove:${a.id}`} onClick={() => remove(a)}>
                        빼기
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {login?.id === a.id ? (
                <div className="account-login stack">
                  <ol className="guide-list" style={{ margin: 0 }}>
                    <li>
                      아래 버튼으로 로그인 페이지를 열어 <b>{a.name}</b> 에 쓸 Claude 계정으로 로그인해요. 폰이나 다른 기기에서 열어도 돼요.
                    </li>
                    <li>로그인이 끝나면 페이지에 나오는 코드를 복사해 아래 칸에 붙여 넣어요.</li>
                  </ol>
                  <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <a className="btn btn-primary btn-sm" href={login.url} target="_blank" rel="noreferrer noopener" onClick={linkClick(login.url, 'accounts')}>
                      <Icon name="link" />
                      <span>로그인 페이지 열기</span>
                    </a>
                    <Button size="sm" onClick={() => copyText(login.url, 'link').then((ok) => ok && toast('로그인 주소를 복사했어요'))}>
                      주소 복사
                    </Button>
                  </div>
                  <div className="hstack" style={{ gap: 6 }}>
                    <input className="input grow" {...NO_AUTOFILL} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void sendCode()} placeholder="로그인 페이지의 코드" aria-label="로그인 코드" />
                    <Button size="sm" tone="primary" disabled={!code.trim()} busy={busy === `code:${a.id}`} onClick={sendCode}>
                      확인
                    </Button>
                    <Button size="sm" onClick={() => (void run('cancel', a.id), setLogin(null))}>
                      취소
                    </Button>
                  </div>
                  <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
                    15분 안에 코드를 넣지 않으면 다시 시작해야 해요.
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
