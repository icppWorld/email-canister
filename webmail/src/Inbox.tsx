import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
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
import { attempt, BATCH, inBatches } from './batch'
import {
  formatNs,
  formatTime,
  memberName,
  messages,
  noLongerHere,
  noteOf,
  shown,
} from './format'
import { Icon, type IconName } from './Icon'
import { MessageBody } from './MessageBody'
import {
  deliveredVia,
  frameBody,
  parseMail,
  saveFile,
  type ParsedMail,
} from './mime'
import { AppBar } from './AppBar'
import { BackButton, IconButton, StarButton } from './Buttons'
import {
  Bulk,
  RowPick,
  SelectionBar,
  useSelectMode,
  useTicks,
  type BulkAction,
} from './Bulk'
import { Menu } from './Menu'
import { Split } from './Splitter'
import type { Toast, ToastAction } from './Toast'

const PAGE_SIZE = 50n
const REFRESH_MS = 20_000
// A search page can come back empty with a cursor, when the canister's budget
// ran out before a match: a load reads on by itself up to this many pages
const SEARCH_CALLS = 5

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
  // read: the reader's copy of the message, newer than the list's
  run: (uids: bigint[], read?: Summary | null) => Promise<unknown>
}

// One in the reader's ⋮ menu. needs: what it waits for, the sender's address
// or the reader's own mark as read, which must not land after it.
type MoreAction = {
  label: string
  icon: IconName
  needs?: 'sender' | 'mark'
  run: (sender: string) => Promise<unknown>
}

// What a move did, as the canister replied: the uids it moved, how many it
// deleted for good instead (mail moved into Spam more than 30 days after it
// arrived), and how many it did neither to, being no longer in the folder, as
// when another member moved them
type Moved = { moved: bigint[]; deleted: number; gone: number }

// A move of many messages, in parts the canister takes. Returns the uids it
// got through, what it did to them, and the refusal that stopped it.
async function moveAll(
  backend: Mailbox,
  uids: bigint[],
  to: Folder
): Promise<{ done: bigint[]; result: Moved; error?: unknown }> {
  const moved: bigint[] = []
  let deleted = 0
  const { done, error } = await inBatches(uids, async (part) => {
    const [, these, gone] = await backend.mail_move(part, FOLDERS[to].number)
    moved.push(...these)
    deleted += gone.length
  })
  const gone = done.length - moved.length - deleted
  return { done, result: { moved, deleted, gone }, error }
}

// The flags that star a message, or take its star off
const starring = (flags: bigint): [bigint, bigint] =>
  flags & FLAG_FLAGGED ? [0n, FLAG_FLAGGED] : [FLAG_FLAGGED, 0n]

// The note of a move, with `also` for what came with it, such as a block
function movedText(
  { moved, deleted, gone }: Moved,
  to: string,
  also: string
): string {
  const they = deleted === 1 ? 'it' : 'they'
  const text = noteOf(
    [
      [moved.length, `moved to ${to}${also && ` and ${also}`}`],
      [deleted, `deleted for good: ${they} arrived more than 30 days ago`],
      [gone, noLongerHere(gone)],
    ],
    'Message'
  )
  return also && moved.length === 0
    ? [text, also].filter(Boolean).join('. ')
    : text
}

// Brings messages back to the folder they left, then puts back the blocks that
// went with them, only once all are back. A move refused before anything
// moved leaves all as it was, so the same Undo can be tried again; after
// that, the note says what was done and what was not. Mail moved back into
// Spam more than 30 days after it arrived is deleted instead, which the note
// says. Without messages it changes only the blocks, and the caller gives it
// a label that promises no mail. Made here, so the toast holds only what it
// needs.
function undo(
  backend: Mailbox,
  uids: bigint[],
  from: Folder,
  { block = [], unblock = [] }: { block?: string[]; unblock?: string[] } = {}
): ToastAction {
  return {
    label: 'Undo',
    icon: 'undo',
    reload: true,
    run: async () => {
      const { done, result, error } = await moveAll(backend, uids, from)
      if (error && done.length === 0) throw error
      if (error) {
        const blocks = block.length + unblock.length > 0
        return {
          text: [
            movedText(result, FOLDERS[from].name, ''),
            `Couldn't move ${uids.length - done.length} back: ${errorText(error)}`,
            ...(blocks ? ["Senders' blocks unchanged"] : []),
          ].join('. '),
        }
      }
      // Each apart, so a refused one leaves the others to go through
      const replies = await Promise.allSettled([
        ...unblock.map((address) => backend.mail_unblock(address)),
        ...block.map((address) => backend.mail_block(address)),
      ])
      const refused = (list: string[], offset: number) =>
        list.filter((_, i) => replies[offset + i].status === 'rejected')
      const unblocked = refused(unblock, 0)
      const blocked = refused(block, unblock.length)
      const them = (list: string[]) => (list.length === 1 ? 'it' : 'them')
      // Each message back, to block from; not when one was deleted for good
      const back = uids.length > 0 && result.moved.length === uids.length
      const parts = [
        result.deleted + result.gone > 0 ||
        unblocked.length + blocked.length > 0
          ? movedText(result, FOLDERS[from].name, '')
          : '',
        unblocked.length > 0
          ? `Couldn't unblock ${unblocked.join(', ')}: unblock ${them(unblocked)} under Blocked senders`
          : '',
        blocked.length > 0
          ? `Couldn't block ${blocked.join(', ')} again` +
            (back ? `: block ${them(blocked)} from the message` : '')
          : '',
      ].filter((part) => part !== '')
      if (parts.length > 0) return { text: parts.join('. ') }
    },
  }
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
  return shown(summary.sender || summary.envelope_from)
}

// A summary as the list shows it: see `shown`. The sender is shown through
// senderOf, which may take it from the envelope.
const shownSummary = (summary: Summary): Summary => ({
  ...summary,
  subject: shown(summary.subject),
  preview: shown(summary.preview),
})

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
  // In the Inbox: to Spam, blocking the sender the message as read names
  onSpam?: (read: Summary | null) => Promise<unknown>
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
  // The message as read here, newer than the list's: its From address as the
  // canister read it, else the envelope's, is the sender, none while it
  // loads, so a quick click cannot block the wrong one
  const [read, setRead] = useState<Summary | null>(null)
  const sender = read ? read.sender_address || read.envelope_from : ''
  const quarantined = state === MESSAGE_QUARANTINED
  const [formatted, setFormatted] = useState(false)
  const plain = quarantined && !formatted
  const rawText = useMemo(
    () => (raw && (plain || unparsed) ? new TextDecoder().decode(raw) : ''),
    [raw, plain, unparsed]
  )
  // Built once per message: it parses the message and encodes its images
  const framed = useMemo(
    () => (mail?.html ? frameBody(mail.html, mail.attachments) : null),
    [mail]
  )
  // Its remote images, blocked until asked for, as loading them tells the
  // sender when it was read; asked for this time only, so opening the message
  // again blocks them again
  const [images, setImages] = useState(false)

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
          setRead(full.summary)
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
    // An address with a mark in it is left out: as it came it shows as
    // something else, and cleaned it is another address
    const to =
      shown(mail.fromAddress) === mail.fromAddress ? mail.fromAddress : ''
    onReply({ to, subject, body: quote(mail) })
  }

  const via = mail
    ? deliveredVia(mail.fromAddress, summary.envelope_from)
    : null
  const files = mail?.attachments.filter((a) => !a.inline || !a.contentId) ?? []
  const flagged = (summary.flags & FLAG_FLAGGED) !== 0n

  return (
    <article className="reader">
      {/* At phone width, the bar along the top */}
      <div className="toolbar">
        <BackButton onClick={onBack} />
        <strong className="toolbar-title">
          {summary.subject || '(no subject)'}
        </strong>
        <IconButton
          label="Reply"
          icon="reply"
          onClick={reply}
          disabled={!mail}
        />
        {actions.map((action) => (
          <IconButton
            key={action.label}
            variant={action.danger ? 'danger' : undefined}
            label={action.label}
            icon={action.icon}
            onClick={() => act(() => action.run([summary.uid], read))}
          />
        ))}
        <StarButton flagged={flagged} onClick={() => act(onStar)} />
        {onSpam && (
          <IconButton
            className="desk-only"
            label="Spam"
            icon="spam"
            onClick={() => act(() => onSpam(read))}
          />
        )}
        {framed?.remote && !images && (
          <IconButton
            label="Show images"
            icon="image"
            onClick={() => setImages(true)}
          />
        )}
        {/* At phone width the star and Spam are in it too */}
        <Menu
          label="More actions"
          className={more.length === 0 ? 'phone-only' : undefined}
        >
          <button className="phone-only" onClick={() => act(onStar)}>
            <Icon name="star" />
            {flagged ? 'Unstar' : 'Star'}
          </button>
          {onSpam && (
            <button
              className="phone-only"
              onClick={() => act(() => onSpam(read))}
            >
              <Icon name="spam" />
              Spam
            </button>
          )}
          {more.map((action) => (
            <button
              key={action.label}
              disabled={
                (action.needs === 'sender' && !sender) ||
                (action.needs === 'mark' && !settled)
              }
              onClick={() => act(() => action.run(sender))}
            >
              <Icon name={action.icon} />
              {action.label}
            </button>
          ))}
        </Menu>
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
            <IconButton
              label="Show it formatted anyway"
              icon="show"
              onClick={() => setFormatted(true)}
            />
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
                  via {shown(via)}
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
          {framed ? (
            <MessageBody framed={framed} images={images} />
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
  onRefresh,
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
  onRefresh: () => void // the folder and the mailboxes' counts again
  onBlocked: () => void // to the Blocked senders page
  domain: string // the mailbox's own, whose addresses Spam never blocks
}) {
  const here = FOLDERS[folder].number
  const [items, setItems] = useState<Summary[]>([])
  // Where the list goes on, and the search it belongs to
  const [more, setMore] = useState<{ search: string; cursor: [] | [bigint] }>({
    search: '',
    cursor: [],
  })
  const [selected, setSelected] = useState<Summary | null>(null)
  // The messages ticked for an action on all of them
  const ticks = useTicks(items.map((m) => m.uid))
  const select = useSelectMode(ticks)
  const [query, setQuery] = useState('')
  // At phone width, the bar along the top is a search field
  const [searching, setSearching] = useState(false)
  const [activeQuery, setActiveQuery] = useState('')
  // The search shown now, for a reload by work that began under another
  const searched = useRef('')
  const [error, setError] = useState('')
  // Replies can arrive out of order, and only the newest may be shown
  const latestLoad = useRef(0)
  // Flags set and mail moved here, which a reply read before them would undo
  const changes = useRef(0)
  const olderShown = useRef(false)
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
        const summaries = page.items.map(shownSummary)
        setItems((previous) =>
          append ? [...previous, ...summaries] : summaries
        )
        setMore({ search, cursor: page.cursor })
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
    ticks.untick(gone)
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
  // refusal leaves the list, and when some of it was no longer here, the
  // list loads again.
  const moveOut = async (uids: bigint[], to: Folder) => {
    const outcome = await moveAll(backend, uids, to)
    if (anyUnread(outcome.done)) onCounts()
    drop(outcome.done)
    if (outcome.result.gone > 0) reload()
    return outcome
  }

  const move = async (uids: bigint[], to: Folder) => {
    const { done, result, error } = await moveOut(uids, to)
    if (done.length > 0) {
      notify({
        text: movedText(result, FOLDERS[to].name, ''),
        // Only what the canister moved: mail deleted for good cannot come
        // back, and mail another member moved before this click is not
        // pulled back
        actions:
          result.moved.length > 0
            ? [undo(backend, result.moved, folder)]
            : undefined,
      })
    }
    if (error) throw error
  }

  // To Spam blocks the From address of each message, and from Spam to the
  // Inbox unblocks it. Undo takes back only what the canister replied this
  // click changed: a refused or lost call may have met a block made before,
  // which stays. With no mail moved, the note offers that alone. Spam blocks
  // no address of the mailbox's own domain or its subdomains, which spam
  // often claims to be from. Mail with no From address only moves. The reader
  // closes with the move, so the note says what failed after it.
  const judge = async (
    uids: bigint[],
    to: 'spam' | 'inbox',
    read: Summary | null = null // the reader's copy, parsed maybe since
  ) => {
    const spam = to === 'spam'
    const before = listed()
    if (read?.sender_address) before.set(read.uid, read)
    const { done, result, error } = await moveOut(uids, to)
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
      const changes = spam ? { unblock: changed } : { block: changed }
      let actions: ToastAction[] | undefined
      if (result.moved.length > 0) {
        actions = [undo(backend, result.moved, folder, changes)]
      } else if (changed.length > 0) {
        const named: Pick<ToastAction, 'label' | 'icon'> = spam
          ? { label: 'Unblock', icon: 'unblock' }
          : { label: 'Block again', icon: 'block' }
        actions = [{ ...undo(backend, [], folder, changes), ...named }]
      }
      notify({ text, actions })
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
        ? [undo(backend, [], folder, { unblock: [address] })]
        : undefined,
    })
  }

  // The reader's ⋮ menu, by folder
  const readerMore = (uid: bigint): MoreAction[] => {
    if (folder === 'inbox') {
      return [
        {
          label: 'Mark unread',
          icon: 'mail',
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
      return [
        { label: 'Block sender', icon: 'block', needs: 'sender', run: block },
      ]
    }
    return []
  }

  // A refusal in the list shows above it
  const act = (run: () => Promise<unknown>) => attempt(run, setError)

  const searchFor = (text: string) => {
    searched.current = text
    setActiveQuery(text)
  }
  const submitSearch = (e: FormEvent) => {
    e.preventDefault()
    setSelected(null)
    searchFor(query.trim())
  }
  const clearSearch = () => {
    setQuery('')
    searchFor('')
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
    run: (uids, read) =>
      folder === 'spam' ? judge(uids, 'inbox', read) : move(uids, 'inbox'),
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
  const star: Action = {
    label: 'Star',
    icon: 'star',
    run: (uids) => flag(uids, FLAG_FLAGGED, 0n),
  }
  // A message's own; the reader has Spam and Mark unread apart
  const actions = folder === 'inbox' ? [toTrash] : [restore, forever]
  const bulkActions =
    folder === 'inbox' ? [toTrash, toSpam, markRead, markUnread] : actions
  // Each for the messages ticked
  const bulk = (list: Action[]): BulkAction[] =>
    list.map((action) => ({
      ...action,
      run: () => act(() => action.run(ticks.ticked)),
    }))
  const emptyFolder: BulkAction | undefined =
    folder !== 'inbox' && !activeQuery
      ? {
          label: `Empty ${FOLDERS[folder].name}`,
          icon: 'trash',
          danger: true,
          run: () => act(empty),
        }
      : undefined
  const placeholder =
    folder === 'inbox' ? 'Search mail' : `Search ${FOLDERS[folder].name}`
  // The list's ⋮ in the bar along the top, at phone width
  const listMenu = (
    <Menu label="List actions">
      <button onClick={onRefresh}>
        <Icon name="refresh" />
        Refresh
      </button>
      <button disabled={items.length === 0} onClick={select.start}>
        <Icon name="select" />
        Select messages
      </button>
      {items.length > 0 && emptyFolder && (
        <button onClick={emptyFolder.run}>
          <Icon name={emptyFolder.icon} />
          {emptyFolder.label}
        </button>
      )}
    </Menu>
  )

  // Only the search shown now goes on, from where its own pages ended
  const cursor: [] | [bigint] = more.search === activeQuery ? more.cursor : []
  // A search with a cursor left, or whose first page is on its way, has not
  // looked everywhere yet
  let emptyHint = `Nothing in ${FOLDERS[folder].name}.`
  if (folder === 'inbox') emptyHint = 'No mail yet.'
  if (activeQuery) {
    emptyHint =
      cursor.length > 0 || more.search !== activeQuery
        ? 'No matches yet.'
        : 'No matches.'
  }

  return (
    <Split reading={selected !== null}>
      <section
        className={select.on ? 'list selecting' : 'list'}
        aria-label="Messages"
      >
        {/* At phone width: the page's bar, a search field, or selection
            mode's actions */}
        {select.on ? (
          <SelectionBar
            ticks={ticks}
            actions={bulk([...bulkActions, star])}
            onExit={select.exit}
          />
        ) : searching ? (
          <div className="appbar">
            <form
              className="appbar-search"
              role="search"
              onSubmit={submitSearch}
            >
              <input
                aria-label="Search mail"
                placeholder={placeholder}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </form>
            <IconButton
              label="Close search"
              icon="close"
              onClick={() => {
                clearSearch()
                setSearching(false)
              }}
            />
            {listMenu}
          </div>
        ) : (
          <AppBar>
            <IconButton
              label="Search"
              icon="search"
              onClick={() => setSearching(true)}
            />
            {listMenu}
          </AppBar>
        )}
        <div className="list-head">
          <form className="search" role="search" onSubmit={submitSearch}>
            <input
              aria-label="Search mail"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {activeQuery && (
              <IconButton
                type="button"
                label="Clear"
                icon="close"
                onClick={clearSearch}
              />
            )}
          </form>
          {folder === 'spam' && (
            <div className="bulk">
              <IconButton
                label="Blocked senders"
                icon="block"
                onClick={onBlocked}
              />
            </div>
          )}
          {items.length > 0 && (
            <Bulk
              ticks={ticks}
              actions={bulk(bulkActions)}
              empty={emptyFolder}
            />
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
                <RowPick ticks={ticks} id={m.uid} name={title} />
                <StarButton
                  flagged={flagged}
                  name={title}
                  onClick={() => act(() => flag([m.uid], ...starring(m.flags)))}
                />
                <button
                  className={unread ? 'message unread' : 'message'}
                  aria-current={selected?.uid === m.uid}
                  {...select.row(m.uid, () => setSelected(m))}
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
                    <IconButton
                      key={action.label}
                      variant="bare"
                      label={action.label}
                      name={title}
                      icon={action.icon}
                      onClick={() => act(() => action.run([m.uid]))}
                    />
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
        {cursor.length > 0 && (
          <IconButton
            className="more"
            label={activeQuery ? 'Keep searching' : 'Older mail'}
            icon="chevronDown"
            onClick={() => load(cursor, true, activeQuery)}
          />
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
            folder === 'inbox'
              ? (read) => judge([selected.uid], 'spam', read)
              : undefined
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
    </Split>
  )
}
