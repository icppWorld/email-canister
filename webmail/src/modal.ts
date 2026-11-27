// A dialog element shown as a modal while it is mounted: the focus moves
// into it, and goes back to where it was when it unmounts, if that is still
// on the page, or else to where `elsewhere` puts it

import { useEffect, useRef, type RefObject } from 'react'

export function useModal(
  ref: RefObject<HTMLDialogElement | null>,
  elsewhere?: () => void
): void {
  // Kept across an effect run again (StrictMode in development), when the
  // focus is already inside the dialog and no longer shows where it came from.
  // The page body is no opener: a tap in some browsers focuses no button
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    const dialog = ref.current
    const active = document.activeElement
    if (!dialog?.contains(active))
      opener.current = active === document.body ? null : active
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      const before = opener.current
      if (before instanceof HTMLElement && before.isConnected) before.focus()
      else elsewhere?.()
    }
  }, [ref, elsewhere])
}
