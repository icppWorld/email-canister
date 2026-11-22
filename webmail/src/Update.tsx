import { useEffect, useState } from 'react'

import { IconButton } from './Buttons'

// The webmail's release, from package.json at build time
export const VERSION = __WEBMAIL_VERSION__

// How often an open webmail asks whether a newer one is deployed, besides
// each time it comes back into view
const CHECK_MS = 10 * 60_000

// The script a page names: each build names its own, by a hash of its content
const scriptOf = (doc: Document) =>
  doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null

// Whether the server now has another build than this page runs. The page is
// served with no-cache, so this asks the server itself.
async function newerDeployed(): Promise<boolean> {
  const running = scriptOf(document)
  if (!running) return false
  const response = await fetch('/', { cache: 'no-store' })
  if (!response.ok) return false
  const served = scriptOf(
    new DOMParser().parseFromString(await response.text(), 'text/html')
  )
  return served !== null && served !== running
}

// A banner once a newer webmail is deployed. A phone keeps an open tab and
// shows it again without loading it, so the check runs whenever the page comes
// back into view, and every few minutes while it is open.
export function UpdateBanner() {
  const [newer, setNewer] = useState(false)

  useEffect(() => {
    if (newer) return
    let gone = false
    const check = () => {
      if (document.visibilityState !== 'visible') return
      newerDeployed()
        .then((found) => {
          if (found && !gone) setNewer(true)
        })
        // Offline, or the server busy: the next check asks again
        .catch(() => {})
    }
    const timer = window.setInterval(check, CHECK_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', check)
    return () => {
      gone = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', check)
    }
  }, [newer])

  if (!newer) return null
  return (
    <div className="update" role="status">
      <span>A newer version of the webmail is available.</span>
      <IconButton
        className="bare"
        label="Reload"
        icon="refresh"
        onClick={() => window.location.reload()}
      />
    </div>
  )
}
