import { useEffect, useMemo, useRef, useState } from 'react'

import {
  errorText,
  MAX_ENCODED_BYTES,
  mailbox,
  type Attachment,
  type Backend,
  type MailboxInfo,
} from './api'
import { IconButton } from './Buttons'
import { MessageBody } from './MessageBody'
import { frameBody, htmlMessage, textToHtml } from './mime'

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
  // An HTML file, or HTML pasted, sent as the message in place of the text,
  // which stays behind it for Use plain text instead
  html?: HtmlMessage
  clientId?: string
}

type HtmlMessage = { name: string; body: string }

// The message is refused when larger than this; an HTML file is checked by its
// size before it is read, so a far larger one is never read or shown
const TOO_LARGE = `This message is too large to send. Attachments can total about 1.4 MB.`

// At phone width the window always fills the screen
type Size = 'normal' | 'minimised' | 'full'

function addresses(text: string): string[] {
  return text.split(/[,;\s]+/).filter(Boolean)
}

function encodedSize(attachment: File): number {
  return Math.ceil(attachment.size / 3) * 4 + attachment.name.length
}

// Files are told apart by name and size: the browser gives no path
const fileKey = (file: File) => `${file.name} ${file.size}`

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
  const [html, setHtml] = useState<HtmlMessage | undefined>(draft.html)
  const [size, setSize] = useState<Size>('normal')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // The same id across retries of this draft, also from another of the
  // person's mailboxes, which the canister refuses: a lost reply cannot send
  // twice
  const [clientId] = useState(() => draft.clientId ?? crypto.randomUUID())
  // The file picker, which Attach opens
  const picker = useRef<HTMLInputElement>(null)
  // The picker for an HTML file to send as the message
  const htmlPicker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    onChange({ from, to, cc, bcc, subject, body, files, html, clientId })
  }, [onChange, from, to, cc, bcc, subject, body, files, html, clientId])

  const listed = mailboxes.some((m) => m.local === from)
  const htmlBody = html ? html.body : textToHtml(body)
  // Shown the way the reader shows it, in its sandboxed frame, with its size,
  // both worked out once: it cannot be edited, and typing in the other fields
  // renders this again
  const htmlView = useMemo(
    () =>
      html && {
        name: html.name,
        framed: frameBody(html.body, []),
        bytes: new TextEncoder().encode(html.body).length,
      },
    [html]
  )
  const total =
    files.reduce((sum, f) => sum + encodedSize(f), 0) +
    (htmlView ? htmlView.bytes : new TextEncoder().encode(htmlBody).length) +
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
        html_body: htmlBody,
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
          {htmlView ? (
            <>
              <p className="attached hint" data-testid="html-message">
                HTML message: {htmlView.name}
                <IconButton
                  variant="bare"
                  label="Use plain text instead"
                  icon="close"
                  onClick={() => setHtml(undefined)}
                />
              </p>
              <MessageBody framed={htmlView.framed} />
            </>
          ) : (
            <textarea
              aria-label="Message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              // HTML pasted into an empty message becomes the message, with
              // its text behind it; into a message with text, only its text
              // goes in, so nothing written is replaced
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text/html')
                if (body !== '' || !pasted) return
                e.preventDefault()
                setBody(e.clipboardData.getData('text/plain'))
                setHtml({ name: 'Pasted HTML', body: pasted })
              }}
            />
          )}
          <input
            ref={htmlPicker}
            aria-label="HTML file"
            type="file"
            accept=".html,.htm,text/html"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              // Cleared, so the same file can be picked again after an edit
              e.target.value = ''
              if (!file) return
              if (file.size > MAX_ENCODED_BYTES) return setError(TOO_LARGE)
              try {
                const text = await file.text()
                setHtml({ name: file.name, body: htmlMessage(text) })
                setError('')
              } catch (e) {
                setError(`Could not read ${file.name}: ${errorText(e)}`)
              }
            }}
          />
          <input
            ref={picker}
            aria-label="Attachments"
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              // Cleared, so the same file can be picked again once removed
              e.target.value = ''
              // A file with the name and size of one attached already, or
              // of one earlier in this pick, is taken as a newer copy of it,
              // as after an edit, and replaces it in its place
              setFiles((before) => {
                const next = [...before]
                for (const file of picked) {
                  const at = next.findIndex((f) => fileKey(f) === fileKey(file))
                  if (at >= 0) next[at] = file
                  else next.push(file)
                }
                return next
              })
            }}
          />
          {/* Each pick adds to these, also in a restored draft, whose file
              input cannot be refilled; a cancelled pick adds none */}
          {files.length > 0 && (
            <div className="attached hint" data-testid="attached">
              Attached:{' '}
              <ul aria-label="Attached files">
                {files.map((file) => (
                  <li key={fileKey(file)}>
                    {file.name} ({Math.ceil(file.size / 1024)} KB)
                    <IconButton
                      variant="bare"
                      label="Remove"
                      name={file.name}
                      icon="close"
                      onClick={() =>
                        setFiles((before) => before.filter((f) => f !== file))
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tooLarge && (
            <p className="error" role="alert">
              {TOO_LARGE}
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
            <IconButton
              label="Use an HTML file as the message"
              icon="code"
              onClick={() => htmlPicker.current?.click()}
            />
          </div>
        </div>
      </div>
    </>
  )
}
