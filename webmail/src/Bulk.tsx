// Ticking messages in a list for an action on all of them: the row's box,
// and the bar above the list with Select all, how many are ticked, and what
// can be done to them. With none ticked, the bar can offer to empty the
// folder.

import { useCallback, useState } from 'react'

import { IconButton } from './Buttons'
import type { IconName } from './Icon'

export type BulkAction = {
  label: string
  icon: IconName
  danger?: true // it cannot be undone
  run: () => void
}

// The messages ticked among `ids`, the ones listed that can be ticked
export function useTicks(ids: bigint[]) {
  const [checked, setChecked] = useState<ReadonlySet<bigint>>(new Set())
  // Mail that left the list leaves its tick, so it comes back unticked
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
