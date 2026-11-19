import { useEffect, useMemo, useState } from 'react'

import {
  frameBody,
  sandboxDocument,
  type PageStyle,
  type ParsedAttachment,
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
    link: role('--action'),
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

// One array for every message without attachments, so the frame is not rebuilt on each render
const NO_ATTACHMENTS: ParsedAttachment[] = []

// No allow-* tokens at all: no scripts, forms, popups or same-origin access
export function MessageBody({
  html,
  attachments = NO_ATTACHMENTS,
}: {
  html: string
  attachments?: ParsedAttachment[]
}) {
  const page = usePageStyle()
  // Built once per message: it parses the message and encodes its images
  const { body, paper } = useMemo(
    () => frameBody(html, attachments),
    [html, attachments]
  )
  const srcdoc = useMemo(
    () => sandboxDocument(body, paper, page),
    [body, paper, page]
  )
  return (
    <iframe
      className={paper ? 'body paper' : 'body'}
      title="Message body"
      sandbox=""
      srcDoc={srcdoc}
    />
  )
}
