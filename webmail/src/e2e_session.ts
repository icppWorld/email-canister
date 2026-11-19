// Only in the e2e build: the identity comes from a key the test put in storage.

import type { Identity } from '@icp-sdk/core/agent'
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity'
import type { Session } from './auth'

export function e2eSession(): Session {
  const load = (): Identity | null => {
    const seed = window.sessionStorage.getItem('e2e-seed')
    if (!seed) return null
    return Ed25519KeyIdentity.generate(
      Uint8Array.from(seed.match(/../g)!, (b) => parseInt(b, 16))
    )
  }
  return {
    current: async () => load(),
    signIn: async () => {
      const identity = load()
      if (!identity) throw new Error('the test set no key')
      return identity
    },
    signOut: async () => window.sessionStorage.removeItem('e2e-seed'),
    // A test ends the session by removing the key and sending this event
    watch(onEnd) {
      const check = () => {
        if (!load()) onEnd()
      }
      window.addEventListener('e2e-session-end', check)
      return () => window.removeEventListener('e2e-session-end', check)
    },
  }
}
