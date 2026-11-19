// A ⋮ button that opens a short list of buttons. Choosing one, a click
// elsewhere, or Escape closes it.

import { useEffect, useRef, type ReactNode } from 'react'

import { Icon } from './Icon'

export function Menu({
  label,
  children,
}: {
  label: string // says what the menu holds, as the button has no text
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const menu = ref.current
      if (menu?.open && !menu.contains(e.target as Node)) menu.open = false
    }
    const escape = (e: KeyboardEvent) => {
      const menu = ref.current
      if (e.key !== 'Escape' || !menu?.open) return
      menu.open = false
      menu.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  return (
    <details className="menu" ref={ref}>
      <summary aria-label={label} title={label}>
        <Icon name="more" />
      </summary>
      <div
        className="menu-items"
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
