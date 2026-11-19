// Sign-in with id.ai. The e2e build swaps in a fixed key, because a passkey
// ceremony cannot be automated; the branch is compiled out of a real build.

import { AuthClient } from '@icp-sdk/auth/client'
import type { Identity } from '@icp-sdk/core/agent'

import { deployment } from './settings'

const SESSION_NS = BigInt(7 * 24 * 60 * 60) * 1_000_000_000n

// setTimeout overflows above this, so longer waits are taken in steps
const MAX_TIMER_MS = 2 ** 31 - 1

export type Session = {
  current(): Promise<Identity | null>
  signIn(): Promise<Identity>
  signOut(): Promise<void>
  // Calls onEnd once when the sign-in ends: it expires, or another tab signs
  // out. Returns a function that stops watching.
  watch(onEnd: () => void): () => void
}

// A local network with `ii: true` serves Internet Identity at id.ai.localhost
// on the gateway that serves this page, with mainnet's canister id
function localIdentityProvider() {
  const { protocol, port } = window.location
  return {
    authorizeUrl: `${protocol}//id.ai.localhost:${port}/authorize`,
    canisterId: 'rdmx6-jaaaa-aaaaa-aaadq-cai',
  }
}

function realSession(): Session {
  const { network, derivationOrigin } = deployment()
  const local = network === 'local'
  const client = new AuthClient({
    identityProvider: local ? localIdentityProvider() : undefined,
    derivationOrigin: derivationOrigin ?? undefined,
    agentOptions: { host: window.location.origin, shouldFetchRootKey: local },
  })
  return {
    async current() {
      await client.ready()
      return client.isAuthenticated() ? client.getIdentity() : null
    },
    // The idle limit is left to id.ai, whose default is also 7 days
    signIn: () => client.signIn({ maxTimeToLive: SESSION_NS }),
    signOut: () => client.signOut(),
    watch(onEnd) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let ended = false
      // Expiry changes nothing in storage, so the client reports it to no
      // subscriber; a timer and a check on return to the tab catch it instead
      const check = () => {
        if (ended) return
        clearTimeout(timer)
        const status = client.getStatus()
        if (status.state !== 'signed-in') {
          ended = true
          onEnd()
          return
        }
        timer = setTimeout(
          check,
          Math.min(
            Math.max(status.expiresAtMs - Date.now(), 0) + 1000,
            MAX_TIMER_MS
          )
        )
      }
      const unsubscribe = client.subscribe(check)
      document.addEventListener('visibilitychange', check)
      check()
      return () => {
        ended = true
        clearTimeout(timer)
        unsubscribe()
        document.removeEventListener('visibilitychange', check)
      }
    },
  }
}

export async function createSession(): Promise<Session> {
  if (import.meta.env.MODE === 'e2e') {
    const { e2eSession } = await import('./e2e_session')
    return e2eSession()
  }
  return realSession()
}
