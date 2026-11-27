// The ☰ drawer at phone width: a modal dialog along the left edge. The focus
// moves into it as it opens, and back to where it was when it closes, or,
// when it went to a page of its own, to that page's ☰.
// Escape, a click on the backdrop beside it, and choosing one of its buttons
// close it.

import { useRef, type ReactNode } from 'react'

import { useModal } from './modal'

// The ☰ of the page the drawer went to: its own one left with the page
const focusMenu = () =>
  document.querySelector<HTMLElement>('.appbar [aria-label="Menu"]')?.focus()

export function Drawer({
  onClose,
  children,
}: {
  onClose: () => void
  children: ReactNode
}) {
  const box = useRef<HTMLDialogElement>(null)
  useModal(box, focusMenu)
  return (
    <dialog
      ref={box}
      className="drawer"
      aria-label="Navigation"
      // Escape: the browser closes it, and the page follows
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop reaches the dialog itself, as its content
        // fills it
        const target = e.target as Element
        if (target === e.currentTarget || target.closest('button')) onClose()
      }}
    >
      <div className="drawer-body">{children}</div>
    </dialog>
  )
}
