// The webmail tests of the calendar: events added, changed and deleted, a
// repeat, an all-day event, the phone width's list, and the secret address
// that calendar apps subscribe to, fetched through the local HTTP gateway.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, type Page, test } from '@playwright/test'
import ICAL from 'ical.js'

import { env } from './local'
import { answer, asAlice, freshBackend, signedIn, USER_A } from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

// Each test starts on an empty calendar and makes the events it needs, so
// that it also passes when run on its own
test.beforeEach(async () => {
  const alice = await asAlice()
  const all = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 500n,
  })
  for (const e of all.items) await alice.mail_cal_delete('alice', e.uid)
})

const pad = (n: number) => String(n).padStart(2, '0')
const now = new Date()
// The 3rd of this month, so a weekly repeat shows four times in it
const third = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-03`

async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible()
}

const month = (page: Page) => page.locator('.month')
const dialog = (page: Page) => page.locator('.event-dialog')

async function addEvent(
  page: Page,
  title: string,
  fill: (page: Page) => Promise<void> = async () => {}
): Promise<void> {
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await dialog(page).getByLabel('Title').fill(title)
  await fill(page)
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toBeHidden()
}

// The feed, fetched across origins from a blank page, which has no policy of
// its own: the feed's CORS header lets any page read it
async function fetchFeed(page: Page, url: string) {
  const blank = await page.context().newPage()
  const result = await blank.evaluate(async (address) => {
    try {
      const response = await fetch(address)
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: await response.text(),
      }
    } catch {
      // A refusal without CORS headers reads as a network error
      return { status: 0, type: null, body: '' }
    }
  }, url)
  await blank.close()
  return result
}

test('events are added, shown, changed and deleted', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)

  await addEvent(page, 'Tee time', async (p) => {
    await dialog(p).getByLabel('Start date').fill(third)
    await dialog(p).getByLabel('Start time').fill('09:30')
    await dialog(p).getByLabel('End time').fill('11:00')
    await dialog(p).getByLabel('Location').fill('The club')
    // A soft line break pasted from a word processor is a control character
    await dialog(p).getByLabel('Notes').fill('Bring\u000bclubs')
  })
  const tee = month(page).getByRole('button', { name: /Tee time/ })
  await expect(tee).toHaveCount(1)
  await expect(tee).toContainText('09:30')

  const alice = await asAlice()
  const stored = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 10n,
  })
  expect(stored.items).toHaveLength(1)
  expect(stored.items[0].vevent).toContain('SUMMARY:Tee time')
  expect(stored.items[0].vevent).toContain('LOCATION:The club')
  expect(stored.items[0].vevent).toContain('DESCRIPTION:Bring clubs')

  // Changed: the same event, with a new title and a higher sequence
  await tee.click()
  await expect(dialog(page).getByLabel('Location')).toHaveValue('The club')
  await dialog(page).getByLabel('Title').fill('Tee time moved')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(
    month(page).getByRole('button', { name: /Tee time moved/ })
  ).toHaveCount(1)
  const changed = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 10n,
  })
  expect(changed.items).toHaveLength(1)
  expect(changed.items[0].uid).toBe(stored.items[0].uid)
  expect(changed.items[0].vevent).toContain('SEQUENCE:1')

  await month(page)
    .getByRole('button', { name: /Tee time moved/ })
    .click()
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(
    month(page).getByRole('button', { name: /Tee time/ })
  ).toHaveCount(0)
  await context.close()
})

// A weekly repeat from the 3rd in a named zone, and an all-day event on the
// 3rd and 4th, added through the form
async function addSamples(page: Page): Promise<void> {
  await addEvent(page, 'Weekly round', async (p) => {
    await dialog(p).getByLabel('Start date').fill(third)
    // A named zone, so the feed carries its VTIMEZONE whatever the browser's
    await dialog(p).getByLabel('Time zone').selectOption('Europe/Amsterdam')
    await dialog(p).getByLabel('Repeats').selectOption('WEEKLY')
  })
  await addEvent(page, 'Club holiday', async (p) => {
    await dialog(p).getByLabel('Start date').fill(third)
    await dialog(p).getByLabel('All day').check()
    await dialog(p).getByLabel('End date').fill(third.replace(/03$/, '04'))
  })
}

test('a repeat and an all-day event show on their days', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await addSamples(page)
  // The 3rd, 10th, 17th and 24th at least, and more in the grid's other days
  // The month loads again after the form closes
  await expect
    .poll(() =>
      month(page)
        .getByRole('button', { name: /Weekly round/ })
        .count()
    )
    .toBeGreaterThanOrEqual(4)
  const holiday = month(page).locator('.event.all-day', {
    hasText: 'Club holiday',
  })
  await expect(holiday).toHaveCount(2)

  // At phone width, the month is a list of its days
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(month(page)).toBeHidden()
  const agenda = page.getByLabel('Events this month')
  await expect(
    agenda.getByRole('button', { name: /Club holiday/ })
  ).toHaveCount(2)
  await expect
    .poll(() => agenda.getByRole('button', { name: /Weekly round/ }).count())
    .toBeGreaterThanOrEqual(4)
  await context.close()
})

test('a calendar app subscribes at the secret address', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  // Sharing is asked first, once declined; then each change is confirmed
  const asked = answer(page, false, true, true, true)
  await openCalendar(page)
  await addSamples(page)
  await page
    .getByRole('button', { name: 'Subscribe from a calendar app' })
    .click()
  const make = page.getByRole('button', { name: 'Make a secret address' })
  await make.click()
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toContain('Anyone who has the secret address')
  await expect(make).toBeVisible()
  const alice = await asAlice()
  expect(await alice.mail_cal_feed('alice')).toEqual([])
  await make.click()
  const address = page.getByLabel('Secret address', { exact: true })
  await expect(address).toHaveValue(/\/cal\/[0-9a-f]{32}\.ics$/)
  const url = await address.inputValue()
  const { port } = new URL(env.url)
  expect(url.startsWith(`http://${env.backend}.localhost:${port}/cal/`)).toBe(
    true
  )

  // Through the gateway, as a calendar app reads it
  const feed = await fetchFeed(page, url)
  expect(feed.status).toBe(200)
  expect(feed.type).toBe('text/calendar; charset=utf-8')
  const calendar = new ICAL.Component(ICAL.parse(feed.body))
  expect(calendar.getFirstPropertyValue('x-wr-calname')).toBe(
    'alice@mail.example'
  )
  const titles = calendar
    .getAllSubcomponents('vevent')
    .map((e) => new ICAL.Event(e).summary)
    .sort()
  expect(titles).toEqual(['Club holiday', 'Weekly round'])
  const round = calendar
    .getAllSubcomponents('vevent')
    .find((e) => new ICAL.Event(e).summary === 'Weekly round')
  expect(String(round?.getFirstPropertyValue('rrule'))).toBe('FREQ=WEEKLY')
  expect(
    calendar
      .getAllSubcomponents('vtimezone')
      .map((z) => z.getFirstPropertyValue('tzid'))
  ).toEqual(['Europe/Amsterdam'])

  // A new address: the old one stops working
  await page
    .getByRole('button', {
      name: 'New secret address: the old one stops working',
    })
    .click()
  await expect(address).not.toHaveValue(url)
  expect((await fetchFeed(page, url)).status).not.toBe(200)
  const renewed = await address.inputValue()
  expect((await fetchFeed(page, renewed)).status).toBe(200)

  await page
    .getByRole('button', { name: 'Stop sharing: the address stops working' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Make a secret address' })
  ).toBeVisible()
  expect((await fetchFeed(page, renewed)).status).not.toBe(200)
  expect(asked).toHaveLength(4)
  await context.close()
})

test('a calendar that cannot load leaves the webmail working', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  // As when a new release has replaced the old build's files
  await page.route(/\/Calendar-[^/]*\.js$/, (route) => route.abort())
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'The calendar could not load. Reload the webmail to try again.'
  )
  await expect(
    page.getByRole('button', { name: 'Reload the webmail' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Inbox', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible()
  await context.close()
})

// A date of this month, or of one some months on, as iCalendar writes it
function ymd(months: number, day: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() + months, day)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// Stores an event as another calendar app would have written it
async function putRaw(uid: string, lines: string[], from: Date, to: Date) {
  const alice = await asAlice()
  await alice.mail_cal_put('alice', {
    uid,
    vevent: ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'].join('\r\n'),
    starts: BigInt(Math.floor(from.getTime() / 1000) - 14 * 3600),
    ends: BigInt(Math.floor(to.getTime() / 1000) + 14 * 3600),
    vtimezones: [],
  })
}

test('an edit keeps the repeat parts the form does not show', async ({
  browser,
}) => {
  await putRaw(
    'fortnightly',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 3)}T090000Z`,
      `DTEND:${ymd(0, 3)}T100000Z`,
      'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
      'SUMMARY:Fortnightly',
    ],
    new Date(now.getFullYear(), now.getMonth(), 2),
    new Date(now.getFullYear(), now.getMonth() + 2, 1)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await month(page)
    .getByRole('button', { name: /Fortnightly/ })
    .first()
    .click()
  await dialog(page).getByLabel('Title').fill('Fortnightly renamed')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toBeHidden()
  const alice = await asAlice()
  const page1 = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 100n,
  })
  const saved = page1.items.find((e) => e.uid === 'fortnightly')
  expect(saved?.vevent).toContain('SUMMARY:Fortnightly renamed')
  expect(saved?.vevent).toMatch(/RRULE:.*INTERVAL=2/)
  expect(saved?.vevent).toMatch(/RRULE:.*COUNT=3/)
  // Its span ends with its third time, four weeks on, not never
  const lastTime = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), 3 + 28, 10)
  )
  expect(saved?.ends).toBe(BigInt(lastTime.getTime() / 1000 + 14 * 3600))
  await alice.mail_cal_delete('alice', 'fortnightly')
  await context.close()
})

test('an all-day event cannot end before it starts', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await dialog(page).getByLabel('Title').fill('Backwards')
  await dialog(page).getByLabel('All day').check()
  await dialog(page).getByLabel('Start date').fill(third.replace(/03$/, '10'))
  await dialog(page).getByLabel('End date').fill(third.replace(/03$/, '09'))
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The event must end after it starts.'
  )
  await context.close()
})

test('an event longer than two months shows on every day of the grid', async ({
  browser,
}) => {
  await putRaw(
    'season',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART;VALUE=DATE:${ymd(-4, 1)}`,
      `DTEND;VALUE=DATE:${ymd(4, 1)}`,
      'SUMMARY:Season',
    ],
    new Date(now.getFullYear(), now.getMonth() - 4, 1),
    new Date(now.getFullYear(), now.getMonth() + 4, 1)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await expect(
    month(page).locator('.event.all-day', { hasText: 'Season' })
  ).toHaveCount(42)
  const alice = await asAlice()
  await alice.mail_cal_delete('alice', 'season')
  await context.close()
})

test('an event from another app keeps what the form does not show', async ({
  browser,
}) => {
  await putRaw(
    'three',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART;TZID="America/New_York":${ymd(0, 5)}T090000`,
      `DTEND;TZID="America/New_York":${ymd(0, 5)}T100000`,
      'RRULE:FREQ=DAILY;COUNT=3',
      `EXDATE;TZID="America/New_York":${ymd(0, 6)}T090000`,
      'SUMMARY:Three days',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'END:VALARM',
    ],
    new Date(now.getFullYear(), now.getMonth(), 4),
    new Date(now.getFullYear(), now.getMonth(), 9)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  // The 5th and the 7th: the 6th is left out
  await expect(
    month(page).getByRole('button', { name: /Three days/ })
  ).toHaveCount(2)
  await month(page)
    .getByRole('button', { name: /Three days/ })
    .first()
    .click()
  // A quoted zone name is read as the zone
  await expect(dialog(page).getByLabel('Time zone')).toHaveValue(
    'America/New_York'
  )
  await dialog(page).getByLabel('Title').fill('Three days renamed')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toBeHidden()
  const alice = await asAlice()
  const found = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 100n,
  })
  const saved = found.items.find((e) => e.uid === 'three')?.vevent ?? ''
  expect(saved).toContain('SUMMARY:Three days renamed')
  expect(saved).toContain('EXDATE')
  expect(saved).toContain('BEGIN:VALARM')
  await alice.mail_cal_delete('alice', 'three')
  await context.close()
})

test('a repeat that cannot be expanded safely shows once', async ({
  browser,
}) => {
  // A Monday a weekly step from a Tuesday never reaches
  const tuesday = new Date(now.getFullYear(), now.getMonth(), 1)
  tuesday.setDate(1 + ((9 - tuesday.getDay()) % 7))
  const day = `${tuesday.getFullYear()}${pad(tuesday.getMonth() + 1)}${pad(tuesday.getDate())}`
  await putRaw(
    'never',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${day}T090000Z`,
      `DTEND:${day}T100000Z`,
      'RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=MO',
      'SUMMARY:Never Monday',
    ],
    tuesday,
    new Date(9999, 0, 1)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await expect(
    month(page).getByRole('button', { name: /Never Monday/ })
  ).toHaveCount(1)
  // The page still answers
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(
    month(page).getByRole('button', { name: /Never Monday/ })
  ).toHaveCount(0)
  const alice = await asAlice()
  await alice.mail_cal_delete('alice', 'never')
  await context.close()
})

test('an event the form cannot show is read-only, and can be deleted', async ({
  browser,
}) => {
  await putRaw(
    'hourly',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART;TZID=America/New_York:${ymd(0, 12)}T090000`,
      // Ends in another zone: 09:00 in Chicago is 10:00 in New York
      `DTEND;TZID=America/Chicago:${ymd(0, 12)}T090000`,
      'RRULE:FREQ=HOURLY;COUNT=3',
      'SUMMARY:Hourly',
    ],
    new Date(now.getFullYear(), now.getMonth(), 11),
    new Date(now.getFullYear(), now.getMonth(), 14)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  const hourly = month(page).getByRole('button', { name: /Hourly/ })
  await expect(hourly).toHaveCount(1)
  await hourly.click()
  await expect(dialog(page)).toContainText('can be deleted here, not changed')
  await expect(dialog(page).getByLabel('Title')).toBeDisabled()
  await expect(dialog(page).getByLabel('Time zone')).toHaveValue(
    'America/New_York'
  )
  await expect(dialog(page).getByLabel('Start time')).toHaveValue('09:00')
  await expect(dialog(page).getByLabel('End time')).toHaveValue('10:00')
  await expect(dialog(page).getByRole('button', { name: 'Save' })).toHaveCount(
    0
  )
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect(hourly).toHaveCount(0)
  await context.close()
})

test('a click on another event while one is open opens that one', async ({
  browser,
}) => {
  // A Monday and a Tuesday: the left of the grid, clear of the open form
  const eighth = new Date(now.getFullYear(), now.getMonth(), 8)
  const monday = 8 + ((8 - eighth.getDay()) % 7)
  for (const [uid, day] of [
    ['first', monday],
    ['second', monday + 1],
  ] as const) {
    await putRaw(
      uid,
      [
        'DTSTAMP:20260101T000000Z',
        `DTSTART:${ymd(0, day)}T120000Z`,
        `DTEND:${ymd(0, day)}T130000Z`,
        `SUMMARY:Pick ${uid}`,
      ],
      new Date(now.getFullYear(), now.getMonth(), day),
      new Date(now.getFullYear(), now.getMonth(), day + 1)
    )
  }
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await month(page)
    .getByRole('button', { name: /Pick first/ })
    .click()
  await expect(dialog(page).getByLabel('Title')).toHaveValue('Pick first')
  await month(page)
    .getByRole('button', { name: /Pick second/ })
    .click()
  await expect(dialog(page).getByLabel('Title')).toHaveValue('Pick second')
  const alice = await asAlice()
  for (const uid of ['first', 'second'])
    await alice.mail_cal_delete('alice', uid)
  await context.close()
})

test('a dialog takes the focus, and Escape gives it back', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  const subscribe = page.getByRole('button', {
    name: 'Subscribe from a calendar app',
  })
  await subscribe.click()
  const shown = page.getByRole('dialog', {
    name: 'Subscribe from a calendar app',
  })
  await expect(
    shown.getByRole('button', { name: 'Make a secret address' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(shown).toBeHidden()
  await expect(subscribe).toBeFocused()

  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await expect(dialog(page).getByLabel('Title')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await context.close()
})

test('the form refuses an event with no length, or before 1970', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await dialog(page).getByLabel('Title').fill('No length')
  await dialog(page).getByLabel('Start time').fill('09:00')
  await dialog(page).getByLabel('End time').fill('09:00')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The event must end after it starts.'
  )
  await dialog(page).getByLabel('End time').fill('10:00')
  await dialog(page).getByLabel('Start date').fill('1969-12-01')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The calendar holds events from 1970 on.'
  )
  await context.close()
})

test('a crowded day scrolls, and the phone list has its own rows', async ({
  browser,
}) => {
  await putRaw(
    'phone-row',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 12)}T090000Z`,
      `DTEND:${ymd(0, 12)}T100000Z`,
      'SUMMARY:Phone row',
    ],
    new Date(now.getFullYear(), now.getMonth(), 12),
    new Date(now.getFullYear(), now.getMonth(), 13)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  expect(
    await month(page)
      .locator('.day')
      .first()
      .evaluate((day) => getComputedStyle(day).overflowY)
  ).toBe('auto')
  // The weekday names are one line high, not a week's row
  const names = await month(page).locator('.weekday').first().boundingBox()
  expect(names?.height).toBeLessThan(40)
  await page.setViewportSize({ width: 390, height: 844 })
  const row = page
    .getByLabel('Events this month')
    .getByRole('button', { name: /Phone row/ })
  expect(await row.evaluate((b) => getComputedStyle(b).fontSize)).toBe('14px')
  await context.close()
})

test('an event that cannot be read leaves the others shown', async ({
  browser,
}) => {
  await putRaw(
    'readable',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 13)}T090000Z`,
      `DTEND:${ymd(0, 13)}T100000Z`,
      'SUMMARY:Readable',
    ],
    new Date(now.getFullYear(), now.getMonth(), 13),
    new Date(now.getFullYear(), now.getMonth(), 14)
  )
  await putRaw(
    'bad-end',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 14)}T090000Z`,
      'DTEND:bad',
      'SUMMARY:Bad end',
    ],
    new Date(now.getFullYear(), now.getMonth(), 14),
    new Date(now.getFullYear(), now.getMonth(), 15)
  )
  await putRaw(
    'period',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 15)}T090000Z`,
      `DTEND:${ymd(0, 15)}T100000Z`,
      `RDATE;VALUE=PERIOD:${ymd(0, 16)}T090000Z/${ymd(0, 16)}T100000Z`,
      'SUMMARY:Period',
    ],
    new Date(now.getFullYear(), now.getMonth(), 15),
    new Date(now.getFullYear(), now.getMonth(), 17)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await expect(
    month(page).getByRole('button', { name: /Readable/ })
  ).toHaveCount(1)
  await expect(month(page).getByRole('button', { name: /Period/ })).toHaveCount(
    1
  )
  await expect(
    month(page).getByRole('button', { name: /Bad end/ })
  ).toHaveCount(0)
  const alice = await asAlice()
  for (const uid of ['bad-end', 'period'])
    await alice.mail_cal_delete('alice', uid)
  await context.close()
})

test('an event another app wrote beyond the form opens read-only', async ({
  browser,
}) => {
  const cases: [string, number, string[]][] = [
    [
      'Seconds',
      21,
      [`DTSTART:${ymd(0, 21)}T090030Z`, `DTEND:${ymd(0, 21)}T100030Z`],
    ],
    [
      'Cutoff',
      22,
      [
        `DTSTART:${ymd(0, 22)}T090000Z`,
        `DTEND:${ymd(0, 22)}T100000Z`,
        `RRULE:FREQ=DAILY;UNTIL=${ymd(0, 23)}T080000Z`,
      ],
    ],
    [
      'Weekdays',
      23,
      [
        `DTSTART:${ymd(0, 23)}T090000Z`,
        `DTEND:${ymd(0, 23)}T100000Z`,
        'RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO,WE',
      ],
    ],
    [
      'Skip zone',
      24,
      [
        `DTSTART;TZID=America/New_York:${ymd(0, 24)}T090000`,
        `DTEND;TZID=America/New_York:${ymd(0, 24)}T100000`,
        'RRULE:FREQ=DAILY;COUNT=3',
        `EXDATE;TZID=America/Los_Angeles:${ymd(0, 25)}T060000`,
      ],
    ],
  ]
  for (const [title, day, lines] of cases) {
    await putRaw(
      title.replace(' ', '-').toLowerCase(),
      ['DTSTAMP:20260101T000000Z', ...lines, `SUMMARY:${title}`],
      new Date(now.getFullYear(), now.getMonth(), day),
      new Date(now.getFullYear(), now.getMonth(), day + 3)
    )
  }
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  for (const [title] of cases) {
    await month(page)
      .getByRole('button', { name: new RegExp(title) })
      .first()
      .click()
    await expect(dialog(page), title).toContainText(
      'can be deleted here, not changed'
    )
    await dialog(page).getByRole('button', { name: 'Close' }).click()
  }
  const alice = await asAlice()
  for (const [title] of cases)
    await alice.mail_cal_delete('alice', title.replace(' ', '-').toLowerCase())
  await context.close()
})

test('an event moved to another month is shown there after the save', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  const later = new Date(now.getFullYear(), now.getMonth() + 3, 5)
  const heading = later.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
  await addEvent(page, 'Moved on', async (p) => {
    await dialog(p)
      .getByLabel('Start date')
      .fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-05`)
  })
  await expect(
    page.getByRole('heading', { level: 2, name: heading })
  ).toBeVisible()
  await expect(
    month(page).getByRole('button', { name: /Moved on/ })
  ).toHaveCount(1)
  await context.close()
})

test('the form holds its fields while it saves', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = 0
  await page.route(/\/api\/v\d\/canister\/[^/]+\/call$/, async (route) => {
    if (held++ === 0) await gate
    await route.continue()
  })
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await dialog(page).getByLabel('Title').fill('Held')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByLabel('Title')).toBeDisabled()
  release()
  await expect(dialog(page)).toBeHidden()
  await expect(month(page).getByRole('button', { name: /Held/ })).toHaveCount(1)
  await context.close()
})

test('a month from before 1970 shows without a load error', async ({
  browser,
}) => {
  await putRaw(
    'early',
    [
      'DTSTAMP:20260101T000000Z',
      'DTSTART:19700115T120000Z',
      'DTEND:19700115T130000Z',
      'SUMMARY:Early',
    ],
    new Date(Date.UTC(1970, 0, 15)),
    new Date(Date.UTC(1970, 0, 16))
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  // Back to January 1970, whose grid starts in December 1969
  const back = (now.getFullYear() - 1970) * 12 + now.getMonth()
  await page
    .getByRole('button', { name: 'Previous month' })
    .evaluate((button: HTMLElement, times: number) => {
      for (let i = 0; i < times; ++i) button.click()
    }, back)
  const january = new Date(1970, 0, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
  await expect(
    page.getByRole('heading', { level: 2, name: january })
  ).toBeVisible()
  // The month loads: its event shows, and no error
  await expect(month(page).getByRole('button', { name: /Early/ })).toHaveCount(
    1
  )
  await expect(
    page.getByRole('region', { name: 'Calendar' }).getByRole('alert')
  ).toHaveCount(0)
  await context.close()
})

test('Delete in the form deletes only, and never also saves', async ({
  browser,
}) => {
  await putRaw(
    'only-delete',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 9)}T090000Z`,
      `DTEND:${ymd(0, 9)}T100000Z`,
      'SUMMARY:Only delete',
    ],
    new Date(now.getFullYear(), now.getMonth(), 9),
    new Date(now.getFullYear(), now.getMonth(), 10)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await month(page)
    .getByRole('button', { name: /Only delete/ })
    .click()
  expect(
    await dialog(page)
      .getByRole('button', { name: 'Delete' })
      .evaluate((b) => (b as HTMLButtonElement).type)
  ).toBe('button')
  // A click in one go, before the page can disable the button
  await dialog(page)
    .getByRole('button', { name: 'Delete' })
    .evaluate((b) => (b as HTMLButtonElement).click())
  await expect(dialog(page)).toBeHidden()
  const alice = await asAlice()
  // A save sent with the delete would bring the event back
  await page.waitForLoadState('networkidle')
  const left = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 10n,
  })
  expect(left.items).toHaveLength(0)
  await context.close()
})

test('a dialog stays open while its change runs, and so does the calendar', async ({
  browser,
}) => {
  await putRaw(
    'waits',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 20)}T090000Z`,
      `DTEND:${ymd(0, 20)}T100000Z`,
      'SUMMARY:Waits',
    ],
    new Date(now.getFullYear(), now.getMonth(), 20),
    new Date(now.getFullYear(), now.getMonth(), 21)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  // The save waits until the test lets it go
  const calls = /\/api\/v\d\/canister\/[^/]+\/call$/
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route(calls, async (route) => {
    await gate
    await route.continue()
  })
  await month(page).getByRole('button', { name: /Waits/ }).click()
  await dialog(page).getByLabel('Title').fill('Waited')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  // Nothing leaves the form, or opens another, while it saves
  await expect(
    dialog(page).getByRole('button', { name: 'Close' })
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'New event', exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Subscribe from a calendar app' })
  ).toBeDisabled()
  await expect(
    month(page).getByRole('button', { name: /Waits/ })
  ).toBeDisabled()
  // The month's reload after the save waits too: until it is in, the old
  // event shows but does not open, as its form would hold the old fields
  const queries = /\/api\/v\d\/canister\/[^/]+\/query$/
  let reload = () => {}
  const reloaded = new Promise<void>((resolve) => (reload = resolve))
  await page.route(queries, async (route) => {
    if (route.request().postDataBuffer()?.includes('mail_cal_list'))
      await reloaded
    await route.continue()
  })
  release()
  await expect(dialog(page)).toBeHidden()
  await expect(
    month(page).getByRole('button', { name: /Waits/ })
  ).toBeDisabled()
  reload()
  await expect(
    month(page).getByRole('button', { name: /Waited/ })
  ).toBeEnabled()
  await page.unroute(calls)
  await page.unroute(queries)
  await context.close()
})

test('a change that fails shows in its dialog, which stays open', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  answer(page, true, true)
  await openCalendar(page)
  // Update calls fail as a lost connection, retries included
  const calls = /\/api\/v\d\/canister\/[^/]+\/call$/
  const failing = () => page.route(calls, (route) => route.abort())

  await failing()
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  await dialog(page).getByLabel('Title').fill('Never saved')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('alert')).toBeVisible()
  await expect(dialog(page).getByLabel('Title')).toHaveValue('Never saved')
  await expect(
    dialog(page).getByRole('button', { name: 'Close' })
  ).toBeEnabled()
  await page.unroute(calls)
  await dialog(page).getByRole('button', { name: 'Close' }).click()
  await expect(
    month(page).getByRole('button', { name: /Never saved/ })
  ).toHaveCount(0)

  // A stop that fails leaves the calendar shared, and says so in the dialog
  await page
    .getByRole('button', { name: 'Subscribe from a calendar app' })
    .click()
  const shown = page.getByRole('dialog', {
    name: 'Subscribe from a calendar app',
  })
  await shown.getByRole('button', { name: 'Make a secret address' }).click()
  const address = page.getByLabel('Secret address', { exact: true })
  await expect(address).toHaveValue(/\.ics$/)
  const kept = await address.inputValue()
  await failing()
  await shown
    .getByRole('button', { name: 'Stop sharing: the address stops working' })
    .click()
  await expect(shown.getByRole('alert')).toBeVisible()
  await expect(address).toHaveValue(kept)
  await page.unroute(calls)
  const alice = await asAlice()
  expect(await alice.mail_cal_feed('alice')).toHaveLength(1)
  await alice.mail_cal_feed_stop('alice')
  await context.close()
})

test('zones are read in any case, and every zone named is in the feed', async ({
  browser,
}) => {
  await putRaw(
    'lower-zone',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART;tzid=America/New_York:${ymd(0, 4)}T090000`,
      `DTEND;tzid=America/New_York:${ymd(0, 4)}T100000`,
      'RRULE:FREQ=DAILY;COUNT=3',
      `EXDATE;tzid=America/New_York:${ymd(0, 5)}T090000`,
      'SUMMARY:Lower zone',
    ],
    new Date(now.getFullYear(), now.getMonth(), 4),
    new Date(now.getFullYear(), now.getMonth(), 7)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  await month(page)
    .getByRole('button', { name: /Lower zone/ })
    .first()
    .click()
  // Read in its own zone, not as a floating time
  await expect(dialog(page).getByLabel('Time zone')).toHaveValue(
    'America/New_York'
  )
  await expect(dialog(page).getByLabel('Start time')).toHaveValue('09:00')
  // Moved to UTC, the skipped date keeps naming New York
  await dialog(page).getByLabel('Time zone').selectOption('UTC')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toBeHidden()

  const alice = await asAlice()
  const token = await alice.mail_cal_feed_reset('alice')
  const { port } = new URL(env.url)
  const feed = await fetchFeed(
    page,
    `http://${env.backend}.localhost:${port}/cal/${token}.ics`
  )
  expect(feed.body).toMatch(/EXDATE;TZID=America\/New_York/i)
  const calendar = new ICAL.Component(ICAL.parse(feed.body))
  expect(
    calendar
      .getAllSubcomponents('vtimezone')
      .map((z) => z.getFirstPropertyValue('tzid'))
  ).toContain('America/New_York')
  await alice.mail_cal_feed_stop('alice')
  await context.close()
})

test('a very long or very sparse repeat neither stalls the month nor a save', async ({
  browser,
}) => {
  await putRaw(
    'million',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 2)}T120000Z`,
      `DTEND:${ymd(0, 2)}T130000Z`,
      'RRULE:FREQ=DAILY;COUNT=1000000',
      'SUMMARY:Million',
    ],
    new Date(now.getFullYear(), now.getMonth(), 2),
    new Date(9999, 0, 1)
  )
  await putRaw(
    'sparse',
    [
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${ymd(0, 6)}T120000Z`,
      `DTEND:${ymd(0, 6)}T130000Z`,
      'RRULE:FREQ=DAILY;INTERVAL=2147483647',
      'SUMMARY:Sparse',
    ],
    new Date(now.getFullYear(), now.getMonth(), 6),
    new Date(9999, 0, 1)
  )
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)
  // The sparse one shows once, and opens read-only
  const sparse = month(page).getByRole('button', { name: /Sparse/ })
  await expect(sparse).toHaveCount(1)
  await sparse.click()
  await expect(dialog(page)).toContainText('can be deleted here, not changed')
  await dialog(page).getByRole('button', { name: 'Close' }).click()

  // The long one saves at once, and counts as having no end
  await month(page)
    .getByRole('button', { name: /Million/ })
    .first()
    .click()
  await dialog(page).getByLabel('Title').fill('Million renamed')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toBeHidden()
  const alice = await asAlice()
  const all = await alice.mail_cal_list('alice', {
    from: 0n,
    to: 253_402_300_799n,
    cursor: [],
    limit: 10n,
  })
  const saved = all.items.find((e) => e.uid === 'million')
  expect(saved?.vevent).toContain('SUMMARY:Million renamed')
  expect(saved?.ends).toBe(253_402_300_799n)
  await context.close()
})
