import { useCallback, useEffect, useRef, useState } from 'react'

import { errorText, type Blocked, type Mailbox } from './api'
import { formatNs, memberName } from './format'

// The senders whose new mail goes to Spam, for every member of the mailbox
export function BlockedSenders({
  backend,
  principal,
  refresh,
}: {
  backend: Mailbox
  principal: string
  // Changes when mail or blocks changed elsewhere, as by Undo
  refresh: number
}) {
  const [list, setList] = useState<Blocked[] | null>(null)
  const [error, setError] = useState('')

  // Only the newest load shows: one read before an unblock would bring the
  // address back
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    try {
      const blocked = await backend.mail_blocked()
      if (request !== latestLoad.current) return
      setList(blocked)
      setError('')
    } catch (e) {
      if (request === latestLoad.current) setError(errorText(e))
    }
  }, [backend])

  useEffect(() => {
    load()
  }, [load, refresh])

  const unblock = async (address: string) => {
    try {
      await backend.mail_unblock(address)
    } catch (e) {
      setError(errorText(e))
      return
    }
    setList((blocked) => blocked?.filter((b) => b.address !== address) ?? null)
    setError('')
    load()
  }

  return (
    <section className="blocked" aria-label="Blocked senders">
      <h2>Blocked senders</h2>
      <p className="hint">
        New mail from these addresses goes to Spam, for everyone in this
        mailbox.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list?.length === 0 && <p className="hint">No one is blocked.</p>}
      <ul className="members">
        {list?.map((b) => (
          <li key={b.address}>
            <span className="blocked-address">{b.address}</span>
            <span className="hint">
              by {memberName(b.blocked_by.toText(), b.name, principal)},{' '}
              {formatNs(b.at_ns)}
            </span>
            <button onClick={() => unblock(b.address)}>Unblock</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
