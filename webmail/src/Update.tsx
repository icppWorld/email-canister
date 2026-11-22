import { useEffect, useState } from 'react'

import { IconButton } from './Buttons'

// The webmail's release, from package.json at build time
export const VERSION = __WEBMAIL_VERSION__

// How often an open webmail asks whether a newer one is deployed, besides
// each time it comes back into view
const CHECK_MS = 10 * 60_000

// Work a reload would lose: a message open in Compose, which is kept in memory
// only, or a copy downloading. Set by the app.
let unsaved = false
let leaving = false
export const setUnsaved = (value: boolean) => {
  unsaved = value
}

// The browser asks before a tab with such work closes. Not every browser asks
// at a reload, so the webmail's own Reload asks itself.
window.addEventListener('beforeunload', (e) => {
  if (!unsaved || leaving) return
  e.preventDefault()
  e.returnValue = ''
})

export function reload(): void {
  if (
    unsaved &&
    !window.confirm(
      'Reload the webmail? The message being written, or the copy downloading, is lost.'
    )
  ) {
    return
  }
  leaving = true
  window.location.reload()
}

// What a deploy changes in a page: the script it names, which each build names
// by a hash of its content, and the settings brand/brand.mjs writes into it
const deployOf = (doc: Document) => {
  const script = doc.querySelector('script[type="module"][src]')
  if (!script) return null
  const settings = doc.getElementById('settings')?.textContent ?? ''
  return `${script.getAttribute('src')}\n${settings}`
}

// Whether the server now has another deploy than this page runs. The page is
// served with no-cache, so this asks the server itself.
async function newerDeployed(): Promise<boolean> {
  const running = deployOf(document)
  if (!running) return false
  const response = await fetch('/', { cache: 'no-store' })
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
