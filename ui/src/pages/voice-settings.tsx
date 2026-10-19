// 설정 → 음성 (REQ-F-754): how speech becomes words (the account's: every device records into the same settings),
// how this device records (its own), and the last few results as heard and as tidied, to see what the tidying does.
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { NONE, useStore } from '../lib/store'
import type { Host, VoiceHost, VoicePrefs } from '../lib/types'
import { canPreview, clearVoiceRecent, getVoiceDevice, getVoiceRecent, KEY_LABEL, listMics, micError, setVoiceDevice, setVoicePrefs, useVoicePrefs, type VoiceDevice } from '../lib/voice'
import { Badge, Button, CardHead, Field, LoadError, NO_AUTOFILL, Segmented, Spinner, Switch } from '../kit'
import { toast } from '../kit/overlay'

const MODELS = [
  { value: 'large-v3-turbo-q5_0', label: 'large-v3-turbo (q5, 574 MB) · 기본' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo (1.6 GB)' },
  { value: 'medium', label: 'medium (1.5 GB)' },
  { value: 'small', label: 'small (466 MB) · 빠름, 덜 정확' },
  { value: 'base', label: 'base (142 MB) · 가장 빠름' },
]

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="hstack" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <div className="grow" style={{ minWidth: 160 }}>
        <div style={{ fontSize: 'var(--fs-medium)' }}>{label}</div>
        {hint ? <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** Whether this Mac can turn speech into words the way it is set, and what is missing (REQ-F-758). */
function readiness(h: Host, model: string, denoise: boolean): { tone: 'green' | 'red' | 'amber' | 'grey'; text: string }[] {
  const s = h.voice
  if (!h.online) return [{ tone: 'grey', text: '꺼져 있어요' }]
  if (!s) return [{ tone: 'grey', text: '에이전트를 업데이트하면 준비 상태가 보여요' }]
  if (!s.whisper) return [{ tone: 'red', text: 'whisper.cpp 없음 (brew install whisper-cpp)' }]
  if (!s.models.includes(model)) return [{ tone: 'red', text: `모델 없음 (${model})` }]
  const out: { tone: 'green' | 'red' | 'amber' | 'grey'; text: string }[] = [{ tone: 'green', text: '준비됨' }]
  if (s.vad === 'off') out.push({ tone: 'amber', text: '말소리 감지 꺼짐' })
  else if (s.vad === 'on') out.push({ tone: 'green', text: '말소리 감지 켬' })
  else if (!s.vadModel) out.push({ tone: 'grey', text: '말소리 감지 모델은 처음 쓸 때 받아요' })
  if (denoise && !s.ffmpeg) out.push({ tone: 'grey', text: 'ffmpeg 없음: 잡음은 기본 게이트로 줄여요' })
  return out
}

/** Per Mac: its own model over the account's, and whether it is ready (REQ-F-758). */
function HostsVoice({ account }: { account: VoicePrefs }) {
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  const [over, setOver] = useState<Record<string, VoiceHost> | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const load = () => (setErr(null), get<{ hosts: Record<string, VoiceHost> }>('/api/prefs/voice/hosts').then((r) => setOver(r.hosts), (e) => setErr(e ?? true)))
  useEffect(() => void load(), [])
  if (err) return <LoadError what="맥마다 설정을" error={err} onRetry={load} />
  if (!over) return <Spinner />
  if (!hosts.length) return <p className="muted">연결된 맥이 없어요.</p>
  const save = async (id: string, next: VoiceHost) => {
    try {
      const r = await post<{ ok: true; hosts: Record<string, VoiceHost> }>('/api/prefs/voice/hosts', { host: id, ...next })
      setOver(r.hosts)
      toast('저장했어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  return (
    <div className="stack">
      {hosts.map((h) => {
        const o = over[h.id] ?? { model: '' }
        const model = o.model || account.model
        return (
          <div key={h.id} className="stack" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10, gap: 8 }}>
            <div style={{ fontSize: 'var(--fs-medium)' }}>{h.name}</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {readiness(h, model, account.denoise).map((r) => (
                <Badge key={r.text} tone={r.tone}>
                  {r.text}
                </Badge>
              ))}
            </div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 8 }}>
              <select className="input" style={{ flex: '1 1 180px' }} aria-label={`${h.name} 모델`} value={o.model} onChange={(e) => void save(h.id, { ...o, model: e.target.value })}>
                <option value="">모델: 계정 값 ({account.model})</option>
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AccountVoice() {
  const [v, setV] = useState<VoicePrefs | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const load = () => (setErr(null), get<VoicePrefs>('/api/prefs/voice').then(setV, (e) => setErr(e ?? true)))
  useEffect(() => void load(), [])
  if (err) return <LoadError what="음성 설정을" error={err} onRetry={load} />
  if (!v) return <Spinner />
  const save = async (next: VoicePrefs) => {
    setSaving(true)
    try {
      const r = await post<{ ok: true } & VoicePrefs>('/api/prefs/voice', next)
      const { ok: _ok, ...saved } = r
      setV(saved)
      setVoicePrefs(saved)
      toast('저장했어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setSaving(false)
  }
  return (
    <div className="stack">
      <Row label="음성 입력" hint="켜면 세션 입력창에 마이크 버튼이 생겨요. 누르면 음성 모드: 계속 듣고 말한 글을 모았다가 전송으로 보내요">
        <Switch label="음성 입력 켜기" checked={v.on} onChange={(on) => void save({ ...v, on })} />
      </Row>
      <Field label="모델" hint="세션이 있는 맥에서 whisper.cpp 로 바꿔요. 녹음은 맥 밖으로 나가지 않아요. 모델 파일은 맥의 에이전트 폴더 안 whisper 폴더에 있어야 해요. 없으면 그 자리로 내려받는 명령을 알려 드려요">
        <select className="input" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })}>
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Row label="언어" hint="자동 감지는 2초쯤 더 걸리고 짧은 말은 잘못 고를 수 있어요">
        <Segmented
          label="언어"
          value={v.language}
          onChange={(language) => setV({ ...v, language })}
          options={[
            { value: 'ko', label: '한국어' },
            { value: 'en', label: 'English' },
            { value: 'auto', label: '자동' },
          ]}
        />
      </Row>
      <Row label="잡음 줄이기" hint="맥에서 RNNoise(ffmpeg) 또는 스펙트럼 게이트로. 조용한 곳에서는 끄는 편이 더 정확할 수 있어요">
        <Switch label="잡음 줄이기" checked={v.denoise} onChange={(denoise) => setV({ ...v, denoise })} />
      </Row>
      <Row label="말 다듬기" hint="음·어·그러니까 같은 군말, 되풀이, 문장 부호를 정리해요. 원문은 아래 기록에 같이 남아요">
        <Switch label="말 다듬기" checked={v.tidy} onChange={(tidy) => setV({ ...v, tidy })} />
      </Row>
      <Field label="용어 사전" hint="한 줄에 하나(또는 쉼표). 이 표기로 알아듣고, 이 표기로 고쳐 써요. 예: Agent Bridge, Kubernetes, PR">
        <textarea className="input" {...NO_AUTOFILL} rows={4} value={v.terms} maxLength={4000} onChange={(e) => setV({ ...v, terms: e.target.value })} placeholder={'Agent Bridge\nKubernetes\nworktree'} />
      </Field>
      <div className="hstack" style={{ justifyContent: 'flex-end' }}>
        <Button tone="primary" busy={saving} onClick={() => void save(v)}>
          저장
        </Button>
      </div>
    </div>
  )
}

function DeviceVoice() {
  const [d, setD] = useState<VoiceDevice>(getVoiceDevice)
  const [mics, setMics] = useState<{ id: string; label: string }[] | null>(null)
  const set = (next: VoiceDevice) => (setD(next), setVoiceDevice(next))
  useEffect(() => void listMics().then(setMics, () => setMics([])), [])
  // The names only show once the microphone has been allowed: asking opens it for a moment and closes it.
  const ask = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
      setMics(await listMics())
    } catch (e) {
      toast(micError(e), { tone: 'bad' })
    }
  }
  const named = mics?.some((m) => !m.label.startsWith('마이크 '))
  return (
    <div className="stack">
      <Row label="즉시 받아쓰기" hint={canPreview() ? '말하는 동안 글을 바로 보여 줘요(흐린 글). 이 미리보기는 브라우저가 Apple·Google 서버로 보내서 만들고, 남는 글은 맥의 whisper 가 다시 써요' : '이 브라우저에는 없어요. 말이 끊길 때마다 맥에서 받아쓴 글만 보여요'}>
        <Switch label="즉시 받아쓰기" checked={d.live && canPreview()} disabled={!canPreview()} onChange={(live) => set({ ...d, live })} />
      </Row>
      <Row label="단축키" hint="세션 화면에서 음성 모드를 켜고 꺼요. 음성 모드에서 Enter 는 전송, Esc 는 리셋">
        <Segmented label="단축키" value={d.key} onChange={(key) => set({ ...d, key })} options={(Object.keys(KEY_LABEL) as VoiceDevice['key'][]).map((k) => ({ value: k, label: KEY_LABEL[k] }))} />
      </Row>
      <Field label="마이크">
        <select className="input" value={d.mic} onChange={(e) => set({ ...d, mic: e.target.value })}>
          <option value="">기본 마이크</option>
          {(mics ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      {!named ? (
        <div className="hstack" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={() => void ask()}>
            마이크 이름 불러오기
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Recent() {
  const [list, setList] = useState(getVoiceRecent)
  if (!list.length) return <p className="muted">아직 없어요. 세션에서 마이크로 말하면 여기에 원문과 다듬은 글이 쌓여요(이 기기에만, 최근 20개).</p>
  return (
    <div className="stack">
      {list.map((r) => (
        <div key={r.at} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
          <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
            {new Date(r.at).toLocaleString()} · {r.sec ? `${r.sec.toFixed(1)}초 녹음` : ''}
            {r.ms?.total ? ` · 맥에서 ${(r.ms.total / 1000).toFixed(1)}초` : ''}
          </div>
          <div style={{ fontSize: 'var(--fs-small)' }}>
            <span className="muted">원문</span> {r.raw || '(없음)'}
          </div>
          <div>
            <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
              다듬음
            </span>{' '}
            {r.text || '(없음)'}
          </div>
        </div>
      ))}
      <div className="hstack" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={() => (clearVoiceRecent(), setList([]))}>
          기록 지우기
        </Button>
      </div>
    </div>
  )
}

export function VoiceSettings() {
  const account = useVoicePrefs()
  return (
    <>
      <section className="card-box">
        <CardHead title="음성 입력" help="계정에 저장돼요. 녹음은 세션이 있는 맥으로 가서 글이 되고, 그 글이 보통 메시지처럼 전달돼요. 맥에 whisper.cpp 와 모델이 있어야 해요(README 의 음성 입력)." />
        <AccountVoice />
      </section>
      <section className="card-box">
        <CardHead title="맥마다" help="맥마다 변환 방식과 모델을 따로 고를 수 있어요. 고르지 않으면 위 계정 값을 따라요. 준비 상태는 맥의 에이전트가 알려 줘요." />
        {account ? <HostsVoice account={account} /> : <Spinner />}
      </section>
      <section className="card-box">
        <CardHead title="이 기기" help="이 브라우저에만 저장돼요." />
        <DeviceVoice />
      </section>
      <section className="card-box">
        <CardHead title="최근 결과" help="원문(받아쓴 그대로)과 다듬은 글을 비교해요. 맥의 에이전트 폴더에도 voice.log 로 남아요." />
        <Recent />
      </section>
    </>
  )
}
