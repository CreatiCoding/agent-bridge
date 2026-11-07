// 링크 열기 (REQ-F-881, 설정 → 이 기기): per host, how a phone's in-app browser sheet (REQ-F-879) opens a link —
// 읽기 (the server reads it), 스냅샷 (the session's Mac renders it, then it is read), 미리보기 (the session's local
// preview, localhost only) or 브라우저 (a new tab, no sheet). Kept with the account and saved whole on each change;
// a change shows at once and goes back if saving fails.
import { useState } from 'react'
import { errorText, post } from '../lib/api'
import { getLinkRules, LINK_MODES, LOCAL_RULE_HOSTS, ruleHost, setLinkRules, type LinkMode, type LinkRule } from '../lib/in-app'
import { Button, IconButton, Segmented, TextField } from '../kit'
import { toast } from '../kit/overlay'

const modesFor = (host: string) => LINK_MODES.filter((m) => m.value !== 'preview' || LOCAL_RULE_HOSTS.has(host))

export function LinkRuleSettings() {
  const [rules, setRules] = useState<LinkRule[]>(getLinkRules)
  const [host, setHost] = useState('')
  const [mode, setMode] = useState<LinkMode>('snapshot')
  const save = async (next: LinkRule[]) => {
    const was = rules
    setRules(next)
    setLinkRules(next)
    try {
      const r = await post<{ ok: true; rules: LinkRule[] }>('/api/prefs/linkrules', { rules: next })
      setRules(r.rules)
      setLinkRules(r.rules)
      return true
    } catch (e) {
      setRules(was)
      setLinkRules(was)
      toast(errorText(e), { tone: 'bad' })
      return false
    }
  }
  const add = async () => {
    const h = ruleHost(host)
    if (!h) return toast('호스트 이름을 적어 주세요 (예: example.com, localhost)', { tone: 'bad' })
    const m = mode === 'preview' && !LOCAL_RULE_HOSTS.has(h) ? 'snapshot' : mode
    if (await save([...rules.filter((r) => r.host !== h), { host: h, mode: m }])) setHost('')
  }
  return (
    <div className="stack link-rules">
      {rules.length ? (
        rules.map((r) => (
          <div key={r.host} className="hstack link-rule" style={{ flexWrap: 'wrap' }}>
            <span className="mono grow">{r.host}</span>
            <Segmented label={`${r.host} 여는 방식`} value={r.mode} options={modesFor(r.host)} onChange={(m) => void save(rules.map((x) => (x.host === r.host ? { ...x, mode: m } : x)))} />
            <IconButton icon="trash" label={`${r.host} 규칙 지우기`} onClick={() => void save(rules.filter((x) => x.host !== r.host))} />
          </div>
        ))
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
          규칙이 없어요. 세션 화면에서는 스냅샷(못 만들면 읽기, localhost 는 미리보기), 그 밖에서는 읽기(localhost 는 미리보기)로 열려요.
        </p>
      )}
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <div className="grow" style={{ minWidth: 160 }}>
          <TextField value={host} onChange={setHost} placeholder="example.com" label="호스트" onEnter={() => void add()} />
        </div>
        <Segmented label="새 규칙의 여는 방식" value={mode} options={modesFor(ruleHost(host) ?? '')} onChange={setMode} />
        <Button size="sm" icon="plus" disabled={!host.trim()} onClick={() => void add()}>
          추가
        </Button>
      </div>
    </div>
  )
}
