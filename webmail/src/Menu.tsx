// A ⋮ button that opens a short list of buttons. Choosing one, a click
// elsewhere, or Escape closes it.

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

  // Listened for only while it is open
  useEffect(() => {
    if (!open) return
    const close = () => {
      if (ref.current) ref.current.open = false
    }
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      ref.current?.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <details
      className="menu"
      ref={ref}
      onToggle={(e) => {
        const menu = e.currentTarget
        const { left, right } = menu.getBoundingClientRect()
        setFromLeft(left + right < window.innerWidth)
        setOpen(menu.open)
      }}
    >
      <summary aria-label={label} title={label}>
        <Icon name="more" />
      </summary>
      <div
        className={fromLeft ? 'menu-items from-left' : 'menu-items'}
        onClick={(e) => {
          if (ref.current && (e.target as Element).closest('button'))
            ref.current.open = false
        }}
      >
        {children}
      </div>
    </details>
  )
}
