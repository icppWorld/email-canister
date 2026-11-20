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
import { BackButton } from './Buttons'
import { memberName } from './format'
import { Icon } from './Icon'
import { MessageBody } from './MessageBody'
import { saveFile } from './mime'

const REFRESH_MS = 5_000

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
  onBack,
}: {
  backend: Mailbox
  summary: OutboxSummary
  sentBy: string | null // which member sent it, in a mailbox others share
  onChanged: () => void
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
          <button className="primary" onClick={resend}>
            Send again
          </button>
        )}
        <button
          className="danger"
          onClick={remove}
          disabled={summary.state === OUTBOX_SENDING}
        >
          Delete
        </button>
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
}: {
  backend: Mailbox
  principal: string // the reader's own
  shared: boolean // the mailbox has other members
  // Changes after a send: the list reloads, also while older mail is shown
  refresh: number
}) {
  const [items, setItems] = useState<OutboxSummary[]>([])
  const [cursor, setCursor] = useState<[] | [bigint]>([])
  const [selectedId, setSelectedId] = useState<bigint | null>(null)
  const [error, setError] = useState('')
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

  const selected = items.find((m) => m.id === selectedId) ?? null

  return (
    <div className={selected ? 'split reading' : 'split'}>
      <section className="list" aria-label="Sent mail">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items.length === 0 && !error && (
          <p className="hint">Nothing sent yet.</p>
        )}
        <ul>
          {items.map((m) => (
            <li key={m.id.toString()}>
              <button
                className="message"
                aria-current={selectedId === m.id}
                onClick={() => setSelectedId(m.id)}
              >
                <span className="who">
                  {m.to.concat(m.cc, m.bcc).join(', ')}
                </span>
                <span className="subject">
                  {m.subject || '(no subject)'}
                  {m.attachments > 0n ? (
                    <Icon name="paperclip" label="Has attachments" />
                  ) : null}
                </span>
                <span className="preview">{stateLabel(m.state)}</span>
              </button>
            </li>
          ))}
        </ul>
        {cursor.length > 0 && (
          <button className="more" onClick={older}>
            Older mail
          </button>
        )}
      </section>
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
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div className="reader empty">Select a message to see its status.</div>
      )}
    </div>
  )
}
