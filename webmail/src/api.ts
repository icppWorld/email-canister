// The backend's Candid interface, and the calls the webmail makes.

import {
  Actor,
  HttpAgent,
  type ActorSubclass,
  type Identity,
} from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'

import { idlFactory } from './idl'
import { deployment } from './settings'

// A mailbox the caller is a member of; members counts who share it
export type MailboxInfo = {
  local: string
  address: string
  members: bigint
  message_count: bigint
  unseen: bigint
  used_bytes: bigint
  quota_bytes: bigint
  uidvalidity: bigint
}

export type Me = {
  principal: Principal
  name: [] | [string]
  is_controller: boolean
  mailboxes: MailboxInfo[]
}

export type Summary = {
  uid: bigint
  state: bigint
  flags: bigint
  modseq: bigint
  received_ns: bigint
  sent_at: bigint
  envelope_from: string
  subject: string
  sender: string
  attachments: bigint
  preview: string
  raw_bytes: bigint
}

export type Page = { items: Summary[]; cursor: [] | [bigint] }
// Who opened a message, and when each first did
export type SeenBy = {
  principal: Principal
  name: [] | [string]
  at_ns: bigint
}
export type FullMessage = {
  summary: Summary
  raw: Uint8Array | number[]
  seen_by: SeenBy[]
}
export type Attachment = { filename: string; content: Uint8Array | number[] }

export type SendRequest = {
  client_id: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html_body: string
  attachments: Attachment[]
}

export type OutboxSummary = {
  id: bigint
  state: bigint
  attempts: bigint
  created_ns: bigint
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  attachments: bigint
  bytes: bigint
  last_error: string
  sent_by: Principal // the member who sent it
  sent_by_name: [] | [string]
}

export type OutboxPage = { items: OutboxSummary[]; cursor: [] | [bigint] }
export type OutboxMessage = {
  summary: OutboxSummary
  html_body: string
  attachments: Attachment[]
}

export type Member = { principal: Principal; name: [] | [string] }
export type Entry = {
  local: string
  members: Member[]
  vacant: boolean // purged: the address is free to create again
  disabled: boolean
  quota_bytes: bigint
  used_bytes: bigint
  message_count: bigint
  needs_repair: [] | [string] // why the mailbox is held, until a check clears it
  uidvalidity: bigint // changes when the address is created again
}

// quarantined: in the mailboxes, could not be parsed; quarantined_moves: in
// the queue, could not be moved into a mailbox
export type IngestStats = {
  queued: bigint
  indexed: bigint
  quarantined: bigint
  quarantined_moves: bigint
}
export type ExportInfo = { size: bigint; started_ns: bigint; until_ns: bigint }
export type ExportChunk = {
  data: Uint8Array | number[]
  size: bigint
  started_ns: bigint
}
export type StorageTotals = {
  mailboxes: bigint
  messages: bigint
  used_bytes: bigint
  database_bytes: bigint
  stable_memory_bytes: bigint
}
export type Settings = { domain: string; bridge: [] | [Principal] }

export const MESSAGE_QUEUED = 0n
export const MESSAGE_QUARANTINED = 2n
export const FLAG_SEEN = 1n
export const FLAG_FLAGGED = 2n

export const OUTBOX_QUEUED = 0n
export const OUTBOX_SENDING = 1n
export const OUTBOX_ACCEPTED = 2n
export const OUTBOX_REJECTED = 3n
export const OUTBOX_UNKNOWN = 4n

// The limit the backend enforces, with attachments in base64
export const MAX_ENCODED_BYTES = 1_950_000

// The methods of one mailbox, as the backend has them after the mailbox's
// local part
export type Mailbox = {
  mail_list(request: { cursor: [] | [bigint]; limit: bigint }): Promise<Page>
  mail_get(uid: bigint): Promise<FullMessage>
  mail_search(request: {
    query: string
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<Page>
  // Sets the flags in `set` and clears those in `clear`, so that members who
  // change different flags at once keep both. Setting the seen flag records
  // that the caller opened the message.
  mail_set_flags(uid: bigint, set: bigint, clear: bigint): Promise<void>
  mail_delete(uids: bigint[]): Promise<bigint>
  mail_send(request: SendRequest): Promise<bigint>
  mail_outbox_list(request: {
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<OutboxPage>
  mail_outbox_get(id: bigint): Promise<OutboxMessage>
  mail_outbox_resend(id: bigint): Promise<void>
  mail_outbox_delete(id: bigint): Promise<void>
  // A download freezes the mailbox file: renew it while reading, thaw it after
  // renew: the started_ns of the download it renews
  mail_export_freeze(renew: [] | [bigint]): Promise<ExportInfo>
  mail_export_thaw(started_ns: bigint): Promise<void>
  mail_export_chunk(request: {
    offset: bigint
    length: bigint
  }): Promise<ExportChunk>
}

// Each Mailbox method with the mailbox's local part as its first argument
type Named<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (local: string, ...args: A) => R
    : never
}

export type Backend = Named<Mailbox> & {
  mail_me(): Promise<Me>
  admin_set_domain(domain: string): Promise<void>
  admin_set_bridge(bridge: Principal): Promise<void>
  admin_settings(): Promise<Settings>
  admin_create_mailbox(mailbox: {
    local: string
    quota_bytes: [] | [bigint]
    first_member: [] | [Principal]
  }): Promise<void>
  // Refused if the address was created again since it was listed with
  // `uidvalidity`
  admin_add_member(
    local: string,
    principal: Principal,
    uidvalidity: [] | [bigint]
  ): Promise<void>
  // Takes effect at the member's next call
  admin_remove_member(local: string, principal: Principal): Promise<void>
  // The name members see for a principal; '' removes it
  admin_set_name(principal: Principal, name: string): Promise<void>
  admin_set_disabled(local: string, disabled: boolean): Promise<void>
  admin_set_quota(local: string, bytes: bigint): Promise<void>
  // remaining counts bytes
  admin_purge(local: string): Promise<{ remaining: bigint }>
  admin_retry_moves(local: string): Promise<bigint>
  admin_check(
    local: string,
    table: [] | [string]
  ): Promise<{ result: string; instructions: bigint }>
  admin_list_entries(): Promise<Entry[]>
  admin_ingest_stats(): Promise<IngestStats>
  admin_storage_totals(): Promise<StorageTotals>
}

export function createBackend(identity: Identity): Backend {
  // On a canister's icp0.io address the agent itself switches to https://icp0.io,
  // so public/.ic-assets.json5 has to allow that host in connect-src
  const agent = HttpAgent.createSync({
    host: window.location.origin,
    identity,
    shouldFetchRootKey: deployment().network === 'local',
  })
  const actor: ActorSubclass = Actor.createActor(idlFactory, {
    agent,
    canisterId: deployment().backend,
  })
  return retryingWhileBusy(actor as unknown as Backend)
}

// The backend's methods of the mailbox `local`
export function mailbox(backend: Backend, local: string): Mailbox {
  return new Proxy({} as Mailbox, {
    get(_, name) {
      const method = Reflect.get(backend, name) as unknown
      if (typeof name !== 'string' || !name.startsWith('mail_'))
        return undefined
      if (typeof method !== 'function') return undefined
      return (...args: unknown[]) =>
        (method as (...all: unknown[]) => unknown).apply(backend, [
          local,
          ...args,
        ])
    },
  })
}

// A call answers "busy:" while the mailbox's file cannot be opened, which a
// short wait covers. A download answers "downloading:" instead: it can last
// minutes, so the reader sees that at once.
const BUSY_RETRIES = 3
const BUSY_WAIT_MS = 1500

function retryingWhileBusy(backend: Backend): Backend {
  return new Proxy(backend, {
    get(target, name, receiver) {
      const method = Reflect.get(target, name, receiver)
      if (typeof method !== 'function') return method
      return async (...args: unknown[]) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await method.apply(target, args)
          } catch (error) {
            if (
              attempt >= BUSY_RETRIES ||
              !errorText(error).startsWith('busy:')
            )
              throw error
            await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
          }
        }
      }
    },
  })
}

// The message a canister trapped with, or else the whole error
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const trapped =
    /with message: '([\s\S]*?)'\.?\s+Consider/.exec(text) ??
    /trapped explicitly: ([^\n]*)/.exec(text)
  return trapped ? trapped[1] : text
}
