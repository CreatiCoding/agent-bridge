// The example extension: one use of each part of the API.
//  - composer.actions: a "? 붙여 보내기" button (and Alt+Shift+Q) that sends the box's text with a "?" added
//  - session.menu + ui.sheet + storage.user: a note per session
//  - session-list.row.badges + data.shared: a badge on the sessions that have a note
//  - settings.section: a switch for the turn-end notice
//  - session.done + events.claim: that notice, once per person however many pages are open
//  - renderer.block: a ```checklist block drawn as check boxes
import type { Bridge, ComposerCtx, SessionDone, SessionMenuCtx, Session } from '../../agent-bridge-ext'
import { Fragment, h, setReact } from './jsx.js'

export default function setup(bridge: Bridge) {
  setReact(bridge.React)
  const { useState, useEffect } = bridge.React
  const { IconButton, Badge, Switch, Field, TextField, Button } = bridge.kit
  const { t } = bridge.i18n
  const notes = bridge.storage.user
  const noteKey = (sid: string) => `note.${sid}`

  // ---------- ? 붙여 보내기 ----------

  const ask = (c: ComposerCtx) => {
    const text = c.text.trim()
    if (!text) return
    void bridge.actions.dispatch('composer.submit', { sid: c.sid, text: text.endsWith('?') ? text : `${text}?` })
  }
  bridge.slots.register('composer.actions', {
    id: 'ask',
    order: { before: 'send' },
    render: () => {
      const c = bridge.slots.useSlotContext<ComposerCtx>()
      return <IconButton icon="info" label={t('ask')} keepFocus disabled={c.disabled || !c.text.trim()} onClick={() => ask(c)} />
    },
    menu: { label: t('ask'), icon: 'info', enabled: (c) => !!c.text.trim(), run: ask },
  })
  bridge.commands.register({
    id: 'ask',
    title: t('ask'),
    keys: 'Alt+Shift+Q',
    when: (ctx) => ctx.focused === 'composer',
    run: (ctx) => ask(ctx.composer as ComposerCtx),
  })

  // ---------- a note per session ----------

  // Every page that shows the list shares one fetch of which sessions have a note.
  const useNoted = () => bridge.data.shared('noted', () => notes.list('note.'), 30_000) ?? []

  function NoteSheet({ sid, close }: { sid: string; close: () => void }) {
    const [text, setText] = useState('')
    const [version, setVersion] = useState<number | undefined>()
    useEffect(() => {
      void notes.get(noteKey(sid)).then((it) => {
        if (!it) return
        setText(String(it.value))
        setVersion(it.version)
      })
    }, [sid])
    const save = async () => {
      // ifVersion: another page that saved meanwhile is not overwritten (it throws instead).
      if (text.trim()) await notes.set(noteKey(sid), text, version === undefined ? {} : { ifVersion: version })
      else await notes.delete(noteKey(sid))
      bridge.ui.toast(t('saved'), { tone: 'ok' })
      close()
    }
    return (
      <>
        <Field>
          <TextField value={text} onChange={setText} rows={5} placeholder={t('notePlaceholder')} autoFocus />
        </Field>
        <Button tone="primary" block onClick={() => void save()}>
          {t('save')}
        </Button>
      </>
    )
  }
  bridge.slots.register('session.menu', {
    id: 'note',
    order: { after: 'rename' },
    label: t('note'),
    icon: 'doc',
    run: (ctx: SessionMenuCtx) => bridge.ui.sheet.open(NoteSheet, { sid: ctx.sid }, { title: t('noteTitle') }),
  })
  bridge.slots.register('session-list.row.badges', {
    id: 'note',
    render: () => {
      const { session } = bridge.slots.useSlotContext<{ session: Session }>()
      return useNoted().includes(noteKey(session.id)) ? <Badge tone="blue">{t('note')}</Badge> : null
    },
  })

  // ---------- turn-end notice ----------

  let notify = false
  void notes.get('notify').then((it) => (notify = it?.value === true))
  function NotifySetting() {
    const [on, setOn] = useState(notify)
    const change = (v: boolean) => {
      setOn((notify = v))
      void notes.set('notify', v)
    }
    return (
      <Field hint={t('notifyHint')}>
        <Switch checked={on} onChange={change} label={t('notifyDone')} />
      </Field>
    )
  }
  bridge.slots.register('settings.section', { id: 'notify', tab: 'plugins', render: () => <NotifySetting /> })
  // primaryOnly: one page of this browser; claim: one browser of this person (a phone and a Mac both open).
  bridge.actions.after(
    'session.done',
    (ev: SessionDone) => {
      if (!notify) return
      void bridge.events.claim(ev.id).then((first) => first && bridge.ui.toast(`${t('done')}: ${ev.session.title || ev.session.cwd}`))
    },
    { primaryOnly: true },
  )

  // ---------- ```checklist ----------

  // "- [x] done" / "- [ ] to do" lines; anything else goes on to the page's own drawing.
  function Checklist({ text }: { text: string }) {
    const items = text.split('\n').map((l) => /^\s*[-*] \[( |x|X)\] (.*)$/.exec(l)).filter((m) => m !== null)
    return (
      <ul className="md-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
        {items.map((m, i) => (
          <li key={i}>
            <input type="checkbox" checked={m[1] !== ' '} readOnly /> {m[2]}
          </li>
        ))}
      </ul>
    )
  }
  bridge.actions.around('renderer.block', (a, next) => (a.lang === 'checklist' && a.closed ? <Checklist text={a.text} /> : next(a)))
}
