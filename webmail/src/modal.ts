// A dialog element shown as a modal while it is mounted: the focus moves
// into it, and goes back to where it was when it unmounts, if that is still
// on the page

import { useEffect, type RefObject } from 'react'

export function useModal(ref: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const dialog = ref.current
    const before = document.activeElement
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [ref])
}
