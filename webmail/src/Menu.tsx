// A ⋮ button that opens a short list of buttons. Choosing one, a click
// elsewhere (the message's frame included), focus moving out, a change of
// width, or Escape closes it.

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
  // The window's width when it opened
  const openWidth = useRef(0)
  // The list opens toward the middle of the screen, so it stays on it
  const [fromLeft, setFromLeft] = useState(false)

  const close = (refocus = false) => {
    const menu = ref.current
    if (!menu) return
    menu.open = false
    if (refocus) menu.querySelector('summary')?.focus()
  }

  // Listened for from the start, so that an Escape or a click right after it
  // opens finds them; they do nothing while it is closed
  useEffect(() => {
    const isOpen = () => !!ref.current?.open
    const outside = (e: PointerEvent) => {
      if (isOpen() && !ref.current?.contains(e.target as Node)) close()
    }
    const escape = (e: KeyboardEvent) => {
      if (isOpen() && e.key === 'Escape') close(true)
    }
    // A click in the message's frame reaches the page only as a blur
    const away = () => {
      if (isOpen()) close()
    }
    // A phone's keyboard and toolbar change only the height
    const resized = () => {
      if (isOpen() && window.innerWidth !== openWidth.current) close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', away)
    window.addEventListener('resize', resized)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', resized)
    }
  }, [])

  // Where it opens and the window's width then. On the click, so its first
  // frame is on screen, and again on the toggle, as it can also open without
  // one (a find in the page expands it)
  const measure = () => {
    const box = ref.current?.querySelector('summary')?.getBoundingClientRect()
    if (!box) return
    openWidth.current = window.innerWidth
    setFromLeft(box.left + box.right < window.innerWidth)
  }

  return (
    <details
      className="menu"
      ref={ref}
      onToggle={(e) => {
        if (e.currentTarget.open) measure()
      }}
      onBlur={(e) => {
        // Focus that moved to the page's body is left to the click handlers
        const to = e.relatedTarget as Node | null
        if (to && !e.currentTarget.contains(to)) close()
      }}
    >
      <summary aria-label={label} title={label} onClick={measure}>
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
