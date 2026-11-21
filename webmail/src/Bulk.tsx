// The bar above a list for the messages ticked in it: Select all, how many
// are ticked, and what can be done to them. With none ticked, it can offer to
// empty the folder.

import { useEffect, useRef } from 'react'

import { IconButton } from './Buttons'
import type { IconName } from './Icon'

export type BulkAction = {
  label: string
  icon: IconName
  danger?: true // it cannot be undone
  run: () => void
}

export function Bulk({
  ticked,
  total,
  onAll,
  actions,
  empty,
}: {
  ticked: number
  total: number // the messages that can be ticked
  onAll: (all: boolean) => void
  actions: BulkAction[]
  empty?: { label: string; run: () => void }
}) {
  const allBox = useRef<HTMLInputElement>(null)
  const all = total > 0 && ticked === total
  const some = ticked > 0 && !all
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = some
  }, [some])

  return (
    <div className="bulk" role="toolbar" aria-label="Selected messages">
      <input
        ref={allBox}
        type="checkbox"
        aria-label="Select all"
        checked={all}
        onChange={(e) => onAll(e.target.checked)}
      />
      {ticked > 0 ? (
        <>
          <span className="hint">{ticked} selected</span>
          {actions.map((action) => (
            <IconButton
              key={action.label}
              variant={action.danger ? 'danger' : undefined}
              label={action.label}
              icon={action.icon}
              onClick={action.run}
            />
          ))}
        </>
      ) : (
        empty && (
          <IconButton label={empty.label} icon="trash" onClick={empty.run} />
        )
      )}
    </div>
  )
}
