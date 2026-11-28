// The backend's Candid interface, and the calls the webmail makes.

import {
  Actor,
  AgentError,
  HttpAgent,
  IngressExpiryInvalidErrorCode,
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
  folder: bigint
  sender_address: string // the From address alone, or empty while not parsed
}

export type Page = { items: Summary[]; cursor: [] | [bigint] }
// New mail from the address goes to Spam
export type Blocked = {
  address: string
  blocked_by: Principal
  name: [] | [string]
  at_ns: bigint
}
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
// Trash keeps mail for 30 days from when it left the Inbox, Spam for 30 days
// from its arrival
export const FOLDER_INBOX = 0n
export const FOLDER_TRASH = 1n
export const FOLDER_SPAM = 2n

export const OUTBOX_QUEUED = 0n
export const OUTBOX_SENDING = 1n
export const OUTBOX_ACCEPTED = 2n
export const OUTBOX_REJECTED = 3n
export const OUTBOX_UNKNOWN = 4n

// The limit the backend enforces, with attachments in base64
export const MAX_ENCODED_BYTES = 1_950_000

// Text's size as the backend counts it (outbox_encoded_size in
// src/store/outbox_store.cpp): UTF-8, as the bridge's JSON escapes it, a
// quote, a backslash, \n, \r and \t in two bytes, any other control
// character in six. Change them together.
export function jsonSize(text: string): number {
  let size = 0
  for (const byte of new TextEncoder().encode(text)) {
    size +=
      byte === 0x22 ||
      byte === 0x5c ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x09
        ? 2
        : byte < 0x20
          ? 6
          : 1
  }
  return size
}

// A calendar event as the backend keeps it: a VEVENT block (see ical.ts),
// and the span it covers in UTC seconds
export type CalendarEvent = {
  uid: string
  vevent: string
  starts: bigint
  ends: bigint
  modified_ns: bigint
}
export type EventPage = { items: CalendarEvent[]; cursor: [] | [bigint] }
// What a put stores: the event, and the VTIMEZONE blocks it names
export type ZoneBlock = { tzid: string; block: string }
export type EventRequest = Omit<CalendarEvent, 'modified_ns'> & {
  vtimezones: ZoneBlock[]
}

// The methods of one mailbox, as the backend has them after the mailbox's
// local part
export type Mailbox = {
  mail_list(request: {
    folder: bigint
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<Page>
  mail_get(uid: bigint): Promise<FullMessage>
  mail_search(request: {
    query: string
    folder: bigint
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<Page>
  // Sets the flags in `set` and clears those in `clear` on each message, so
  // that members who change different flags at once keep both. Setting the
  // seen flag records that the caller opened the message.
  mail_set_flags(uids: bigint[], set: bigint, clear: bigint): Promise<void>
  // For good, the messages still in `folder`: mail_move puts mail in Trash
  mail_delete(uids: bigint[], folder: bigint): Promise<bigint>
  // How many moved, the uids moved, and the uids deleted instead: mail moved
  // into Spam that arrived more than 30 days ago. A vec nat64 in a reply
  // decodes to a BigUint64Array.
  mail_move(
    uids: bigint[],
    folder: bigint
  ): Promise<[bigint, BigUint64Array, BigUint64Array]>
  // Whether this call blocked the address: false when it was already
  mail_block(address: string): Promise<boolean>
  // Whether the address was blocked
  mail_unblock(address: string): Promise<boolean>
  mail_blocked(): Promise<Blocked[]>
  mail_send(request: SendRequest): Promise<bigint>
  mail_outbox_list(request: {
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<OutboxPage>
  mail_outbox_get(id: bigint): Promise<OutboxMessage>
  mail_outbox_resend(id: bigint): Promise<void>
  mail_outbox_delete(id: bigint): Promise<void>
  // For good, at most 200 at once: the ids it deleted. It skips mail being
  // sent, and mail no longer there.
  mail_outbox_delete_many(ids: bigint[]): Promise<BigUint64Array>
  // A download freezes the mailbox file: renew it while reading, thaw it after
  // renew: the started_ns of the download it renews
  mail_export_freeze(renew: [] | [bigint]): Promise<ExportInfo>
  mail_export_thaw(started_ns: bigint): Promise<void>
  mail_export_chunk(request: {
    offset: bigint
    length: bigint
  }): Promise<ExportChunk>
  // The events that overlap [from, to), in UTC seconds
  mail_cal_list(request: {
    from: bigint
    to: bigint
    cursor: [] | [bigint]
    limit: bigint
  }): Promise<EventPage>
  // Adds or replaces the event with this uid
  mail_cal_put(request: EventRequest): Promise<void>
  // Whether there was such an event
  mail_cal_delete(uid: string): Promise<boolean>
  // The token of the calendar's secret address, while it is shared
  mail_cal_feed(): Promise<[] | [string]>
  // A new secret address; the old one stops working
  mail_cal_feed_reset(): Promise<string>
  mail_cal_feed_stop(): Promise<void>
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

// The delays before the agent sends a request that did not get through again,
// as its own default has them, but limited only by the number of tries. Its
// default also gives up once 15 minutes have passed since the request began:
// a read under way when a phone slept had passed that when it woke, so it
// failed without another try.
const AGENT_RETRIES = 3
function retryDelays() {
  let interval = 500
  let tries = 0
  return {
    next: () => {
      if (tries === AGENT_RETRIES) return null
      tries += 1
      interval *= 1.5
      return interval * (0.5 + Math.random())
    },
  }
}

export function createBackend(identity: Identity): Backend {
  // On a canister's icp0.io address the agent itself switches to https://icp0.io,
  // so public/.ic-assets.json5 has to allow that host in connect-src
  const agent = HttpAgent.createSync({
    host: window.location.origin,
    identity,
    shouldFetchRootKey: deployment().network === 'local',
    retryTimes: AGENT_RETRIES,
    backoffStrategy: retryDelays,
  })
  const actor: ActorSubclass = Actor.createActor(idlFactory, {
    agent,
    canisterId: deployment().backend,
  })
  const queries = new Set(
    Actor.interfaceOf(actor)
      ._fields.filter(([, method]) => method.annotations.includes('query'))
      .map(([name]) => name)
  )
  return retrying(actor as unknown as Backend, queries)
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
//
// The network refuses a request whose expiry has passed, as one signed before
// a phone slept and sent when it woke. A query is asked again at once, signed
// anew. An update is not: one refused while its result was awaited may have
// run already.
const RETRIES = 3
const BUSY_WAIT_MS = 1500

function retrying(backend: Backend, queries: Set<string>): Backend {
  return new Proxy(backend, {
    get(target, name, receiver) {
      const method = Reflect.get(target, name, receiver)
      if (typeof method !== 'function') return method
      const query = typeof name === 'string' && queries.has(name)
      return async (...args: unknown[]) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await method.apply(target, args)
          } catch (error) {
            const refused = expiryRefused(error)
            if (refused && !query)
              throw new Error(UNCONFIRMED, { cause: error })
            if (
              attempt >= RETRIES ||
              !(refused || errorText(error).startsWith('busy:'))
            )
              throw error
            if (!refused)
              await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
          }
        }
      }
    },
  })
}

const expiryRefused = (error: unknown) =>
  error instanceof AgentError && error.hasCode(IngressExpiryInvalidErrorCode)

const UNCONFIRMED =
  'The connection to the mail server was interrupted. Check whether this went through before trying again.'

// A refused expiry in plain words: one that a fresh request does not get past
// is a clock that is off. Or the message a canister trapped with, or else the
// error without the stack trace a failed fetch carries.
export function errorText(error: unknown): string {
  if (expiryRefused(error))
    return "The mail server refuses this device's time. Check that its date and time are set automatically, then reload this page."
  const text = error instanceof Error ? error.message : String(error)
  const trapped =
    /with message: '([\s\S]*?)'\.?\s+Consider/.exec(text) ??
    /trapped explicitly: ([^\n]*)/.exec(text)
  return trapped
    ? trapped[1]
    : text
        .split('\n')
        .filter((line) => !/^\s+at /.test(line))
        .join('\n')
}
