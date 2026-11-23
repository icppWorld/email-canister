// Calendar events as standard iCalendar (RFC 5545) VEVENT blocks, which the
// backend stores as they are and serves in the calendar's feed. All the
// calendar logic lives here: building a block from the event form, reading
// one back, the span it covers, and its occurrences in a window.

import ICAL from 'ical.js'
import { tzlib_get_ical_block as icalBlock } from 'timezones-ical-library'

import type { EventRequest, ZoneBlock } from './api'

export type Repeat = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

// What the event form edits. Dates are YYYY-MM-DD and times HH:MM, in the
// event's time zone; an all-day event's end date is its last day.
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
  tzid: string
  repeat: Repeat
  until: string // the last day a repeat may fall on, or ''
  sequence: number // raised on each change, so subscribers take the new one
  created: string // as written first, or ''
}

export type Occurrence = {
  fields: EventFields
  start: Date
  end: Date
}

// The end of a repeat that never ends: the last second of the year 9999
const FOREVER = 253_402_300_799n

// An all-day event's day is midnight to midnight wherever it is seen: its
// span takes in the widest offsets, so a window's list finds it
const DAY_MARGIN = 14 * 3600

// The browser's own time zone, as an IANA name
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

// The VTIMEZONE block of an IANA zone, under that name: the library keeps
// one block for zones that are the same, such as Europe/Amsterdam and
// Europe/Brussels. Null for UTC and for a zone it does not know.
function zoneBlock(name: string): ZoneBlock | null {
  if (name === 'UTC' || name === 'Etc/UTC') return null
  try {
    const found = icalBlock(name)
    if (!Array.isArray(found) || !found[0]) return null
    const block = found[0]
      .replace(/\r?\n/g, '\r\n')
      .replace(/^TZID:.*$/m, `TZID:${name}`)
      .replace(/^X-LIC-LOCATION:.*$/m, `X-LIC-LOCATION:${name}`)
    return { tzid: name, block }
  } catch {
    return null
  }
}

// The zone, registered so that ical.js reads times in it, or UTC
function zoneOf(tzid: string): ICAL.Timezone {
  if (ICAL.TimezoneService.has(tzid)) return ICAL.TimezoneService.get(tzid)
  const found = zoneBlock(tzid)
  if (!found) return ICAL.Timezone.utcTimezone
  const component = new ICAL.Component(
    ICAL.parse(`BEGIN:VCALENDAR\r\n${found.block}\r\nEND:VCALENDAR`)
  ).getFirstSubcomponent('vtimezone')
  if (!component) return ICAL.Timezone.utcTimezone
  const zone = new ICAL.Timezone(component)
  ICAL.TimezoneService.register(zone, tzid)
  return zone
}

const pad = (n: number) => String(n).padStart(2, '0')

// A local day as YYYY-MM-DD, as the form and the grid name days
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function dateParts(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

function timeParts(time: string) {
  const [hour, minute] = time.split(':').map(Number)
  return { hour, minute, second: 0 }
}

function dateOf(t: ICAL.Time): string {
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`
}

function timeOf(t: ICAL.Time): string {
  return `${pad(t.hour)}:${pad(t.minute)}`
}

// A day later or earlier, as YYYY-MM-DD
export function addDays(date: string, days: number): string {
  const t = ICAL.Time.fromData({ ...dateParts(date), isDate: true })
  t.adjust(days, 0, 0, 0)
  return dateOf(t)
}

function startOf(f: EventFields, zone: ICAL.Timezone): ICAL.Time {
  return f.allDay
    ? ICAL.Time.fromData({ ...dateParts(f.startDate), isDate: true })
    : ICAL.Time.fromData(
        { ...dateParts(f.startDate), ...timeParts(f.startTime) },
        zone
      )
}

function endOf(f: EventFields, zone: ICAL.Timezone): ICAL.Time {
  return f.allDay
    ? ICAL.Time.fromData({
        ...dateParts(addDays(f.endDate, 1)), // DTEND is the day after
        isDate: true,
      })
    : ICAL.Time.fromData(
        { ...dateParts(f.endDate), ...timeParts(f.endTime) },
        zone
      )
}

// Why the form cannot be saved, or ''
export function invalidFields(f: EventFields): string {
  if (!f.title.trim()) return 'Give the event a title.'
  if (!f.startDate || !f.endDate) return 'Give the event a date.'
  if (!f.allDay && (!f.startTime || !f.endTime)) return 'Give the event a time.'
  const zone = zoneOf(f.tzid)
  if (endOf(f, zone).compare(startOf(f, zone)) < 0)
    return 'The event must end after it starts.'
  if (f.repeat && f.until && f.until < f.startDate)
    return 'The repeat must end after the event starts.'
  return ''
}

function utcStamp(): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(), true)
}

// The block the backend stores, and the span it covers in UTC seconds
export function buildEvent(f: EventFields): EventRequest {
  const zoneData = f.allDay ? null : zoneBlock(f.tzid)
  const zone = zoneData ? zoneOf(zoneData.tzid) : ICAL.Timezone.utcTimezone
  const start = startOf(f, zone)
  const end = endOf(f, zone)

  const event = new ICAL.Component('vevent')
  event.addPropertyWithValue('uid', f.uid)
  event.addPropertyWithValue('dtstamp', utcStamp())
  event.addPropertyWithValue(
    'created',
    f.created ? ICAL.Time.fromDateTimeString(f.created) : utcStamp()
  )
  event.addPropertyWithValue('last-modified', utcStamp())
  event.addPropertyWithValue('sequence', f.sequence)
  const dtstart = event.addPropertyWithValue('dtstart', start)
  const dtend = event.addPropertyWithValue('dtend', end)
  if (zoneData) {
    dtstart.setParameter('tzid', zoneData.tzid)
    dtend.setParameter('tzid', zoneData.tzid)
  }
  event.addPropertyWithValue('summary', f.title.trim())
  if (f.location.trim())
    event.addPropertyWithValue('location', f.location.trim())
  if (f.notes.trim()) event.addPropertyWithValue('description', f.notes.trim())

  let ends: bigint
  if (f.repeat) {
    const rule: Record<string, unknown> = { freq: f.repeat }
    if (f.until) {
      // Through the whole last day, in the event's own zone
      rule.until = f.allDay
        ? ICAL.Time.fromData({ ...dateParts(f.until), isDate: true })
        : ICAL.Time.fromData(
            { ...dateParts(f.until), hour: 23, minute: 59, second: 59 },
            zone
          ).convertToZone(ICAL.Timezone.utcTimezone)
    }
    event.addPropertyWithValue('rrule', ICAL.Recur.fromData(rule))
    // The last occurrence starts on the until day at the latest
    const afterLast = startOf(
      { ...f, startDate: addDays(f.until, 1), startTime: '00:00' },
      zone
    )
    ends = f.until
      ? BigInt(
          afterLast.toUnixTime() +
            (end.toUnixTime() - start.toUnixTime()) +
            DAY_MARGIN
        )
      : FOREVER
  } else {
    ends = BigInt(end.toUnixTime() + (f.allDay ? DAY_MARGIN : 0))
  }
  const starts = BigInt(
    Math.max(0, start.toUnixTime() - (f.allDay ? DAY_MARGIN : 0))
  )
  return {
    uid: f.uid,
    vevent: event.toString(),
    starts,
    ends,
    vtimezones: zoneData ? [zoneData] : [],
  }
}

function parseEvent(vevent: string): ICAL.Event | null {
  try {
    // Its zone first, so that its times read in it
    const tzid = /;TZID=([^:;]+)[:;]/.exec(vevent)?.[1]
    if (tzid) zoneOf(tzid)
    const calendar = new ICAL.Component(
      ICAL.parse(`BEGIN:VCALENDAR\r\n${vevent}\r\nEND:VCALENDAR`)
    )
    const component = calendar.getFirstSubcomponent('vevent')
    return component ? new ICAL.Event(component) : null
  } catch {
    return null
  }
}

// The form's fields of a parsed event
function fieldsOf(event: ICAL.Event): EventFields {
  const start = event.startDate
  const end = event.endDate ?? start
  const allDay = start.isDate
  const component = event.component
  const rule = component.getFirstPropertyValue('rrule') as ICAL.Recur | null
  const repeat = (rule?.freq ?? '') as Repeat
  let until = ''
  if (rule?.until) {
    const last = rule.until.clone()
    if (!last.isDate && start.zone) {
      until = dateOf(last.convertToZone(start.zone))
    } else {
      until = dateOf(last)
    }
  }
  const created = component.getFirstPropertyValue('created') as ICAL.Time | null
  const lastDay = allDay ? end.clone() : end
  if (allDay) lastDay.adjust(-1, 0, 0, 0)
  return {
    uid: event.uid,
    title: event.summary ?? '',
    location: event.location ?? '',
    notes: event.description ?? '',
    allDay,
    startDate: dateOf(start),
    startTime: allDay ? '' : timeOf(start),
    endDate: dateOf(lastDay),
    endTime: allDay ? '' : timeOf(end),
    tzid:
      start.zone?.tzid && start.zone.tzid !== 'floating'
        ? start.zone.tzid
        : localZone(),
    repeat: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(repeat)
      ? repeat
      : '',
    until,
    sequence: event.sequence ?? 0,
    created: created ? created.toString() : '',
  }
}

// A local Date at the time, or at local midnight of an all-day date
function shownDate(t: ICAL.Time): Date {
  return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate()
}

// The event's occurrences that overlap [from, to), at most `max` of them
export function occurrences(
  vevent: string,
  from: Date,
  to: Date,
  max = 500
): Occurrence[] {
  const event = parseEvent(vevent)
  if (!event?.startDate) return []
  const fields = fieldsOf(event)
  const found: Occurrence[] = []
  const add = (start: Date, end: Date) => {
    // An event with no length still shows on its day
    const last = end > start ? end : new Date(start.getTime() + 1)
    if (start < to && last > from) found.push({ fields, start, end })
  }
  if (!event.isRecurring()) {
    add(shownDate(event.startDate), shownDate(event.endDate ?? event.startDate))
    return found
  }
  // Occurrences that end before the window are passed over cheaply, by
  // their start and the event's length, so an old repeat costs little
  const length =
    (event.endDate ?? event.startDate).toUnixTime() -
    event.startDate.toUnixTime()
  const fromSeconds = from.getTime() / 1000 - 14 * 3600
  const iterator = event.iterator()
  for (let i = 0; i < 100_000 && found.length < max; ++i) {
    const next = iterator.next()
    if (!next) break
    if (next.toUnixTime() + length < fromSeconds) continue
    const details = event.getOccurrenceDetails(next)
    const start = shownDate(details.startDate)
    if (start >= to) break
    add(start, shownDate(details.endDate))
  }
  return found
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
