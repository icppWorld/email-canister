import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Principal } from '@icp-sdk/core/principal'

import {
  errorText,
  FLAG_FLAGGED,
  FLAG_SEEN,
  MESSAGE_QUARANTINED,
  MESSAGE_QUEUED,
  type Mailbox,
  type SeenBy,
  type Summary,
} from './api'
import type { Draft } from './Compose'
import { formatTime, memberName } from './format'
import { Icon } from './Icon'
import { MessageBody } from './MessageBody'
import { deliveredVia, parseMail, saveFile, type ParsedMail } from './mime'

const PAGE_SIZE = 50n
const REFRESH_MS = 20_000

function when(summary: Summary): string {
  const ms =
    summary.sent_at > 0n
      ? Number(summary.sent_at) * 1000
      : Number(summary.received_ns / 1_000_000n)
  return formatTime(ms)
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
  onDeleted,
  onReply,
  onFlags,
  onCounts,
}: {
  backend: Mailbox
  principal: string // the reader's own
  shared: boolean // the mailbox has other members, or had
  onCounts: () => void // the mailbox's unread count may have changed
  summary: Summary
  onDeleted: () => void
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
  // The flags changed here since the message started loading: its reply must
  // not undo them
  const changed = useRef(0n)
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
          const mine = changed.current
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
            await backend.mail_set_flags(summary.uid, FLAG_SEEN, 0n)
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

  const remove = async () => {
    if (!window.confirm('Delete this message permanently?')) return
    try {
      await backend.mail_delete([summary.uid])
      if ((summary.flags & FLAG_SEEN) === 0n) onCounts()
      onDeleted()
    } catch (e) {
      setActionError(errorText(e))
    }
  }

  const toggleFlag = async () => {
    const flagged = (summary.flags & FLAG_FLAGGED) !== 0n
    const set = flagged ? 0n : FLAG_FLAGGED
    const clear = flagged ? FLAG_FLAGGED : 0n
    changed.current |= FLAG_FLAGGED
    try {
      await backend.mail_set_flags(summary.uid, set, clear)
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
        <button className="danger" onClick={remove}>
          Delete
        </button>
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
                    <span className="date">
                      {formatTime(Number(seen.at_ns / 1_000_000n))}
                    </span>
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
  onReply,
  onCounts,
  refresh,
  onLoaded,
}: {
  backend: Mailbox
  principal: string
  shared: boolean
  onCounts: () => void
  onReply: (draft: Omit<Draft, 'from'>) => void
  refresh: number
  onLoaded: () => void
}) {
  const [items, setItems] = useState<Summary[]>([])
  const [cursor, setCursor] = useState<[] | [bigint]>([])
  const [selected, setSelected] = useState<Summary | null>(null)
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [error, setError] = useState('')
  // Replies can arrive out of order, and only the newest may be shown
  const latestLoad = useRef(0)
  const olderShown = useRef(false)

  const load = useCallback(
    async (from: [] | [bigint], append: boolean, search: string) => {
      const request = ++latestLoad.current
      try {
        const page = search
          ? await backend.mail_search({
              query: search,
              cursor: from,
              limit: PAGE_SIZE,
            })
          : await backend.mail_list({ cursor: from, limit: PAGE_SIZE })
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
    [backend]
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

  const updateFlags = (uid: bigint, set: bigint, clear: bigint) => {
    const apply = (m: Summary) =>
      m.uid === uid ? { ...m, flags: (m.flags | set) & ~clear } : m
    setItems((previous) => previous.map(apply))
    setSelected((previous) => previous && apply(previous))
  }

  return (
    <div className="split">
      <section className="list" aria-label="Messages">
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
            placeholder="Search mail"
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items.length === 0 && !error && (
          <p className="hint">{activeQuery ? 'No matches.' : 'No mail yet.'}</p>
        )}
        <ul>
          {items.map((m) => (
            <li key={m.uid.toString()}>
              <button
                className={
                  (m.flags & FLAG_SEEN) === 0n ? 'message unread' : 'message'
                }
                aria-current={selected?.uid === m.uid}
                onClick={() => setSelected(m)}
              >
                <span className="who">
                  {m.flags & FLAG_FLAGGED ? (
                    <Icon name="star" label="Flagged" />
                  ) : null}
                  {senderOf(m)}
                </span>
                <span className="date">{when(m)}</span>
                <span className="subject">
                  {m.state === MESSAGE_QUEUED
                    ? 'Arriving…'
                    : m.subject || '(no subject)'}
                  {m.attachments > 0n ? (
                    <Icon name="paperclip" label="Has attachments" />
                  ) : null}
                  {m.state === MESSAGE_QUARANTINED
                    ? ' (could not be processed)'
                    : ''}
                </span>
                <span className="preview">{m.preview}</span>
              </button>
            </li>
          ))}
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
          onDeleted={() => {
            setSelected(null)
            load([], false, activeQuery)
          }}
          onReply={onReply}
          onFlags={(set, clear) => updateFlags(selected.uid, set, clear)}
        />
      ) : (
        <div className="reader empty">Select a message to read it.</div>
      )}
    </div>
  )
}
