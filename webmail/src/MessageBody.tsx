import { useEffect, useMemo, useState } from 'react'

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

// No allow-* tokens at all: no scripts, forms, popups or same-origin access.
// The message is framed by the caller, once per message (frameBody in mime.ts).
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
  return (
    <iframe
      className={paper ? 'body paper' : 'body'}
      title="Message body"
      sandbox={SANDBOX}
      // An image shown carries none of the reader's cookies for its host.
      // Spread, as React's types do not know the attribute yet.
      {...{ credentialless: '' }}
      srcDoc={srcdoc}
    />
  )
}
