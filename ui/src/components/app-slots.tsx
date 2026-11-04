// The app's own slots (REQ-F-863): app.rail.items on the PC's rail and app.menu.items in the app menu. An added item
// is data (AppItem), so the rail and the menu draw the same label, icon, badge and state, and run the same action.
import { Fragment, type ReactNode } from 'react'
import { IconButton, type IconName } from '../kit'
import type { MenuEntry, MenuItem } from '../kit/overlay'
import { resolve, type AppCtx, type AppItem, type SlotItem } from '../lib/slots'
import { slotFailed, useSlots } from '../lib/slot-view'

type Raw = { raw?: unknown }
const isApp = (i: SlotItem): i is AppItem => typeof i.label === 'string' && typeof i.run === 'function'
const badgeText = (b: AppItem['badge']) => (b === 'new' ? 'NEW' : typeof b === 'number' && b > 0 ? (b > 99 ? '99+' : String(b)) : '')
const blocked = (i: AppItem) => !!i.disabled || (i.busy != null && i.busy !== false)
const why = (i: AppItem) => (typeof i.disabled === 'string' ? i.disabled : i.busy != null && i.busy !== false ? (typeof i.busy === 'number' ? `진행 중 ${Math.round(i.busy * 100)}%` : '진행 중') : undefined)

function run(i: AppItem, ctx: AppCtx) {
  if (blocked(i)) return
  try {
    i.run(ctx)
  } catch (e) {
    slotFailed(String(i.extId ?? ''), `${ctx.place === 'rail' ? 'app.rail.items' : 'app.menu.items'}/${i.id}`, e)
  }
}

/** One added item on the rail: an icon button with its badge, its state said in its name. */
function RailButton({ item, ctx }: { item: AppItem; ctx: Omit<AppCtx, 'place'> }) {
  const text = badgeText(item.badge)
  const state = why(item)
  const label = `${item.label}${text ? ` · ${text === 'NEW' ? '새 소식' : `${text}개`}` : item.badge === 'dot' ? ' · 새 소식' : ''}${state ? ` · ${state}` : ''}`
  return (
    <span className="relative">
      <IconButton icon={item.icon as IconName} label={label} active={!!item.active} disabled={blocked(item)} aria-busy={item.busy != null && item.busy !== false} onClick={() => run(item, { ...ctx, place: 'rail' })} />
      {text ? <span className={`count${text === 'NEW' ? ' count-new' : ''}`} aria-hidden>{text}</span> : item.badge === 'dot' ? <span className="count count-dot" aria-hidden /> : null}
    </span>
  )
}

/** The rail's entries (each the page's own button under its id, `grow` the gap) with the added ones in place. */
export function RailSlot({ entries, ctx }: { entries: ({ id: string; node: ReactNode } | 'grow')[]; ctx: Omit<AppCtx, 'place'> }) {
  useSlots()
  const list = resolve<({ id: string; node: ReactNode } & Raw) | 'grow' | AppItem>(
    'app.rail.items',
    entries,
    (b) => (b === 'grow' ? null : ({ id: b.id, raw: b } as SlotItem)),
    (i) => (isApp(i) ? i : ((i as Raw).raw as { id: string; node: ReactNode })),
  )
  return (
    <>
      {list.map((e, n) =>
        e === 'grow' ? <span key={`grow${n}`} className="grow" /> : 'node' in e ? <Fragment key={e.id}>{e.node as ReactNode}</Fragment> : <RailButton key={e.id} item={e as AppItem} ctx={ctx} />,
      )}
    </>
  )
}

/** The app menu's entries with the added ones in place; `wide` leaves out the items meant only for a phone. */
export function menuWithSlot(entries: MenuEntry[], ctx: Omit<AppCtx, 'place'>): MenuEntry[] {
  const SKIP = 'skip' as unknown as MenuEntry
  return resolve<MenuEntry>(
    'app.menu.items',
    entries,
    (b) => (typeof b === 'object' && 'id' in b && b.id ? ({ id: b.id, raw: b } as SlotItem) : null),
    (i, builtin) => {
      if (!isApp(i)) return builtin ? ((i as Raw).raw as MenuEntry) : SKIP
      if (ctx.wide && !i.wide && !builtin) return SKIP
      const text = badgeText(i.badge)
      const m: MenuItem = {
        id: i.id,
        label: text || i.badge === 'dot' ? <>{i.label} <span className={`menu-badge${text ? '' : ' menu-dot'}`}>{text}</span></> : i.label,
        icon: i.icon as IconName,
        checked: i.active || undefined,
        disabled: blocked(i),
        hint: why(i) ?? i.hint,
        onSelect: () => run(i, { ...ctx, place: 'menu' }),
      }
      return m
    },
  ).filter((e) => e !== SKIP)
}

/** Whether an added app menu item has a badge: the phone's ⋯ button then shows a dot, so it is not missed. */
export function useMenuBadge() {
  useSlots()
  return resolve<SlotItem>('app.menu.items', [], () => null, (i) => i).some((i) => isApp(i) && (i.badge === 'dot' || i.badge === 'new' || (typeof i.badge === 'number' && i.badge > 0)))
}
