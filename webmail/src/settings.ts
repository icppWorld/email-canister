// This deployment's settings, which brand/brand.mjs writes into index.html.
// The same build serves every deployment, so nothing here is compiled in.

import type { Brand, Settings as Deployment } from '../brand/brand.mjs'

export type { Brand }

// derivationOrigin: principals depend on it. Changing it after onboarding locks everyone out.
export type Settings = Deployment & { brand: Brand }

const text = (value: unknown): value is string => typeof value === 'string'

function valid(value: unknown): value is Settings {
  const s = value as Settings | null
  const logo = s?.brand?.logo
  return (
    text(s?.backend) &&
    s.backend.length > 0 &&
    (s.network === 'ic' || s.network === 'local') &&
    (s.derivationOrigin === null || text(s.derivationOrigin)) &&
    text(s.brand?.name) &&
    text(s.brand.label) &&
    text(s.brand.tagline) &&
    (logo === null || (text(logo?.light) && text(logo.dark) && text(logo.alt)))
  )
}

// Null when the page was deployed without running brand.mjs
function read(): Settings | null {
  const block = document.getElementById('settings')
  if (!block || block.getAttribute('type') !== 'application/json') return null
  try {
    const value: unknown = JSON.parse(block.textContent ?? '')
    return valid(value) ? value : null
  } catch {
    return null
  }
}

export const settings = read()

// For modules that run only once the app has checked settings exist
export function deployment(): Settings {
  if (!settings) throw new Error('This webmail is not configured')
  return settings
}
