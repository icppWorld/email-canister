import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { settings } from './settings'
import './styles.css'

// The generic build, deployed without brand/brand.mjs: say so, rather than
// failing on the first call
function NotConfigured() {
  return (
    <main className="centered">
      <div className="card">
        <h1>This webmail is not configured</h1>
        <p>
          Its deployment settings are missing. Whoever deploys it runs
          brand/brand.mjs on the build, which names the backend canister and the
          sign-in origin.
        </p>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{settings ? <App /> : <NotConfigured />}</StrictMode>
)
