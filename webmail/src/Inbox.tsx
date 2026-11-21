import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Principal } from '@icp-sdk/core/principal'

import {
  errorText,
  FLAG_FLAGGED,
  FLAG_SEEN,
  FOLDER_INBOX,
  FOLDER_SPAM,
  FOLDER_TRASH,
  MESSAGE_QUARANTINED,
  MESSAGE_QUEUED,
  type Mailbox,
  type SeenBy,
  type Summary,
} from './api'
import type { Draft } from './Compose'
import { formatNs, formatTime, memberName } from './format'
import { Icon, type IconName } from './Icon'
import { MessageBody } from './MessageBody'
import { deliveredVia, parseMail, saveFile, type ParsedMail } from './mime'
import { BackButton, StarButton } from './Buttons'
import { Menu } from './Menu'
import type { Toast, ToastAction } from './Toast'

const PAGE_SIZE = 50n
const REFRESH_MS = 20_000
// The most messages the canister lists, flags, moves or deletes in one call
const BATCH = 100
// A search page can come back empty with a cursor, when the canister's budget
// ran out before a match: a load reads on by itself up to this many pages
const SEARCH_CALLS = 5
// Spam keeps mail for 30 days from its arrival: a move there deletes older
// mail instead
const SPAM_KEEP_NS = 30n * 86_400n * 1_000_000_000n

export type Folder = 'inbox' | 'trash' | 'spam'

const FOLDERS: Record<Folder, { number: bigint; name: string }> = {
  inbox: { number: FOLDER_INBOX, name: 'the Inbox' },
  trash: { number: FOLDER_TRASH, name: 'Trash' },
  spam: { number: FOLDER_SPAM, name: 'Spam' },
}

export const isFolder = (view: string): view is Folder =>
  Object.hasOwn(FOLDERS, view)

// What can be done to a message, by the folder it is in
type Action = {
  label: string
  icon: IconName
  danger?: true // it cannot be undone
  run: (uids: bigint[]) => Promise<unknown>
}

// One in the reader's ⋮ menu. needs: what it waits for, the sender's address
// or the reader's own mark as read, which must not land after it.
type MoreAction = {
  label: string
  needs?: 'sender' | 'mark'
  run: (sender: string) => Promise<unknown>
}

// Runs an action, showing a refusal with onError. A new action clears the
// refusal shown before, and keeps one its own work shows.
async function attempt(
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

// A call for many messages, in parts the canister takes. Returns the uids it
// got through, how many of them the canister counted as changed, and the
// refusal that stopped it.
async function inBatches(
  uids: bigint[],
  call: (part: bigint[]) => Promise<bigint | void>
): Promise<{ done: bigint[]; count: number; error?: unknown }> {
  let count = 0
  for (let at = 0; at < uids.length; at += BATCH) {
    try {
      const changed = await call(uids.slice(at, at + BATCH))
      if (typeof changed === 'bigint') count += Number(changed)
    } catch (error) {
      return { done: uids.slice(0, at), count, error }
    }
  }
  return { done: uids, count }
}

// "Message", "this message" or "3 messages"
const messages = (count: number, one: string) =>
  count === 1 ? one : `${count} messages`

// The flags that star a message, or take its star off
const starring = (flags: bigint): [bigint, bigint] =>
  flags & FLAG_FLAGGED ? [0n, FLAG_FLAGGED] : [FLAG_FLAGGED, 0n]

// Brings messages back to the folder they left, then puts back the blocks that
// went with them: a refused move leaves the blocks as they are, and a refusal
// offers Undo again, which does it all once more. Made here, so the toast
// holds only what it needs.
function undo(
  backend: Mailbox,
  uids: bigint[],
  from: bigint,
  { block = [], unblock = [] }: { block?: string[]; unblock?: string[] } = {}
): ToastAction {
  return {
    label: 'Undo',
    reload: true,
    run: async () => {
      const { error } = await inBatches(uids, (part) =>
        backend.mail_move(part, from)
      )
      if (error) throw error
      // Each apart, so a refused one leaves the others to go through
      const changes = await Promise.allSettled([
        ...unblock.map((address) => backend.mail_unblock(address)),
        ...block.map((address) => backend.mail_block(address)),
      ])
      const refused = changes.find((c) => c.status === 'rejected')
      if (refused) throw refused.reason
    },
  }
}

// What a move did, by what the canister counted as moved: mail to Spam that
// arrived more than 30 days ago was deleted instead, and the rest it did not
// count was no longer in the folder, as when another member moved it. back:
// the messages Undo can bring back.
type Moved = { count: number; deleted: number; gone: number; back: bigint[] }

function moved(
  listed: Map<bigint, Summary>,
  done: bigint[],
  count: number,
  to: Folder
): Moved {
  const cutoff = BigInt(Date.now()) * 1_000_000n - SPAM_KEEP_NS
  const old = new Set(
    to === 'spam'
      ? done.filter((uid) => (listed.get(uid)?.received_ns ?? cutoff) < cutoff)
      : []
  )
  const deleted = Math.min(old.size, done.length - count)
  return {
    count,
    deleted,
    gone: done.length - count - deleted,
    back: done.filter((uid) => !old.has(uid)),
  }
}

// The note of a move, with `also` for what came with it, such as a block
function movedText(
  { count, deleted, gone }: Moved,
  to: string,
  also: string
): string {
  const parts: string[] = []
  // The first part says "Message" or "3 messages", the others only the number
  const many = (n: number) =>
    parts.length === 0 ? messages(n, 'Message') : `${n}`
  if (count > 0) {
    parts.push(`${many(count)} moved to ${to}${also && ` and ${also}`}`)
  }
  if (deleted > 0) {
    const they = deleted === 1 ? 'it' : 'they'
    parts.push(
      `${many(deleted)} deleted for good: ${they} arrived more than 30 days ago`
    )
  }
  if (gone > 0) {
    parts.push(`${many(gone)} ${gone === 1 ? 'was' : 'were'} no longer here`)
  }
  if (also && count === 0) parts.push(also)
  return parts.join('. ')
}

function when(summary: Summary): string {
  return summary.sent_at > 0n
    ? formatTime(Number(summary.sent_at) * 1000)
    : formatNs(summary.received_ns)
}

// An address as the canister keeps it: only A to Z in lower case
const kept = (address: string) =>
  address.replace(/[A-Z]/g, (c) => c.toLowerCase())

function senderOf(summary: Summary): string {
  return summary.sender || summary.envelope_from
}

function quote(mail: ParsedMail): string {
  return (
    `\n\nOn ${mail.date}, ${mail.from} wrote:\n` +
    mail.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
  )
}

function Reader({
  backend,
  principal,
  shared,
  summary,
  touched,
  actions,
  onSpam,
  onStar,
  more,
  onReply,
  onFlags,
  onCounts,
  onBack,
}: {
  backend: Mailbox
  principal: string // the reader's own
  shared: boolean // the mailbox has other members, or had
  onCounts: () => void // the mailbox's unread count may have changed
  summary: Summary
  // The flags changed on this page since each message started loading, here
  // or in the list: its reply must not undo them
  touched: RefObject<Map<bigint, bigint>>
  actions: Action[] // the folder's, for this message
  onSpam?: () => Promise<unknown> // in the Inbox: to Spam, blocking the sender
  onStar: () => Promise<unknown> // stars the message, or takes its star off
  more: MoreAction[] // the folder's, in the ⋮ menu
  onReply: (draft: Omit<Draft, 'from'>) => void // from the mailbox shown
  // The flags set and cleared, applied to the latest state: another change
  // may have landed while this one was under way
  onFlags: (set: bigint, clear: bigint) => void
  onBack: () => void // to the list, at phone width
}) {
  const [raw, setRaw] = useState<Uint8Array | null>(null)
  const [mail, setMail] = useState<ParsedMail | null>(null)
  const [unparsed, setUnparsed] = useState(false)
  const [error, setError] = useState('')
  // A refused flag or delete, apart from the message's own error, which it
  // must not hide
  const [actionError, setActionError] = useState('')
  // The backend could not process a quarantined message, and it may have been
  // made to harm whatever reads it: it shows as plain text until asked. The
  // state comes with the message, as it may have changed since the list loaded.
  const [state, setState] = useState(summary.state)
  // Who opened the message, and when each first did
  const [seenBy, setSeenBy] = useState<SeenBy[]>([])
  // Its mark as read is made, or was not needed
  const [settled, setSettled] = useState(false)
  // The From address as the canister read it, else the envelope's; none
  // while it loads, so a quick click cannot block the wrong one
  const [sender, setSender] = useState('')
  const quarantined = state === MESSAGE_QUARANTINED
  const [formatted, setFormatted] = useState(false)
  const plain = quarantined && !formatted
  const rawText = useMemo(
    () => (raw && (plain || unparsed) ? new TextDecoder().decode(raw) : ''),
    [raw, plain, unparsed]
  )

  // Mounted once per message (keyed by uid), so its state starts empty
  useEffect(() => {
    let current = true
    const listed = summary.flags
    touched.current.set(summary.uid, 0n)
    ;(async () => {
      try {
        const full = await backend.mail_get(summary.uid)
        if (current) {
          setState(full.summary.state)
          setSender(full.summary.sender_address || full.summary.envelope_from)
          setRaw(Uint8Array.from(full.raw))
          setSeenBy(full.seen_by)
          // Only what changed since the list loaded, as when another member
          // flagged or read it, so a change made here meanwhile stays
          const flags = full.summary.flags
          const mine = touched.current.get(summary.uid) ?? 0n
          onFlags(flags & ~listed & ~mine, listed & ~flags & ~mine)
        }
        // Every member who opens a message is recorded once, also after
        // another member read it
        const recorded = full.seen_by.some(
          (seen) => seen.principal.toText() === principal
        )
        const unread = (full.summary.flags & FLAG_SEEN) === 0n
        // Marked read or unread by hand while it loaded: that choice stays
        const byHand =
          ((touched.current.get(summary.uid) ?? 0n) & FLAG_SEEN) !== 0n
        if ((unread || !recorded) && !byHand) {
          try {
            await backend.mail_set_flags([summary.uid], FLAG_SEEN, 0n)
            // A message already read by another member counts no differently
            if (unread) onCounts()
            if (current) {
              onFlags(FLAG_SEEN, 0n)
              if (!recorded) {
                const self = {
                  principal: Principal.fromText(principal),
                  name: [] as [],
                  at_ns: BigInt(Date.now()) * 1_000_000n,
                }
                setSeenBy((seen) => [...seen, self])
              }
            }
          } catch (e) {
            // During a download of the mailbox it stays unread, without an error
            if (!errorText(e).startsWith('downloading:')) throw e
          }
        }
      } catch (e) {
        if (current) setError(errorText(e))
      } finally {
        if (current) setSettled(true)
      }
    })()
    return () => {
      current = false
    }
    // Flags change as a result of opening: only a new message reloads this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, summary.uid])

  useEffect(() => {
    if (!raw || plain) return
    let current = true
    ;(async () => {
      try {
        const parsed = await parseMail(raw)
        if (current) setMail(parsed)
      } catch {
        // Mail the parser cannot read stays readable as text
        if (current) setUnparsed(true)
      }
    })()
    return () => {
      current = false
    }
  }, [raw, plain])

  // A refusal stays beside the message
  const act = (run: () => Promise<unknown>) => attempt(run, setActionError)

  const reply = () => {
    if (!mail) return
    const subject = /^re:/i.test(mail.subject)
      ? mail.subject
      : `Re: ${mail.subject}`
    onReply({ to: mail.fromAddress, subject, body: quote(mail) })
  }

  const via = mail
    ? deliveredVia(mail.fromAddress, summary.envelope_from)
    : null
  const files = mail?.attachments.filter((a) => !a.inline || !a.contentId) ?? []

  return (
    <article className="reader">
      <div className="toolbar">
        <BackButton onClick={onBack} />
        <button onClick={reply} disabled={!mail}>
          Reply
        </button>
        {actions.map((action) => (
          <button
            key={action.label}
            className={action.danger ? 'danger' : undefined}
            onClick={() => act(() => action.run([summary.uid]))}
          >
            {action.label}
          </button>
        ))}
        <StarButton
          flagged={(summary.flags & FLAG_FLAGGED) !== 0n}
          onClick={() => act(onStar)}
        />
        {onSpam && <button onClick={() => act(onSpam)}>Spam</button>}
        {more.length > 0 && (
          <Menu label="More actions">
            {more.map((action) => (
              <button
                key={action.label}
                disabled={
                  (action.needs === 'sender' && !sender) ||
                  (action.needs === 'mark' && !settled)
                }
                onClick={() => act(() => action.run(sender))}
              >
                {action.label}
              </button>
            ))}
          </Menu>
        )}
        {(shared ||
          seenBy.some((seen) => seen.principal.toText() !== principal)) && (
          <details className="seen-by">
            <summary>Seen by {seenBy.length}</summary>
            <ul aria-label="Seen by">
              {seenBy.map((seen) => {
                const who = seen.principal.toText()
                return (
                  <li key={who}>
                    <span>{memberName(who, seen.name, principal)}</span>
                    <span className="date">{formatNs(seen.at_ns)}</span>
                  </li>
                )
              })}
            </ul>
          </details>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {quarantined && (
        <div className="warning" role="status" data-testid="quarantine-warning">
          <p>
            This message could not be processed. It may be malformed, or crafted
            to cause harm: be careful with its links and attachments.
          </p>
          {!formatted && raw && (
            <button onClick={() => setFormatted(true)}>
              Show it formatted anyway
            </button>
          )}
        </div>
      )}
      {!mail && !rawText && !error && <p className="hint">Loading…</p>}
      {mail && (
        <>
          <h2 data-testid="subject">{mail.subject || '(no subject)'}</h2>
          <dl className="headers">
            <dt>From</dt>
            <dd>
              {mail.from}
              {via && (
                <span className="via" data-testid="via">
                  {' '}
                  via {via}
                </span>
              )}
            </dd>
            <dt>To</dt>
            <dd>{mail.to}</dd>
            {mail.cc && (
              <>
                <dt>Cc</dt>
                <dd>{mail.cc}</dd>
              </>
            )}
            <dt>Date</dt>
            <dd>{when(summary)}</dd>
          </dl>
          {files.length > 0 && (
            <ul className="attachments" aria-label="Attachments">
              {files.map((file, index) => (
                <li key={index}>
                  <button onClick={() => saveFile(file.filename, file.content)}>
                    {file.filename} ({Math.ceil(file.content.length / 1024)} KB)
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mail.html ? (
            <MessageBody html={mail.html} attachments={mail.attachments} />
          ) : (
            <pre className="body text">{mail.text}</pre>
          )}
        </>
      )}
      {rawText && <pre className="body text">{rawText}</pre>}
    </article>
  )
}

export function Inbox({
  backend,
  principal,
  shared,
  folder,
  notify,
  onReply,
  onCounts,
  refresh,
  onLoaded,
  onBlocked,
  domain,
}: {
  backend: Mailbox
  principal: string
  shared: boolean
  folder: Folder
  notify: (toast: Toast) => void
  onCounts: () => void
  onReply: (draft: Omit<Draft, 'from'>) => void
  refresh: number
  onLoaded: () => void
  onBlocked: () => void // to the Blocked senders page
  domain: string // the mailbox's own, whose addresses Spam never blocks
}) {
  const here = FOLDERS[folder].number
  const [items, setItems] = useState<Summary[]>([])
  const [cursor, setCursor] = useState<[] | [bigint]>([])
  const [selected, setSelected] = useState<Summary | null>(null)
  // The messages ticked for an action on all of them
  const [checked, setChecked] = useState<ReadonlySet<bigint>>(new Set())
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  // The search shown now, for a reload by work that began under another
  const searched = useRef('')
  const [error, setError] = useState('')
  // Replies can arrive out of order, and only the newest may be shown
  const latestLoad = useRef(0)
  // Flags set and mail moved here, which a reply read before them would undo
  const changes = useRef(0)
  const olderShown = useRef(false)
  const allBox = useRef<HTMLInputElement>(null)
  const touched = useRef(new Map<bigint, bigint>())

  const load = useCallback(
    async (from: [] | [bigint], append: boolean, search: string) => {
      const request = ++latestLoad.current
      const readPage = (cursor: [] | [bigint]) =>
        search
          ? backend.mail_search({
              query: search,
              folder: here,
              cursor,
              limit: PAGE_SIZE,
            })
          : backend.mail_list({ folder: here, cursor, limit: PAGE_SIZE })
      try {
        let read = changes.current
        let at = from
        let page = await readPage(at)
        for (let calls = 1; request === latestLoad.current; ) {
          if (read !== changes.current) {
            // Read before a change made here: read again, so the change stays
            read = changes.current
          } else if (
            page.items.length === 0 &&
            page.cursor.length > 0 &&
            calls < SEARCH_CALLS
          ) {
            // Nothing found before the canister's budget ran out: on from there
            at = page.cursor
            calls++
          } else {
            break
          }
          page = await readPage(at)
        }
        if (request !== latestLoad.current) return
        olderShown.current = append
        setItems((previous) =>
          append ? [...previous, ...page.items] : page.items
        )
        setCursor(page.cursor)
        setError('')
      } catch (e) {
        if (request === latestLoad.current) setError(errorText(e))
      }
    },
    [backend, here]
  )

  useEffect(() => {
    load([], false, activeQuery).finally(onLoaded)
    if (activeQuery) return
    // Refreshing replaces the list with its first page, so not while reading older mail
    const timer = window.setInterval(() => {
      if (!olderShown.current) load([], false, '')
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load, activeQuery, refresh, onLoaded])

  // The first page again, of the search shown now
  const reload = () => load([], false, searched.current)

  // A list load under way began before this change: its reply must not undo it
  const updateFlags = (uids: bigint[], set: bigint, clear: bigint) => {
    if (uids.length === 0 || (set | clear) === 0n) return
    changes.current++
    const changed = new Set(uids)
    const apply = (m: Summary) =>
      changed.has(m.uid) ? { ...m, flags: (m.flags | set) & ~clear } : m
    setItems((previous) => previous.map(apply))
    setSelected((previous) => previous && apply(previous))
  }

  // Takes messages that moved or were deleted off the list and the reader
  const drop = (uids: bigint[]) => {
    if (uids.length === 0) return
    changes.current++
    const gone = new Set(uids)
    setItems((previous) => previous.filter((m) => !gone.has(m.uid)))
    setChecked((ticked) => new Set([...ticked].filter((uid) => !gone.has(uid))))
    setSelected((previous) =>
      previous && gone.has(previous.uid) ? null : previous
    )
  }

  const anyUnread = (uids: bigint[]) => {
    const asked = new Set(uids)
    return items.some((m) => asked.has(m.uid) && (m.flags & FLAG_SEEN) === 0n)
  }

  // The list's copy of each message, newer than the reader's, read before a
  // move takes them off it
  const listed = () =>
    new Map([...(selected ? [selected] : []), ...items].map((m) => [m.uid, m]))

  // Out of this folder, for the caller to say so. What moved before a
  // refusal leaves the list, and when the canister moved fewer than asked,
  // the list loads again.
  const moveOut = async (uids: bigint[], to: Folder) => {
    const before = listed()
    const { done, count, error } = await inBatches(uids, (part) =>
      backend.mail_move(part, FOLDERS[to].number)
    )
    if (anyUnread(done)) onCounts()
    drop(done)
    const result = moved(before, done, count, to)
    if (result.gone > 0) reload()
    return { done, result, before, error }
  }

  // Undo only for what moved: mail deleted for good cannot come back
  const noted = (result: Moved, actions: ToastAction[]) =>
    result.count > 0 ? actions : undefined

  const move = async (uids: bigint[], to: Folder) => {
    const { done, result, error } = await moveOut(uids, to)
    if (done.length > 0) {
      notify({
        text: movedText(result, FOLDERS[to].name, ''),
        actions: noted(result, [undo(backend, result.back, here)]),
      })
    }
    if (error) throw error
  }

  // To Spam blocks the From address of each message, and from Spam to the
  // Inbox unblocks it, both as the canister replies. Undo takes back the
  // blocks this click made, and those whose reply was lost, which may have
  // been made; it blocks again only what this click unblocked. Spam blocks no
  // address of the mailbox's own domain or its subdomains, which spam often
  // claims to be from. Mail with no From address only moves. The reader
  // closes with the move, so the note says what failed after it.
  const judge = async (uids: bigint[], to: 'spam' | 'inbox') => {
    const spam = to === 'spam'
    const { done, result, before, error } = await moveOut(uids, to)
    const ours = (address: string) =>
      address.endsWith(`@${kept(domain)}`) ||
      address.endsWith(`.${kept(domain)}`)
    const tried = [
      ...new Set(
        done.map((uid) => kept(before.get(uid)?.sender_address ?? ''))
      ),
    ].filter((address) => address !== '' && !(spam && ours(address)))
    const results = await Promise.allSettled(
      tried.map((address) =>
        spam ? backend.mail_block(address) : backend.mail_unblock(address)
      )
    )
    if (done.length > 0) {
      const changed = tried.filter((_, i) => {
        const reply = results[i]
        return reply.status === 'fulfilled' && reply.value
      })
      const refused = tried.filter((_, i) => results[i].status === 'rejected')
      const who = (list: string[]) =>
        list.length === 1 ? list[0] : `${list.length} senders`
      let text = movedText(
        result,
        FOLDERS[to].name,
        changed.length > 0
          ? `${who(changed)} ${spam ? 'blocked' : 'unblocked'}`
          : ''
      )
      const refusal = results.find((r) => r.status === 'rejected')?.reason
      if (refused.length > 0) {
        text +=
          `. ${spam ? 'Blocking' : 'Unblocking'} ${who(refused)}` +
          ` failed: ${errorText(refusal)}`
      }
      const blocks = spam
        ? { unblock: [...changed, ...refused] }
        : { block: changed }
      notify({
        text,
        actions: noted(result, [undo(backend, result.back, here, blocks)]),
      })
    }
    if (error) throw error
  }

  // For good, once confirmed
  const deleteForever = async (uids: bigint[]) => {
    if (
      !window.confirm(
        `Delete ${messages(uids.length, 'this message')} forever?`
      )
    )
      return
    const { done, error } = await inBatches(uids, (part) =>
      backend.mail_delete(part, here)
    )
    if (anyUnread(done)) onCounts()
    drop(done)
    if (error) throw error
  }

  const flag = async (uids: bigint[], set: bigint, clear: bigint) => {
    // Before the call, so a message loading in the reader keeps the change
    for (const uid of uids) {
      if (touched.current.has(uid))
        touched.current.set(uid, touched.current.get(uid)! | set | clear)
    }
    const { done, error } = await inBatches(uids, (part) =>
      backend.mail_set_flags(part, set, clear)
    )
    updateFlags(done, set, clear)
    if ((set | clear) & FLAG_SEEN) onCounts()
    if (error) throw error
  }

  // Every message in Trash or Spam, page by page. The walk follows the
  // cursor, so a page that still lists mail deleted already, as a replica
  // that lags can, neither repeats nor ends it.
  const empty = async () => {
    if (
      !window.confirm(
        `Delete every message in ${FOLDERS[folder].name} forever?`
      )
    )
      return
    try {
      let cursor: [] | [bigint] = []
      do {
        const page = await backend.mail_list({
          folder: here,
          cursor,
          limit: BigInt(BATCH),
        })
        if (page.items.length > 0) {
          await backend.mail_delete(
            page.items.map((m) => m.uid),
            here
          )
        }
        cursor = page.cursor
      } while (cursor.length > 0)
    } finally {
      // Also after a refusal: what went before is gone from the list
      setSelected(null)
      await reload()
    }
  }

  // New mail from the address goes to Spam. Undo lifts only a block this
  // made, as the canister replies.
  const block = async (address: string) => {
    const made = await backend.mail_block(address)
    notify({
      text: made ? `Blocked ${address}` : `${address} was blocked already`,
      actions: made
        ? [undo(backend, [], here, { unblock: [address] })]
        : undefined,
    })
  }

  // The reader's ⋮ menu, by folder
  const readerMore = (uid: bigint): MoreAction[] => {
    if (folder === 'inbox') {
      return [
        {
          label: 'Mark unread',
          needs: 'mark',
          // Back to the list, unless another message opened meanwhile
          run: async () => {
            await markUnread.run([uid])
            setSelected((open) => (open?.uid === uid ? null : open))
          },
        },
      ]
    }
    if (folder === 'spam') {
      return [{ label: 'Block sender', needs: 'sender', run: block }]
    }
    return []
  }

  // A refusal in the list shows above it
  const act = (run: () => Promise<unknown>) => attempt(run, setError)

  const searchFor = (text: string) => {
    searched.current = text
    setActiveQuery(text)
  }

  const toTrash: Action = {
    label: 'Delete',
    icon: 'trash',
    run: (uids) => move(uids, 'trash'),
  }
  const toSpam: Action = {
    label: 'Spam',
    icon: 'spam',
    run: (uids) => judge(uids, 'spam'),
  }
  const restore: Action = {
    label: folder === 'spam' ? 'Not spam' : 'Restore',
    icon: folder === 'spam' ? 'inbox' : 'undo',
    run: (uids) =>
      folder === 'spam' ? judge(uids, 'inbox') : move(uids, 'inbox'),
  }
  const forever: Action = {
    label: 'Delete forever',
    icon: 'trash',
    danger: true,
    run: deleteForever,
  }
  const markRead: Action = {
    label: 'Mark read',
    icon: 'mailOpen',
    run: (uids) => flag(uids, FLAG_SEEN, 0n),
  }
  const markUnread: Action = {
    label: 'Mark unread',
    icon: 'mail',
    run: (uids) => flag(uids, 0n, FLAG_SEEN),
  }
  // A message's own; the reader has Spam and Mark unread apart
  const actions = folder === 'inbox' ? [toTrash] : [restore, forever]
  const bulkActions =
    folder === 'inbox' ? [toTrash, toSpam, markRead, markUnread] : actions

  const tick = (uid: bigint, on: boolean) =>
    setChecked((ticked) => {
      const next = new Set(ticked)
      if (on) next.add(uid)
      else next.delete(uid)
      return next
    })
  const ticked = items.filter((m) => checked.has(m.uid)).map((m) => m.uid)
  const allTicked = items.length > 0 && ticked.length === items.length
  const someTicked = ticked.length > 0 && !allTicked
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = someTicked
  }, [someTicked])

  // A search with a cursor left has not looked everywhere yet
  let emptyHint = `Nothing in ${FOLDERS[folder].name}.`
  if (folder === 'inbox') emptyHint = 'No mail yet.'
  if (activeQuery) {
    emptyHint = cursor.length > 0 ? 'No matches yet.' : 'No matches.'
  }

  return (
    <div className={selected ? 'split reading' : 'split'}>
      <section className="list" aria-label="Messages">
        <div className="list-head">
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              setSelected(null)
              searchFor(query.trim())
            }}
          >
            <input
              aria-label="Search mail"
              placeholder={
                folder === 'inbox'
                  ? 'Search mail'
                  : `Search ${FOLDERS[folder].name}`
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {activeQuery && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  searchFor('')
                }}
              >
                Clear
              </button>
            )}
          </form>
          {folder === 'spam' && (
            <div className="bulk">
              <button className="small" onClick={onBlocked}>
                Blocked senders
              </button>
            </div>
          )}
          {items.length > 0 && (
            <div className="bulk" role="toolbar" aria-label="Selected messages">
              <input
                ref={allBox}
                type="checkbox"
                aria-label="Select all"
                checked={allTicked}
                onChange={(e) =>
                  setChecked(
                    new Set(e.target.checked ? items.map((m) => m.uid) : [])
                  )
                }
              />
              {ticked.length > 0 ? (
                <>
                  <span className="hint">{ticked.length} selected</span>
                  {bulkActions.map((action) => (
                    <button
                      key={action.label}
                      className="small"
                      onClick={() => act(() => action.run(ticked))}
                    >
                      {action.label}
                    </button>
                  ))}
                </>
              ) : (
                folder !== 'inbox' &&
                !activeQuery && (
                  <button className="small" onClick={() => act(empty)}>
                    Empty {FOLDERS[folder].name}
                  </button>
                )
              )}
            </div>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items.length === 0 && !error && <p className="hint">{emptyHint}</p>}
        <ul>
          {items.map((m) => {
            const title =
              m.state === MESSAGE_QUEUED
                ? 'Arriving…'
                : m.subject || '(no subject)'
            const flagged = (m.flags & FLAG_FLAGGED) !== 0n
            const unread = (m.flags & FLAG_SEEN) === 0n
            const rowActions =
              folder === 'inbox'
                ? [toTrash, unread ? markRead : markUnread]
                : actions
            return (
              <li key={m.uid.toString()} className="message-row">
                {/* The label is the box's larger touch target */}
                <label className="pick-area">
                  <input
                    type="checkbox"
                    className="pick"
                    aria-label={`Select ${title}`}
                    checked={checked.has(m.uid)}
                    onChange={(e) => tick(m.uid, e.target.checked)}
                  />
                </label>
                <StarButton
                  flagged={flagged}
                  name={title}
                  onClick={() => act(() => flag([m.uid], ...starring(m.flags)))}
                />
                <button
                  className={unread ? 'message unread' : 'message'}
                  aria-current={selected?.uid === m.uid}
                  onClick={() => setSelected(m)}
                >
                  <span className="who">{senderOf(m)}</span>
                  <span className="date">{when(m)}</span>
                  <span className="subject">
                    {title}
                    {m.attachments > 0n ? (
                      <Icon name="paperclip" label="Has attachments" />
                    ) : null}
                    {m.state === MESSAGE_QUARANTINED
                      ? ' (could not be processed)'
                      : ''}
                  </span>
                  <span className="preview">{m.preview}</span>
                </button>
                {/* On hover, for a pointer; the boxes and the reader do the same */}
                <span className="row-actions">
                  {rowActions.map((action) => (
                    <button
                      key={action.label}
                      className="bare"
                      aria-label={`${action.label}: ${title}`}
                      title={action.label}
                      onClick={() => act(() => action.run([m.uid]))}
                    >
                      <Icon name={action.icon} />
                    </button>
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
        {cursor.length > 0 && (
          <button
            className="more"
            onClick={() => load(cursor, true, activeQuery)}
          >
            {activeQuery ? 'Keep searching' : 'Older mail'}
          </button>
        )}
      </section>
      {selected ? (
        <Reader
          principal={principal}
          shared={shared}
          onCounts={onCounts}
          key={selected.uid.toString()}
          backend={backend}
          summary={selected}
          touched={touched}
          actions={actions}
          onSpam={
            folder === 'inbox' ? () => toSpam.run([selected.uid]) : undefined
          }
          onStar={() => flag([selected.uid], ...starring(selected.flags))}
          more={readerMore(selected.uid)}
          onReply={onReply}
          onFlags={(set, clear) => updateFlags([selected.uid], set, clear)}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div className="reader empty">Select a message to read it.</div>
      )}
    </div>
  )
}
