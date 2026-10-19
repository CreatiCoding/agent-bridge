// 분할 화면 (REQ-F-786): the panes side by side, a bar above them, and the session picker that 분할로 띄우기 and
// 세션 추가 ask. Each pane is this same page in a frame at a phone's width (lib/split).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { folderPath } from '../lib/format'
import { go, matchRoute } from '../lib/router'
import { look, titleOf } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import { openPreset, pickSession, presetActions, presetLive, presetOf, savePresetAs, SPLIT_MAX, splitUrl, type SplitHost } from '../lib/split'
import type { LiveListen, LivePreview } from '../lib/voice'
import type { VoiceEnd } from '../lib/voice-commands'
import { Button, Empty, IconButton, NO_AUTOFILL, Row } from '../kit'
import { openMenu, Sheet, toast, type MenuEntry } from '../kit/overlay'

interface Pane {
  key: string
  /** Where the frame was first opened; it moves on by itself after that. */
  src: string
  /** The session it shows now (the last one it showed, when it has gone to the list). */
  id: string
}

const paneOf = (id: string): Pane => ({ key: crypto.randomUUID(), src: `/s/${id}`, id })

export function SplitView({ ids, onPanes }: { ids: string[]; onPanes?: (ids: string[]) => void }) {
  const [panes, setPanes] = useState<Pane[]>(() => ids.slice(0, SPLIT_MAX).map(paneOf))
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const latest = useRef(panes)
  latest.current = panes
  const byWindow = (w: Window) => latest.current.find((p) => frames.current.get(p.key)?.contentWindow === w)

  // The address follows the panes in place: a reload or the iOS app's relaunch opens the same ones. Not through
  // navigate: a route change would draw the panes again from the address.
  useEffect(() => {
    onPanes?.(panes.map((p) => p.id))
    const url = splitUrl(panes.map((p) => p.id))
    if (location.pathname + location.search !== url) history.replaceState(history.state, '', url)
  }, [panes, onPanes])

  const add = async () => {
    if (latest.current.length >= SPLIT_MAX) return void toast(`분할 화면은 ${SPLIT_MAX}칸까지예요`)
    const id = await pickSession(latest.current.map((p) => p.id))
    if (id) setPanes((ps) => (ps.length >= SPLIT_MAX ? ps : [...ps, paneOf(id)]))
  }
  // 음성 모드 across the panes (REQ-F-788): the microphone one pane opened, and the pane it is heard into. Every pane
  // is told when either changes; the one heard into is drawn with a ring.
  const voice = useRef<{ listen: LiveListen; preview: LivePreview | null; owner: Window; target: Window } | null>(null)
  const [hearing, setHearing] = useState<Window | null>(null)
  /** The phrase a pane named by voice takes as its panel comes up. */
  const carried = useRef<{ text: string; end: VoiceEnd | null } | null>(null)
  const tell = () => {
    setHearing(voice.current?.target ?? null)
    for (const f of frames.current.values()) f.contentWindow?.dispatchEvent(new Event('cb-split-voice'))
  }
  const voiceEnd = () => {
    const v = voice.current
    if (!v) return
    voice.current = null
    v.listen.close()
    v.preview?.stop()
    tell()
  }
  // Leaving 분할 화면 turns it off.
  useEffect(() => () => voiceEnd(), [])

  const close = (key: string) => {
    // The pane that opened the microphone or is heard into goes: its sound or its words go with it.
    const w = frames.current.get(key)?.contentWindow
    if (w && (voice.current?.owner === w || voice.current?.target === w)) voiceEnd()
    const left = latest.current.filter((p) => p.key !== key)
    // One left is no split: that session opens on its own.
    if (left.length <= 1) return go(left.length ? { name: 'session', id: left[0].id } : { name: 'home' }, { replace: true })
    setPanes(left)
  }

  // Set before the frames' pages run: they read it to know they are panes.
  useLayoutEffect(() => {
    const api: SplitHost = {
      count: () => latest.current.length,
      add: () => void add(),
      close: (w) => {
        const p = byWindow(w)
        if (p) close(p.key)
      },
      full: (w) => {
        const p = byWindow(w)
        if (p) go({ name: 'session', id: p.id })
      },
      moved: (w, path) => {
        const p = byWindow(w)
        const r = matchRoute(path)
        if (p && r?.name === 'session' && r.id !== p.id) setPanes((ps) => ps.map((x) => (x.key === p.key ? { ...x, id: r.id } : x)))
      },
      voice: () => {
        const v = voice.current
        if (!v) return null
        const no = latest.current.findIndex((p) => frames.current.get(p.key)?.contentWindow === v.target) + 1
        return { ...v, targetNo: no }
      },
      voiceStart: (w, listen, preview) => {
        voiceEnd()
        voice.current = { listen, preview, owner: w, target: w }
        tell()
      },
      voiceTarget: (w) => {
        const v = voice.current
        if (!v || v.target === w) return
        // The pane heard into until now keeps what it gathered: it goes into that pane's input (cbVoiceYield).
        ;(v.target as unknown as { cbVoiceYield?: () => void }).cbVoiceYield?.()
        v.target = w
        tell()
      },
      // "두 번째 세션 …" said into another pane (REQ-F-789): that pane hears from now on and takes the phrase.
      voiceRoute: (no, text, end) => {
        const p = latest.current[no - 1]
        const w = p && frames.current.get(p.key)?.contentWindow
        if (!w || !voice.current) return
        carried.current = { text, end }
        api.voiceTarget(w)
      },
      voiceCarry: () => {
        const c = carried.current
        carried.current = null
        return c
      },
      voiceEnd,
    }
    ;(window as unknown as { cbSplit?: SplitHost }).cbSplit = api
    return () => void delete (window as unknown as { cbSplit?: SplitHost }).cbSplit
  })

  // 분할 조합 (REQ-F-790): these panes saved by name, and the other saved sets to open in their place.
  const presets = useStore((s) => s.state?.splits ?? NONE)
  const saved = presetOf(presets, panes.map((p) => p.id))
  // Another set in place of these panes: their 음성 모드 ends with them.
  const swap = (ids: string[]) => {
    voiceEnd()
    setPanes(ids.slice(0, SPLIT_MAX).map(paneOf))
  }
  const presetMenu = (at: HTMLElement) => {
    const others = presets.filter((p) => p !== saved)
    openMenu(
      [
        saved
          ? { label: `'${saved.name}' 저장됨`, icon: 'check', hint: '이 칸들이 저장한 조합이에요', items: presetActions(saved) }
          : { label: '지금 조합 저장', icon: 'plus', hint: '이 칸들을 이름 붙여 저장', onSelect: () => void savePresetAs(panes.map((p) => p.id)) },
        ...(others.length ? (['sep', { header: '저장한 조합' }] as MenuEntry[]) : []),
        ...others.map((p) => ({ label: p.name, icon: 'columns', hint: `${presetLive(p).length}개 세션`, onSelect: () => openPreset(p, swap) })),
      ],
      at,
      '분할 조합',
    )
  }

  return (
    <div className="split">
      <div className="split-bar">
        <IconButton icon="back" label="분할 끝내기" title="분할 끝내기 (첫 칸의 세션으로)" onClick={() => go({ name: 'session', id: panes[0].id })} />
        <b className="split-title">{saved?.name ?? '분할 화면'}</b>
        <span className="muted split-count">
          {panes.length} / {SPLIT_MAX}
        </span>
        <span className="grow" />
        <Button size="sm" icon="columns" className="split-presets" onClick={(e) => presetMenu(e.currentTarget)}>
          조합
        </Button>
        <Button size="sm" icon="plus" disabled={panes.length >= SPLIT_MAX} onClick={() => void add()}>
          세션 추가
        </Button>
      </div>
      <div className="split-panes" style={{ ['--panes' as string]: panes.length }}>
        {panes.map((p, i) => (
          <iframe
            key={p.key}
            ref={(el) => void (el ? frames.current.set(p.key, el) : frames.current.delete(p.key))}
            className={`split-pane${hearing && frames.current.get(p.key)?.contentWindow === hearing ? ' hearing' : ''}`}
            src={p.src}
            title={`분할 ${i + 1}번 칸`}
            allow="microphone; clipboard-read; clipboard-write; fullscreen"
          />
        ))}
      </div>
    </div>
  )
}

/** The session picker: asked by pickSession (분할로 띄우기, 세션 추가). Live sessions, the latest first. */
export function SessionPicker() {
  const [ask, setAsk] = useState<{ exclude: string[]; resolve: (id: string | null) => void } | null>(null)
  const [filter, setFilter] = useState('')
  const sessions = useStore((s) => s.state?.sessions ?? NONE)
  const hosts = useStore((s) => s.state?.hosts ?? NONE)
  useEffect(() => {
    const f = (e: Event) => {
      const d = (e as CustomEvent<{ exclude: string[]; resolve: (id: string | null) => void }>).detail
      setFilter('')
      setAsk((prev) => (prev?.resolve(null), d))
    }
    addEventListener('cb-split-pick', f)
    return () => removeEventListener('cb-split-pick', f)
  }, [])
  const list = useMemo(() => {
    if (!ask) return []
    const q = filter.trim().toLowerCase()
    return sessions
      .filter((s) => !s.closed && !ask.exclude.includes(s.id))
      .filter((s) => !q || `${titleOf(s)} ${s.cwd}`.toLowerCase().includes(q))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  }, [ask, filter, sessions])
  const done = (id: string | null) => {
    ask?.resolve(id)
    setAsk(null)
  }
  return (
    <Sheet open={!!ask} onClose={() => done(null)} title="나란히 띄울 세션" className="split-picker">
      <input className="search" type="search" placeholder="검색" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="이름·폴더 검색" {...NO_AUTOFILL} />
      <div className="split-picker-list" role="list">
        {list.map((s) => {
          const host = hosts.find((h) => h.id === s.hostId)
          const l = look(s, host)
          return (
            <Row
              key={s.id}
              className="split-pick"
              left={<span className={`dot dot-${l.tone}${l.pulse ? ' pulse' : ''}`} />}
              title={titleOf(s)}
              sub={`${l.label}${hosts.length > 1 && host ? ` · ${host.name}` : ''} · ${folderPath(s.cwd, s.home)}`}
              onClick={() => done(s.id)}
            />
          )
        })}
        {!list.length ? (
          <Empty icon="search" title={filter ? '맞는 세션이 없어요' : '더 띄울 세션이 없어요'}>
            {filter ? '다른 말로 찾아보세요.' : '끝나지 않은 세션만 나란히 띄울 수 있어요.'}
          </Empty>
        ) : null}
      </div>
    </Sheet>
  )
}
