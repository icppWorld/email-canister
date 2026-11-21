// A short note at the bottom of the page about what was just done, with
// actions such as Undo

import { Fragment, useEffect, useRef } from 'react'

import { IconButton } from './Buttons'
import type { IconName } from './Icon'

export type ToastAction = {
  label: string
  icon: IconName
  // May return a note on what it did
  run: () => Promise<Toast | void> | void
  // The action changes mail, so the list and counts load again
  reload?: true
}

export type Toast = { text: string; actions?: ToastAction[] }
// A note as shown, with an id of its own
export type ShownToast = Toast & { id: number }

export function ToastBar({
  toast,
  onAction,
  onClose,
  onHold,
}: {
  toast: ShownToast | null
  onAction: (action: ToastAction) => void
  onClose: () => void
  // True while the pointer is over it or the focus is in it
  onHold: (held: boolean) => void
}) {
  const bar = useRef<HTMLDivElement>(null)
  // A new note's buttons take the place of the old ones, a focused one too,
  // which some browsers drop with no blur: the hold is read again
  const id = toast?.id
  useEffect(() => {
    const element = bar.current
    if (id === undefined || !element) return
    onHold(
      element.matches(':hover') || element.contains(document.activeElement)
    )
  }, [id, onHold])

  // The live region stays on the page, so a new note is announced
  return (
    <div
      ref={bar}
      className="toast"
      role="status"
      data-testid="toast"
      // Held while either the pointer or the focus is in it
      onMouseEnter={() => onHold(true)}
      onMouseLeave={(e) =>
        onHold(e.currentTarget.contains(document.activeElement))
      }
      onFocus={() => onHold(true)}
      onBlur={(e) =>
        onHold(
          e.currentTarget.matches(':hover') ||
            e.currentTarget.contains(e.relatedTarget)
        )
      }
    >
      {toast && (
        // By the note, so one that takes another's place has buttons of its
        // own: a focused one would run the new note's action
        <Fragment key={toast.id}>
          <span>{toast.text}</span>
          {toast.actions?.map((action) => (
            <IconButton
              key={action.label}
              className="bare"
              label={action.label}
              icon={action.icon}
              onClick={() => onAction(action)}
            />
          ))}
          <IconButton
            className="bare"
            label="Dismiss"
            icon="close"
            onClick={onClose}
          />
        </Fragment>
      )}
    </div>
  )
}
