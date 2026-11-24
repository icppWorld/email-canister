// Calendar events as standard iCalendar (RFC 5545) VEVENT blocks, which the
// backend stores as they are and serves in the calendar's feed. The form
// writes one-off events only: a timed one in UTC, which every calendar app
// shows in its own time zone, or an all-day one as dates. An event another
// app wrote with more than that, such as a repeat, a time zone or an alarm,
// shows once, at its start, and can be deleted but not changed.

import ICAL from 'ical.js'

import type { EventRequest } from './api'

// What the event form edits. Dates are YYYY-MM-DD and times HH:MM, in the
// browser's time zone; an all-day event's end date is its last day.
export type EventFields = {
  uid: string
  title: string
  location: string
  notes: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  sequence: number // raised on each change, so subscribers take the new one
  created: string // as written first, or ''
  // Written by another app with more than the form shows: it can be deleted
  // here, not changed
  readOnly: boolean
}

// The properties the form writes. An event with any other, or with a
// component inside it such as an alarm, is read-only.
const WRITTEN = new Set([
  'uid',
  'dtstamp',
  'created',
  'last-modified',
  'sequence',
  'dtstart',
  'dtend',
  'summary',
  'location',
  'description',
])

export type Occurrence = {
  fields: EventFields
  start: Date
  end: Date
}

// An all-day event's day is midnight to midnight wherever it is seen: its
// span takes in the widest offsets, so a window's list finds it
const DAY_MARGIN = 14 * 3600

const pad = (n: number) => String(n).padStart(2, '0')

// A local day as YYYY-MM-DD, as the form and the grid name days
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const timeKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

// A local Date at a form's date, and time if given. The year is set on its
// own: the Date constructor reads 0 to 99 as 1900 to 1999.
function localDate(date: string, time = '00:00'): Date {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const d = new Date(2000, 0, 1, hour, minute)
  d.setFullYear(year, month - 1, day)
  return d
}

// A day later or earlier, as YYYY-MM-DD
export function addDays(date: string, days: number): string {
  const d = localDate(date)
  d.setDate(d.getDate() + days)
  return dayKey(d)
}

// The event's start and end: local times, or midnights of an all-day
// event's first day and of the day after its last
function spanOf(f: EventFields): { start: Date; end: Date } {
  return f.allDay
    ? { start: localDate(f.startDate), end: localDate(addDays(f.endDate, 1)) }
    : {
        start: localDate(f.startDate, f.startTime),
        end: localDate(f.endDate, f.endTime),
      }
}

// Why the form cannot be saved, or ''
export function invalidFields(f: EventFields): string {
  if (!f.title.trim()) return 'Give the event a title.'
  if (!f.startDate || !f.endDate) return 'Give the event a date.'
  if (!f.allDay && (!f.startTime || !f.endTime)) return 'Give the event a time.'
  const { start, end } = spanOf(f)
  // A timed event ends after it starts (RFC 5545 3.6.1); an all-day one
  // ends the day after its last
  if (end <= start) return 'The event must end after it starts.'
  // By the date for an all-day event, whose midnight may fall before 1970 in
  // UTC; the backend counts its span from 1970
  if (f.allDay ? f.startDate < '1970-01-01' : start.getTime() < 0)
    return 'The calendar holds events from 1970 on.'
  return ''
}

// Text as the backend takes it: no control characters but line breaks, which
// iCalendar escapes, in notes; none at all in a one-line field
// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROLS = /[\u0000-\u001f\u007f]+/g
// eslint-disable-next-line no-control-regex -- the same, but a line break
const CONTROLS_BUT_LF = /[\u0000-\u0009\u000b-\u001f\u007f]+/g
const oneLine = (s: string) => s.replace(CONTROLS, ' ').trim()
const multiLine = (s: string) =>
  s.replace(/\r\n?/g, '\n').replace(CONTROLS_BUT_LF, ' ').trim()

const utc = (d: Date) => ICAL.Time.fromJSDate(d, true)
const date = (d: Date) =>
  ICAL.Time.fromData({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    isDate: true,
  })

// The block the backend stores, and the span it covers in UTC seconds
export function buildEvent(f: EventFields): EventRequest {
  const { start, end } = spanOf(f)
  const now = new Date()
  const event = new ICAL.Component('vevent')
  event.addPropertyWithValue('uid', f.uid)
  event.addPropertyWithValue('dtstamp', utc(now))
  event.addPropertyWithValue(
    'created',
    f.created ? ICAL.Time.fromDateTimeString(f.created) : utc(now)
  )
  event.addPropertyWithValue('last-modified', utc(now))
  event.addPropertyWithValue('sequence', f.sequence)
  event.addPropertyWithValue('dtstart', f.allDay ? date(start) : utc(start))
  event.addPropertyWithValue('dtend', f.allDay ? date(end) : utc(end))
  event.addPropertyWithValue('summary', oneLine(f.title))
  if (oneLine(f.location))
    event.addPropertyWithValue('location', oneLine(f.location))
  if (multiLine(f.notes))
    event.addPropertyWithValue('description', multiLine(f.notes))
  const margin = f.allDay ? DAY_MARGIN : 0
  return {
    uid: f.uid,
    vevent: event.toString(),
    starts: BigInt(Math.max(0, Math.floor(start.getTime() / 1000) - margin)),
    ends: BigInt(Math.floor(end.getTime() / 1000) + margin),
    vtimezones: [],
  }
}

// Only what the form writes, as it writes it: each property once and without
// parameters, a start and an end both in UTC or both dates, and a created
// time in UTC
function editable(event: ICAL.Event): boolean {
  const component = event.component
  if (component.getAllSubcomponents().length > 0) return false
  const seen = new Set<string>()
  for (const p of component.getAllProperties()) {
    if (!WRITTEN.has(p.name) || seen.has(p.name)) return false
    seen.add(p.name)
    // A date's VALUE=DATE is the only parameter the form writes
    const parameters = Object.keys(p.toJSON()[1] as object)
    if (parameters.some((name) => name !== 'value')) return false
  }
  if (!seen.has('dtend')) return false
  const created = component.getFirstPropertyValue('created') as ICAL.Time | null
  if (created && (created.isDate || created.zone?.tzid !== 'UTC')) return false
  return [event.startDate, event.endDate].every(
    (t) =>
      (t.isDate || (t.zone?.tzid === 'UTC' && t.second === 0)) &&
      t.isDate === event.startDate.isDate
  )
}

// A local Date at the time, or at local midnight of an all-day date. A time
// in a zone the event defines nowhere here reads as the browser's own.
function shownDate(t: ICAL.Time): Date {
  return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate()
}

// The event as it shows, once, if it overlaps [from, to); null when it does
// not, or cannot be read, so that it alone is left out
export function occurrence(
  vevent: string,
  from: Date,
  to: Date
): Occurrence | null {
  try {
    const component = new ICAL.Component(
      ICAL.parse(`BEGIN:VCALENDAR\r\n${vevent}\r\nEND:VCALENDAR`)
    ).getFirstSubcomponent('vevent')
    if (!component) return null
    const event = new ICAL.Event(component)
    if (!event.startDate) return null
    const start = shownDate(event.startDate)
    const end = shownDate(event.endDate ?? event.startDate)
    // An event with no length still shows on its day
    const last = end > start ? end : new Date(start.getTime() + 1)
    if (start >= to || last <= from) return null
    // The form's end date is an all-day event's last day
    const lastDay = event.startDate.isDate
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
      : end
    const created = event.component.getFirstPropertyValue(
      'created'
    ) as ICAL.Time | null
    const allDay = event.startDate.isDate
    return {
      start,
      end,
      fields: {
        uid: event.uid,
        title: event.summary ?? '',
        location: event.location ?? '',
        notes: event.description ?? '',
        allDay,
        startDate: dayKey(start),
        startTime: allDay ? '' : timeKey(start),
        endDate: dayKey(lastDay > start ? lastDay : start),
        endTime: allDay ? '' : timeKey(end),
        sequence: event.sequence ?? 0,
        created: created ? created.toString() : '',
        readOnly: !editable(event),
      },
    }
  } catch {
    return null
  }
}

// A new event's uid: letters, digits and - only, as the backend takes them
export function newUid(): string {
  return crypto.randomUUID()
}

// The address of a calendar's feed on the backend canister
export function feedUrl(backend: string, network: string, token: string) {
  if (network === 'ic') return `https://${backend}.icp0.io/cal/${token}.ics`
  const { protocol, port } = window.location
  return `${protocol}//${backend}.localhost${port ? `:${port}` : ''}/cal/${token}.ics`
}
