// A ⋮ button that opens a short list of buttons. Choosing one, a click
// elsewhere (the message's frame included), focus moving out, a resize, or
// Escape closes it.

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Icon } from './Icon'

export function Menu({
  label,
  children,
}: {
  label: string // says what the menu holds, as the button has no text
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  // The list opens toward the middle of the screen, so it stays on it
  const [fromLeft, setFromLeft] = useState(false)

  const close = (refocus = false) => {
    const menu = ref.current
    if (!menu) return
    menu.open = false
    if (refocus) menu.querySelector('summary')?.focus()
  }

  // Listened for only while it is open
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    // A click in the message's frame reaches the page only as a blur
    const away = () => close()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
    }
  }, [open])

  return (
    <details
      className="menu"
      ref={ref}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onBlur={(e) => {
        // Focus that moved to the page's body is left to the click handlers
        const to = e.relatedTarget as Node | null
        if (to && !e.currentTarget.contains(to)) close()
      }}
    >
      <summary
        aria-label={label}
        title={label}
        onClick={(e) => {
          // Measured before it opens, so its first frame is on screen
          const { left, right } = e.currentTarget.getBoundingClientRect()
          setFromLeft(left + right < window.innerWidth)
        }}
      >
        <Icon name="more" />
      </summary>
      <div
        className={fromLeft ? 'menu-items from-left' : 'menu-items'}
        onClick={(e) => {
          if ((e.target as Element).closest('button')) close(true)
        }}
      >
        {children}
      </div>
    </details>
  )
}
