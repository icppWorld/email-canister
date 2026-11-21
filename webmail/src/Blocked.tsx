import { useCallback, useEffect, useRef, useState } from 'react'

import { errorText, type Blocked, type Mailbox } from './api'
import { formatNs, memberName } from './format'

// One block: its address, and when it was made
const blockOf = (b: Blocked) => `${b.address} ${b.at_ns}`

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

  // Only the newest load shows, without the blocks unblocked on this page: a
  // read from a replica that has not seen the unblock yet would list them. A
  // block of the address made again has a time of its own, and shows.
  const latestLoad = useRef(0)
  const unblocked = useRef(new Set<string>())
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    try {
      const blocked = await backend.mail_blocked()
      if (request !== latestLoad.current) return
      setList(blocked.filter((b) => !unblocked.current.has(blockOf(b))))
      setError('')
    } catch (e) {
      if (request === latestLoad.current) setError(errorText(e))
    }
  }, [backend])

  useEffect(() => {
    load()
  }, [load, refresh])

  const unblock = async (block: Blocked) => {
    const { address } = block
    try {
      await backend.mail_unblock(address)
    } catch (e) {
      setError(errorText(e))
      return
    }
    // No reload: a replica that has not seen the unblock yet would bring the
    // address back
    unblocked.current.add(blockOf(block))
    // That block alone: one made again meanwhile stays
    setList(
      (blocked) => blocked?.filter((b) => blockOf(b) !== blockOf(block)) ?? null
    )
    setError('')
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
            <button onClick={() => unblock(b)}>Unblock</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
