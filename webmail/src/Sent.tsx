import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { attempt, BATCH, inBatches, MAX_BATCH } from './batch'
import { BackButton, IconButton } from './Buttons'
import { Bulk, RowPick, useTicks } from './Bulk'
import { memberName, messages, noteOf, shown, was } from './format'
import { Icon } from './Icon'
import { MessageBody } from './MessageBody'
import { frameBody, saveFile } from './mime'
import { Split } from './Splitter'
import type { Toast } from './Toast'

const REFRESH_MS = 5_000
// What deletions did, as the canister replied: the mail it deleted, and the
// mail it skipped, being sent or deleted already, which the page cannot tell
// apart
type Deleted = { deleted: number; skipped: number }

const deletedText = ({ deleted, skipped }: Deleted) =>
  noteOf(
    [
      [deleted, 'deleted'],
      [
        skipped,
        `could not be deleted: ${skipped === 1 ? 'it is' : 'they are'} ` +
          `being sent, or ${was(skipped)} deleted already`,
      ],
    ],
    '1 sent message',
    'sent messages'
  )

// For good, in parts the canister takes, adding up what it did
async function deleteSent(
  backend: Mailbox,
  ids: bigint[],
  done: Deleted
): Promise<void> {
  const { error } = await inBatches(
    ids,
    async (part) => {
      const deleted = await backend.mail_outbox_delete_many(part)
      done.deleted += deleted.length
      done.skipped += part.length - deleted.length
    },
    MAX_BATCH
  )
  if (error) throw error
}

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
  // Built once per message: it parses the message
  const framed = useMemo(
    () => (message ? frameBody(message.html_body, []) : null),
    [message]
  )

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
    const waiting =
      summary.state === OUTBOX_QUEUED
        ? ' Mail waiting to be sent is deleted and not sent.'
        : ''
    if (!window.confirm(`Delete this message permanently?${waiting}`)) return
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
      <h2>{shown(summary.subject) || '(no subject)'}</h2>
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
        <dd>{shown(summary.to.join(', '))}</dd>
        {summary.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{shown(summary.cc.join(', '))}</dd>
          </>
        )}
        {summary.bcc.length > 0 && (
          <>
            <dt>Bcc</dt>
            <dd>{shown(summary.bcc.join(', '))}</dd>
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
      {framed && <MessageBody framed={framed} />}
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
  // The messages ticked for an action on all of them. Mail being sent cannot
  // be deleted, so it is not ticked.
  const ticks = useTicks(
    items.filter((m) => m.state !== OUTBOX_SENDING).map((m) => m.id)
  )
  // The list's own error, which a reload clears, and an action's refusal
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
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

  // The messages given, or all of them, for good once confirmed. Mail
  // waiting to be sent is then never sent, and mail being sent is kept, as
  // the canister replies. The note says what it did, also before a refusal,
  // which shows at once while the list loads again. Each message asked for
  // is unticked, so one kept does not come back ticked.
  const remove = async (ids: bigint[] | 'all') => {
    const waiting =
      ids !== 'all' &&
      items.some((m) => m.state === OUTBOX_QUEUED && ids.includes(m.id))
    const question =
      ids === 'all'
        ? 'Delete every message in Sent for good? Mail waiting to be sent ' +
          'is deleted and not sent; mail being sent is kept.'
        : `Delete ${messages(ids.length, 'this sent message', 'sent messages')} for good?` +
          (waiting ? ' Mail waiting to be sent is deleted and not sent.' : '')
    if (!window.confirm(question)) return
    const done: Deleted = { deleted: 0, skipped: 0 }
    let all = ids === 'all' ? [] : ids
    try {
      if (ids === 'all') {
        // Every page first, then the deletes in the canister's largest parts
        let at: [] | [bigint] = []
        do {
          const page = await backend.mail_outbox_list({
            cursor: at,
            limit: BigInt(BATCH),
          })
          all = [...all, ...page.items.map((m) => m.id)]
          at = page.cursor
        } while (at.length > 0)
      }
      await deleteSent(backend, all, done)
    } finally {
      ticks.untick(new Set(all))
      if (done.deleted + done.skipped > 0) {
        notify({ text: deletedText(done) })
      }
      if (done.deleted > 0) onUsage()
      load()
    }
  }

  const act = (run: () => Promise<unknown>) => attempt(run, setActionError)

  const selected = items.find((m) => m.id === selectedId) ?? null

  return (
    <Split reading={selected !== null}>
      <section className="list" aria-label="Sent mail">
        {items.length > 0 && (
          <div className="list-head">
            <Bulk
              ticks={ticks}
              actions={[
                {
                  label: 'Delete',
                  icon: 'trash',
                  danger: true,
                  run: () => act(() => remove(ticks.ticked)),
                },
              ]}
              empty={{
                label: 'Empty Sent',
                icon: 'trash',
                danger: true,
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
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {items.length === 0 && !error && (
          <p className="hint">Nothing sent yet.</p>
        )}
        <ul>
          {items.map((m) => {
            const title = shown(m.subject) || '(no subject)'
            const sending = m.state === OUTBOX_SENDING
            return (
              <li key={m.id.toString()} className="message-row">
                <RowPick
                  ticks={ticks}
                  id={m.id}
                  name={title}
                  disabled={sending}
                />
                <button
                  className="message"
                  aria-current={selectedId === m.id}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="who">
                    {shown(m.to.concat(m.cc, m.bcc).join(', '))}
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
                    <IconButton
                      variant="bare"
                      label="Delete"
                      name={title}
                      icon="trash"
                      onClick={() => act(() => remove([m.id]))}
                    />
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
            // A change made from the reader went through: a refusal shown
            // over the list no longer applies
            setActionError('')
            setSelectedId(null)
            load()
          }}
          onUsage={onUsage}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div className="reader empty">Select a message to see its status.</div>
      )}
    </Split>
  )
}
