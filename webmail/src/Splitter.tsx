// A message list beside a reader, with a divider between them that sets the
// list's width: dragged, by the arrow keys, Home and End, or back to the
// start by a double-click. The width is the same in every folder, kept in
// this browser. At phone width the divider is hidden, and the list and the
// reader take turns.

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { store, stored } from './storage'

const MIN = 260
const START = 380
const READER_MIN = 320 // the reader keeps at least this much
const STEP = 16
const KEY = 'list-width'

export function Split({
  reading,
  children: [list, reader],
}: {
  reading: boolean // the reader shows a message: at phone width, alone
  children: [ReactNode, ReactNode]
}) {
  const split = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => Number(stored(KEY)) || START)
  // The widest the list can be in the split as it is now: measured before
  // the first paint, and again as the split changes size
  const [max, setMax] = useState(START)
  useLayoutEffect(() => {
    const element = split.current
    if (!element) return
    const measure = () =>
      setMax(Math.max(MIN, element.clientWidth - READER_MIN))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const within = (next: number) =>
    Math.min(Math.max(Math.round(next), MIN), max)
  const now = within(width)
  const change = (to: number) => {
    const next = within(to)
    setWidth(next)
    store(KEY, String(next))
  }

  // A drag draws the width straight on the page, at most once a frame, and
  // keeps it once let go. It measures from where the split starts, read as
  // the drag begins.
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<{ left: number; width?: number; frame?: number } | null>(
    null
  )
  const draw = () => {
    const at = drag.current
    if (!at || at.width === undefined) return
    at.frame = undefined
    split.current?.style.setProperty('--list-width', `${at.width}px`)
    handle.current?.setAttribute('aria-valuenow', String(at.width))
  }
  const dropped = () => {
    const at = drag.current
    if (!at) return
    if (at.frame !== undefined) cancelAnimationFrame(at.frame)
    draw()
    drag.current = null
    if (at.width !== undefined) change(at.width)
  }

  return (
    <div
      ref={split}
      className={reading ? 'split reading' : 'split'}
      style={{ '--list-width': `${now}px` } as CSSProperties}
    >
      {list}
      <div
        ref={handle}
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
          drag.current = {
            left: split.current?.getBoundingClientRect().left ?? 0,
          }
        }}
        onPointerMove={(e) => {
          const at = drag.current
          if (!at) return
          at.width = within(e.clientX - at.left)
          at.frame ??= requestAnimationFrame(draw)
        }}
        onPointerUp={dropped}
        onLostPointerCapture={dropped}
        onDoubleClick={() => change(START)}
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
          change(to)
        }}
      />
      {reader}
    </div>
  )
}
