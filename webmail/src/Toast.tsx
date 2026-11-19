// A short note at the bottom of the page about what was just done, with an
// action such as Undo

export type Toast = {
  text: string
  action?: { label: string; run: () => Promise<void> | void }
}

export function ToastBar({
  toast,
  onAction,
  onClose,
}: {
  toast: Toast | null
  onAction: (run: () => Promise<void> | void) => void
  onClose: () => void
}) {
  // The live region stays on the page, so a new note is announced
  return (
    <div className="toast" role="status" data-testid="toast">
      {toast && (
        <>
          <span>{toast.text}</span>
          {toast.action && (
            <button onClick={() => onAction(toast.action!.run)}>
              {toast.action.label}
            </button>
          )}
          <button className="close" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        </>
      )}
    </div>
  )
}
