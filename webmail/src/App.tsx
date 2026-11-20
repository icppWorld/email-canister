import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Identity } from '@icp-sdk/core/agent'

import { createBackend, errorText, mailbox, type Backend, type Me } from './api'
import { createSession, type Session } from './auth'
import { AdminPanel } from './AdminPanel'
import { BlockedSenders } from './Blocked'
import { formatBytes } from './format'
import { Icon } from './Icon'
import { Compose, type Draft } from './Compose'
import { useDownload } from './Download'
import { Inbox, isFolder } from './Inbox'
import { Menu } from './Menu'
import { Sent } from './Sent'
import { deployment } from './settings'
import { ToastBar, type Toast, type ToastAction } from './Toast'

// A mailbox's folders and pages, each with an address of its own
const PAGES = {
  inbox: 'Inbox',
  sent: 'Sent',
  spam: 'Spam',
  trash: 'Trash',
  blocked: 'Blocked senders',
} as const
type Page = keyof typeof PAGES
type View = Page | 'admin'

// How long a note about what was just done stays shown
const TOAST_MS = 8_000

// How often the person's mailboxes, with their unread counts and usage, are
// fetched again
const MAILBOXES_REFRESH_MS = 30_000

// The mailbox and folder the address names, as #team or #team/sent, so a view
// can be bookmarked or shared
function route(): { local: string | null; view: Page } {
  const [local, folder] = window.location.hash.slice(1).split('/')
  const view = Object.hasOwn(PAGES, folder ?? '') ? (folder as Page) : 'inbox'
  return { local: local || null, view }
}

function hashOf(local: string, view: Page): string {
  return `#${local}${view === 'inbox' ? '' : `/${view}`}`
}

// The mailbox a person last chose, kept in this browser only
function remembered(principal: string): string | null {
  try {
    return window.localStorage.getItem(`mailbox:${principal}`)
  } catch {
    return null
  }
}

function remember(principal: string, local: string): void {
  try {
    window.localStorage.setItem(`mailbox:${principal}`, local)
  } catch {
    // Not kept: the first mailbox opens next time
  }
}

// The light and dark versions swap with the system setting, without script
function Logo({ large = false }: { large?: boolean }) {
  const logo = deployment().brand.logo
  if (!logo) return null
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={logo.dark} />
      <img
        className={large ? 'logo large' : 'logo'}
        src={logo.light}
        alt={logo.alt}
      />
    </picture>
  )
}

function SignIn({
  onSignIn,
  error,
  ended,
  keptDraft,
}: {
  onSignIn: () => void
  error: string
  ended: boolean
  keptDraft: boolean
}) {
  return (
    <main className="centered">
      <div className="card">
        <Logo large />
        <h1>{deployment().brand.label}</h1>
        <p>{deployment().brand.tagline}</p>
        {ended && (
          <p className="warning" role="status">
            Your sign-in has ended. Please sign in again.
            {keptDraft && ' Your unsent message reopens once you do.'}
          </p>
        )}
        <button className="primary" onClick={onSignIn}>
          Sign in with Internet Identity
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}

function NotActivated({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const principal = me.principal.toText()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(principal)
    setCopied(true)
  }
  return (
    <main className="centered">
      <div className="card">
        <h1>Not activated yet</h1>
        <p>
          Send this ID to your administrator. Your mail opens here once they
          give you a mailbox, or add you to one.
        </p>
        <code className="principal" data-testid="principal">
          {principal}
        </code>
        <div className="row">
          <button className="primary" onClick={copy}>
            {copied ? 'Copied' : 'Copy ID'}
          </button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </main>
  )
}

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [backend, setBackend] = useState<Backend | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [selected, setSelected] = useState<string | null>(() => route().local)
  const [view, setView] = useState<View>(() => route().view)
  const [refresh, setRefresh] = useState(0)
  // Sends made here, for the Sent list alone: other folders keep their pages
  const [sends, setSends] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const onLoaded = useCallback(() => setRefreshing(false), [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  // Under the pointer or holding the focus, the note stays until let go
  const [toastHeld, setToastHeld] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // Whose sign-in ended while the page was open, so only they get the draft back
  const [endedFor, setEndedFor] = useState<string | null>(null)
  // A reply for an earlier sign-in must not replace this one's mailboxes
  const latestBackend = useRef<Backend | null>(null)
  // A reload's reply counts only when no later one has been applied: an
  // older one holds older counts
  const reloads = useRef(0)
  const applied = useRef(0)
  const principal = me?.principal.toText()
  // Read once per sign-in: after that, selected names the mailbox shown, so
  // a choice made in another tab does not move this one
  const lastChosen = useMemo(
    () => (principal ? remembered(principal) : null),
    [principal]
  )
  // The chosen mailbox while the person is still a member of it, else the one
  // they chose last in this browser, else their first
  const member = (wanted: string | null) =>
    me?.mailboxes.find((m) => m.local === wanted)
  const shown = member(selected) ?? member(lastChosen) ?? me?.mailboxes[0]
  const local = shown?.local
  const box = useMemo(
    () => (backend && local !== undefined ? mailbox(backend, local) : null),
    [backend, local]
  )
  const current = box !== null ? view : 'admin'
  const download = useDownload(box, shown?.address ?? '', backend)

  // The draft open now, for a send that ends later
  const sendingDraft = useRef(draft)
  useEffect(() => {
    sendingDraft.current = draft
  }, [draft])

  const open = useCallback(async (identity: Identity) => {
    const api = createBackend(identity)
    latestBackend.current = api
    setMe(await api.mail_me())
    setBackend(api)
  }, [])

  // Ends the session's calls too: a late reply finds no backend to match
  const closeSession = () => {
    latestBackend.current = null
    setBackend(null)
    setMe(null)
    setToast(null)
  }

  const reloadMailboxes = useCallback(async () => {
    const api = latestBackend.current
    if (!api) return
    const reload = ++reloads.current
    try {
      const fresh = await api.mail_me()
      if (api === latestBackend.current && reload > applied.current) {
        applied.current = reload
        setMe(fresh)
      }
    } catch {
      // Shown again on the next try, or the sign-in's end shows why
    }
  }, [])

  useEffect(() => {
    if (!backend) return
    const timer = window.setInterval(reloadMailboxes, MAILBOXES_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [backend, reloadMailboxes])

  // A note that closed while held, as by its own button, lets go. One that
  // takes the place of a held note stays held.
  useEffect(() => {
    if (!toast) setToastHeld(false)
  }, [toast])
  useEffect(() => {
    if (!toast || toastHeld) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast, toastHeld])

  // A toast's action, such as Undo
  const runToast = async (action: ToastAction) => {
    setToast(null)
    // Its end belongs to the session it began in
    const session = latestBackend.current
    try {
      await action.run()
    } catch (e) {
      if (session === latestBackend.current) setToast({ text: errorText(e) })
    } finally {
      if (action.reload && session === latestBackend.current) {
        setRefresh((count) => count + 1)
        reloadMailboxes()
      }
    }
  }

  // The address follows the mailbox and folder shown
  useEffect(() => {
    if (local === undefined || current === 'admin') return
    const hash = hashOf(local, current)
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash)
    }
  }, [local, current])

  // The mailbox shown is the one this browser opens next time; a folder
  // switch leaves what another tab chose since
  useEffect(() => {
    if (local === undefined || !principal) return
    remember(principal, local)
    // From now on the choice is the mailbox shown, also when it was a
    // fallback for one the person no longer has
    setSelected(local)
  }, [local, principal])

  // An address typed or followed opens what it names, when it is one of
  // theirs; otherwise the address goes back to the mailbox shown
  const mailboxes = me?.mailboxes
  useEffect(() => {
    const follow = () => {
      const named = route()
      // Before their mailboxes load, kept until they can be checked
      if (!mailboxes || mailboxes.some((m) => m.local === named.local)) {
        if (named.local) setSelected(named.local)
      } else if (local !== undefined) {
        window.history.replaceState(null, '', hashOf(local, named.view))
      }
      setView(named.view)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [mailboxes, local])

  // Back to the sign-in page when the sign-in ends, rather than leaving the
  // mailbox on screen while every call fails
  useEffect(() => {
    if (!session || !principal) return
    return session.watch(() => {
      setEndedFor(principal)
      closeSession()
    })
  }, [session, principal])

  useEffect(() => {
    ;(async () => {
      try {
        const created = await createSession()
        setSession(created)
        const identity = await created.current()
        if (identity) await open(identity)
      } catch (e) {
        setError(errorText(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const choose = (chosen: string) => {
    setSelected(chosen)
    setView('inbox')
  }

  const signIn = async () => {
    if (!session) return
    try {
      setError('')
      const identity = await session.signIn()
      if (endedFor !== null && identity.getPrincipal().toText() !== endedFor) {
        setDraft(null)
        setSelected(null)
        setView('inbox')
      }
      await open(identity)
      setEndedFor(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const signOut = async () => {
    await session?.signOut()
    closeSession()
    setDraft(null)
    setEndedFor(null)
    setSelected(null)
    setView('inbox')
  }

  if (loading) return <main className="centered">Loading…</main>
  if (!backend || !me || !principal) {
    return (
      <SignIn
        onSignIn={signIn}
        error={error}
        ended={endedFor !== null}
        keptDraft={draft !== null}
      />
    )
  }

  if (!shown && !me.is_controller) {
    return <NotActivated me={me} onSignOut={signOut} />
  }

  const shared = shown !== undefined && shown.members > 1n

  const refreshInbox = () => {
    setRefreshing(true)
    setView('inbox')
    setRefresh((count) => count + 1)
    reloadMailboxes()
  }

  // The open mailbox's folders, below its row in the list
  const folders = (
    <div className="folders">
      <div className="folder">
        <button
          aria-current={current === 'inbox'}
          onClick={() => setView('inbox')}
        >
          Inbox
        </button>
        <button
          className={refreshing ? 'refresh spinning' : 'refresh'}
          aria-label="Refresh"
          aria-busy={refreshing}
          title="Refresh"
          disabled={refreshing}
          onClick={refreshInbox}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {(Object.keys(PAGES) as Page[])
        // Blocked senders is in the menu
        .filter((page) => page !== 'inbox' && page !== 'blocked')
        .map((page) => (
          <button
            key={page}
            aria-current={current === page}
            onClick={() => setView(page)}
          >
            {PAGES[page]}
          </button>
        ))}
    </div>
  )

  return (
    <div className="app">
      <header>
        <strong className="brand">
          <Logo />
          {deployment().brand.label}
        </strong>
        <span className="address" data-testid="address">
          {shown?.address ?? 'Administrator'}
        </span>
        {(box || me.is_controller) && (
          <Menu label="More">
            {box && (
              <>
                <button
                  aria-current={current === 'blocked'}
                  onClick={() => setView('blocked')}
                >
                  Blocked senders
                </button>
                <button onClick={download.start} disabled={download.busy}>
                  Download a copy
                </button>
              </>
            )}
            {me.is_controller && (
              <button
                aria-current={current === 'admin'}
                onClick={() => setView('admin')}
              >
                Admin
              </button>
            )}
          </Menu>
        )}
        <button onClick={signOut}>Sign out</button>
      </header>
      <nav aria-label="Folders">
        {box && shown && (
          <>
            <button
              className="primary compose"
              onClick={() => setDraft((open) => open ?? { from: shown.local })}
            >
              Compose
            </button>
            {/* At phone width a select takes the place of the list */}
            <select
              className="mailbox-select"
              aria-label="Mailbox"
              value={shown.local}
              onChange={(e) => choose(e.target.value)}
            >
              {me.mailboxes.map((m) => (
                <option key={m.local} value={m.local}>
                  {m.address}
                  {m.unseen > 0n ? ` (${m.unseen} unread)` : ''}
                </option>
              ))}
            </select>
            <ul className="mailboxes" aria-label="Mailboxes">
              {me.mailboxes.map((m) => {
                const isOpen = m.local === shown.local
                return (
                  <li key={m.local} className={isOpen ? 'open' : undefined}>
                    <button
                      className="mailbox"
                      title={m.address}
                      aria-current={isOpen && current !== 'admin'}
                      onClick={() => choose(m.local)}
                    >
                      <span className="name">{m.local}</span>
                      {m.unseen > 0n && (
                        <span
                          className="badge"
                          data-testid={`unread-${m.local}`}
                        >
                          {m.unseen.toString()}
                        </span>
                      )}
                    </button>
                    {isOpen && folders}
                  </li>
                )
              })}
            </ul>
          </>
        )}
        {shown && (
          <p className="usage" data-testid="usage">
            {formatBytes(shown.used_bytes)} of {formatBytes(shown.quota_bytes)}{' '}
            used
          </p>
        )}
        {/* Started from the menu, and shown here while it runs */}
        {download.progress && (
          <p className="download-status" role="status">
            {download.progress}
          </p>
        )}
        {download.error && (
          <p className="error" role="alert">
            {download.error}
          </p>
        )}
        {!box && (
          <p className="hint" data-testid="principal">
            {principal}
          </p>
        )}
      </nav>
      <div className="content">
        {isFolder(current) && box && shown && (
          <Inbox
            key={`${shown.local}/${current}`}
            backend={box}
            principal={principal}
            shared={shared}
            folder={current}
            notify={(note) => {
              // A move that ends after a new sign-in is not this session's
              if (latestBackend.current === backend) setToast(note)
            }}
            onReply={(reply) =>
              setDraft((open) => open ?? { ...reply, from: shown.local })
            }
            onCounts={reloadMailboxes}
            refresh={refresh}
            onLoaded={onLoaded}
            onBlocked={() => setView('blocked')}
            domain={shown.address.slice(shown.address.indexOf('@') + 1)}
          />
        )}
        {current === 'sent' && box && (
          <Sent
            key={local}
            backend={box}
            principal={principal}
            shared={shared}
            refresh={sends}
          />
        )}
        {current === 'blocked' && box && (
          <BlockedSenders
            key={local}
            backend={box}
            principal={principal}
            refresh={refresh}
          />
        )}
        {current === 'admin' && <AdminPanel backend={backend} />}
      </div>
      {draft && backend && (
        <Compose
          backend={backend}
          mailboxes={me.mailboxes}
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSent={(from, clientId) => {
            // A send that ends after this draft was closed, as over a new
            // sign-in, leaves the draft open now alone
            if (sendingDraft.current?.clientId !== clientId) return
            // The folder shown stays, and a Sent list shown reloads; the note
            // leads to the Sent folder it was sent from
            setDraft(null)
            setSends((count) => count + 1)
            setToast({
              text: 'Message sent',
              actions: [
                {
                  label: 'View in Sent',
                  run: () => {
                    setSelected(from)
                    setView('sent')
                  },
                },
              ],
            })
          }}
        />
      )}
      <ToastBar
        toast={toast}
        onAction={runToast}
        onClose={() => setToast(null)}
        onHold={setToastHeld}
      />
    </div>
  )
}
