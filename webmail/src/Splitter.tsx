// The divider between the message list and the reader, which sets the list's
// width: dragged, by the arrow keys, Home and End, or back to the start by a
// double-click. Hidden at phone width, where the two take turns.

import { useEffect, useRef, useState, type CSSProperties } from 'react'

const MIN = 260
const START = 380
const READER_MIN = 320 // the reader keeps at least this much
const STEP = 16
const KEY = 'list-width'

// The width chosen last, kept in this browser only
function remembered(): number {
  try {
    const width = Number(window.localStorage.getItem(KEY))
    return width > 0 ? width : START
  } catch {
    return START
  }
}

function remember(width: number): void {
  try {
    window.localStorage.setItem(KEY, String(width))
  } catch {
    // Not kept: the list starts at its usual width next time
  }
}

// The list's width, the same in every folder, and the style that sets it on
// the split
export function useListWidth() {
  const [width, setWidth] = useState(remembered)
  const style = { '--list-width': `${width}px` } as CSSProperties
  const change = (next: number) => {
    setWidth(next)
    remember(next)
  }
  return { width, style, change }
}

export function Splitter({
  width,
  onChange,
}: {
  width: number
  onChange: (width: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The widest the list can be in the split as it is now
  const [max, setMax] = useState(START)
  useEffect(() => {
    const split = ref.current?.parentElement
    if (!split) return
    const observer = new ResizeObserver(() =>
      setMax(Math.max(MIN, split.clientWidth - READER_MIN))
    )
    observer.observe(split)
    return () => observer.disconnect()
  }, [])

  const now = Math.min(Math.max(width, MIN), max)
  const set = (next: number) =>
    onChange(Math.min(Math.max(Math.round(next), MIN), max))

  return (
    <div
      ref={ref}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the message list"
      aria-valuemin={MIN}
      aria-valuemax={max}
      aria-valuenow={now}
      tabIndex={0}
      onPointerDown={(e) => {
        // No text is selected while it moves
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const split = e.currentTarget.parentElement
        if (!split || !e.currentTarget.hasPointerCapture(e.pointerId)) return
        set(e.clientX - split.getBoundingClientRect().left)
      }}
      onDoubleClick={() => set(START)}
      onKeyDown={(e) => {
        const keys: Record<string, number | undefined> = {
          ArrowLeft: now - STEP,
          ArrowRight: now + STEP,
          Home: MIN,
          End: max,
        }
        const to = keys[e.key]
        if (to === undefined) return
        e.preventDefault()
        set(to)
      }}
    />
  )
}
