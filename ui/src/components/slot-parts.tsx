// Drawing the slots of REQ-F-865 the same way everywhere: `action` items as buttons in a row (more than fit go into
// a ⋯ menu), `menu` items as menu rows, `section` and `badge` items as their own drawings under the slot's context.
// An item that throws while deciding, drawing or running is left out or ignored and reported to its extension.
import { Fragment, useMemo, type ReactNode } from 'react'
import { IconButton, type IconName } from '../kit'
import { openMenu, type MenuEntry, type MenuItem } from '../kit/overlay'
import { resolve, type ActionItem, type SlotItem, type SlotName } from '../lib/slots'
import { slotFailed, SlotContext, SlotRender, useSlots } from '../lib/slot-view'

/** What an item with a count, a dot or NEW shows; nothing for null or 0. */
export const badgeText = (b: ActionItem['badge']) => (b === 'new' ? 'NEW' : typeof b === 'number' && b > 0 ? (b > 99 ? '99+' : String(b)) : '')
/** Not pressable: disabled, or still working (so it does not run twice). */
export const blocked = (i: { disabled?: ActionItem['disabled']; busy?: ActionItem['busy'] }) => !!i.disabled || (i.busy != null && i.busy !== false)
/** Why it is not pressable, in words. */
export const why = (i: { disabled?: ActionItem['disabled']; busy?: ActionItem['busy'] }) =>
  typeof i.disabled === 'string' ? i.disabled : i.busy != null && i.busy !== false ? (typeof i.busy === 'number' ? `진행 중 ${Math.round(i.busy * 100)}%` : '진행 중') : undefined
/** The button's name: its label with its badge and state, so a screen reader hears all of it. */
export const spoken = (i: ActionItem) => {
  const t = badgeText(i.badge)
  const s = why(i)
  return `${i.label}${t ? ` · ${t === 'NEW' ? '새 소식' : `${t}개`}` : i.badge === 'dot' ? ' · 새 소식' : ''}${s ? ` · ${s}` : ''}`
}

const isAction = (i: SlotItem): i is ActionItem => typeof i.label === 'string' && typeof i.run === 'function'

/** The items added to a slot as they are now (order, replace and hide applied). Redraws when they change. */
export function useAdded<T extends SlotItem = SlotItem>(slot: SlotName): T[] {
  useSlots()
  return added<T>(slot)
}
export const added = <T extends SlotItem = SlotItem>(slot: SlotName): T[] => resolve<SlotItem>(slot, [], () => null, (i) => i) as T[]

function visibleIn<C>(slot: SlotName, list: SlotItem[], ctx: C): ActionItem<C>[] {
  return list.filter(isAction).filter((i) => {
    if (!i.visible) return true
    try {
      return !!i.visible(ctx)
    } catch (e) {
      slotFailed(String(i.extId ?? ''), `${slot}/${i.id} visible`, e)
      return false
    }
  }) as ActionItem<C>[]
}

export function runItem<C>(slot: SlotName, i: ActionItem<C>, ctx: C) {
  if (blocked(i)) return
  try {
    i.run(ctx)
  } catch (e) {
    slotFailed(String(i.extId ?? ''), `${slot}/${i.id}`, e)
  }
}

const menuRow = <C,>(slot: SlotName, i: ActionItem<C>, ctx: C): MenuItem => {
  const t = badgeText(i.badge)
  return {
    id: i.id,
    label: t || i.badge === 'dot' ? <>{i.label} <span className={`menu-badge${t ? '' : ' menu-dot'}`}>{t}</span></> : i.label,
    icon: i.icon as IconName,
    checked: i.active || undefined,
    disabled: blocked(i),
    danger: i.danger,
    hint: why(i) ?? i.hint,
    onSelect: () => runItem(slot, i, ctx),
  }
}

/** A `menu` slot's items as menu rows for ctx (a separator first when there are any and `sep` is set). */
export function slotMenu<C>(slot: SlotName, ctx: C, sep = true): MenuEntry[] {
  const rows = visibleIn(slot, added(slot), ctx).map((i) => menuRow(slot, i, ctx))
  return rows.length && sep ? ['sep', ...rows] : rows
}

/** One `action` item as an icon button with its badge. */
export function ActionButton<C>({ slot, item, ctx }: { slot: SlotName; item: ActionItem<C>; ctx: C }) {
  const t = badgeText(item.badge)
  return (
    <span className="relative slot-action">
      <IconButton
        icon={item.icon as IconName}
        label={spoken(item as ActionItem)}
        active={!!item.active}
        disabled={blocked(item)}
        aria-busy={item.busy != null && item.busy !== false}
        onClick={(e) => {
          // Inside a row that is a link or opens something: the button is its own.
          e.preventDefault()
          e.stopPropagation()
          runItem(slot, item, ctx)
        }}
      />
      {t ? <span className={`count${t === 'NEW' ? ' count-new' : ''}`} aria-hidden>{t}</span> : item.badge === 'dot' ? <span className="count count-dot" aria-hidden /> : null}
    </span>
  )
}

/**
 * An `action` slot as buttons: the first `max` visible ones, the rest in a ⋯ menu so a narrow row does not
 * overflow. Nothing at all when nothing is added.
 */
export function SlotActions<C>({ slot, ctx, max = 2 }: { slot: SlotName; ctx: C; max?: number }) {
  const list = visibleIn(slot, useAdded(slot), ctx)
  if (!list.length) return null
  const shown = list.length > max ? list.slice(0, Math.max(0, max - 1)) : list
  const rest = list.slice(shown.length)
  return (
    <span className="slot-actions" data-slot={slot}>
      {shown.map((i) => (
        <ActionButton key={i.id} slot={slot} item={i} ctx={ctx} />
      ))}
      {rest.length ? (
        <span className="relative slot-action">
          <IconButton
            icon="more"
            label={`더 보기 ${rest.length}개`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openMenu(
                rest.map((i) => menuRow(slot, i, ctx)),
                e.currentTarget,
              )
            }}
          />
          {rest.some((i) => badgeText(i.badge) || i.badge === 'dot') ? <span className="count count-dot" aria-hidden /> : null}
        </span>
      ) : null}
    </span>
  )
}

/** A `section` slot: each added drawing under the slot's context, stacked. Nothing when nothing is added. */
export function SlotSections<C>({ slot, ctx, className = 'slot-sections' }: { slot: SlotName; ctx: C; className?: string }) {
  const list = useAdded<SlotItem & { render: () => ReactNode }>(slot)
  const value = useMemo(() => ctx, [ctx])
  if (!list.length) return null
  return (
    <SlotContext.Provider value={value}>
      <div className={className} data-slot={slot}>
        {list.map((i) => (
          <SlotRender key={i.id} render={i.render} owner={i.extId as string | undefined} />
        ))}
      </div>
    </SlotContext.Provider>
  )
}

/** A `badge` slot: the first `max` drawings inline, then +n. */
export function SlotBadges<C>({ slot, ctx, max = 2 }: { slot: SlotName; ctx: C; max?: number }) {
  const list = useAdded<SlotItem & { render: () => ReactNode }>(slot)
  if (!list.length) return null
  return (
    <SlotContext.Provider value={ctx}>
      {list.slice(0, max).map((i) => (
        <Fragment key={i.id}>
          <SlotRender render={i.render} owner={i.extId as string | undefined} />
        </Fragment>
      ))}
      {list.length > max ? <span className="badge">+{list.length - max}</span> : null}
    </SlotContext.Provider>
  )
}
