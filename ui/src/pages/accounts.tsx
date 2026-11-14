// 설정 → Claude 계정: the Claude accounts on each of the person's Macs (agent/accounts.mjs). An account is a Claude
// Code config folder of its own, so it has its own sign-in and its own conversations; settings, CLAUDE.md, skills,
// plugins and MCP servers are the main account's. Signing in happens here: the Mac starts `claude auth login`, this
// page shows its sign-in address, and the code the sign-in page gives is pasted back.
import { useEffect, useState } from 'react'
import { errorText } from '../lib/api'
import { href } from '../lib/router'
import { hostIcon } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import type { Account, Host } from '../lib/types'
import { Badge, Button, CardHead, Empty, Icon, Spinner } from '../kit'
import { confirmDialog, promptDialog, toast } from '../kit/overlay'
import { accountCall as call, expiryOf, LoginRenew } from '../components/claude-login'

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
  // An account just added: its sign-in starts at once (LoginRenew autoStart).
  const [fresh, setFresh] = useState<string | null>(null)
  // An agent from before accounts says nothing about them, and would not answer the list either.
  const supported = !!host.accounts
  useEffect(() => {
    if (!host.online || !supported) return
    call(host.id, { op: 'list' }).then((r) => setList(r.accounts), () => {})
  }, [host.id, host.online, supported])
  // The list answered here has the e-mail addresses; the page's state is newer for what the Mac sends by itself
  // (a sign-in closed after 30 minutes, an end date read again every 6 hours), so those come from it.
  const live = new Map((host.accounts ?? []).map((a) => [a.id, a]))
  const accounts = list
    ? list.map((a) => {
        const s = live.get(a.id)
        return s ? { ...a, loggedIn: s.loggedIn, signingIn: s.signingIn, expiresAt: s.expiresAt, renewedAt: s.renewedAt, sameAccount: s.sameAccount } : a
      })
    : (host.accounts ?? [])

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
  const add = async () => {
    const name = await promptDialog('Claude 계정 추가', { placeholder: '계정 이름 (예: 회사, 개인)', ok: '추가', text: '이 맥에 새 계정 폴더를 만들고 바로 로그인을 시작해요.' })
    if (!name?.trim()) return
    const r = await run('add', '', { name: name.trim() }, '계정을 더했어요. 이어서 로그인해 주세요')
    if (r?.id) setFresh(r.id)
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
  // 폴더 연결: another tool's Claude Code config folder, used as it is. bridge never writes in it.
  const link = async () => {
    const dir = await promptDialog('설정 폴더 연결', {
      placeholder: '폴더 경로 (예: ~/.other-tool/claude)',
      ok: '다음',
      text: '다른 도구가 쓰는 Claude Code 설정 폴더(CLAUDE_CONFIG_DIR)를 그대로 계정으로 써요. 그 폴더의 로그인·설정·훅·CLAUDE.md·스킬이 그대로 적용되고, bridge 는 그 폴더의 파일을 만들거나 고치거나 지우지 않아요. 연결 해제도 목록에서만 빼요.',
    })
    if (!dir?.trim()) return
    const name = await promptDialog('연결한 폴더의 이름', { placeholder: '계정 이름 (예: 자동화 도구)', ok: '연결' })
    if (!name?.trim()) return
    const r = await run('link', '', { dir: dir.trim(), name: name.trim() }, '폴더를 계정으로 연결했어요. 그 폴더의 대화는 "이 맥의 대화 이어 가기" 에 보여요')
    for (const n of r?.notes ?? []) toast(n, { tone: 'bad' })
  }
  const unlink = async (a: Account) => {
    if (await confirmDialog(`${a.name} 연결을 해제할까요?`, { text: '이 맥의 계정 목록에서만 빼요. 그 폴더와 로그인, 대화 기록은 그대로 둬요.', ok: '연결 해제' })) await run('remove', a.id, {}, '연결을 해제했어요')
  }
  const sync = (a: Account) => run('sync', a.id, {}, 'MCP 서버와 폴더 신뢰 설정을 기본 계정에서 다시 가져왔어요')

  return (
    <section className="card-box">
      <div className="hstack" style={{ marginBottom: 8 }}>
        <Icon name={hostIcon(host.kind)} />
        <b className="grow">{host.name}</b>
        {host.online && supported ? (
          <>
            <Button size="sm" icon="link" busy={busy === 'link:'} onClick={link} title="다른 도구가 쓰는 Claude Code 설정 폴더를 그대로 계정으로 써요">
              폴더 연결
            </Button>
            <Button size="sm" icon="plus" busy={busy === 'add:'} onClick={add}>
              계정 추가
            </Button>
          </>
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
                  <b>{a.name}</b> {a.main ? <Badge>기본</Badge> : null} {a.external ? <Badge>연결한 폴더</Badge> : null} {a.missing ? <Badge tone="red">폴더 없음</Badge> : null} {a.loggedIn === false ? <Badge tone="amber">로그인 필요</Badge> : a.loggedIn ? <Badge tone="green">로그인됨</Badge> : null}
                  <div className="muted" style={{ fontSize: 'var(--fs-small)', overflowWrap: 'anywhere' }}>
                    {accountLine(a)}
                    {a.sessions ? ` · 세션 ${a.sessions}개` : ''}
                  </div>
                  {(() => {
                    const e = expiryOf(a)
                    return e ? (
                      <div className={e.tone === 'grey' ? 'muted' : undefined} style={{ fontSize: 'var(--fs-small)', ...(e.tone === 'grey' ? {} : { color: e.tone === 'red' ? 'var(--red)' : 'var(--amber)', fontWeight: 600 }) }}>
                        {e.text}
                      </div>
                    ) : null
                  })()}
                  {a.external && a.dir ? (
                    <div className="muted" style={{ fontSize: 'var(--fs-small)', overflowWrap: 'anywhere' }}>
                      <code>{a.dir}</code>
                    </div>
                  ) : null}
                  {a.external && a.loggedIn === false ? (
                    <div className="muted" style={{ fontSize: 'var(--fs-small)', overflowWrap: 'anywhere' }}>
                      그 폴더를 쓰는 도구에서 로그인하거나, 맥 터미널에서 <code>CLAUDE_CONFIG_DIR={a.dir ?? '<폴더>'} claude auth login</code> 으로 로그인해 주세요.
                    </div>
                  ) : null}
                </div>
                <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {a.external ? (
                    <>
                      <Button size="sm" icon="edit" onClick={() => rename(a)}>
                        이름
                      </Button>
                      <Button size="sm" icon="close" busy={busy === `remove:${a.id}`} onClick={() => unlink(a)}>
                        연결 해제
                      </Button>
                    </>
                  ) : (
                    <>
                      {a.loggedIn ? (
                        <Button size="sm" busy={busy === `logout:${a.id}`} onClick={() => logout(a)}>
                          로그아웃
                        </Button>
                      ) : null}
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
                    </>
                  )}
                </div>
              </div>
              {!a.external ? (
                <div style={{ marginTop: 6 }}>
                  <LoginRenew hostId={host.id} account={a} onAccounts={setList} autoStart={fresh === a.id} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
