// The backend as a signed-in user, called from the test itself: for a state a
// click cannot reach quickly, such as a download held open.

import { Actor, HttpAgent } from '@icp-sdk/core/agent'
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity'

import type { Backend } from '../src/api'
import { idlFactory } from '../src/idl'

// The identity the e2e build signs in with, from its hex seed
export const identityOf = (seed: string) =>
  Ed25519KeyIdentity.generate(Uint8Array.from(Buffer.from(seed, 'hex')))

export async function asUser(
  seed: string,
  url: string,
  backend: string
): Promise<Backend> {
  const identity = identityOf(seed)
  const host = new URL(url)
  host.hostname = '127.0.0.1' // Node does not resolve *.localhost
  const agent = await HttpAgent.create({
    host: host.origin,
    identity,
    shouldFetchRootKey: true,
  })
  return Actor.createActor(idlFactory, {
    agent,
    canisterId: backend,
  }) as unknown as Backend
}
