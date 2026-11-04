// session-create.fields (REQ-F-865): an extension's own fields on the new session page. Each extension sees and
// sets only its own values (kept under its id), never the page's (host, folder, model, mode, account): those go to
// the server, the extensions' values only to their own session.create hooks (args.ext).
import { useMemo, type ReactNode } from 'react'
import { added, useAdded } from './slot-parts'
import { SlotContext, SlotRender, slotFailed } from '../lib/slot-view'
import type { SlotItem } from '../lib/slots'

type Values = Record<string, Record<string, unknown>>
interface FieldItem extends SlotItem {
  render: () => ReactNode
  /** What is wrong with this extension's values (shown, and the start waits), or nothing. */
  validate?: (values: Record<string, unknown>, draft: unknown) => string | null | undefined
}

function One({ item, values, onChange, draft }: { item: FieldItem; values: Values; onChange: (v: Values) => void; draft: unknown }) {
  const ext = String(item.extId ?? '')
  const mine = values[ext] ?? {}
  const ctx = useMemo(
    () => ({
      draft,
      values: mine,
      set: (name: string, value: unknown) => onChange({ ...values, [ext]: { ...mine, [name]: value } }),
    }),
    [draft, mine, values, ext, onChange],
  )
  return (
    <SlotContext.Provider value={ctx}>
      <SlotRender render={item.render} owner={ext} />
    </SlotContext.Provider>
  )
}

export function ExtCreateFields({ values, onChange, draft }: { values: Values; onChange: (v: Values) => void; draft: unknown }) {
  const list = useAdded<FieldItem>('session-create.fields')
  if (!list.length) return null
  return (
    <div className="slot-sections" data-slot="session-create.fields">
      {list.map((i) => (
        <One key={`${i.extId}/${i.id}`} item={i} values={values} onChange={onChange} draft={draft} />
      ))}
    </div>
  )
}

/** The first thing an extension's field says is wrong, or null. A validate that throws is reported and passes. */
export function createFieldError(values: Values, draft: unknown): string | null {
  for (const i of added<FieldItem>('session-create.fields')) {
    if (typeof i.validate !== 'function') continue
    try {
      const why = i.validate(values[String(i.extId ?? '')] ?? {}, draft)
      if (why) return String(why)
    } catch (e) {
      slotFailed(String(i.extId ?? ''), `session-create.fields/${i.id} validate`, e)
    }
  }
  return null
}
