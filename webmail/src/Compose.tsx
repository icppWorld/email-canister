import { useEffect, useRef, useState } from 'react'

import {
  errorText,
  MAX_ENCODED_BYTES,
  mailbox,
  type Attachment,
  type Backend,
  type MailboxInfo,
} from './api'
import { IconButton } from './Buttons'
import { textToHtml } from './mime'

// Held in memory only, so a draft survives signing in again but not a reload
export type Draft = {
  // The local part of the mailbox it is sent from: the one it was started in,
  // also when it reopens after a new sign-in that lists other mailboxes first
  from: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  files?: File[]
  clientId?: string
}

// At phone width the window always fills the screen
type Size = 'normal' | 'minimised' | 'full'

function addresses(text: string): string[] {
  return text.split(/[,;\s]+/).filter(Boolean)
}

function encodedSize(attachment: File): number {
  return Math.ceil(attachment.size / 3) * 4 + attachment.name.length
}

export function Compose({
  backend,
  mailboxes,
  draft,
  onChange,
  onClose,
  onSent,
}: {
  backend: Backend
  mailboxes: MailboxInfo[] // the ones it can be sent from
  draft: Draft
  onChange: (draft: Draft) => void
  onClose: () => void
  onSent: (from: string, clientId: string) => void
}) {
  const [from, setFrom] = useState(draft.from)
  const [to, setTo] = useState(draft.to ?? '')
  const [cc, setCc] = useState(draft.cc ?? '')
  const [bcc, setBcc] = useState(draft.bcc ?? '')
  const [subject, setSubject] = useState(draft.subject ?? '')
  const [body, setBody] = useState(draft.body ?? '')
  const [files, setFiles] = useState<File[]>(draft.files ?? [])
  const [size, setSize] = useState<Size>('normal')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // The same id across retries of this draft, also from another of the
  // person's mailboxes, which the canister refuses: a lost reply cannot send
  // twice
  const [clientId] = useState(() => draft.clientId ?? crypto.randomUUID())
  // The file picker, which Attach opens
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    onChange({ from, to, cc, bcc, subject, body, files, clientId })
  }, [onChange, from, to, cc, bcc, subject, body, files, clientId])

  const listed = mailboxes.some((m) => m.local === from)
  const html = textToHtml(body)
  const total =
    files.reduce((sum, f) => sum + encodedSize(f), 0) +
    new TextEncoder().encode(html).length +
    new TextEncoder().encode(subject).length
  const tooLarge = total > MAX_ENCODED_BYTES

  const send = async () => {
    setSending(true)
    setError('')
    try {
      const attachments: Attachment[] = await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          content: new Uint8Array(await file.arrayBuffer()),
        }))
      )
      // From the mailbox the form shows
      await mailbox(backend, from).mail_send({
        client_id: clientId,
        to: addresses(to),
        cc: addresses(cc),
        bcc: addresses(bcc),
        subject,
        html_body: html,
        attachments,
      })
      onSent(from, clientId)
    } catch (e) {
      setError(errorText(e))
      setSending(false)
      // Minimised while it was sending, it opens to show why it did not go
      setSize((now) => (now === 'minimised' ? 'normal' : now))
    }
  }

  const minimised = size === 'minimised'
  const full = size === 'full'
  return (
    <>
      {full && <div className="backdrop" />}
      <div
        className={`dialog compose ${size}`}
        role="dialog"
        aria-label="New message"
      >
        <div className="compose-bar">
          <h2>{subject.trim() || 'New message'}</h2>
          <IconButton
            className="bare"
            label={minimised ? 'Restore' : 'Minimise'}
            icon={minimised ? 'chevronUp' : 'minus'}
            onClick={() => setSize(minimised ? 'normal' : 'minimised')}
          />
          <IconButton
            className="bare full-toggle"
            label={full ? 'Exit full screen' : 'Full screen'}
            icon={full ? 'minimize' : 'maximize'}
            onClick={() => setSize(full ? 'normal' : 'full')}
          />
          <IconButton
            className="bare"
            label="Close"
            icon="close"
            onClick={onClose}
          />
        </div>
        {/* Hidden, not removed, when minimised: the fields keep what they hold */}
        <div className="compose-body" hidden={minimised}>
          {(mailboxes.length > 1 || !listed) && (
            <label>
              From
              <select
                aria-label="From"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                {mailboxes.map((m) => (
                  <option key={m.local} value={m.local}>
                    {m.address}
                  </option>
                ))}
                {/* A draft from a mailbox no longer listed still says where from */}
                {!listed && <option value={from}>{from}</option>}
              </select>
            </label>
          )}
          <label>
            To
            <input
              aria-label="To"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label>
            Cc
            <input
              aria-label="Cc"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </label>
          <label>
            Bcc
            <input
              aria-label="Bcc"
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
            />
          </label>
          <label>
            Subject
            <input
              aria-label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <textarea
            aria-label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <input
            ref={picker}
            aria-label="Attachments"
            type="file"
            multiple
            hidden
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {/* A file input cannot be refilled, so a restored draft names its files here */}
          {files.length > 0 && (
            <p className="hint" data-testid="attached">
              Attached: {files.map((f) => f.name).join(', ')}
            </p>
          )}
          {tooLarge && (
            <p className="error" role="alert">
              This message is too large to send. Attachments can total about 1.4
              MB.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <IconButton
              variant="primary"
              label={sending ? 'Sending…' : 'Send'}
              icon="send"
              onClick={send}
              disabled={sending || tooLarge}
            />
            <IconButton
              label="Attach"
              icon="paperclip"
              onClick={() => picker.current?.click()}
            />
          </div>
        </div>
      </div>
    </>
  )
}
