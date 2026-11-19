// A short note at the bottom of the page about what was just done, with an
// action such as Undo

export type Toast = {
  text: string
  // reload: the action changes mail, so the list and counts load again
  action?: { label: string; run: () => Promise<void> | void; reload?: true }
}

export function ToastBar({
  toast,
  onAction,
  onClose,
  onHold,
}: {
  toast: Toast | null
  onAction: (action: NonNullable<Toast['action']>) => void
  onClose: () => void
  // True while the pointer is over it or the focus is in it
  onHold: (held: boolean) => void
}) {
  const action = toast?.action
  // The live region stays on the page, so a new note is announced
  return (
    <div
      className="toast"
      role="status"
      data-testid="toast"
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onHold(false)
      }}
    >
      {toast && (
        <>
          <span>{toast.text}</span>
          {action && (
            <button className="bare" onClick={() => onAction(action)}>
              {action.label}
            </button>
          )}
          <button className="bare" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        </>
      )}
    </div>
  )
}
