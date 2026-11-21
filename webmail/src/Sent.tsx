import { useCallback, useEffect, useRef, useState } from 'react'

import {
  errorText,
  OUTBOX_ACCEPTED,
  OUTBOX_QUEUED,
  OUTBOX_REJECTED,
  OUTBOX_SENDING,
  OUTBOX_UNKNOWN,
  type Mailbox,
  type OutboxMessage,
  type OutboxSummary,
} from './api'
import { BackButton, IconButton } from './Buttons'
import { Bulk } from './Bulk'
import { memberName } from './format'
import { Icon } from './Icon'
import { MessageBody } from './MessageBody'
import { saveFile } from './mime'
import { Splitter, useListWidth } from './Splitter'
import type { Toast } from './Toast'

const REFRESH_MS = 5_000
// The most the canister lists, and deletes, in one call
const LIST_MAX = 100n
const DELETE_MAX = 200

// What deletions did, as the canister replied: the mail it deleted, and of
// the mail it skipped, how much was listed as being sent and how much else,
// which was no longer there, as when another member deleted it
type Deleted = { deleted: number; kept: number; gone: number }

// One message, as the caller says it, or "3 sent messages"
const sentMessages = (count: number, one: string) =>
  count === 1 ? one : `${count} sent messages`

function deletedText({ deleted, kept, gone }: Deleted): string {
  const parts: string[] = []
  // The first part says "1 sent message" or "3 sent messages", the others
  // only the number
  const many = (n: number) =>
    parts.length === 0 ? sentMessages(n, '1 sent message') : `${n}`
  const was = (n: number) => (n === 1 ? 'was' : 'were')
  if (deleted > 0) parts.push(`${many(deleted)} deleted`)
  if (kept > 0) parts.push(`${many(kept)} being sent ${was(kept)} kept`)
  if (gone > 0) parts.push(`${many(gone)} ${was(gone)} no longer here`)
  return parts.join('. ')
}

// For good, in parts the canister takes, adding up what it did. `sending`
// holds the ids the page listed as being sent.
async function deleteSent(
  backend: Mailbox,
  ids: bigint[],
  sending: ReadonlySet<bigint>,
  done: Deleted
): Promise<void> {
  for (let at = 0; at < ids.length; at += DELETE_MAX) {
    const part = ids.slice(at, at + DELETE_MAX)
    const deleted = new Set(await backend.mail_outbox_delete_many(part))
    done.deleted += deleted.size
    for (const id of part) {
      if (deleted.has(id)) continue
      if (sending.has(id)) done.kept++
      else done.gone++
    }
  }
}

// The ids of the mail listed as being sent, or waiting to: mail that waited
// may have started sending since, which the canister then keeps
const sendingIn = (listed: OutboxSummary[]) =>
  new Set(
    listed
      .filter((m) => m.state === OUTBOX_SENDING || m.state === OUTBOX_QUEUED)
      .map((m) => m.id)
  )

function stateLabel(state: bigint): string {
  switch (state) {
    case OUTBOX_QUEUED:
      return 'Waiting to send'
    case OUTBOX_SENDING:
      return 'Sending'
    case OUTBOX_ACCEPTED:
      return 'Accepted for delivery'
    case OUTBOX_REJECTED:
      return 'Not sent'
    case OUTBOX_UNKNOWN:
      return 'Outcome unknown'
    default:
      return ''
  }
}

function Details({
  backend,
  summary,
  sentBy,
  onChanged,
  onUsage,
  onBack,
}: {
  backend: Mailbox
  summary: OutboxSummary
  sentBy: string | null // which member sent it, in a mailbox others share
  onChanged: () => void
  onUsage: () => void // the mailbox's usage changed
  onBack: () => void // to the list, at phone width
}) {
  const [message, setMessage] = useState<OutboxMessage | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setMessage(null)
    backend
      .mail_outbox_get(summary.id)
      .then(setMessage, (e) => setError(errorText(e)))
  }, [backend, summary.id])

  const resend = async () => {
    const warning =
      summary.state === OUTBOX_UNKNOWN
        ? 'It is not known whether this message went out. If it did, the recipient will get it twice. Send it again?'
        : 'Send this message again?'
    if (!window.confirm(warning)) return
    try {
      await backend.mail_outbox_resend(summary.id)
      onChanged()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this message permanently?')) return
    try {
      await backend.mail_outbox_delete(summary.id)
      onUsage()
      onChanged()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const canResend =
    summary.state === OUTBOX_REJECTED || summary.state === OUTBOX_UNKNOWN

  return (
    <article className="reader">
      <div className="toolbar">
        <BackButton onClick={onBack} />
        {canResend && (
          <IconButton
            variant="primary"
            label="Send again"
            icon="send"
            onClick={resend}
          />
        )}
        <IconButton
          variant="danger"
          label="Delete"
          icon="trash"
          onClick={remove}
          disabled={summary.state === OUTBOX_SENDING}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h2>{summary.subject || '(no subject)'}</h2>
      <p className="status" data-testid="outbox-state">
        {stateLabel(summary.state)}
      </p>
      {summary.state === OUTBOX_ACCEPTED && (
        <p className="hint">
          The mail service accepted this message. Delivery itself is not
          reported.
        </p>
      )}
      {summary.state === OUTBOX_UNKNOWN && (
        <p className="warning" role="status">
          This message may or may not have been sent. Check with the recipient
          before sending it again.
        </p>
      )}
      {summary.last_error && summary.state === OUTBOX_REJECTED && (
        <p className="error">{summary.last_error}</p>
      )}
      <dl className="headers">
        {sentBy !== null && (
          <>
            <dt>Sent by</dt>
            <dd data-testid="sent-by">{sentBy}</dd>
          </>
        )}
        <dt>To</dt>
        <dd>{summary.to.join(', ')}</dd>
        {summary.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{summary.cc.join(', ')}</dd>
          </>
        )}
        {summary.bcc.length > 0 && (
          <>
            <dt>Bcc</dt>
            <dd>{summary.bcc.join(', ')}</dd>
          </>
        )}
      </dl>
      {message && message.attachments.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {message.attachments.map((file, index) => (
            <li key={index}>
              <button
                onClick={() =>
                  saveFile(file.filename, Uint8Array.from(file.content))
                }
              >
                {file.filename} ({Math.ceil(file.content.length / 1024)} KB)
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <MessageBody html={message.html_body} />}
    </article>
  )
}

export function Sent({
  backend,
  principal,
  shared,
  refresh,
  notify,
  onUsage,
}: {
  backend: Mailbox
  principal: string // the reader's own
  shared: boolean // the mailbox has other members
  // Changes after a send: the list reloads, also while older mail is shown
  refresh: number
  notify: (toast: Toast) => void
  onUsage: () => void // the mailbox's usage changed
}) {
  const [items, setItems] = useState<OutboxSummary[]>([])
  const [cursor, setCursor] = useState<[] | [bigint]>([])
  const [selectedId, setSelectedId] = useState<bigint | null>(null)
  // The messages ticked for an action on all of them
  const [checked, setChecked] = useState<ReadonlySet<bigint>>(new Set())
  const [error, setError] = useState('')
  const listWidth = useListWidth()
  // Replies can arrive out of order, and only the newest may be shown
  const latestLoad = useRef(0)
  const olderShown = useRef(false)
  // The first page is loading: Older mail waits, or it would drop that load
  const loading = useRef(false)
  // A first-page load failed, as after a send: refreshes try it again until
  // one succeeds, also while older mail is shown
  const failed = useRef(false)

  const load = useCallback(async () => {
    const request = ++latestLoad.current
    loading.current = true
    try {
      const page = await backend.mail_outbox_list({ cursor: [], limit: 50n })
      if (request !== latestLoad.current) return
      olderShown.current = false
      failed.current = false
      setItems(page.items)
      setCursor(page.cursor)
      setError('')
    } catch (e) {
      if (request !== latestLoad.current) return
      setError(errorText(e))
      failed.current = true
    } finally {
      if (request === latestLoad.current) loading.current = false
    }
  }, [backend])

  useEffect(() => {
    load()
    // Refreshing replaces the list with its first page, so not while reading older mail
    const timer = window.setInterval(() => {
      // One at a time: a load slower than this would otherwise be replaced
      // by the next before its reply could show
      if (loading.current) return
      if (!olderShown.current || failed.current) load()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load, refresh])

  const older = async () => {
    if (loading.current) return
    const request = ++latestLoad.current
    try {
      const page = await backend.mail_outbox_list({ cursor, limit: 50n })
      if (request !== latestLoad.current) return
      olderShown.current = true
      setItems((previous) => [...previous, ...page.items])
      setCursor(page.cursor)
    } catch (e) {
      if (request === latestLoad.current) setError(errorText(e))
    }
  }

  // The messages given, or all of them page by page, for good once
  // confirmed. Mail being sent is kept, as the canister replies. The note
  // says what it did, also before a refusal, and the list loads again; the
  // ticks of mail it deleted go with it, as an id is never used again.
  const remove = async (ids: bigint[] | 'all') => {
    const asked =
      ids === 'all'
        ? 'Delete every message in Sent for good? Mail being sent is kept.'
        : `Delete ${sentMessages(ids.length, 'this sent message')} for good?`
    if (!window.confirm(asked)) return
    const done: Deleted = { deleted: 0, kept: 0, gone: 0 }
    try {
      if (ids !== 'all') {
        await deleteSent(backend, ids, sendingIn(items), done)
      } else {
        let at: [] | [bigint] = []
        do {
          const page = await backend.mail_outbox_list({
            cursor: at,
            limit: LIST_MAX,
          })
          await deleteSent(
            backend,
            page.items.map((m) => m.id),
            sendingIn(page.items),
            done
          )
          at = page.cursor
        } while (at.length > 0)
      }
    } finally {
      if (done.deleted + done.kept + done.gone > 0) {
        notify({ text: deletedText(done) })
      }
      if (done.deleted > 0) onUsage()
      await load()
    }
  }

  // A refusal shows above the list
  const act = async (run: () => Promise<unknown>) => {
    setError('')
    try {
      await run()
    } catch (e) {
      setError(errorText(e))
    }
  }

  // Mail being sent cannot be deleted, so it is not ticked
  const tickable = items.filter((m) => m.state !== OUTBOX_SENDING)
  const ticked = tickable.filter((m) => checked.has(m.id)).map((m) => m.id)
  const tick = (id: bigint, on: boolean) =>
    setChecked((before) => {
      const next = new Set(before)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const selected = items.find((m) => m.id === selectedId) ?? null

  return (
    <div
      className={selected ? 'split reading' : 'split'}
      style={listWidth.style}
    >
      <section className="list" aria-label="Sent mail">
        {items.length > 0 && (
          <div className="list-head">
            <Bulk
              ticked={ticked.length}
              total={tickable.length}
              onAll={(all) =>
                setChecked(new Set(all ? tickable.map((m) => m.id) : []))
              }
              actions={[
                {
                  label: 'Delete',
                  icon: 'trash',
                  danger: true,
                  run: () => act(() => remove(ticked)),
                },
              ]}
              empty={{
                label: 'Empty Sent',
                run: () => act(() => remove('all')),
              }}
            />
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items.length === 0 && !error && (
          <p className="hint">Nothing sent yet.</p>
        )}
        <ul>
          {items.map((m) => {
            const title = m.subject || '(no subject)'
            const sending = m.state === OUTBOX_SENDING
            return (
              <li key={m.id.toString()} className="message-row">
                {/* The label is the box's larger touch target */}
                <label className="pick-area">
                  <input
                    type="checkbox"
                    className="pick"
                    aria-label={`Select ${title}`}
                    checked={!sending && checked.has(m.id)}
                    disabled={sending}
                    onChange={(e) => tick(m.id, e.target.checked)}
                  />
                </label>
                <button
                  className="message"
                  aria-current={selectedId === m.id}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="who">
                    {m.to.concat(m.cc, m.bcc).join(', ')}
                  </span>
                  <span className="subject">
                    {title}
                    {m.attachments > 0n ? (
                      <Icon name="paperclip" label="Has attachments" />
                    ) : null}
                  </span>
                  <span className="preview">{stateLabel(m.state)}</span>
                </button>
                {/* On hover, for a pointer, as in the Inbox */}
                {!sending && (
                  <span className="row-actions">
                    <button
                      className="bare"
                      aria-label={`Delete: ${title}`}
                      title="Delete"
                      onClick={() => act(() => remove([m.id]))}
                    >
                      <Icon name="trash" />
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        {cursor.length > 0 && (
          <IconButton
            className="more"
            label="Older mail"
            icon="chevronDown"
            onClick={older}
          />
        )}
      </section>
      <Splitter width={listWidth.width} onChange={listWidth.change} />
      {selected ? (
        <Details
          key={selected.id.toString()}
          backend={backend}
          summary={selected}
          sentBy={
            shared || selected.sent_by.toText() !== principal
              ? memberName(
                  selected.sent_by.toText(),
                  selected.sent_by_name,
                  principal
                )
              : null
          }
          onChanged={() => {
            setSelectedId(null)
            load()
          }}
          onUsage={onUsage}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div className="reader empty">Select a message to see its status.</div>
      )}
    </div>
  )
}
