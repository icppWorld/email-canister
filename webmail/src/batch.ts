// Calls for many messages, and how their refusals show

import { errorText } from './api'

// The most messages the canister lists, flags, moves or deletes in one call
export const BATCH = 100

// Runs an action, showing a refusal with onError. A new action clears the
// refusal shown before, and keeps one its own work shows.
export async function attempt(
  run: () => Promise<unknown>,
  onError: (text: string) => void
): Promise<void> {
  onError('')
  try {
    await run()
  } catch (e) {
    onError(errorText(e))
  }
}

// A call for many messages, in parts of `size`, as the canister takes them.
// Returns the ids it got through, and the refusal that stopped it.
export async function inBatches(
  ids: bigint[],
  call: (part: bigint[]) => Promise<unknown>,
  size = BATCH
): Promise<{ done: bigint[]; error?: unknown }> {
  for (let at = 0; at < ids.length; at += size) {
    try {
      await call(ids.slice(at, at + size))
    } catch (error) {
      return { done: ids.slice(0, at), error }
    }
  }
  return { done: ids }
}
