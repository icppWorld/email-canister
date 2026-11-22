import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import {
  SANDBOX,
  sandboxDocument,
  type FramedBody,
  type PageStyle,
} from './mime'

function readPageStyle(): PageStyle {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const role = (name: string) => root.getPropertyValue(name).trim()
  // As a ratio: the computed line height is in pixels, which larger text would inherit
  const ratio = parseFloat(body.lineHeight) / parseFloat(body.fontSize)
  return {
    background: role('--surface-raised'),
    ink: role('--ink'),
    link: role('--action-text'),
    // The app's own text, as styles.css sets it from the brand
    font: `${body.fontSize}/${Number.isFinite(ratio) ? ratio.toFixed(3) : 'normal'} ${body.fontFamily}`,
    scheme: root.colorScheme,
  }
}

// The brand's values for the current light or dark theme, read again when it changes
function usePageStyle(): PageStyle {
  const [page, setPage] = useState(readPageStyle)
  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setPage(readPageStyle())
    dark.addEventListener('change', update)
    return () => dark.removeEventListener('change', update)
  }, [])
  return page
}

// The inner width of the frame, once it has settled: a drag of the divider
// would otherwise measure the message at every step
function useWidth(frame: RefObject<HTMLIFrameElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    let timer = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setWidth(element.clientWidth), 150)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [frame])
  return width
}

// A message laid out wider than its frame, as one made for a 600px column
// often is, is shrunk to fit, as phone mail apps do. The frame shows the
// webmail nothing of its document, so the width is measured on a copy in a
// frame of its own: hidden, without remote images, with no script and no
// link that can open, and gone once measured.
type Measured = { document: string; width: number; needs: number }

// The sandbox allows a message only what SANDBOX in mime.ts says: no scripts,
// forms or same-origin access. The message is framed by the caller, once per
// message (frameBody in mime.ts).
export function MessageBody({
  framed,
  images = false,
}: {
  framed: FramedBody
  images?: boolean // its remote images are shown, after Show images
}) {
  const page = usePageStyle()
  // A remote image shown is no longer the nothing a plain page allows
  const paper = framed.paper || (images && framed.remote)
  const frame = useRef<HTMLIFrameElement>(null)
  const width = useWidth(frame)
  const copy = useMemo(
    () => sandboxDocument(framed.body, paper, page),
    [framed.body, paper, page]
  )
  const [measured, setMeasured] = useState<Measured | null>(null)
  const settled =
    measured !== null && measured.document === copy && measured.width === width
  const zoom =
    settled && measured.needs > width
      ? Math.floor((width / measured.needs) * 1000) / 1000
      : 1
  const srcdoc = useMemo(
    () => sandboxDocument(framed.body, paper, page, images, zoom),
    [framed.body, paper, page, images, zoom]
  )
  return (
    <>
      {width > 0 && !settled && (
        <iframe
          key={width}
          className="measure"
          aria-hidden="true"
          tabIndex={-1}
          inert
          sandbox="allow-same-origin"
          {...{ credentialless: '' }}
          style={{ width }}
          srcDoc={copy}
          onLoad={(e) =>
            setMeasured({
              document: copy,
              width,
              needs:
                e.currentTarget.contentDocument?.documentElement.scrollWidth ??
                0,
            })
          }
        />
      )}
      <iframe
        ref={frame}
        className={paper ? 'body paper' : 'body'}
        title="Message body"
        sandbox={SANDBOX}
        // An image shown carries none of the reader's cookies for its host, in
        // the browsers that know the attribute; the others leave such cookies
        // out, or keep them apart, by themselves. Spread, as React's types do
        // not know it yet.
        {...{ credentialless: '' }}
        srcDoc={srcdoc}
        // The zoom, once the message is measured at this width
        data-fit={settled ? zoom : undefined}
      />
    </>
  )
}
