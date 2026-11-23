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

test('a repeat and an all-day event show on their days', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await openCalendar(page)

  await addEvent(page, 'Weekly round', async (p) => {
    await dialog(p).getByLabel('Start date').fill(third)
    await dialog(p).getByLabel('Repeats').selectOption('WEEKLY')
  })
  // The 3rd, 10th, 17th and 24th at least, and more in the grid's other days
  expect(
    await month(page)
      .getByRole('button', { name: /Weekly round/ })
      .count()
  ).toBeGreaterThanOrEqual(4)

  await addEvent(page, 'Club holiday', async (p) => {
    await dialog(p).getByLabel('Start date').fill(third)
    await dialog(p).getByLabel('All day').check()
    await dialog(p).getByLabel('End date').fill(third.replace(/03$/, '04'))
  })
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
  expect(
    await agenda.getByRole('button', { name: /Weekly round/ }).count()
  ).toBeGreaterThanOrEqual(4)
  await context.close()
})

test('a calendar app subscribes at the secret address', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  // Sharing is asked first, once declined; then each change is confirmed
  const asked = answer(page, false, true, true, true)
  await openCalendar(page)
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
  const address = page.getByLabel('Secret address')
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
  expect(calendar.getAllSubcomponents('vtimezone').length).toBeGreaterThan(0)

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
