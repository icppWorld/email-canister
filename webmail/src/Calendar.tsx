// A mailbox's calendar: a month of its events, a form to add or change one,
// and the secret address calendar apps subscribe to. Loaded only when opened,
// with the calendar libraries.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { tzlib_get_timezones as zoneList } from 'timezones-ical-library'

import { errorText, type CalendarEvent, type Mailbox } from './api'
import { attempt } from './batch'
import { IconButton } from './Buttons'
import {
  addDays,
  buildEvent,
  dayKey,
  feedUrl,
  invalidFields,
  localZone,
  newUid,
  occurrences,
  type EventFields,
  type Occurrence,
  type Repeat,
} from './ical'
import { deployment } from './settings'

const seconds = (d: Date) => BigInt(Math.floor(d.getTime() / 1000))

// The six weeks shown for a month, from the Monday on or before its first day
function gridOf(month: Date): { start: Date; end: Date; days: Date[] } {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7))
  const days = Array.from(
    { length: 42 },
    (_, i) =>
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
  )
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 42
  )
  return { start, end, days }
}

const monthTitle = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
const dayTitle = (d: Date) =>
  d.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
const timeText = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })
)

// The days an occurrence shows on, as day keys: an all-day event's dates,
// a timed one's local days
function daysOf(o: Occurrence, grid: { start: Date; end: Date }): string[] {
  const keys: string[] = []
  // Only the grid's days, however long the event
  const last = Math.min(
    Math.max(o.start.getTime(), o.end.getTime() - 1),
    grid.end.getTime() - 1
  )
  const first = o.start > grid.start ? o.start : grid.start
  const y = first.getFullYear()
  const m = first.getMonth()
  const d = first.getDate()
  for (let i = 0; i < 42; ++i) {
    const day = new Date(y, m, d + i)
    if (day.getTime() > last) break
    keys.push(dayKey(day))
  }
  return keys
}

function newFields(date: string): EventFields {
  return {
    uid: newUid(),
    title: '',
    location: '',
    notes: '',
    allDay: false,
    startDate: date,
    startTime: '09:00',
    endDate: date,
    endTime: '10:00',
    tzid: localZone(),
    repeat: '',
    until: '',
    sequence: 0,
    created: '',
    kept: null,
    source: '',
  }
}

// The first day of this month
function thisMonth(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export function Calendar({
  backend,
  address,
}: {
  backend: Mailbox
  address: string
}) {
  const [month, setMonth] = useState(thisMonth)
  // The events, with the grid they were loaded for: a month just left shows
  // nothing rather than its events read against the new grid
  const [loaded, setLoaded] = useState<{
    grid: ReturnType<typeof gridOf>
    items: CalendarEvent[]
  } | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{
    fields: EventFields
    isNew: boolean
  } | null>(null)
  const [sharing, setSharing] = useState(false)
  // Raised after a change, so that the month shown then loads again
  const [changes, setChanges] = useState(0)
  const grid = useMemo(() => gridOf(month), [month])
  const events = loaded?.grid === grid ? loaded.items : null

  // Only the newest load shows
  const latest = useRef(0)
  const load = useCallback(async () => {
    const request = ++latest.current
    try {
      const found: CalendarEvent[] = []
      let cursor: [] | [bigint] = []
      // Every page, however many: the backend's caps bound them
      for (;;) {
        const page = await backend.mail_cal_list({
          from: seconds(grid.start),
          to: seconds(grid.end),
          cursor,
          limit: 200n,
        })
        found.push(...page.items)
        cursor = page.cursor
        if (cursor.length === 0) break
      }
      if (request !== latest.current) return
      setLoaded({ grid, items: found })
      setError('')
    } catch (e) {
      if (request === latest.current) setError(errorText(e))
    }
  }, [backend, grid])

  useEffect(() => {
    load()
  }, [load, changes])

  const byDay = useMemo(() => {
    const days = new Map<string, Occurrence[]>()
    for (const e of events ?? []) {
      for (const o of occurrences(e.vevent, grid.start, grid.end)) {
        for (const key of daysOf(o, grid)) {
          const list = days.get(key) ?? []
          list.push(o)
          days.set(key, list)
        }
      }
    }
    // All-day events first, then by time
    for (const list of days.values()) {
      list.sort(
        (a, b) =>
          Number(b.fields.allDay) - Number(a.fields.allDay) ||
          a.start.getTime() - b.start.getTime()
      )
    }
    return days
  }, [events, grid])

  const today = dayKey(new Date())
  const shift = (months: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + months, 1))
  const open = (o: Occurrence) =>
    setEditing({ fields: { ...o.fields }, isNew: false })
  const create = (date: string) =>
    setEditing({ fields: newFields(date), isNew: true })

  const chip = (o: Occurrence, key: string) => (
    <li key={key}>
      <button
        className={o.fields.allDay ? 'event all-day' : 'event'}
        onClick={() => open(o)}
      >
        {!o.fields.allDay && (
          <span className="event-time">{timeText(o.start)}</span>
        )}
        <span className="event-title">{o.fields.title || '(no title)'}</span>
      </button>
    </li>
  )

  const chips = (key: string) => (
    <ul>
      {(byDay.get(key) ?? []).map((o, i) => chip(o, `${o.fields.uid}/${i}`))}
    </ul>
  )
  const agendaDays = grid.days.filter(
    (d) => d.getMonth() === month.getMonth() && byDay.has(dayKey(d))
  )

  return (
    <section className="calendar" aria-label="Calendar">
      <div className="toolbar calendar-bar">
        <IconButton
          label="Previous month"
          icon="chevronLeft"
          onClick={() => shift(-1)}
        />
        <IconButton
          label="This month"
          icon="calendar"
          onClick={() => setMonth(thisMonth())}
        />
        <IconButton
          label="Next month"
          icon="chevronRight"
          onClick={() => shift(1)}
        />
        <h2 aria-live="polite">{monthTitle(month)}</h2>
        <IconButton
          variant="primary"
          label="New event"
          icon="plus"
          onClick={() =>
            create(
              month.getTime() === thisMonth().getTime() ? today : dayKey(month)
            )
          }
        />
        <IconButton
          label="Subscribe from a calendar app"
          icon="link"
          onClick={() => setSharing(true)}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="month" role="grid" aria-label={monthTitle(month)}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="weekday" role="columnheader">
            {w}
          </div>
        ))}
        {grid.days.map((d) => {
          const key = dayKey(d)
          const classes = ['day']
          if (d.getMonth() !== month.getMonth()) classes.push('other')
          if (key === today) classes.push('today')
          return (
            <div key={key} className={classes.join(' ')} role="gridcell">
              <button
                className="bare day-number"
                aria-label={`New event on ${dayTitle(d)}`}
                title="New event"
                onClick={() => create(key)}
              >
                {d.getDate()}
              </button>
              {chips(key)}
            </div>
          )
        })}
      </div>
      {/* At phone width, the month as a list of the days that have events */}
      <div className="agenda" aria-label="Events this month">
        {events !== null && agendaDays.length === 0 && (
          <p className="hint">No events this month.</p>
        )}
        {agendaDays.map((d) => (
          <div key={dayKey(d)} className="agenda-day">
            <h3>{dayTitle(d)}</h3>
            {chips(dayKey(d))}
          </div>
        ))}
      </div>
      {editing && (
        <EventDialog
          backend={backend}
          fields={editing.fields}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={() => {
            // A save that ends late closes only its own form
            const saved = editing
            setEditing((now) => (now === saved ? null : now))
            setChanges((n) => n + 1)
          }}
        />
      )}
      {sharing && (
        <SubscribeDialog
          backend={backend}
          address={address}
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  )
}

const REPEATS: [Repeat, string][] = [
  ['', 'Does not repeat'],
  ['DAILY', 'Every day'],
  ['WEEKLY', 'Every week'],
  ['MONTHLY', 'Every month'],
  ['YEARLY', 'Every year'],
]

let zoneNames: string[] | null = null
function zones(current: string): string[] {
  if (!zoneNames) {
    const listed = zoneList()
    zoneNames = Array.isArray(listed) ? listed : []
  }
  return zoneNames.includes(current) ? zoneNames : [current, ...zoneNames]
}

// A calendar dialog: its title, a Close, and Escape to close it
function Dialog({
  label,
  title,
  onClose,
  children,
}: {
  label: string
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="dialog event-dialog"
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="compose-bar">
        <h2>{title}</h2>
        <IconButton
          className="bare"
          label="Close"
          icon="close"
          onClick={onClose}
        />
      </div>
      {children}
    </div>
  )
}

function EventDialog({
  backend,
  fields: initial,
  isNew,
  onClose,
  onSaved,
}: {
  backend: Mailbox
  fields: EventFields
  isNew: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (change: Partial<EventFields>) =>
    setF((now) => ({ ...now, ...change }))

  // The zone list is long: built again only when the zone changes
  const zoneOptions = useMemo(
    () =>
      zones(f.tzid).map((z) => (
        <option key={z} value={z}>
          {z}
        </option>
      )),
    [f.tzid]
  )

  // Runs a change, then closes; a refusal shows and the form stays
  const run = (work: () => Promise<unknown>) => {
    setBusy(true)
    return attempt(
      async () => {
        await work()
        onSaved()
      },
      (text) => {
        setError(text)
        if (text) setBusy(false)
      }
    )
  }

  const save = () => {
    const why = invalidFields(f)
    if (why) {
      setError(why)
      return
    }
    run(() =>
      backend.mail_cal_put(
        buildEvent({ ...f, sequence: isNew ? 0 : f.sequence + 1 })
      )
    )
  }

  const label = isNew ? 'New event' : 'Event'
  return (
    <Dialog label={label} title={f.title.trim() || label} onClose={onClose}>
      <form
        className="compose-body"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label>
          Title
          <input
            aria-label="Title"
            value={f.title}
            autoFocus
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={f.allDay}
            onChange={(e) => set({ allDay: e.target.checked })}
          />
          All day
        </label>
        <label>
          Starts
          <span className="when">
            <input
              aria-label="Start date"
              type="date"
              value={f.startDate}
              onChange={(e) => {
                const startDate = e.target.value
                // The end moves with the start, keeping the length in days
                const days =
                  f.startDate && f.endDate
                    ? Math.round(
                        (Date.parse(f.endDate) - Date.parse(f.startDate)) /
                          86_400_000
                      )
                    : 0
                set({
                  startDate,
                  endDate: startDate ? addDays(startDate, days) : f.endDate,
                })
              }}
            />
            {!f.allDay && (
              <input
                aria-label="Start time"
                type="time"
                value={f.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
              />
            )}
          </span>
        </label>
        <label>
          Ends
          <span className="when">
            <input
              aria-label="End date"
              type="date"
              value={f.endDate}
              onChange={(e) => set({ endDate: e.target.value })}
            />
            {!f.allDay && (
              <input
                aria-label="End time"
                type="time"
                value={f.endTime}
                onChange={(e) => set({ endTime: e.target.value })}
              />
            )}
          </span>
        </label>
        {!f.allDay && (
          <label>
            Time zone
            <select
              aria-label="Time zone"
              value={f.tzid}
              onChange={(e) => set({ tzid: e.target.value })}
            >
              {zoneOptions}
            </select>
          </label>
        )}
        <label>
          Repeats
          <select
            aria-label="Repeats"
            value={f.repeat}
            onChange={(e) => set({ repeat: e.target.value as Repeat })}
          >
            {REPEATS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        {f.repeat && (
          <label>
            Until
            <input
              aria-label="Repeat until"
              type="date"
              value={f.until}
              onChange={(e) => set({ until: e.target.value })}
            />
          </label>
        )}
        <label>
          Where
          <input
            aria-label="Location"
            value={f.location}
            onChange={(e) => set({ location: e.target.value })}
          />
        </label>
        <label>
          Notes
          <textarea
            aria-label="Notes"
            value={f.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="toolbar">
          <IconButton
            type="submit"
            variant="primary"
            label="Save"
            icon="check"
            disabled={busy}
          />
          {!isNew && (
            <IconButton
              variant="danger"
              label={f.repeat ? 'Delete every time it repeats' : 'Delete'}
              icon="trash"
              disabled={busy}
              onClick={() => run(() => backend.mail_cal_delete(f.uid))}
            />
          )}
        </div>
        {f.repeat && !isNew && (
          <p className="hint">A change applies to every time it repeats.</p>
        )}
      </form>
    </Dialog>
  )
}

function SubscribeDialog({
  backend,
  address,
  onClose,
}: {
  backend: Mailbox
  address: string
  onClose: () => void
}) {
  // undefined while it loads, null while the calendar is not shared
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let current = true
    backend
      .mail_cal_feed()
      .then((found) => {
        if (current) setToken(found[0] ?? null)
      })
      .catch((e: unknown) => {
        if (current) setError(errorText(e))
      })
    return () => {
      current = false
    }
  }, [backend])

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true)
    setCopied(false)
    await attempt(async () => setToken(await work()), setError)
    setBusy(false)
  }

  const { backend: canister, network } = deployment()
  const url = token ? feedUrl(canister, network, token) : ''

  return (
    <Dialog
      label="Subscribe from a calendar app"
      title={`Subscribe to ${address}`}
      onClose={onClose}
    >
      <div className="compose-body">
        {token === null && (
          <>
            <p>
              This calendar is not shared. A secret address lets a calendar app
              subscribe to it.
            </p>
            <div className="toolbar">
              <IconButton
                variant="primary"
                label="Make a secret address"
                icon="link"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Share ${address}'s calendar? Anyone who has the secret address sees every event in it.`
                    )
                  )
                    act(() => backend.mail_cal_feed_reset())
                }}
              />
            </div>
          </>
        )}
        {token && (
          <>
            <p>
              Add this address to a calendar app as a calendar &ldquo;from
              URL&rdquo;, or open it in one.
            </p>
            <input
              aria-label="Secret address"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
            />
            <div className="toolbar">
              <IconButton
                label={copied ? 'Copied' : 'Copy the address'}
                icon={copied ? 'check' : 'copy'}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url)
                    setCopied(true)
                  } catch {
                    setError('Copy it from the box above.')
                  }
                }}
              />
              <IconButton
                label="Open in a calendar app"
                icon="calendar"
                onClick={() => {
                  window.location.href = url.replace(/^https?:/, 'webcal:')
                }}
              />
              <IconButton
                label="New secret address: the old one stops working"
                icon="refresh"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Make a new secret address? Calendar apps subscribed to the old one stop getting this calendar.'
                    )
                  )
                    act(() => backend.mail_cal_feed_reset())
                }}
              />
              <IconButton
                variant="danger"
                label="Stop sharing: the address stops working"
                icon="close"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Stop sharing this calendar? Calendar apps subscribed to it stop getting it.'
                    )
                  )
                    act(async () => {
                      await backend.mail_cal_feed_stop()
                      return null
                    })
                }}
              />
            </div>
            <p className="hint">
              Anyone who has this address sees every event in this calendar.
              Calendar apps fetch it on their own schedule, some only every few
              hours, so a change can take that long to show there.
            </p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
