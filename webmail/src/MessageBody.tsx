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

type Size = { width: number; height: number }

// The inner size of the message's box. The first is taken at once; later
// ones once they have settled, as a drag of the divider would otherwise
// measure the message at every step.
function useSize(box: RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const element = box.current
    if (!element) return
    let timer = 0
    let first = true
    const read = () => {
      const { clientWidth: width, clientHeight: height } = element
      setSize((last) =>
        last.width === width && last.height === height
          ? last
          : { width, height }
      )
    }
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      if (first) read()
      else timer = window.setTimeout(read, 150)
      first = false
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [box])
  return size
}

// A message laid out wider than its box, as one made for a 600px column
// often is, is shrunk to fit, as phone mail apps do: its frame is made wider
// and scaled down to the box, so the message lays itself out again without
// loading again. The frame shows the webmail nothing of its document, so the
// width is measured on a copy in a frame of its own: hidden, without remote
// images, with no script and no link that can open, and gone once measured.
// Shrunk to half at most: a wider message scrolls the rest of the way, which
// keeps its text readable.
const MIN_ZOOM = 0.5
type Measured = { document: string; width: number; zoom: number }

const zoomOf = (frame: HTMLIFrameElement): number => {
  const root = frame.contentDocument?.documentElement
  if (!root || root.scrollWidth <= root.clientWidth) return 1
  const fit = Math.floor((root.clientWidth / root.scrollWidth) * 1000) / 1000
  return Math.max(fit, MIN_ZOOM)
}

// Each copy gets a measuring frame of its own, so that a load is always its
// own copy's
let copies = 0

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
  const srcdoc = useMemo(
    () => sandboxDocument(framed.body, paper, page, images),
    [framed.body, paper, page, images]
  )
  const box = useRef<HTMLDivElement>(null)
  const size = useSize(box)
  const copy = useMemo(() => {
    copies += 1
    return { document: sandboxDocument(framed.body, paper, page), key: copies }
  }, [framed.body, paper, page])
  const [measured, setMeasured] = useState<Measured | null>(null)
  const settled =
    measured?.document === copy.document && measured.width === size.width
  // While the message is measured again, it keeps the zoom it has
  const zoom = measured?.zoom ?? 1
  const scaled =
    zoom < 1
      ? {
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
        }
      : undefined
  return (
    <div className="message-box" ref={box}>
      {size.width > 0 && !settled && (
        <iframe
          key={`${copy.key}:${size.width}`}
          className="measure"
          aria-hidden="true"
          tabIndex={-1}
          inert
          sandbox="allow-same-origin"
          {...{ credentialless: '' }}
          style={size}
          srcDoc={copy.document}
          onLoad={(e) =>
            setMeasured({
              document: copy.document,
              width: size.width,
              zoom: zoomOf(e.currentTarget),
            })
          }
        />
      )}
      <iframe
        className={paper ? 'body paper' : 'body'}
        style={scaled}
        title="Message body"
        sandbox={SANDBOX}
        // An image shown carries none of the reader's cookies for its host, in
        // the browsers that know the attribute; the others leave such cookies
        // out, or keep them apart, by themselves. Spread, as React's types do
        // not know it yet.
        {...{ credentialless: '' }}
        srcDoc={srcdoc}
        // The zoom, and the width it was measured at, once it is
        data-fit={settled ? zoom : undefined}
        data-measured={settled ? size.width : undefined}
      />
    </div>
  )
}
