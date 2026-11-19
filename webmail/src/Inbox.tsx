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
import type { Toast } from './Toast'

const PAGE_SIZE = 50n
const REFRESH_MS = 20_000
// The most messages the canister lists, flags, moves or deletes in one call
const BATCH = 100

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

// Runs an action, showing a refusal with onError
async function attempt(
  run: () => Promise<unknown>,
  onError: (text: string) => void
): Promise<void> {
  try {
    await run()
  } catch (e) {
    onError(errorText(e))
  }
}

// A call for many messages, in parts the canister takes. Returns the uids it
// got through, and the refusal that stopped it.
async function inBatches(
  uids: bigint[],
  call: (part: bigint[]) => Promise<unknown>
): Promise<{ done: bigint[]; error?: unknown }> {
  for (let at = 0; at < uids.length; at += BATCH) {
    try {
      await call(uids.slice(at, at + BATCH))
    } catch (error) {
      return { done: uids.slice(0, at), error }
    }
  }
  return { done: uids }
}

// "Message", "this message" or "3 messages"
const messages = (count: number, one: string) =>
  count === 1 ? one : `${count} messages`

// The flags that star a message, or take its star off
const starring = (flags: bigint): [bigint, bigint] =>
  flags & FLAG_FLAGGED ? [0n, FLAG_FLAGGED] : [FLAG_FLAGGED, 0n]

// Brings messages back to the folder they left, and unblocks an address. Made
// here, so the toast holds only what it needs.
function undo(
  backend: Mailbox,
  uids: bigint[],
  from: bigint,
  unblock?: string
): NonNullable<Toast['action']> {
  return {
    label: 'Undo',
    reload: true,
    run: async () => {
      if (unblock) await backend.mail_unblock(unblock)
      const { error } = await inBatches(uids, (part) =>
        backend.mail_move(part, from)
      )
      if (error) throw error
    },
  }
}

function when(summary: Summary): string {
  return summary.sent_at > 0n
    ? formatTime(Number(summary.sent_at) * 1000)
    : formatNs(summary.received_ns)
}

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
  onBlock,
  onReply,
  onFlags,
  onCounts,
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
  // Blocks the address and files the message in Spam; absent in Trash
  onBlock?: (address: string) => Promise<void>
  onReply: (draft: Omit<Draft, 'from'>) => void // from the mailbox shown
  // The flags set and cleared, applied to the latest state: another change
  // may have landed while this one was under way
  onFlags: (set: bigint, clear: bigint) => void
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
        if (unread || !recorded) {
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

  // The From address once the message is read, else the envelope's; none
  // while it loads, so a quick click cannot block the wrong one
  const sender = mail
    ? mail.fromAddress || summary.envelope_from
    : rawText
      ? summary.envelope_from
      : ''
  const block = () => {
    if (!onBlock || !sender) return
    const asked =
      `Block ${sender}? New mail from this address goes to Spam, for ` +
      'everyone in this mailbox, and this message moves there now.'
    if (window.confirm(asked)) act(() => onBlock(sender))
  }

  const toggleFlag = async () => {
    const [set, clear] = starring(summary.flags)
    const uid = summary.uid
    touched.current.set(uid, (touched.current.get(uid) ?? 0n) | FLAG_FLAGGED)
    try {
      await backend.mail_set_flags([summary.uid], set, clear)
      setActionError('')
      onFlags(set, clear)
    } catch (e) {
      setActionError(errorText(e))
    }
  }

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
        <button onClick={reply} disabled={!mail}>
          Reply
        </button>
        <button onClick={toggleFlag}>
          {summary.flags & FLAG_FLAGGED ? 'Unflag' : 'Flag'}
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
        {onBlock && (
          <button onClick={block} disabled={!sender}>
            Block sender
          </button>
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
}) {
  const here = FOLDERS[folder].number
  const [items, setItems] = useState<Summary[]>([])
  const [cursor, setCursor] = useState<[] | [bigint]>([])
  const [selected, setSelected] = useState<Summary | null>(null)
  // The messages ticked for an action on all of them
  const [checked, setChecked] = useState<ReadonlySet<bigint>>(new Set())
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
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
      const readPage = () =>
        search
          ? backend.mail_search({
              query: search,
              folder: here,
              cursor: from,
              limit: PAGE_SIZE,
            })
          : backend.mail_list({ folder: here, cursor: from, limit: PAGE_SIZE })
      try {
        let read = changes.current
        let page = await readPage()
        // Read before a change made here: read again, so the change stays
        while (request === latestLoad.current && read !== changes.current) {
          read = changes.current
          page = await readPage()
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

  // Out of this folder, for the caller to say so. What moved before a
  // refusal leaves the list.
  const moveOut = async (uids: bigint[], to: bigint) => {
    const result = await inBatches(uids, (part) => backend.mail_move(part, to))
    if (anyUnread(result.done)) onCounts()
    drop(result.done)
    return result
  }

  const move = async (uids: bigint[], to: Folder) => {
    const { done, error } = await moveOut(uids, FOLDERS[to].number)
    if (done.length > 0) {
      notify({
        text: `${messages(done.length, 'Message')} moved to ${FOLDERS[to].name}`,
        action: undo(backend, done, here),
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
      backend.mail_delete(part)
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

  // Every message in Trash or Spam, page by page
  const empty = async () => {
    if (
      !window.confirm(
        `Delete every message in ${FOLDERS[folder].name} forever?`
      )
    )
      return
    for (;;) {
      const page = await backend.mail_list({
        folder: here,
        cursor: [],
        limit: BigInt(BATCH),
      })
      if (page.items.length === 0) break
      // None of them could go: stop rather than ask again forever
      if ((await backend.mail_delete(page.items.map((m) => m.uid))) === 0n)
        break
    }
    setSelected(null)
    await load([], false, activeQuery)
  }

  // Blocked first, then out to Spam: a refused block moves nothing. Undo
  // leaves a block made before alone.
  const block = async (uid: bigint, address: string) => {
    const before = await backend.mail_blocked()
    const already = before.some((b) => b.address === address.toLowerCase())
    await backend.mail_block(address)
    const filed = folder === 'spam' ? [] : [uid]
    if (filed.length > 0) {
      const { error } = await moveOut(filed, FOLDER_SPAM)
      if (error) throw error
    }
    notify({
      text: already ? `${address} was blocked already` : `Blocked ${address}`,
      action:
        already && filed.length === 0
          ? undefined
          : undo(backend, filed, here, already ? undefined : address),
    })
  }

  // A refusal in the list shows above it
  const act = (run: () => Promise<unknown>) => attempt(run, setError)

  const toTrash: Action = {
    label: 'Delete',
    icon: 'trash',
    run: (uids) => move(uids, 'trash'),
  }
  const toSpam: Action = {
    label: 'Report spam',
    icon: 'spam',
    run: (uids) => move(uids, 'spam'),
  }
  const restore: Action = {
    label: folder === 'spam' ? 'Not spam' : 'Restore',
    icon: folder === 'spam' ? 'inbox' : 'undo',
    run: (uids) => move(uids, 'inbox'),
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
  // A message's own, in the reader; the ticked ones can also be read or not
  const actions = folder === 'inbox' ? [toTrash, toSpam] : [restore, forever]
  const bulkActions =
    folder === 'inbox' ? [...actions, markRead, markUnread] : actions

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

  return (
    <div className="split">
      <section className="list" aria-label="Messages">
        <div className="list-head">
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              setSelected(null)
              setActiveQuery(query.trim())
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
                  setActiveQuery('')
                }}
              >
                Clear
              </button>
            )}
          </form>
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
        {items.length === 0 && !error && (
          <p className="hint">
            {activeQuery
              ? 'No matches.'
              : folder === 'inbox'
                ? 'No mail yet.'
                : `Nothing in ${FOLDERS[folder].name}.`}
          </p>
        )}
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
                <input
                  type="checkbox"
                  className="pick"
                  aria-label={`Select ${title}`}
                  checked={checked.has(m.uid)}
                  onChange={(e) => tick(m.uid, e.target.checked)}
                />
                <button
                  className={flagged ? 'bare star on' : 'bare star'}
                  aria-label={flagged ? `Unstar ${title}` : `Star ${title}`}
                  aria-pressed={flagged}
                  title={flagged ? 'Starred' : 'Not starred'}
                  onClick={() => act(() => flag([m.uid], ...starring(m.flags)))}
                >
                  <Icon name="star" />
                </button>
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
          onBlock={
            folder === 'trash'
              ? undefined
              : (address) => block(selected.uid, address)
          }
          onReply={onReply}
          onFlags={(set, clear) => updateFlags([selected.uid], set, clear)}
        />
      ) : (
        <div className="reader empty">Select a message to read it.</div>
      )}
    </div>
  )
}
