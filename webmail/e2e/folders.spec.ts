// The webmail tests of Trash, Spam, blocked senders and the notes.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, test } from '@playwright/test'
import { asUser } from './as_user'
import { env } from './local'
import {
  answer,
  asAlice,
  backend,
  callsTo,
  deliver,
  DOMAIN,
  FLAG_FLAGGED,
  FLAG_SEEN,
  folder,
  FOLDER_INBOX,
  FOLDER_SPAM,
  FOLDER_TRASH,
  freshBackend,
  hold,
  joinMailbox,
  menu,
  menuItem,
  messageRow,
  openMail,
  openMenu,
  reader,
  search,
  signedIn,
  signInAgain,
  spamAndBlock,
  spamFromReader,
  toastButton,
  uidOf,
  undo,
  USER_A,
  waitDrained,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

// The addresses alice's mailbox blocks
const blockedAddresses = async (user: Awaited<ReturnType<typeof asUser>>) =>
  (await user.mail_blocked('alice')).map((b) => b.address)

test('Delete moves mail to Trash, where Undo, Restore and Delete forever work', async ({
  browser,
}) => {
  deliver({ subject: 'Trashed shoveler', body: '<p>A shoveler.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  // With no note shown, its live region is still there to announce the next
  await expect(
    page.getByRole('status').and(page.getByTestId('toast'))
  ).toHaveCount(1)
  await openMail(page, 'shoveler')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(messageRow(page, 'Trashed shoveler')).toHaveCount(0)
  await undo(page)
  await expect(messageRow(page, 'Trashed shoveler')).toHaveCount(1)

  // Restored from Trash
  await messageRow(page, 'Trashed shoveler').click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await folder(page, 'Trash')
  await expect(page).toHaveURL(/#alice\/trash$/)
  await messageRow(page, 'Trashed shoveler').click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(messageRow(page, 'Trashed shoveler')).toHaveCount(0)
  await openMail(page, 'shoveler')
  await expect(page.getByTestId('subject')).toHaveText('Trashed shoveler')

  // Deleted for good, once confirmed
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await folder(page, 'Trash')
  await messageRow(page, 'Trashed shoveler').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page
    .getByRole('button', { name: 'Delete forever', exact: true })
    .click()
  await expect(messageRow(page, 'Trashed shoveler')).toHaveCount(0)
  const alice = await asAlice()
  for (const folder of [FOLDER_INBOX, FOLDER_TRASH, FOLDER_SPAM]) {
    const { items } = await alice.mail_search('alice', {
      query: 'shoveler',
      folder,
      cursor: [],
      limit: 10n,
    })
    expect(items).toHaveLength(0)
  }
  await context.close()
})

test('ticked messages are read, unread, starred and deleted together, and Trash empties', async ({
  browser,
}) => {
  for (const n of [1, 2, 3]) {
    deliver({ subject: `Ticked pratincole ${n}`, body: '<p>A pratincole.</p>' })
  }
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'pratincole')
  await expect(messageRow(page, 'Ticked pratincole')).toHaveCount(3)
  // The boxes are boxes: the list fits its column, with no sideways scroll
  const list = page.getByRole('region', { name: 'Messages' })
  expect(
    await list.evaluate((el) => el.scrollWidth - el.clientWidth)
  ).toBeLessThanOrEqual(0)
  expect(
    (await page.getByLabel('Select Ticked pratincole 1').boundingBox())!.width
  ).toBeLessThan(32)
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })

  // A ticked row stands out from the rest
  const row = page.locator('li.message-row', {
    has: page.getByLabel('Select Ticked pratincole 2'),
  })
  const background = () =>
    row.evaluate((el) => getComputedStyle(el).backgroundColor)
  const unticked = await background()
  await bulk.getByLabel('Select all').check()
  await expect(bulk).toContainText('3 selected')
  expect(await background()).not.toBe(unticked)
  await bulk.getByRole('button', { name: 'Mark read' }).click()
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await bulk.getByRole('button', { name: 'Mark unread' }).click()
  await expect(page.locator('button.message.unread')).toHaveCount(3)
  await bulk.getByLabel('Select all').uncheck()

  // The star in the row
  const star = page.getByRole('button', {
    name: 'Star Ticked pratincole 1',
    exact: true,
  })
  await star.click()
  await expect(
    page.getByRole('button', {
      name: 'Unstar Ticked pratincole 1',
      exact: true,
    })
  ).toHaveAttribute('aria-pressed', 'true')

  // An action of the row's own, shown on hover
  await messageRow(page, 'Ticked pratincole 2').hover()
  await page
    .getByRole('button', { name: 'Delete: Ticked pratincole 2' })
    .click()
  await expect(messageRow(page, 'Ticked pratincole')).toHaveCount(2)
  await expect(page.getByTestId('toast')).toHaveText(/Message moved to Trash/)

  await bulk.getByLabel('Select all').check()
  await expect(
    bulk.getByRole('button', { name: 'Spam', exact: true })
  ).toBeVisible()
  await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('toast')).toHaveText(
    /2 messages moved to Trash/
  )
  await expect(page.getByText('No matches.')).toBeVisible()

  await folder(page, 'Trash')
  await expect(messageRow(page, 'Ticked pratincole')).toHaveCount(3)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await expect(page.getByText('Nothing in Trash.')).toBeVisible()
  await context.close()
})

test('a blocked sender goes to Spam, until Not spam and Unblock bring the mail back', async ({
  browser,
}) => {
  const from = 'Pushy <pushy@sender.example>'
  deliver({ subject: 'Pushy grebe', body: '<p>Buy now.</p>', from })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  // Blocked with no dialog to confirm
  const dialogs = answer(page)
  await openMail(page, 'Pushy grebe')
  await spamAndBlock(page)
  await expect(page.getByTestId('toast')).toHaveText(
    /Blocked pushy@sender.example/
  )
  await expect(messageRow(page, 'Pushy grebe')).toHaveCount(0)

  // New mail from the address goes to Spam, by its From address
  deliver({ subject: 'Pushy grebe again', body: '<p>Last chance.</p>', from })
  await waitDrained()
  await folder(page, 'Spam')
  await expect(page).toHaveURL(/#alice\/spam$/)
  await expect(messageRow(page, 'Pushy grebe')).toHaveCount(2)

  await menuItem(page, 'More', 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('pushy@sender.example')
  await expect(blocked).toContainText('by you')
  await blocked.getByRole('button', { name: 'Unblock' }).click()
  await expect(blocked).toContainText('No one is blocked.')

  await folder(page, 'Spam')
  await messageRow(page, 'Pushy grebe again').click()
  await page.getByRole('button', { name: 'Not spam', exact: true }).click()
  await expect(page.getByTestId('toast')).toHaveText(/moved to the Inbox/)
  await openMail(page, 'Pushy grebe again')
  await expect(page.getByTestId('subject')).toHaveText('Pushy grebe again')

  // A block made before is not undone: in Spam already, there is nothing to undo
  const alice = await asAlice()
  await alice.mail_block('alice', 'Again@sender.example')
  deliver({
    subject: 'Pushy shrike',
    body: '<p>Again.</p>',
    from: 'Again <again@sender.example>',
  })
  await waitDrained()
  await folder(page, 'Spam')
  await messageRow(page, 'Pushy shrike').click()
  await menuItem(page, 'More actions', 'Block sender')
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/again@sender.example was blocked already/)
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await alice.mail_unblock('alice', 'again@sender.example')
  expect(dialogs).toEqual([])
  await context.close()
})

test('a list load under way when mail moves does not bring it back', async ({
  browser,
}) => {
  deliver({ subject: 'Lingering dowitcher', body: '<p>A dowitcher.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'dowitcher')
  await expect(messageRow(page, 'Lingering dowitcher')).toHaveCount(1)
  // A reload whose reply, still listing the message, arrives after the move
  const listing = await hold(page, 'mail_search', { late: true })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await listing.seen
  await messageRow(page, 'Lingering dowitcher').hover()
  await page
    .getByRole('button', { name: 'Delete: Lingering dowitcher' })
    .click()
  await expect(messageRow(page, 'Lingering dowitcher')).toHaveCount(0)
  listing.release()
  await page.waitForTimeout(1_500)
  await expect(messageRow(page, 'Lingering dowitcher')).toHaveCount(0)
  await context.close()
})

test('a star changed in the list while the message loads stays as set', async ({
  browser,
}) => {
  deliver({ subject: 'Starry phalarope', body: '<p>A phalarope.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const { items } = await alice.mail_search('alice', {
    query: 'phalarope',
    folder: FOLDER_INBOX,
    cursor: [],
    limit: 1n,
  })
  await alice.mail_set_flags('alice', [items[0].uid], FLAG_FLAGGED, 0n)
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'phalarope')

  // The message's load reads it unstarred, and its reply comes after the
  // star is set again
  let send = () => {}
  const sent = new Promise<void>((resolve) => (send = resolve))
  let answer = () => {}
  const answered = new Promise<void>((resolve) => (answer = resolve))
  let fetched = () => {}
  const read = new Promise<void>((resolve) => (fetched = resolve))
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), 'mail_get')) return route.fallback()
    await sent
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    const response = await route.fetch({ url: url.toString() })
    fetched()
    await answered
    await route.fulfill({ response })
  })
  await messageRow(page, 'Starry phalarope').click()
  await page
    .getByRole('button', { name: 'Unstar Starry phalarope', exact: true })
    .click()
  const star = page.getByRole('button', {
    name: 'Star Starry phalarope',
    exact: true,
  })
  await expect(star).toBeVisible()
  send()
  await read
  await star.click()
  const starred = page.getByRole('button', {
    name: 'Unstar Starry phalarope',
    exact: true,
  })
  await expect(starred).toBeVisible()
  answer()
  await expect(page.getByTestId('subject')).toHaveText('Starry phalarope')
  await page.waitForTimeout(1_000)
  await expect(starred).toHaveAttribute('aria-pressed', 'true')
  await context.close()
})

// Iris has the mailbox stint, filled with seeded mail
const IRIS = '4a'.repeat(32)

test('when part of a large move is refused, the part that moved leaves the list', async ({
  browser,
}) => {
  joinMailbox('stint', IRIS)
  backend('dev_seed', '("stint", 1 : nat64, 120 : nat64)')
  const { context, page } = await signedIn(browser, IRIS)
  await expect(page.getByTestId('address')).toHaveText(`stint@${DOMAIN}`)
  for (const shown of [100, 120]) {
    await page.getByRole('button', { name: 'Older mail' }).click()
    await expect(page.locator('button.message')).toHaveCount(shown)
  }
  // Every call after the first part fails
  let moves = 0
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_move') && ++moves > 1
      ? route.abort('failed')
      : route.fallback()
  )
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await bulk.getByLabel('Select all').check()
  await expect(bulk).toContainText('120 selected')
  await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('toast')).toHaveText(
    /100 messages moved to Trash/
  )
  await expect(page.locator('button.message')).toHaveCount(20)
  await expect(
    page.getByRole('region', { name: 'Messages' }).getByRole('alert')
  ).toBeVisible()
  await context.close()
})

test('a move that ends after a new sign-in leaves no note', async ({
  browser,
}) => {
  deliver({ subject: 'Late killdeer', body: '<p>A killdeer.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'killdeer')
  const moving = await hold(page, 'mail_move')
  await messageRow(page, 'Late killdeer').hover()
  await page.getByRole('button', { name: 'Delete: Late killdeer' }).click()
  await moving.seen
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signInAgain(page, USER_A)
  await expect(page.getByTestId('address')).toBeVisible()
  moving.release()
  const alice = await asAlice()
  await expect
    .poll(
      async () =>
        (
          await alice.mail_search('alice', {
            query: 'killdeer',
            folder: FOLDER_TRASH,
            cursor: [],
            limit: 1n,
          })
        ).items.length
    )
    .toBe(1)
  await page.waitForTimeout(1_000)
  // Read once: the note would close by itself before a waiting check ended
  expect(await page.getByTestId('toast').textContent()).toBe('')
  await context.close()
})

test('a search under way when a message opens still shows what it found', async ({
  browser,
}) => {
  deliver({ subject: 'Patient bittern', body: '<p>A bittern.</p>' })
  // Mail the search does not find, so its result differs from the Inbox
  deliver({ subject: 'Unsought plover', body: '<p>A plover.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  const first = page.locator('button.message').first()
  await expect(first).toBeVisible()
  // The search's reply comes after the message on screen has opened
  const searching = await hold(page, 'mail_search', { late: true })
  await search(page, 'bittern')
  await searching.seen
  await first.click()
  await expect(page.getByTestId('subject')).toBeVisible()
  searching.release()
  await expect(page.locator('button.message')).toHaveCount(1)
  await expect(messageRow(page, 'Patient bittern')).toHaveCount(1)
  await context.close()
})

test('an action that goes through once refused clears the refusal', async ({
  browser,
}) => {
  deliver({ subject: 'Retried wagtail', body: '<p>A wagtail.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'wagtail')
  await expect(messageRow(page, 'Retried wagtail')).toHaveCount(1)
  // Refused, the agent's own retries included, until the refusal shows
  let refusing = true
  await page.route('**/api/*/canister/*/*', (route) =>
    refusing && callsTo(route.request(), 'mail_set_flags')
      ? route.abort('failed')
      : route.fallback()
  )
  const star = page.getByRole('button', {
    name: 'Star Retried wagtail',
    exact: true,
  })
  const refusal = page
    .getByRole('region', { name: 'Messages' })
    .getByRole('alert')
  await star.click()
  await expect(refusal).toBeVisible()
  refusing = false
  await star.click()
  await expect(
    page.getByRole('button', { name: 'Unstar Retried wagtail', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(refusal).toHaveCount(0)
  await context.close()
})

test('an Undo that fails after a new sign-in leaves no note', async ({
  browser,
}) => {
  deliver({ subject: 'Undone smew', body: '<p>A smew.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'smew')
  await messageRow(page, 'Undone smew').hover()
  await page.getByRole('button', { name: 'Delete: Undone smew' }).click()
  await expect(page.getByTestId('toast')).toHaveText(/moved to Trash/)
  // The move back is refused, after the sign-in that began it has ended
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let reached = () => {}
  const seen = new Promise<void>((resolve) => (reached = resolve))
  let refused = 0
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), 'mail_move')) return route.fallback()
    reached()
    await released
    await route.abort('failed')
    refused++
  })
  await undo(page)
  await seen
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signInAgain(page, USER_A)
  await expect(page.getByTestId('address')).toBeVisible()
  release()
  // The agent tries 3 more times before the Undo fails
  await expect.poll(() => refused, { timeout: 60_000 }).toBe(4)
  await page.waitForTimeout(3_000)
  // Read once: the note would close by itself before a waiting check ended
  expect(await page.getByTestId('toast').textContent()).toBe('')
  await context.close()
})

// Snow has the mailbox snipe, with seeded mail in Trash
const SNOW = '4b'.repeat(32)

test('Empty Trash refused part way leaves only what is still there', async ({
  browser,
}) => {
  joinMailbox('snipe', SNOW)
  backend('dev_seed', '("snipe", 1 : nat64, 120 : nat64)')
  const snow = await asUser(SNOW, env.url, env.backend)
  const uids = Array.from({ length: 120 }, (_, n) => BigInt(n + 1))
  expect(await snow.mail_move('snipe', uids, FOLDER_TRASH)).toBe(120n)
  const { context, page } = await signedIn(browser, SNOW)
  await expect(page.getByTestId('address')).toHaveText(`snipe@${DOMAIN}`)
  await folder(page, 'Trash')
  await expect(page.locator('button.message')).toHaveCount(50)
  // The first part goes, the second is refused
  let deletes = 0
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_delete') && ++deletes > 1
      ? route.abort('failed')
      : route.fallback()
  )
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await expect(
    page.getByRole('region', { name: 'Messages' }).getByRole('alert')
  ).toBeVisible()
  // At once, not at the next timed refresh
  await expect(page.locator('button.message')).toHaveCount(20, {
    timeout: 2_000,
  })

  // The rest goes, but the list cannot load again: that refusal stays shown
  await page.unrouteAll({ behavior: 'wait' })
  let lists = 0
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_list') && ++lists > 2
      ? route.abort('failed')
      : route.fallback()
  )
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  // The reload and the agent's 3 tries more, then at once, not at the next
  // timed refresh
  await expect.poll(() => lists, { timeout: 60_000 }).toBe(6)
  await expect(
    page.getByRole('region', { name: 'Messages' }).getByRole('alert')
  ).toBeVisible({ timeout: 2_000 })
  await context.close()
})

// The block comes after the move, from its note: a refused move blocks no one
test('a move to Spam that is refused offers no block', async ({ browser }) => {
  deliver({
    subject: 'Stubborn dipper',
    body: '<p>A dipper.</p>',
    from: 'Dipper <dipper@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'dipper')
  await expect(page.getByTestId('subject')).toHaveText('Stubborn dipper')
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_move')
      ? route.abort('failed')
      : route.fallback()
  )
  // Loaded, so a move that went through would offer the block
  await spamFromReader(page)
  // The refusal shows beside the message, after the agent's own retries
  await expect(reader(page).getByRole('alert')).toBeVisible({
    timeout: 60_000,
  })
  await expect(
    page.getByTestId('toast').getByRole('button', { name: 'Block sender' })
  ).toHaveCount(0)
  await expect(messageRow(page, 'Stubborn dipper')).toHaveCount(1)
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).not.toContain('dipper@sender.example')
  await context.close()
})

test('a block made before of an address with letters beyond A to Z is not undone', async ({
  browser,
}) => {
  const alice = await asAlice()
  // The canister keeps it as given, past A to Z
  await alice.mail_block('alice', 'Ärla@sender.example')
  deliver({
    subject: 'Foreign grosbeak',
    body: '<p>A grosbeak.</p>',
    from: 'Ärla <Ärla@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  await messageRow(page, 'Foreign grosbeak').click()
  await menuItem(page, 'More actions', 'Block sender')
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Ärla@sender.example was blocked already/)
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await alice.mail_unblock('alice', 'Ärla@sender.example')
  await context.close()
})

test('a note holding the focus stays until the focus leaves', async ({
  browser,
}) => {
  deliver({ subject: 'Lingering tanager', body: '<p>A tanager.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'tanager')
  await messageRow(page, 'Lingering tanager').hover()
  await page.getByRole('button', { name: 'Delete: Lingering tanager' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await note.getByRole('button', { name: 'Undo' }).focus()
  // The pointer passing over and away leaves the focus's hold in place
  await note.hover()
  await page.mouse.move(600, 400)
  // Longer than a note stays by itself
  await page.waitForTimeout(9_000)
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(messageRow(page, 'Lingering tanager')).toHaveCount(1)
  await context.close()
})

test('a note that takes the place of a held note stays held', async ({
  browser,
}) => {
  deliver({ subject: 'Held limpkin', body: '<p>A limpkin.</p>' })
  deliver({ subject: 'Held coot', body: '<p>A coot.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  // Each search's own list, before the hover: one that lands later moves the
  // row away from the pointer
  const rows = page.locator('li.message-row')
  await search(page, 'limpkin')
  await expect(rows).toHaveCount(1)
  await messageRow(page, 'Held limpkin').hover()
  await page.getByRole('button', { name: 'Delete: Held limpkin' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await search(page, 'coot')
  await expect(rows).toHaveCount(1)
  const moving = await hold(page, 'mail_move')
  await messageRow(page, 'Held coot').hover()
  await page.getByRole('button', { name: 'Delete: Held coot' }).click()
  await moving.seen
  // The pointer rests on the first note when the second takes its place
  await note.hover()
  moving.release()
  await expect(messageRow(page, 'Held coot')).toHaveCount(0)
  await page.waitForTimeout(9_000)
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible({
    timeout: 1_000,
  })
  await context.close()
})

// From the Spam folder's reader, which keeps the message where it is
test('Undo of a block shows on the Blocked senders page', async ({
  browser,
}) => {
  deliver({
    subject: 'Hasty jay',
    body: '<p>A jay.</p>',
    from: 'Hasty <hasty@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Hasty jay')
  await alice.mail_move('alice', [uid], FOLDER_SPAM)
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  await messageRow(page, 'Hasty jay').click()
  await expect(page.getByTestId('subject')).toHaveText('Hasty jay')
  // Spam has Block sender in its menu, and asks nothing
  const dialogs = answer(page)
  await menuItem(page, 'More actions', 'Block sender')
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Blocked hasty@sender.example/)
  await menuItem(page, 'More', 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('hasty@sender.example')
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(blocked).not.toContainText('hasty@sender.example')
  expect(dialogs).toEqual([])
  await context.close()
})

test("Spam in the reader offers to block the sender, and that block's Undo brings the message back", async ({
  browser,
}) => {
  deliver({
    subject: 'Brash kittiwake',
    body: '<p>A kittiwake.</p>',
    from: 'Brash <brash@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  const dialogs = answer(page)
  await openMail(page, 'kittiwake')
  await expect(page.getByTestId('subject')).toHaveText('Brash kittiwake')
  // The Inbox's reader blocks no one by itself: the note offers it
  await openMenu(page, 'More actions')
  await expect(
    menu(page, 'More actions').getByRole('button', { name: 'Mark unread' })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Block sender' })).toHaveCount(
    0
  )
  await page.keyboard.press('Escape')
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Message moved to Spam/)
  await expect(messageRow(page, 'Brash kittiwake')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(
    note.getByRole('button', { name: 'Block sender' })
  ).toHaveAttribute('title', 'Block brash@sender.example')

  await note.getByRole('button', { name: 'Block sender' }).click()
  await expect(note).toHaveText(/Blocked brash@sender.example/)
  await menuItem(page, 'More', 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('brash@sender.example')

  // Undo unblocks the address and brings the message back from Spam
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(blocked).not.toContainText('brash@sender.example')
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).not.toContain('brash@sender.example')
  await openMail(page, 'kittiwake')
  await expect(page.getByTestId('subject')).toHaveText('Brash kittiwake')
  expect(dialogs).toEqual([])
  await context.close()
})

test('a block refused after Spam shows why, and its Undo still brings the message back', async ({
  browser,
}) => {
  deliver({
    subject: 'Refused gannet',
    body: '<p>A gannet.</p>',
    from: 'Gannet <gannet@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'gannet')
  await expect(page.getByTestId('subject')).toHaveText('Refused gannet')
  // The block itself fails; the list of blocked addresses it reads first
  // goes through. Its name holds mail_block too.
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_block') &&
    !callsTo(route.request(), 'mail_blocked')
      ? route.abort('failed')
      : route.fallback()
  )
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Message moved to Spam/)
  await expect(messageRow(page, 'Refused gannet')).toHaveCount(0)
  await toastButton(page, 'Block sender')
  // The refusal, after the agent's own retries, with the move's Undo
  await expect(note).toHaveText(
    /Blocking gannet@sender\.example failed: [\s\S]*The message is in Spam\./,
    { timeout: 60_000 }
  )
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(note.getByRole('button', { name: 'Block sender' })).toHaveCount(
    0
  )
  // Undo first, before the note's time runs out
  await undo(page)
  await expect(messageRow(page, 'Refused gannet')).toHaveCount(1)
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).not.toContain('gannet@sender.example')
  await openMail(page, 'gannet')
  await expect(page.getByTestId('subject')).toHaveText('Refused gannet')
  await context.close()
})

test("the reader's Mark unread waits until its own mark as read has landed", async ({
  browser,
}) => {
  deliver({ subject: 'Waiting merlin', body: '<p>A merlin.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  const marked = await hold(page, 'mail_set_flags')
  await openMail(page, 'merlin')
  await expect(page.getByTestId('subject')).toHaveText('Waiting merlin')
  await marked.seen
  // Parsed, with its sender known: only the mark as read still holds it
  await expect(
    reader(page).getByRole('button', { name: 'Reply', exact: true })
  ).toBeEnabled()
  await openMenu(page, 'More actions')
  const item = menu(page, 'More actions').getByRole('button', {
    name: 'Mark unread',
  })
  await expect(item).toBeDisabled()
  marked.release()
  await expect(item).toBeEnabled()
  await context.close()
})

test("the reader's Mark unread marks the message unread and closes it", async ({
  browser,
}) => {
  deliver({ subject: 'Unread kestrel', body: '<p>A kestrel.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Unread kestrel')
  // As stored, read without opening it
  const seen = async () =>
    ((await alice.mail_get('alice', uid)).summary.flags & FLAG_SEEN) !== 0n
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'kestrel')
  await expect(page.getByTestId('subject')).toHaveText('Unread kestrel')
  const unread = page.locator('button.message.unread', {
    hasText: 'Unread kestrel',
  })
  // Read by opening it, first
  await expect(unread).toHaveCount(0)
  await expect.poll(seen).toBe(true)
  await menuItem(page, 'More actions', 'Mark unread')
  await expect(reader(page)).toHaveCount(0)
  await expect(unread).toHaveCount(1)
  await expect.poll(seen).toBe(false)
  await context.close()
})
