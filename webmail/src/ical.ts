// Calendar events as standard iCalendar (RFC 5545) VEVENT blocks, which the
// backend stores as they are and serves in the calendar's feed. All the
// calendar logic lives here: building a block from the event form, reading
// one back, the span it covers, and its occurrences in a window.

import ICAL from 'ical.js'
import { tzlib_get_ical_block as icalBlock } from 'timezones-ical-library'

import type { EventRequest, ZoneBlock } from './api'

export type Repeat = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
const REPEATS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

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
  // The stored repeat's parts the form does not show, such as an interval
  // or a count, kept while the repeat stays the same
  kept: { freq: string; parts: Record<string, unknown> } | null
  // The stored block, whose other properties and alarms a save keeps, or ''
  source: string
  // Written by another app in a way the form cannot show, such as extra
  // dates or an hourly repeat: it can be deleted here, not changed
  readOnly: boolean
}

// The properties the form writes; a save keeps every other one
const OWNED = [
  'uid',
  'dtstamp',
  'created',
  'last-modified',
  'sequence',
  'dtstart',
  'dtend',
  'duration',
  'summary',
  'location',
  'description',
  'rrule',
]

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
  if (f.endDate < f.startDate) return 'The event must end after it starts.'
  const zone = zoneOf(f.tzid)
  // A timed event ends after it starts (RFC 5545 3.6.1); an all-day one
  // ends the day after its last
  if (endOf(f, zone).compare(startOf(f, zone)) <= 0)
    return 'The event must end after it starts.'
  if (startOf(f, zone).toUnixTime() < 0)
    return 'The calendar holds events from 1970 on.'
  if (f.repeat && f.until && f.until < f.startDate)
    return 'The repeat must end after the event starts.'
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

function utcStamp(): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(), true)
}

// The block the backend stores, and the span it covers in UTC seconds
export function buildEvent(f: EventFields): EventRequest {
  const zoneData = f.allDay ? null : zoneBlock(f.tzid)
  const zone = zoneData ? zoneOf(zoneData.tzid) : ICAL.Timezone.utcTimezone
  const start = startOf(f, zone)
  const end = endOf(f, zone)

  const event =
    (f.source && parseEvent(f.source)?.component) ||
    new ICAL.Component('vevent')
  for (const name of OWNED) event.removeAllProperties(name)
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
  event.addPropertyWithValue('summary', oneLine(f.title))
  if (oneLine(f.location))
    event.addPropertyWithValue('location', oneLine(f.location))
  if (multiLine(f.notes))
    event.addPropertyWithValue('description', multiLine(f.notes))

  let ends: bigint
  if (f.repeat) {
    const rule: Record<string, unknown> = {
      ...(f.kept?.freq === f.repeat ? f.kept.parts : {}),
      freq: f.repeat,
    }
    if (f.until) {
      delete rule.count // a repeat ends by a date or a count, not both
      // Through the whole last day, in the event's own zone
      rule.until = f.allDay
        ? ICAL.Time.fromData({ ...dateParts(f.until), isDate: true })
        : ICAL.Time.fromData(
            { ...dateParts(f.until), hour: 23, minute: 59, second: 59 },
            zone
          ).convertToZone(ICAL.Timezone.utcTimezone)
    }
    const recur = ICAL.Recur.fromData(rule)
    event.addPropertyWithValue('rrule', recur)
    // The last occurrence starts on the until day at the latest, or is the
    // count's last
    const last = recur.count ? lastStart(event, recur.count) : null
    ends = last
      ? BigInt(
          last.toUnixTime() +
            (end.toUnixTime() - start.toUnixTime()) +
            DAY_MARGIN
        )
      : f.until
        ? BigInt(
            startOf(
              { ...f, startDate: addDays(f.until, 1), startTime: '00:00' },
              zone
            ).toUnixTime() +
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
    // Every zone the event names, kept properties such as a skipped date's
    // included, so that the feed defines each one
    vtimezones: [...zonesNamed(event)]
      .map(zoneBlock)
      .filter((z): z is ZoneBlock => z !== null),
  }
}

// The zones an event's properties name, read as a parser reads them: in any
// case, and across a folded line
function zonesNamed(component: ICAL.Component): Set<string> {
  const found = new Set<string>()
  for (const property of component.getAllProperties()) {
    const tzid = property.getParameter('tzid')
    if (typeof tzid === 'string') found.add(tzid)
  }
  for (const sub of component.getAllSubcomponents())
    for (const tzid of zonesNamed(sub)) found.add(tzid)
  return found
}

function parseEvent(vevent: string): ICAL.Event | null {
  try {
    const calendar = new ICAL.Component(
      ICAL.parse(`BEGIN:VCALENDAR\r\n${vevent}\r\nEND:VCALENDAR`)
    )
    const component = calendar.getFirstSubcomponent('vevent')
    if (!component) return null
    // Its zones before its times are read, so that they read in them
    for (const tzid of zonesNamed(component)) zoneOf(tzid)
    return new ICAL.Event(component)
  } catch {
    return null
  }
}

// The most steps a repeat may take, and the longest gap between two of its
// times: ical.js steps through each day of a gap
const MAX_STEPS = 1000
const MAX_INTERVAL = 1000

// A rule ical.js expands safely, and soon: with BY parts, such as a weekday a
// daily repeat never reaches, its iterator can search for ever, an hourly one
// would take too many steps to reach the window, and a long gap takes as
// many steps as its days
function boundedRule(rule: ICAL.Recur): boolean {
  return (
    REPEATS.includes(rule.freq) &&
    Object.keys(rule.parts).length === 0 &&
    (rule.interval ?? 1) <= MAX_INTERVAL
  )
}

// The start of a counted repeat's last occurrence by its rule alone, or null
// for a count too long to step through, which then counts as no end. Skipped
// dates only take times away, so the rule's last bounds the event's; and many
// in a row would stop the event's own iterator
function lastStart(event: ICAL.Component, count: number): ICAL.Time | null {
  const rule = event.getFirstPropertyValue('rrule') as ICAL.Recur | null
  const start = event.getFirstPropertyValue('dtstart') as ICAL.Time | null
  if (!rule || !start || !boundedRule(rule) || count > MAX_STEPS) return null
  const iterator = rule.iterator(start)
  let last: ICAL.Time | null = null
  for (let i = 0; i < count; ++i) {
    const next = iterator.next()
    if (!next) break
    last = next
  }
  return last
}

// The form's fields of a parsed event
function fieldsOf(event: ICAL.Event): EventFields {
  const start = event.startDate
  const allDay = start.isDate
  // An end written in another zone is shown in the start's
  let end = event.endDate ?? start
  if (!allDay && start.zone && end.zone && end.zone.tzid !== start.zone.tzid)
    end = end.convertToZone(start.zone)
  const component = event.component
  const rule = component.getFirstPropertyValue('rrule') as ICAL.Recur | null
  // Zones named anywhere but on the start, such as an end or a skipped date
  // in another zone
  const startZone = component.getFirstProperty('dtstart')?.getParameter('tzid')
  const zones = [...zonesNamed(component)]
  const lastUntil = rule?.until?.clone()
  const untilAt =
    lastUntil && !lastUntil.isDate && start.zone
      ? lastUntil.convertToZone(start.zone)
      : lastUntil
  // A cutoff the form shows: a date, or the end of a day in the start's zone
  const untilShown =
    !untilAt ||
    (allDay
      ? untilAt.isDate
      : !untilAt.isDate &&
        untilAt.hour === 23 &&
        untilAt.minute === 59 &&
        untilAt.second === 59)
  const readOnly =
    component.hasProperty('rdate') ||
    component.getAllProperties('rrule').length > 1 ||
    (rule !== null && !boundedRule(rule)) ||
    !untilShown ||
    start.second !== 0 ||
    // A repeat whose length is days, which a calendar keeps in local time
    // across a clock change, while the form writes an end in hours
    (rule !== null && !allDay && nominalDuration(component)) ||
    // A floating time, read in each viewer's own zone, which the form would
    // replace with a named one
    (!allDay && (!start.zone || start.zone.tzid === 'floating')) ||
    (!allDay && (event.endDate ?? start).second !== 0) ||
    zones.some((z) => z !== startZone)
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
  let kept: EventFields['kept'] = null
  if (rule) {
    const {
      freq,
      until: _until,
      ...parts
    } = rule.toJSON() as Record<string, unknown>
    kept = { freq: String(freq), parts }
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
    repeat: REPEATS.includes(repeat) ? repeat : '',
    until,
    sequence: event.sequence ?? 0,
    created: created ? created.toString() : '',
    kept,
    source: event.component.toString(),
    readOnly,
  }
}

// A DURATION in days or weeks, rather than hours or less
function nominalDuration(component: ICAL.Component): boolean {
  const duration = component.getFirstPropertyValue(
    'duration'
  ) as ICAL.Duration | null
  return duration !== null && (duration.days > 0 || duration.weeks > 0)
}

// A repeat the month view expands; any other shows once, at its start
function safeRepeat(event: ICAL.Event): boolean {
  // Extra dates may be periods, which the loop does not read
  if (event.component.hasProperty('rdate')) return false
  return event.component
    .getAllProperties('rrule')
    .every((p) => boundedRule(p.getFirstValue() as ICAL.Recur))
}

// A local Date at the time, or at local midnight of an all-day date
function shownDate(t: ICAL.Time): Date {
  return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate()
}

// The event's occurrences that overlap [from, to), at most `max` of them; none
// for an event that cannot be read, so that it alone is left out
export function occurrences(
  vevent: string,
  from: Date,
  to: Date,
  max = 500
): Occurrence[] {
  try {
    return occurrencesOf(vevent, from, to, max)
  } catch {
    return []
  }
}

function occurrencesOf(
  vevent: string,
  from: Date,
  to: Date,
  max: number
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
  // A repeat that is not safe shows once, at its start
  if (!event.isRecurring() || !safeRepeat(event)) {
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

// The address to hand a calendar app: webcals keeps TLS on the token, where
// many apps fetch a plain webcal address over http; the local network has no
// TLS to keep
export function subscribeUrl(url: string): string {
  return url.replace(/^https:/, 'webcals:').replace(/^http:/, 'webcal:')
}

// The address of a calendar's feed on the backend canister
export function feedUrl(backend: string, network: string, token: string) {
  if (network === 'ic') return `https://${backend}.icp0.io/cal/${token}.ics`
  const { protocol, port } = window.location
  return `${protocol}//${backend}.localhost${port ? `:${port}` : ''}/cal/${token}.ics`
}
