import { Field, Switch } from '../kit'
import { codexModeParts, codexModeOf, codexOptions } from '../lib/codex-mode'
import { AllowHint } from './auto-allow-confirm'

/**
 * A Codex session's 전부 허용 (REQ-F-856): "" leaves codex's approvals to the person as cards; 안전한 전부 허용 has the
 * Mac answer them except risky calls; 전부 허용 answers them all. Claude Code's other permission modes are not codex's.
 */
export function CodexAllowField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="권한 모드" hint={value ? <AllowHint mode={value} /> : 'Codex 의 승인 창을 권한 카드로 물어요'}>
      <select className={`input${value === 'allowAll' ? ' input-allow-all' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">묻기 (권한 카드)</option>
        <option value="autoAllow">안전한 전부 허용</option>
        <option value="allowAll" className="opt-allow-all">
          전부 허용
        </option>
      </select>
    </Field>
  )
}

/**
 * A Codex session's sandbox and approval (REQ-F-854), picked like Claude Code's permission mode. "" in either is
 * codex's own default (config.toml); the network switch is there only for workspace-write. The value is the one
 * string the server and the Mac take (`<sandbox>:<approval>[:net]`).
 */
export function CodexModeFields({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = codexModeParts(value)
  const o = codexOptions()
  const set = (p: Partial<typeof m>) => onChange(codexModeOf({ ...m, ...p }))
  return (
    <>
      <Field label="샌드박스" hint="read-only 면 파일을 바꿀 수 없어요. workspace-write 는 이 폴더 안에서만 써요">
        <select className="input" value={m.sandbox} onChange={(e) => set({ sandbox: e.target.value, network: e.target.value === 'workspace-write' && m.network })}>
          <option value="">Codex 기본값 (config.toml)</option>
          {o.sandboxes.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      {m.sandbox === 'workspace-write' && o.network ? (
        <div className="setting-line">
          <span className="grow">샌드박스 안에서 네트워크 허용</span>
          <Switch label="샌드박스 안에서 네트워크 허용" checked={m.network} onChange={(on) => set({ network: on })} />
        </div>
      ) : null}
      <Field label="승인" hint="on-request 는 필요할 때 권한 카드로 물어요. never 는 묻지 않고 실패를 그대로 모델에 돌려줘요">
        <select className="input" value={m.approval} onChange={(e) => set({ approval: e.target.value })}>
          <option value="">Codex 기본값 (config.toml)</option>
          {o.approvals.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}
