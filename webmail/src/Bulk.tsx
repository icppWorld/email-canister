// Ticking messages in a list for an action on all of them: the row's box,
// and the list's bar along the top, which, while any are ticked, says how
// many and what can be done to them. At phone width the boxes wait for
// selection mode.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { AppBar, usePhone } from './AppBar'
import { IconButton } from './Buttons'
import { Icon, type IconName } from './Icon'
import { Menu } from './Menu'

export type BulkAction = {
  label: string
  icon: IconName
  danger?: true // it cannot be undone
  run: () => void
}

// The messages ticked among `ids`, the ones listed that can be ticked
export function useTicks(ids: bigint[]) {
  const [checked, setChecked] = useState<ReadonlySet<bigint>>(new Set())
  // Only listed mail stays ticked: mail that leaves the list, as after a
  // search or a reload, or that can no longer be ticked, comes back unticked
  const listed = ids.join(' ')
  const [shown, setShown] = useState(listed)
  if (listed !== shown) {
    setShown(listed)
    const now = new Set(ids)
    setChecked((before) => new Set([...before].filter((id) => now.has(id))))
  }
  // The ids listed now: a handler made before a change, as a long press's
  // timer, which mail that started sending meanwhile, asks these
  const current = useRef(ids)
  useLayoutEffect(() => {
    current.current = ids
  })
  // Mail being taken off the list leaves its tick at once
  const untick = useCallback(
    (gone: ReadonlySet<bigint>) =>
      setChecked(
        (before) => new Set([...before].filter((id) => !gone.has(id)))
      ),
    []
  )
  return {
    ticked: ids.filter((id) => checked.has(id)),
    total: ids.length,
    has: (id: bigint) => checked.has(id),
    can: (id: bigint) => current.current.includes(id),
    // Only mail that can be ticked now is
    tick: (id: bigint, on: boolean) => {
      if (on && !current.current.includes(id)) return
      setChecked((before) => {
        const next = new Set(before)
        if (on) next.add(id)
        else next.delete(id)
        return next
      })
    },
    all: (on: boolean) => setChecked(new Set(on ? ids : [])),
    untick,
  }
}

export type Ticks = ReturnType<typeof useTicks>

// A row's box; the label is its larger touch target
export function RowPick({
  ticks,
  id,
  name,
  disabled = false,
}: {
  ticks: Ticks
  id: bigint
  name: string // says which message
  disabled?: boolean
}) {
  return (
    <label className="pick-area">
      <input
        type="checkbox"
        className="pick"
        aria-label={`Select ${name}`}
        checked={!disabled && ticks.has(id)}
        disabled={disabled}
        onChange={(e) => ticks.tick(id, e.target.checked)}
      />
    </label>
  )
}

// How long a row is held to start selection mode, and how far the pointer
// may move meanwhile, as a scroll moves it further
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10

// Selection mode, at phone width: a long press on a row starts it with that
// row ticked, as does the browser's own long press on a touch screen, or a
// right click, and the list's ⋮ starts it with none. A tap on a row then
// ticks it rather than opening it. A row that cannot be ticked, as mail being
// sent, does neither. Leaving it, or phone width, unticks them all. Wider,
// where the rows' boxes show, any box ticked is selecting, and the ⋮ has
// Select all in its place.
export function useSelectMode(ticks: Ticks) {
  const [on, setOn] = useState(false)
  const phone = usePhone()
  const timer = useRef<number | undefined>(undefined)
  const from = useRef({ x: 0, y: 0 })
  // The press ran its full time: the click that ends it opens nothing
  const fired = useRef(false)
  // Nothing to do while no press is pending
  const cancel = () => {
    if (timer.current === undefined) return
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => cancel, [])
  // A press pending as the page leaves phone width starts nothing
  useEffect(() => {
    if (phone) return
    window.clearTimeout(timer.current)
    timer.current = undefined
  }, [phone])
  if (on && !phone) {
    setOn(false)
    ticks.all(false)
  }
  const press = (id: bigint) => {
    cancel()
    if (!ticks.can(id)) return
    fired.current = true
    setOn(true)
    ticks.tick(id, true)
  }
  return {
    on,
    // The selection bar shows
    selecting: phone ? on : ticks.ticked.length > 0,
    // The list's ⋮ item that starts selecting
    entry: phone
      ? ({
          label: 'Select messages',
          icon: 'select',
          run: () => {
            fired.current = false
            setOn(true)
          },
        } satisfies BulkAction)
      : selectAll(ticks),
    exit: () => {
      cancel()
      fired.current = false
      setOn(false)
      ticks.all(false)
    },
    // A row's button: open is what a tap does outside selection mode
    row: (id: bigint, open: () => void) => ({
      onPointerDown: (e: PointerEvent) => {
        fired.current = false
        cancel()
        if (e.button !== 0 || !e.isPrimary || !phone) return
        from.current = { x: e.clientX, y: e.clientY }
        // Its click opens nothing, also on a row that cannot be ticked
        timer.current = window.setTimeout(() => {
          fired.current = true
          press(id)
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e: PointerEvent) => {
        if (timer.current === undefined) return
        const moved = Math.hypot(
          e.clientX - from.current.x,
          e.clientY - from.current.y
        )
        if (moved > LONG_PRESS_SLOP) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      // In place of the browser's own menu
      onContextMenu: (e: MouseEvent) => {
        if (!phone) return
        e.preventDefault()
        press(id)
      },
      onClick: (e: MouseEvent) => {
        // A key's click (detail 0) ends no press
        const ending = fired.current && e.detail > 0
        fired.current = false
        if (ending) return
        if (on && phone) {
          ticks.tick(id, !ticks.has(id))
        } else {
          open()
        }
      },
    }),
  }
}

export type SelectMode = ReturnType<typeof useSelectMode>

const selectAll = (ticks: Ticks): BulkAction => ({
  label: 'Select all',
  icon: 'selectAll',
  run: () => ticks.all(true),
})

// The bar along the top while messages are ticked, or in selection mode: ✕
// to untick them all, how many are ticked, the actions, and a ⋮ with Select
// all (AppBar keeps ☰ before the ✕ where there is room); at phone width the
// first two actions, with the rest in the ⋮
export function SelectionBar({
  ticks,
  actions,
  onExit,
  ref,
}: {
  ticks: Ticks
  actions: BulkAction[]
  onExit: () => void
  ref?: Ref<HTMLDivElement>
}) {
  const ticked = ticks.ticked.length
  const none = ticked === 0
  const inBar = usePhone() ? 2 : actions.length
  return (
    <AppBar
      ref={ref}
      label="Selected messages"
      lead={<IconButton label="Stop selecting" icon="close" onClick={onExit} />}
      title={`${ticked} selected`}
    >
      {actions.slice(0, inBar).map((action) => (
        <IconButton
          key={action.label}
          variant={action.danger ? 'danger' : undefined}
          label={action.label}
          icon={action.icon}
          disabled={none}
          onClick={action.run}
        />
      ))}
      <Menu label="Selection actions">
        <MenuAction
          action={selectAll(ticks)}
          disabled={ticks.total === 0 || ticked === ticks.total}
        />
        {actions.slice(inBar).map((action) => (
          <MenuAction key={action.label} action={action} disabled={none} />
        ))}
      </Menu>
    </AppBar>
  )
}

// A list's bar along the top: the page's bar with the page's own buttons
// and the list's ⋮, or the selection bar while messages are ticked, which at
// phone width is selection mode. As one takes the other's place at phone
// width, the focus goes to ✕, or back to the ⋮; at a wider one, where a
// row's box ticks and keeps the focus, only focus the swap took moves. At
// phone width it gives way to the reader's toolbar while a message is open.
export function ListBar({
  select,
  ticks,
  actions,
  listed,
  empty,
  bare = false,
  reading,
  items,
  children,
}: {
  select: SelectMode
  ticks: Ticks
  actions: BulkAction[] // for the mail ticked
  listed: boolean // the list shows mail
  empty?: BulkAction
  bare?: boolean // as AppBar's
  reading: boolean // a message is open beside the list
  items?: ReactNode // the page's own, first in the ⋮
  children?: ReactNode // the page's own buttons, before the ⋮
}) {
  const phone = usePhone()
  const { selecting } = select
  const bar = useRef<HTMLDivElement>(null)
  const wasSelecting = useRef(selecting)
  useEffect(() => {
    if (wasSelecting.current === selecting) return
    wasSelecting.current = selecting
    // Each bar is a new element: a focus it held is lost with the other
    if (!phone && document.activeElement !== document.body) return
    const to = selecting ? 'Stop selecting' : 'List actions'
    bar.current?.querySelector<HTMLElement>(`[aria-label="${to}"]`)?.focus()
  }, [selecting, phone])
  if (phone && reading) return null
  if (selecting) {
    return (
      <SelectionBar
        ref={bar}
        ticks={ticks}
        actions={actions}
        onExit={select.exit}
      />
    )
  }
  return (
    <AppBar ref={bar} bare={bare}>
      {children}
      <ListMenu listed={listed} select={select.entry} empty={empty}>
        {items}
      </ListMenu>
    </AppBar>
  )
}

// An action as an item of a ⋮ menu
export function MenuAction({
  action,
  disabled = false,
}: {
  action: BulkAction
  disabled?: boolean
}) {
  return (
    <button disabled={disabled} onClick={action.run}>
      <Icon name={action.icon} />
      {action.label}
    </button>
  )
}

// A list's ⋮ in the bar along the top: the page's own items, Select
// messages, or Select all where the rows' boxes show, and the action that
// empties the folder, while it lists mail
export function ListMenu({
  listed,
  select,
  empty,
  children,
}: {
  listed: boolean // the list shows mail
  select: BulkAction
  empty?: BulkAction
  children?: ReactNode
}) {
  return (
    <Menu label="List actions">
      {children}
      <MenuAction action={select} disabled={!listed} />
      {listed && empty && <MenuAction action={empty} />}
    </Menu>
  )
}
