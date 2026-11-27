// Ticking messages in a list for an action on all of them: the row's box,
// and the bar above the list with Select all, how many are ticked, and what
// can be done to them. With none ticked, the bar can offer to empty the
// folder. At phone width the boxes and that bar wait for selection mode,
// whose actions take the place of the bar along the top.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

import { AppBar, phoneWidth } from './AppBar'
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
    tick: (id: bigint, on: boolean) =>
      setChecked((before) => {
        const next = new Set(before)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
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

export function Bulk({
  ticks,
  actions,
  empty,
}: {
  ticks: Ticks
  actions: BulkAction[]
  empty?: BulkAction
}) {
  const ticked = ticks.ticked.length
  const all = ticks.total > 0 && ticked === ticks.total
  const shown = ticked > 0 ? actions : empty ? [empty] : []
  return (
    <div className="bulk" role="toolbar" aria-label="Selected messages">
      <input
        ref={(box) => {
          if (box) box.indeterminate = ticked > 0 && !all
        }}
        type="checkbox"
        aria-label="Select all"
        checked={all}
        onChange={(e) => ticks.all(e.target.checked)}
      />
      {ticked > 0 && <span className="hint">{ticked} selected</span>}
      {shown.map((action) => (
        <IconButton
          key={action.label}
          variant={action.danger ? 'danger' : undefined}
          label={action.label}
          icon={action.icon}
          onClick={action.run}
        />
      ))}
    </div>
  )
}

// How long a row is held to start selection mode, and how far the pointer
// may move meanwhile, as a scroll moves it further
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10

// Selection mode, at phone width: a long press on a row starts it with that
// row ticked, as does the browser's own long press on a touch screen, or a
// right click, and the list's ⋮ starts it with none. A tap on a row then
// ticks it rather than opening it. Leaving it unticks them all.
export function useSelectMode(ticks: Ticks) {
  const [on, setOn] = useState(false)
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
  const press = (id: bigint) => {
    cancel()
    fired.current = true
    setOn(true)
    ticks.tick(id, true)
  }
  return {
    on,
    start: () => setOn(true),
    exit: () => {
      setOn(false)
      ticks.all(false)
    },
    // A row's button: open is what a tap does outside selection mode
    row: (id: bigint, open: () => void) => ({
      onPointerDown: (e: PointerEvent) => {
        fired.current = false
        cancel()
        if (e.button !== 0 || !e.isPrimary || !phoneWidth.matches) return
        from.current = { x: e.clientX, y: e.clientY }
        timer.current = window.setTimeout(() => press(id), LONG_PRESS_MS)
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
        if (!phoneWidth.matches) return
        e.preventDefault()
        press(id)
      },
      onClick: () => {
        if (fired.current) {
          fired.current = false
        } else if (on && phoneWidth.matches) {
          ticks.tick(id, !ticks.has(id))
        } else {
          open()
        }
      },
    }),
  }
}

// The bar along the top in selection mode: ✕ to leave it, how many are
// ticked, the first two actions, and a ⋮ with Select all and the rest
export function SelectionBar({
  ticks,
  actions,
  onExit,
}: {
  ticks: Ticks
  actions: BulkAction[]
  onExit: () => void
}) {
  const ticked = ticks.ticked.length
  const none = ticked === 0
  return (
    <AppBar
      lead={<IconButton label="Stop selecting" icon="close" onClick={onExit} />}
      title={`${ticked} selected`}
    >
      {actions.slice(0, 2).map((action) => (
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
          action={{
            label: 'Select all',
            icon: 'selectAll',
            run: () => ticks.all(true),
          }}
          disabled={ticks.total === 0 || ticked === ticks.total}
        />
        {actions.slice(2).map((action) => (
          <MenuAction key={action.label} action={action} disabled={none} />
        ))}
      </Menu>
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
// messages, and the action that empties the folder, while it lists mail
export function ListMenu({
  listed,
  onSelect,
  empty,
  children,
}: {
  listed: boolean // the list shows mail
  onSelect: () => void // starts selection mode
  empty?: BulkAction
  children?: ReactNode
}) {
  return (
    <Menu label="List actions">
      {children}
      <MenuAction
        action={{ label: 'Select messages', icon: 'select', run: onSelect }}
        disabled={!listed}
      />
      {listed && empty && <MenuAction action={empty} />}
    </Menu>
  )
}
