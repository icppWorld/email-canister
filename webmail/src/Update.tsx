import { useEffect, useState } from 'react'

import { IconButton } from './Buttons'

// The webmail's release, from package.json at build time
export const VERSION = __WEBMAIL_VERSION__

// How often an open webmail asks whether a newer one is deployed, besides
// each time it comes back into view
const CHECK_MS = 10 * 60_000
// A check the server does not answer ends after this, so the next one can ask
const ANSWER_MS = 15_000

// Work a reload would lose: a message open in Compose, which is kept in memory
// only, or a copy downloading. Set by the app.
let unsaved = false
export const setUnsaved = (value: boolean) => {
  unsaved = value
}

// The page again from the server, after asking when that loses work
export function reload(): void {
  if (
    unsaved &&
    !window.confirm(
      'Reload the webmail? The message being written, or the copy downloading, is lost.'
    )
  ) {
    return
  }
  window.location.reload()
}

// The webmail's own files, on its own origin; anything else on the page, such
// as a browser extension's style sheet, is not part of a deploy
const own = (url: string | null): url is string => {
  if (url === null) return false
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

// What a deploy changes in a page: the script and style sheets it names, which
// each build names by a hash of their content, and the settings
// brand/brand.mjs writes into it
const deployOf = (doc: Document) => {
  const script = Array.from(
    doc.querySelectorAll('script[type="module"][src]'),
    (element) => element.getAttribute('src')
  ).find(own)
  if (!script) return null
  const sheets = Array.from(
    doc.querySelectorAll('link[rel="stylesheet"][href]'),
    (link) => link.getAttribute('href')
  ).filter(own)
  const settings = doc.getElementById('settings')?.textContent ?? ''
  return [script, ...sheets, settings].join('\n')
}

// The deploy this page runs, read as it loads: a style sheet added to the page
// later is not part of it
const running = deployOf(document)

// Whether the server now has another deploy than this page runs. The page is
// served with no-cache, so this asks the server itself.
async function newerDeployed(): Promise<boolean> {
  if (!running) return false
  const response = await fetch('/', {
    cache: 'no-store',
    signal: AbortSignal.timeout(ANSWER_MS),
  })
  if (!response.ok) return false
  const served = deployOf(
    new DOMParser().parseFromString(await response.text(), 'text/html')
  )
  return served !== null && served !== running
}

// A banner once a newer webmail is deployed. A phone keeps an open tab, or
// takes the page from its cache, and shows it without asking the server, so
// the check runs at the start, whenever the page comes back into view, and
// every few minutes while it is open.
export function UpdateBanner() {
  const [newer, setNewer] = useState(false)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (newer) return
    let gone = false
    let asking = false
    const check = () => {
      if (asking || document.visibilityState !== 'visible') return
      asking = true
      newerDeployed()
        .then((found) => {
          if (found && !gone) setNewer(true)
        })
        // Offline, or the server busy: the next check asks again
        .catch(() => {})
        .finally(() => {
          asking = false
        })
    }
    // A page the browser restores from its cache starts again without a mount
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) check()
    }
    check()
    const timer = window.setInterval(check, CHECK_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', restored)
    return () => {
      gone = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', restored)
    }
  }, [newer])

  // The live region stays on the page, so that its text is announced
  return (
    <div className="update" role="status">
      {newer && !closed && (
        <>
          <span>A newer version of the webmail is available.</span>
          <IconButton
            className="bare"
            label="Reload"
            icon="refresh"
            onClick={reload}
          />
          <IconButton
            className="bare"
            label="Close"
            icon="close"
            onClick={() => setClosed(true)}
          />
        </>
      )}
    </div>
  )
}
