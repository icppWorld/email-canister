// The webmail tests of shared mailboxes and of several mailboxes per person.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, test } from '@playwright/test'
import { asUser } from './as_user'
import { env } from './local'
import {
  ADMIN,
  appBar,
  asAlice,
  backend,
  callsTo,
  compose,
  deliver,
  DOMAIN,
  downloadCopy,
  downloadStatus,
  drawer,
  drawerButton,
  endSignIn,
  FLAG_FLAGGED,
  FLAG_SEEN,
  freshBackend,
  hold,
  joinMailbox,
  joinTeam,
  mailboxButton,
  menuItem,
  navButton,
  openDrawer,
  openMail,
  phoneOpenMail,
  principalOf,
  refreshList,
  send,
  signedIn,
  signedInPhone,
  signInAgain,
  uidOf,
  USER_A,
  USER_B,
  USER_C,
  USER_D,
  viewSent,
  waitDrained,
  watch,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

test('a flag set while the message loads stays set', async ({ browser }) => {
  deliver({ subject: 'Slow avocet', body: '<p>Flag me early</p>' })
  const { context, page } = await signedIn(browser, USER_A)
  // The message's reply is answered at once but arrives late, so it holds
  // the flags from before the click
  const reply = await hold(page, 'mail_get', { late: true })
  await openMail(page, 'Slow avocet')
  await reply.seen
  await page.getByRole('button', { name: 'Star', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unstar', exact: true })
  ).toBeVisible()
  reply.release()
  // Read once the message has loaded, and still flagged
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Unstar', exact: true })
  ).toBeVisible()
  await context.close()
})

test('an opened message shows the flags another member set meanwhile', async ({
  browser,
}) => {
  joinTeam(USER_C, USER_D)
  deliver({ subject: 'Quiet egret', body: '<p>One</p>', to: 'team' })
  const other = await asUser(USER_D, env.url, env.backend)
  const uid = await uidOf(other, 'team', 'Quiet egret')

  const { context, page } = await signedIn(browser, USER_C)
  const search = async (text: string) => {
    await page.getByLabel('Search mail').fill(text)
    await page.getByLabel('Search mail').press('Enter')
  }
  const unread = page.locator('button.message.unread', {
    hasText: 'Quiet egret',
  })
  await search('Quiet egret')
  await page.locator('button.message', { hasText: 'Quiet egret' }).click()
  await expect(unread).toHaveCount(0)
  // Unread when the list loads, then read again by the other member
  await other.mail_set_flags('team', [uid], 0n, FLAG_SEEN)
  await search('egret')
  await expect(unread).toHaveCount(1)
  await other.mail_set_flags('team', [uid], FLAG_SEEN | FLAG_FLAGGED, 0n)
  // Nothing to write, as this member opened it before
  const writes = watch(page, 'mail_set_flags')
  await unread.click()
  await expect(unread).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Unstar', exact: true })
  ).toBeVisible()
  // The list shows the message's flags before a write would start: a moment
  // more, for one to show
  await page.waitForTimeout(2000)
  expect(writes).toHaveLength(0)
  await context.close()
})

test('every member who opens a shared message is recorded, the second too', async ({
  browser,
}) => {
  joinTeam(USER_C, USER_D)
  deliver({ subject: 'Shared osprey', body: '<p>For the team</p>', to: 'team' })
  const member = await asUser(USER_C, env.url, env.backend)
  // Delivered once the queue has moved it into the mailbox
  const uid = await uidOf(member, 'team', 'osprey')
  const seenBy = async () =>
    (await member.mail_get('team', uid)).seen_by
      .map((seen) => seen.principal.toText())
      .sort()
  const opened: string[] = []
  for (const seed of [USER_C, USER_D]) {
    const { context, page } = await signedIn(browser, seed)
    await expect(page.getByTestId('address')).toHaveText(`team@${DOMAIN}`)
    await openMail(page, 'Shared osprey')
    // Recorded before the page closes, which could cut the call short
    opened.push(principalOf(seed))
    await expect.poll(seenBy).toEqual([...opened].sort())
    await context.close()
  }
})

test('opening a message another member marked unread reads it again', async ({
  browser,
}) => {
  joinTeam(USER_C, USER_D)
  deliver({ subject: 'Stale ibis', body: '<p>One</p>', to: 'team' })
  deliver({ subject: 'Other ibis', body: '<p>Two</p>', to: 'team' })
  const other = await asUser(USER_D, env.url, env.backend)
  const uid = await uidOf(other, 'team', 'Stale ibis')
  const seen = async () =>
    ((await other.mail_get('team', uid)).summary.flags & FLAG_SEEN) !== 0n

  const { context, page } = await signedIn(browser, USER_C)
  await page.getByLabel('Search mail').fill('ibis')
  await page.getByLabel('Search mail').press('Enter')
  const message = (subject: string) =>
    page.locator('button.message', { hasText: subject })
  await message('Stale ibis').click()
  await expect.poll(seen).toBe(true)
  // Unread again, while this page's list still shows it read
  await other.mail_set_flags('team', [uid], 0n, FLAG_SEEN)
  await message('Other ibis').click()
  await message('Stale ibis').click()
  await expect.poll(seen).toBe(true)
  await context.close()
})

test('a flag set while the message is being marked read stays set', async ({
  browser,
}) => {
  deliver({ subject: 'Raced plover', body: '<p>Flag me</p>' })
  const { context, page } = await signedIn(browser, USER_A)
  // Only the first call, the one that marks the message read, waits
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let held = false
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (held || !callsTo(route.request(), 'mail_set_flags'))
      return route.fallback()
    held = true
    await released
    await route.continue()
  })
  await openMail(page, 'Raced plover')
  await expect.poll(() => held).toBe(true)
  await page.getByRole('button', { name: 'Star', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unstar', exact: true })
  ).toBeVisible()
  release()
  // The list shows the message read only once the held call has completed
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Unstar', exact: true })
  ).toBeVisible()
  const alice = await asAlice()
  await expect
    .poll(async () => {
      const { items } = await alice.mail_search('alice', {
        query: 'Raced plover',
        folder: 0n,
        cursor: [],
        limit: 1n,
      })
      return items[0]?.flags
    })
    .toBe(FLAG_SEEN | FLAG_FLAGGED)
  await context.close()
})

test('a refusal in the Admin panel stays shown when its first load ends', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  await expect(page.getByTestId('entry-alice')).toBeVisible()
  const list = await hold(page, 'admin_list_entries')
  await page.reload()
  await list.seen
  await page.getByLabel('User ID').fill('not-a-principal')
  await page.getByLabel('Address').fill('zed')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const refusal = page.getByRole('alert').getByText(/not-a-principal/)
  await expect(refusal).toBeVisible()
  list.release()
  await expect(page.getByTestId('entry-alice')).toBeVisible()
  await expect(refusal).toBeVisible()
  await context.close()
})

test('purges a mailbox from the Admin panel, freeing the address', async ({
  browser,
}) => {
  const admin = await signedIn(browser, ADMIN)
  const row = admin.page.getByTestId('entry-bob')
  await row.getByRole('button', { name: 'Disable' }).click()
  await expect(row).toContainText('Disabled')

  const user = await signedIn(browser, USER_B)
  await expect(
    user.page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()
  await user.context.close()

  admin.page.once('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: 'Purge' }).click()
  await expect(row).toContainText('Free', { timeout: 90_000 })
  await admin.context.close()
})

// Fern has her own mailbox heron and shares shore with Gail, who has gull
const FERN = '17'.repeat(32)

const GAIL = '28'.repeat(32)

let fernAndGailReady = false

function fernAndGail(): void {
  if (fernAndGailReady) return
  joinMailbox('heron', FERN)
  joinMailbox('gull', GAIL)
  joinMailbox('shore', FERN, GAIL)
  backend('admin_set_name', `(principal "${principalOf(FERN)}", "Fern")`)
  backend('admin_set_name', `(principal "${principalOf(GAIL)}", "Gail")`)
  fernAndGailReady = true
}

test('a person with several mailboxes switches between them, by the list or the address', async ({
  browser,
}) => {
  fernAndGail()
  deliver({ subject: 'Heron note', body: '<p>Mine</p>', to: 'heron' })
  deliver({ subject: 'Shore note', body: '<p>Ours</p>', to: 'shore' })
  await waitDrained()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await expect(page.getByTestId('unread-shore')).toBeVisible()
  await openMail(page, 'Heron note')
  await expect(page.getByTestId('subject')).toHaveText('Heron note')

  await mailboxButton(page, 'shore').click()
  await expect(page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(page).toHaveURL(/#shore$/)
  // The list and the reader start over in the other mailbox
  await expect(page.getByText('Select a message to read it.')).toBeVisible()
  await expect(
    page.locator('button.message', { hasText: 'Shore note' })
  ).toBeVisible()
  await expect(
    page.locator('button.message', { hasText: 'Heron note' })
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Sent' }).click()
  await expect(page).toHaveURL(/#shore\/sent$/)
  // An address naming none of theirs opens the one chosen last, also when
  // it was chosen after this page opened
  await page.goto(`${env.url}#nosuch`)
  await expect(page).toHaveURL(/#shore$/)

  // This browser opens the mailbox chosen last
  const again = await context.newPage()
  await again.goto(env.url)
  await expect(again.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  // An address naming none of theirs opens the one chosen last
  await again.goto(`${env.url}#nosuch`)
  // once the page has read it, it names the mailbox shown
  await expect(again).toHaveURL(/#shore$/)
  await expect(again.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  // and an address names a mailbox and folder
  await again.goto(`${env.url}#heron/sent`)
  await expect(again.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await expect(
    again.getByText('Select a message to see its status.')
  ).toBeVisible()
  await context.close()
})

test('a shared mailbox shows who opened a message and who sent one', async ({
  browser,
}) => {
  fernAndGail()
  deliver({ subject: 'Shared egret', body: '<p>For both</p>', to: 'shore' })
  deliver({ subject: 'Own heron', body: '<p>Mine</p>', to: 'heron' })
  await waitDrained()
  const fern = await signedIn(browser, FERN)
  // Not in a mailbox no one else reads
  await openMail(fern.page, 'Own heron')
  await expect(fern.page.getByTestId('subject')).toHaveText('Own heron')
  await expect(fern.page.getByText(/^Seen by/)).toHaveCount(0)

  await mailboxButton(fern.page, 'shore').click()
  await openMail(fern.page, 'Shared egret')
  await fern.page.getByText('Seen by 1').click()
  await expect(fern.page.getByRole('list', { name: 'Seen by' })).toHaveText(
    /^you/
  )

  // Started in heron, sent from shore
  await mailboxButton(fern.page, 'heron').click()
  await compose(fern.page, 'Shore reply')
  await expect(fern.page.getByLabel('From')).toHaveValue('heron')
  // styled like the fields beside it
  const look = (label: string) =>
    fern.page.getByLabel(label, { exact: true }).evaluate((e) => {
      const css = getComputedStyle(e)
      return [css.fontSize, css.height, css.borderRadius].join(' ')
    })
  expect(await look('From')).toBe(await look('To'))
  await fern.page.getByLabel('From').selectOption('shore')
  await send(fern.page)
  // The mailbox shown stays, until the note opens the Sent folder of shore
  await expect(fern.page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await expect(fern.page).toHaveURL(/#heron$/)
  await viewSent(fern.page)
  await expect(fern.page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(
    fern.page.getByRole('button', { name: /Shore reply/ })
  ).toBeVisible()

  const gail = await signedIn(browser, GAIL)
  await expect(gail.page.getByTestId('address')).toHaveText(`gull@${DOMAIN}`)
  await mailboxButton(gail.page, 'shore').click()
  await openMail(gail.page, 'Shared egret')
  await gail.page.getByText('Seen by 2').click()
  const seen = gail.page.getByRole('list', { name: 'Seen by' })
  await expect(seen).toContainText('Fern')
  await expect(seen).toContainText('you')
  await gail.page.getByRole('button', { name: 'Sent' }).click()
  await gail.page.getByRole('button', { name: /Shore reply/ }).click()
  await expect(gail.page.getByTestId('sent-by')).toHaveText('Fern')
  await Promise.all([fern.context.close(), gail.context.close()])
})

test('the unread count of a mailbox follows a delivery and a reading', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  const badge = page.getByTestId('unread-shore')
  const before = (await badge.count()) ? Number(await badge.textContent()) : 0
  deliver({ subject: 'Counted dunlin', body: '<p>One more</p>', to: 'shore' })
  await waitDrained()
  await refreshList(page)
  await expect(badge).toHaveText(String(before + 1))
  // Read here, and counted at once: well before the 30 s refresh
  await mailboxButton(page, 'shore').click()
  await openMail(page, 'Counted dunlin')
  const soon = { timeout: 5_000 }
  if (before === 0) await expect(badge).toHaveCount(0, soon)
  else await expect(badge).toHaveText(String(before), soon)
  await context.close()
})

test("at phone width the drawer chooses the mailbox, and lists the open one's folders", async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedInPhone(browser, FERN)
  await expect(appBar(page)).toContainText(`heron@${DOMAIN}`)
  await expect(mailboxButton(page, 'heron')).toBeHidden()
  await openDrawer(page)
  await mailboxButton(page, 'shore', drawer(page)).click()
  await expect(drawer(page)).toHaveCount(0)
  await expect(appBar(page)).toContainText(`shore@${DOMAIN}`)
  await openDrawer(page)
  for (const name of ['Inbox', 'Sent']) {
    await expect(drawerButton(page, name)).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  // A long address does not widen the page
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  // Compose covers an open Seen by list
  deliver({ subject: 'Covered stint', body: '<p>Under</p>', to: 'shore' })
  await waitDrained()
  await menuItem(page, 'List actions', 'Refresh')
  await phoneOpenMail(page, 'Covered stint')
  await page.getByText(/^Seen by/).click()
  const seen = page.getByRole('list', { name: 'Seen by' })
  await expect(seen).toBeVisible()
  await page.getByRole('button', { name: 'Compose' }).click()
  const box = await seen.boundingBox()
  if (!box) throw new Error('no Seen by list')
  expect(
    await page.evaluate(
      ({ x, y }) =>
        Boolean(document.elementFromPoint(x, y)?.closest('.dialog')),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    )
  ).toBe(true)
  await context.close()
})

test('a late reply does not undo a flag set and cleared while the message loads', async ({
  browser,
}) => {
  fernAndGail()
  deliver({ subject: 'Late plover', body: '<p>Flag, unflag</p>', to: 'shore' })
  const gail = await asUser(GAIL, env.url, env.backend)
  const uid = await uidOf(gail, 'shore', 'Late plover')
  const { context, page } = await signedIn(browser, FERN)
  await mailboxButton(page, 'shore').click()
  await page.getByLabel('Search mail').fill('Late plover')
  await page.getByLabel('Search mail').press('Enter')
  const row = page.locator('button.message', { hasText: 'Late plover' })
  await expect(row).toBeVisible()
  // Flagged by the other member after the list loaded
  await gail.mail_set_flags('shore', [uid], FLAG_FLAGGED, 0n)
  // The message's reply holds that flag, and arrives after both clicks
  const reply = await hold(page, 'mail_get', { late: true })
  await row.click()
  await reply.seen
  await page.getByRole('button', { name: 'Star', exact: true }).click()
  await page.getByRole('button', { name: 'Unstar', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Star', exact: true })
  ).toBeVisible()
  reply.release()
  // Read once the message has loaded, and still not flagged, as stored
  await expect(
    page.locator('button.message.unread', { hasText: 'Late plover' })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Star', exact: true })
  ).toBeVisible()
  const { items } = await gail.mail_search('shore', {
    query: 'Late plover',
    folder: 0n,
    cursor: [],
    limit: 1n,
  })
  expect(items[0].flags & FLAG_FLAGGED).toBe(0n)
  await context.close()
})

test('a download started from the menu shows below the folders, keeps going, and names its mailbox, when another one opens', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  const chunks = await hold(page, 'mail_export_chunk')
  const saved = page.waitForEvent('download')
  await downloadCopy(page)
  await chunks.seen
  // The download shows below the bar, and waits for its end to start again
  await expect(navButton(page, 'Download a copy')).toBeDisabled()
  const status = downloadStatus(page)
  await expect(status).toHaveClass(/download-status/)
  await expect(status).toContainText(`heron@${DOMAIN}`)
  await mailboxButton(page, 'shore').click()
  await expect(page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(downloadStatus(page)).toContainText(`heron@${DOMAIN}`)
  chunks.release()
  expect((await saved).suggestedFilename()).toMatch(/^heron@/)
  // The download has ended its hold, so later tests can write to heron
  await expect(downloadStatus(page)).toHaveCount(0)
  await context.close()
})

test('a draft left open while another mailbox opens is sent from the mailbox it shows', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await compose(page, 'Kept whimbrel')
  await mailboxButton(page, 'shore').click()
  // Compose gives way to the open draft, which keeps its From
  await expect(page.getByRole('button', { name: 'Compose' })).toHaveCount(0)
  await expect(page.getByLabel('Subject')).toHaveValue('Kept whimbrel')
  await expect(page.getByLabel('From')).toHaveValue('heron')
  await send(page)
  await viewSent(page)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await expect(
    page.getByRole('button', { name: /Kept whimbrel/ })
  ).toBeVisible()
  await context.close()
})

test('a send whose reply was lost cannot go out again from another mailbox', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await compose(page, 'Twice curlew')
  // The first try is queued, but its reply never reaches the page: once it
  // has, every call fails, the agent's polls for that reply too
  let lost = false
  let cut = false
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (cut) return route.abort()
    if (lost || !callsTo(route.request(), 'mail_send')) return route.fallback()
    lost = true
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    await route.fetch({ url: url.toString() })
    cut = true
    await route.abort()
  })
  await send(page)
  const alert = page.getByRole('dialog').getByRole('alert')
  await expect(alert).toBeVisible()
  cut = false
  // From another mailbox the canister refuses it, and says where it went
  await page.getByLabel('From').selectOption('shore')
  await send(page)
  await expect(alert).toContainText(`already queued from heron@${DOMAIN}`)
  // From the one it went out from, the retry finds it, once
  await page.getByLabel('From').selectOption('heron')
  await send(page)
  await viewSent(page)
  await expect(page).toHaveURL(/#heron\/sent$/)
  await expect(page.getByRole('button', { name: /Twice curlew/ })).toHaveCount(
    1
  )
  await context.close()
})

// Hal is in wren and teal, until teal is taken away
const HAL = '39'.repeat(32)

test('a draft from a mailbox taken away meanwhile can be sent from another one', async ({
  browser,
}) => {
  joinMailbox('wren', HAL)
  joinMailbox('teal', HAL)
  const { context, page } = await signedIn(browser, HAL)
  await mailboxButton(page, 'teal').click()
  await expect(page.getByTestId('address')).toHaveText(`teal@${DOMAIN}`)
  await compose(page, 'Orphan stilt')
  backend('admin_remove_member', `("teal", principal "${principalOf(HAL)}")`)
  await refreshList(page)
  await expect(page.getByTestId('address')).toHaveText(`wren@${DOMAIN}`)
  // The draft still says where it is from, and another mailbox can be chosen,
  // also after the canister refused to send it from there
  const from = page.getByLabel('From')
  await expect(from).toHaveValue('teal')
  await send(page)
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
  await expect(from).toBeEnabled()
  await from.selectOption('wren')
  await send(page)
  await viewSent(page)
  await expect(page).toHaveURL(/#wren\/sent$/)
  await expect(page.getByRole('button', { name: /Orphan stilt/ })).toBeVisible()
  await context.close()
})

test('an older reload does not bring back an unread count', async ({
  browser,
}) => {
  fernAndGail()
  deliver({
    subject: 'Stale godwit',
    body: '<p>Count me once</p>',
    to: 'shore',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, FERN)
  const badge = page.getByTestId('unread-shore')
  const unread = async () =>
    (await badge.count()) ? Number(await badge.textContent()) : 0
  await expect.poll(unread).toBeGreaterThan(0)
  const before = await unread()
  // The next reload is answered now, with this count, but arrives last
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let arrived = false
  let held = false
  let answered = false
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (held || !callsTo(route.request(), 'mail_me')) return route.fallback()
    held = true
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    const response = await route.fetch({ url: url.toString() })
    answered = true
    await released
    await route.fulfill({ response })
    arrived = true
  })
  await mailboxButton(page, 'shore').click()
  await refreshList(page)
  // Answered before the message is read, so the reply holds the old count
  await expect.poll(() => answered).toBe(true)
  await openMail(page, 'Stale godwit')
  await expect.poll(unread).toBe(before - 1)
  release()
  await expect.poll(() => arrived).toBe(true)
  // Long enough for the page to take in the older reply
  await page.waitForTimeout(1_500)
  expect(await unread()).toBe(before - 1)
  await context.close()
})

test('a mailbox chosen in another tab does not move this one', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  const other = await context.newPage()
  await other.goto(env.url)
  await mailboxButton(other, 'shore').click()
  await expect(other.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  // Drawn again, as every reload and keystroke does
  await refreshList(page)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  // A folder switch here leaves the mailbox the other tab chose for the next
  await page.getByRole('button', { name: 'Sent' }).click()
  await expect(page).toHaveURL(/#heron\/sent$/)
  const next = await context.newPage()
  await next.goto(env.url)
  await expect(next.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  // An address followed before the mailboxes load is kept until they do
  const early = await context.newPage()
  const mailboxes = await hold(early, 'mail_me')
  await early.goto(`${env.url}#heron`)
  await mailboxes.seen
  await early.evaluate(() => {
    window.location.hash = '#shore/sent'
  })
  mailboxes.release()
  await expect(early.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(early).toHaveURL(/#shore\/sent$/)
  await context.close()
})

test('who opened and who sent stay shown after the others leave the mailbox', async ({
  browser,
}) => {
  fernAndGail()
  joinMailbox('rail', HAL, GAIL)
  deliver({ subject: 'Rail note', body: '<p>For both</p>', to: 'rail' })
  const gail = await asUser(GAIL, env.url, env.backend)
  const uid = await uidOf(gail, 'rail', 'Rail note')
  await gail.mail_set_flags('rail', [uid], FLAG_SEEN, 0n)
  await gail.mail_send('rail', {
    client_id: crypto.randomUUID(),
    to: ['friend@example.org'],
    cc: [],
    bcc: [],
    subject: 'Rail reply',
    html_body: '<p>From Gail</p>',
    attachments: [],
  })
  backend('admin_remove_member', `("rail", principal "${principalOf(GAIL)}")`)
  const { context, page } = await signedIn(browser, HAL)
  await mailboxButton(page, 'rail').click()
  await openMail(page, 'Rail note')
  await page.getByText(/^Seen by/).click()
  await expect(page.getByRole('list', { name: 'Seen by' })).toContainText(
    'Gail'
  )
  await page.getByRole('button', { name: 'Sent' }).click()
  await page.getByRole('button', { name: /Rail reply/ }).click()
  await expect(page.getByTestId('sent-by')).toHaveText('Gail')
  await context.close()
})

test('a reload that fails does not discard an earlier one', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await mailboxButton(page, 'shore').click()
  await expect(page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  const badge = page.getByTestId('unread-shore')
  const unread = async () =>
    (await badge.count()) ? Number(await badge.textContent()) : 0
  const before = await unread()
  // The next reload is answered at once but arrives late; the one after fails
  const first = await hold(page, 'mail_me', { late: true })
  deliver({ subject: 'Kept knot', body: '<p>One more</p>', to: 'shore' })
  await waitDrained()
  await refreshList(page)
  await first.seen
  // Registered last, so it comes before the held one
  let failed = false
  await page.route('**/api/*/canister/*/*', (route) => {
    if (!callsTo(route.request(), 'mail_me')) return route.fallback()
    failed = true
    return route.abort()
  })
  await refreshList(page)
  await expect.poll(() => failed).toBe(true)
  first.release()
  await expect.poll(unread, { timeout: 5_000 }).toBe(before + 1)
  await context.close()
})

test('a send that ends after a new sign-in leaves the draft open then alone', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await compose(page, 'Late sanderling')
  const sending = await hold(page, 'mail_send')
  await send(page)
  await sending.seen
  await endSignIn(page)
  await signInAgain(page, FERN)
  // The kept draft is closed, and another one started
  await expect(page.getByLabel('Subject')).toHaveValue('Late sanderling')
  await page.getByRole('button', { name: 'Close' }).click()
  await compose(page, 'Second dunlin')
  sending.release()
  const fern = await asUser(FERN, env.url, env.backend)
  await expect
    .poll(async () =>
      (
        await fern.mail_outbox_list('heron', { cursor: [], limit: 20n })
      ).items.map((item) => item.subject)
    )
    .toContain('Late sanderling')
  // Long enough for the page to take in the send's end
  await page.waitForTimeout(1_500)
  await expect(page.getByLabel('Subject')).toHaveValue('Second dunlin')
  await context.close()
})
