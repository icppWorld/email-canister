// A short note at the bottom of the page about what was just done, with
// actions such as Undo

import { Fragment } from 'react'

export type ToastAction = {
  label: string
  run: () => Promise<void> | void
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
  // The live region stays on the page, so a new note is announced
  return (
    <div
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
            <button
              key={action.label}
              className="bare"
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
          <button className="bare" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        </Fragment>
      )}
    </div>
  )
}
