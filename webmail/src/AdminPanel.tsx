// Controllers only, enforced by the backend: hiding this is just tidiness. It
// shows counts and sizes, and the backend has no call that returns mail here.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Principal } from '@icp-sdk/core/principal'

import {
  errorText,
  type Backend,
  type Entry,
  type IngestStats,
  type Member,
  type Settings,
  type StorageTotals,
} from './api'
import { formatBytes as size, memberName } from './format'

const GIB = 1024 ** 3

// A quota typed in GB, in bytes; null unless it is a decimal number of at
// least 1 MB
function quotaBytes(text: string): bigint | null {
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return null
  const megabytes = Math.round(Number(text) * 1024)
  return Number.isFinite(megabytes) && megabytes >= 1
    ? BigInt(megabytes) * 1024n * 1024n
    : null
}

// A member as an action names them: the name alone could be anyone's
function identified(member: Member): string {
  const principal = member.principal.toText()
  return member.name[0] ? `${member.name[0]} (${principal})` : principal
}

// Everyone who is a member somewhere, with the mailboxes they are in
interface Person {
  principal: string
  name: string
  mailboxes: string[]
}

function peopleOf(entries: Entry[]): Person[] {
  const people = new Map<string, Person>()
  for (const entry of entries) {
    for (const member of entry.members) {
      const principal = member.principal.toText()
      const person = people.get(principal) ?? {
        principal,
        name: member.name[0] ?? '',
        mailboxes: [],
      }
      person.mailboxes.push(entry.local)
      people.set(principal, person)
    }
  }
  return [...people.values()].sort(
    (a, b) =>
      (a.name || '\uffff').localeCompare(b.name || '\uffff') ||
      a.principal.localeCompare(b.principal)
  )
}

function status(entry: Entry): string {
  if (entry.vacant) return 'Free'
  if (entry.needs_repair.length > 0) return 'Needs repair'
  return entry.disabled ? 'Disabled' : 'Active'
}

export function AdminPanel({ backend }: { backend: Backend }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [totals, setTotals] = useState<StorageTotals | null>(null)
  const [stats, setStats] = useState<IngestStats | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [principal, setPrincipal] = useState('')
  const [local, setLocal] = useState('')
  const [newQuota, setNewQuota] = useState('')
  // Names being typed, by principal, kept across reloads until saved
  const [names, setNames] = useState<Record<string, string>>({})
  // Names saved since the last load, which then shows what the canister holds
  const savedNames = useRef(new Map<string, string>())
  const [domain, setDomain] = useState('')
  const [bridge, setBridge] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  // A load's error, and an action's: a load that ends clears only its own,
  // so an action that failed meanwhile keeps its message
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')

  // Replies can arrive out of order, and only the newest may be shown
  const latestLoad = useRef(0)
  const refocus = useRef<HTMLElement | null>(null)
  // The settings as last loaded into the Domain and Bridge fields
  const shown = useRef({ domain: '', bridge: '' })

  const load = useCallback(async () => {
    const request = ++latestLoad.current
    try {
      const [e, t, s, c] = await Promise.all([
        backend.admin_list_entries(),
        backend.admin_storage_totals(),
        backend.admin_ingest_stats(),
        backend.admin_settings(),
      ])
      if (request !== latestLoad.current) return
      setEntries(e)
      // A name typed in People stays until it is saved, or the list shows
      // it stored
      const stored = new Map(
        peopleOf(e).map((person) => [person.principal, person.name])
      )
      const saved = savedNames.current
      savedNames.current = new Map()
      setNames((typed) =>
        Object.fromEntries(
          Object.entries(typed).filter(
            ([principal, name]) =>
              stored.has(principal) &&
              stored.get(principal) !== name.trim() &&
              saved.get(principal) !== name
          )
        )
      )
      setTotals(t)
      setStats(s)
      // A field the admin has edited since the last load keeps the edit
      const before = shown.current
      const bridgeText = c.bridge[0]?.toText() ?? ''
      setDomain((d) => (d === before.domain ? c.domain : d))
      setBridge((b) => (b === before.bridge ? bridgeText : b))
      shown.current = { domain: c.domain, bridge: bridgeText }
      setSettings(c)
      setLoadError('')
    } catch (e) {
      if (request === latestLoad.current) setLoadError(errorText(e))
    }
  }, [backend])

  // The control that started an action has the focus again once it ends
  useEffect(() => {
    if (busy !== '') return
    refocus.current?.focus()
    refocus.current = null
  }, [busy])

  useEffect(() => {
    load()
  }, [load])

  const run = async (label: string, action: () => Promise<unknown>) => {
    // The controls are disabled meanwhile, which takes the focus away
    refocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setBusy(label)
    setNotice('')
    setError('')
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
      // Also after a refusal: the action may have changed something first.
      // The controls do not wait for it, so a reload that hangs holds nothing.
      load()
    }
  }

  const people = useMemo(() => peopleOf(entries), [entries])

  const addressOf = (local: string) => {
    const saved = settings?.domain
    return saved ? `${local}@${saved}` : local
  }

  // Creates a new mailbox, with its first member if one is given, in one call
  // that the canister refuses whole for an address in use. It never adds
  // anyone to an existing mailbox: that gives them all its mail, so it is a
  // separate, confirmed action on the mailbox's row.
  const create = (event: FormEvent) => {
    event.preventDefault()
    const quotaText = newQuota.trim()
    const bytes = quotaBytes(quotaText)
    if (quotaText !== '' && bytes === null) {
      setError(
        'Enter the quota as a number of GB, at least 0.001, or leave it empty.'
      )
      return
    }
    run('Creating…', async () => {
      const first = principal.trim()
      await backend.admin_create_mailbox({
        local: local.trim(),
        quota_bytes: bytes === null ? [] : [bytes],
        first_member: first === '' ? [] : [Principal.fromText(first)],
      })
      setPrincipal('')
      setLocal('')
      setNewQuota('')
    })
  }

  // Gives one more principal access to all of an existing mailbox's mail,
  // once the admin has confirmed it for this mailbox by name. The canister
  // refuses it if the address was created again since this list was read.
  const addMember = (entry: Entry) => {
    const text = window.prompt(
      `User ID (principal) to give access to ${entry.local}`
    )
    if (!text) return
    let member: Principal
    try {
      member = Principal.fromText(text.trim())
    } catch (e) {
      setError(errorText(e))
      return
    }
    if (
      !window.confirm(
        `Give ${member.toText()} access to all mail in ${addressOf(entry.local)}? They can read, delete and send from it.`
      )
    )
      return
    run('Adding…', () =>
      backend.admin_add_member(entry.local, member, [entry.uidvalidity])
    )
  }

  const removeMember = (entry: Entry, member: Member) => {
    if (
      !window.confirm(
        `Remove ${identified(member)} from ${addressOf(entry.local)}? They lose access to all of its mail at once.`
      )
    )
      return
    run('Removing…', () =>
      backend.admin_remove_member(entry.local, member.principal)
    )
  }

  // An empty name removes it: members then see the start of the User ID
  const saveName = (person: Person) => {
    const typed = names[person.principal] ?? person.name
    run('Saving…', async () => {
      await backend.admin_set_name(
        Principal.fromText(person.principal),
        typed.trim()
      )
      savedNames.current.set(person.principal, typed)
    })
  }

  const purge = (entry: Entry) => {
    if (
      !window.confirm(
        `Permanently delete all mail of ${entry.local}? This cannot be undone.`
      )
    )
      return
    run(`Purging ${entry.local}…`, async () => {
      let remaining = 1n
      while (remaining > 0n) {
        remaining = (await backend.admin_purge(entry.local)).remaining
        setBusy(`Purging ${entry.local}: ${size(remaining)} left…`)
      }
    })
  }

  // Mail that could not be moved into the mailbox waits in the queue, until this
  const retryMoves = (entry: Entry) =>
    run(`Retrying ${entry.local}…`, async () => {
      const count = await backend.admin_retry_moves(entry.local)
      setNotice(
        count === 0n
          ? `${entry.local} has no stuck mail.`
          : `Queued ${count} stuck message${count === 1n ? '' : 's'} for ${entry.local} again.`
      )
    })

  // A check of the whole file holds the mailbox for repair when it finds a
  // problem, and releases it when it finds none
  const check = (entry: Entry) =>
    run(`Checking ${entry.local}…`, async () => {
      const { result } = await backend.admin_check(entry.local, [])
      // A file that cannot be opened now is not held: the check says only that
      setNotice(
        result === 'ok'
          ? `${entry.local}: the mailbox is sound.`
          : result === 'the file cannot be opened'
            ? `${entry.local}: the file cannot be opened now. Check it again later.`
            : `${entry.local} needs repair: ${result}`
      )
    })

  const setQuota = (entry: Entry) => {
    const shown = String(Number(entry.quota_bytes) / GIB)
    const text = window.prompt(`Quota for ${entry.local}, in GB`, shown)
    // Unchanged, it stays as it is: the GB shown can be rounded
    if (!text || text === shown) return
    const bytes = quotaBytes(text.trim())
    if (bytes === null) {
      setError('Enter a number of GB, at least 0.001.')
      return
    }
    run('Saving…', () => backend.admin_set_quota(entry.local, bytes))
  }

  return (
    <section className="admin" aria-label="Administration">
      <h2>Administration</h2>
      {(error || loadError) && (
        <p className="error" role="alert">
          {[error, loadError].filter(Boolean).join(' — ')}
        </p>
      )}
      {busy && (
        <p className="hint" role="status">
          {busy}
        </p>
      )}
      {notice && (
        <p className="hint" role="status" data-testid="notice">
          {notice}
        </p>
      )}

      {totals && stats && (
        <dl className="stats" data-testid="totals">
          <div>
            <dt>Mailboxes</dt>
            <dd>{totals.mailboxes.toString()}</dd>
          </div>
          <div>
            <dt>Messages</dt>
            <dd>{totals.messages.toString()}</dd>
          </div>
          <div>
            <dt>Mail stored</dt>
            <dd>{size(totals.used_bytes)}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{size(totals.database_bytes)}</dd>
          </div>
          <div>
            <dt>Stable memory reserved</dt>
            <dd>{size(totals.stable_memory_bytes)}</dd>
          </div>
          <div>
            <dt>Being processed</dt>
            <dd>{stats.queued.toString()}</dd>
          </div>
          <div>
            <dt>Quarantined in mailboxes</dt>
            <dd>{stats.quarantined.toString()}</dd>
          </div>
          <div>
            <dt>Quarantined in the queue</dt>
            <dd>{stats.quarantined_moves.toString()}</dd>
          </div>
        </dl>
      )}

      {/* Every control waits while an action runs */}
      <fieldset
        className="controls"
        aria-label="Mailboxes and settings"
        disabled={busy !== ''}
      >
        <details className="help">
          <summary>How people get their mail</summary>
          <p>
            Someone new signs in and sees <em>Not activated yet</em> with their
            User ID, which they send you.
          </p>
          <ul>
            <li>
              <strong>Their own mailbox:</strong> create it with their User ID
              as its first member.
            </li>
            <li>
              <strong>A shared mailbox</strong>, such as one for a team: create
              it, then use <em>Add member</em> on its row for each person. Every
              member can read, delete and send from it, and sees who opened and
              who sent each message.
            </li>
            <li>
              One sign-in shows every mailbox the person is a member of. Under{' '}
              <em>People</em>, give them the name the other members see.
            </li>
          </ul>
        </details>

        <h3>New mailbox</h3>
        <form className="row wrap" onSubmit={create}>
          <input
            aria-label="Address"
            placeholder="Address, before the @"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            required
          />
          <input
            aria-label="User ID"
            placeholder="First member's User ID (optional)"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
          />
          <input
            aria-label="Quota in GB"
            placeholder="Quota in GB (optional)"
            inputMode="decimal"
            value={newQuota}
            onChange={(e) => setNewQuota(e.target.value)}
          />
          <button className="primary" type="submit">
            Create
          </button>
        </form>

        <h3>Mailboxes</h3>
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Members</th>
              <th>Status</th>
              <th>Messages</th>
              <th>Used</th>
              <th>Quota</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const vacant = entry.vacant
              return (
                <tr key={entry.local} data-testid={`entry-${entry.local}`}>
                  <td>{entry.local}</td>
                  <td data-label="Members">
                    {entry.members.length === 0 ? (
                      '—'
                    ) : (
                      <ul className="members">
                        {entry.members.map((member) => (
                          <li key={member.principal.toText()}>
                            <span title={member.principal.toText()}>
                              {memberName(
                                member.principal.toText(),
                                member.name
                              )}
                            </span>
                            <button
                              className="small"
                              aria-label={`Remove ${identified(member)} from ${entry.local}`}
                              onClick={() => removeMember(entry, member)}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td data-label="Status" title={entry.needs_repair[0]}>
                    {status(entry)}
                  </td>
                  <td data-label="Messages">
                    {entry.message_count.toString()}
                  </td>
                  <td data-label="Used">{size(entry.used_bytes)}</td>
                  <td data-label="Quota">{size(entry.quota_bytes)}</td>
                  <td>
                    <div className="actions">
                      {!vacant && (
                        <button
                          onClick={() =>
                            run('Saving…', () =>
                              backend.admin_set_disabled(
                                entry.local,
                                !entry.disabled
                              )
                            )
                          }
                        >
                          {entry.disabled ? 'Enable' : 'Disable'}
                        </button>
                      )}
                      {!vacant && (
                        <button onClick={() => addMember(entry)}>
                          Add member
                        </button>
                      )}
                      {!vacant && (
                        <button onClick={() => setQuota(entry)}>Quota</button>
                      )}
                      {!vacant && (
                        <button onClick={() => retryMoves(entry)}>
                          Retry stuck mail
                        </button>
                      )}
                      {!vacant && (
                        <button onClick={() => check(entry)}>Check</button>
                      )}
                      {entry.disabled && !vacant && (
                        <button className="danger" onClick={() => purge(entry)}>
                          Purge
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <h3>People</h3>
        {people.length === 0 ? (
          <p className="hint">No one is a member of a mailbox yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>User ID</th>
                <th>Mailboxes</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr
                  key={person.principal}
                  data-testid={`person-${person.principal}`}
                >
                  <td>
                    <form
                      className="row tight"
                      onSubmit={(e) => {
                        e.preventDefault()
                        saveName(person)
                      }}
                    >
                      <input
                        aria-label="Name"
                        placeholder="Name members see"
                        value={names[person.principal] ?? person.name}
                        onChange={(e) =>
                          setNames((n) => ({
                            ...n,
                            [person.principal]: e.target.value,
                          }))
                        }
                      />
                      <button type="submit">Save name</button>
                    </form>
                  </td>
                  <td data-label="User ID" className="mono">
                    {person.principal}
                  </td>
                  <td data-label="Mailboxes">{person.mailboxes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {settings && (
          <>
            <h3>Settings</h3>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                run('Saving…', async () => {
                  await backend.admin_set_domain(domain.trim())
                  // Saved, so the reload shows it as the canister stores it
                  shown.current.domain = domain
                })
              }}
            >
              <input
                aria-label="Domain"
                placeholder="Mail domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
              <button type="submit">Save domain</button>
            </form>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                run('Saving…', async () => {
                  await backend.admin_set_bridge(
                    Principal.fromText(bridge.trim())
                  )
                  shown.current.bridge = bridge
                })
              }}
            >
              <input
                aria-label="Bridge"
                placeholder="Sending bridge canister"
                value={bridge}
                onChange={(e) => setBridge(e.target.value)}
              />
              <button type="submit">Save bridge</button>
            </form>
          </>
        )}
      </fieldset>
    </section>
  )
}
