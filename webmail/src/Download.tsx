// A copy of the whole mailbox, as the SQLite file the backend keeps it in.
// The download freezes the file, so its chunks fit together; while it runs,
// new mail waits and changes to the mailbox are paused.

import { useEffect, useRef, useState } from 'react'

import { errorText, type Mailbox } from './api'
import { saveFile } from './mime'

const CHUNK = 1_900_000n // the most the backend returns at once
const PARALLEL = 4
const READ_TRIES = 3
const RETRY_MS = 1_000

const INTERRUPTED = 'The download was interrupted. Please start it again.'

export function Download({
  backend,
  address,
}: {
  backend: Mailbox
  address: string
}) {
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  // Cleared when the button goes away, at sign-out, which ends the download
  const mounted = useRef(true)
  const renewTimer = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearInterval(renewTimer.current)
    }
  }, [])

  const start = async () => {
    setError('')
    // A download keeps the mailbox it started in when another one opens, and
    // says which it is
    setProgress(`Starting the download of ${address}…`)
    // The download this button holds, which the thaw names
    let held: bigint | null = null
    // Set when the download fails, so that every reader stops
    let stopped = false
    const halted = () => stopped || !mounted.current
    try {
      const info = await backend.mail_export_freeze([])
      held = info.started_ns
      // Renewed when two fifths of the hold have passed, so that a renewal
      // that fails leaves time for the next. A download that lapses fails its
      // next chunk. The download starts now, as none other may run, so
      // until_ns - started_ns is the whole hold.
      const renewMs = Number((info.until_ns - info.started_ns) / 2_500_000n)
      // Each goes out on its own, so that one that hangs does not hold up the
      // next. One that lands after the thaw is refused: it names this download.
      renewTimer.current = setInterval(() => {
        backend.mail_export_freeze([info.started_ns]).catch(() => undefined)
      }, renewMs)

      // A query may reach a replica that has not seen the freeze yet, or fail
      // on its way, so a chunk is read a few times before the download gives
      // up. null once the download has stopped.
      const readChunk = async (offset: bigint, length: bigint) => {
        for (let tries = 1; ; tries++) {
          const chunk = await backend
            .mail_export_chunk({ offset, length })
            .catch(() => null)
          if (halted()) return null
          if (
            chunk !== null &&
            chunk.started_ns === info.started_ns &&
            chunk.size === info.size &&
            BigInt(chunk.data.length) === length
          ) {
            return chunk
          }
          if (tries === READ_TRIES) throw new Error(INTERRUPTED)
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
          if (halted()) return null
        }
      }

      // As Blobs, which the browser may keep outside the page's memory
      const parts: Blob[] = []
      let next = 0n
      let received = 0
      const read = async () => {
        while (next < info.size && !halted()) {
          const offset = next
          next += CHUNK
          const length = info.size - offset < CHUNK ? info.size - offset : CHUNK
          const chunk = await readChunk(offset, length)
          if (chunk === null) return
          const data =
            chunk.data instanceof Uint8Array
              ? chunk.data
              : Uint8Array.from(chunk.data)
          parts[Number(offset / CHUNK)] = new Blob([data as BlobPart])
          received += chunk.data.length
          setProgress(
            `Downloading ${address}… ${Math.floor((received * 100) / Number(info.size))}%`
          )
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, read))
      if (halted()) throw new Error(INTERRUPTED)
      const date = new Date().toISOString().slice(0, 10)
      saveFile(`${address}-${date}.sqlite`, parts)
    } catch (e) {
      stopped = true
      setError(`${address}: ${errorText(e)}`)
    } finally {
      clearInterval(renewTimer.current)
      // Lets new mail in at once; otherwise the freeze lapses by itself. The
      // button waits for it, so a new download does not start before it lands.
      if (held !== null) {
        await backend.mail_export_thaw(held).catch(() => undefined)
      }
      setProgress('')
    }
  }

  return (
    <div className="download">
      <button onClick={start} disabled={progress !== ''}>
        Download a copy
      </button>
      {progress && (
        <p className="hint" role="status">
          {progress}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
