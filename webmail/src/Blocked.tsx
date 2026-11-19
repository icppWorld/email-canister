import { useCallback, useEffect, useState } from 'react'

import { errorText, type Blocked, type Mailbox } from './api'
import { formatTime, memberName } from './format'

// The senders whose new mail goes to Spam, for every member of the mailbox
export function BlockedSenders({
  backend,
  principal,
}: {
  backend: Mailbox
  principal: string
}) {
  const [list, setList] = useState<Blocked[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setList(await backend.mail_blocked())
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [backend])

  useEffect(() => {
    load()
  }, [load])

  const unblock = async (address: string) => {
    try {
      await backend.mail_unblock(address)
      setList(
        (blocked) => blocked?.filter((b) => b.address !== address) ?? null
      )
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
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
      <ul>
        {list?.map((b) => (
          <li key={b.address}>
            <span className="address">{b.address}</span>
            <span className="hint">
              by {memberName(b.blocked_by.toText(), b.name, principal)},{' '}
              {formatTime(Number(b.at_ns / 1_000_000n))}
            </span>
            <button onClick={() => unblock(b.address)}>Unblock</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
