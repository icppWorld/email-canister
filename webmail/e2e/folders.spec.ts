// The webmail tests of Trash, Spam, blocked senders and the notes.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test'
import { asUser } from './as_user'
import { env } from './local'
import {
  answer,
  argOf,
  asAlice,
  backdate,
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
  navItem,
  openMail,
  openMenu,
  reader,
  refreshList,
  search,
  selectAll,
  signedIn,
  signInAgain,
  spamFromReader,
  stale,
  stopSelecting,
  toastButton,
  uidOf,
  undo,
  USER_A,
  waitDrained,
  watch,
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

test('a ticked message that a reload takes off the list comes back unticked', async ({
  browser,
}) => {
  for (const bird of ['godwit', 'curlew']) {
    deliver({ subject: `Tickgone ${bird}`, body: `<p>A ${bird}.</p>` })
  }
  await waitDrained()
  const alice = await asAlice()
  const godwit = await uidOf(alice, 'alice', 'Tickgone godwit')
  // The list reloads by itself only while no search is shown
  const { context, page } = await signedIn(browser, USER_A)
  await expect(messageRow(page, 'Tickgone')).toHaveCount(2)
  await page.getByLabel('Select Tickgone godwit', { exact: true }).check()
  // Moved away, as by another member, and gone at the list's next load
  await alice.mail_move('alice', [godwit], FOLDER_TRASH)
  await expect(messageRow(page, 'Tickgone godwit')).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(messageRow(page, 'Tickgone curlew')).toHaveCount(1)
  // and back
  await alice.mail_move('alice', [godwit], FOLDER_INBOX)
  await refreshList(page)
  await expect(messageRow(page, 'Tickgone')).toHaveCount(2)
  await expect(
    page.getByLabel('Select Tickgone godwit', { exact: true })
  ).not.toBeChecked()
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)
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
  await selectAll(page)
  await expect(bulk).toContainText('3 selected')
  expect(await background()).not.toBe(unticked)
  await bulk.getByRole('button', { name: 'Mark read' }).click()
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await bulk.getByRole('button', { name: 'Mark unread' }).click()
  await expect(page.locator('button.message.unread')).toHaveCount(3)
  await stopSelecting(page)

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

  await selectAll(page)
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
  await menuItem(page, 'List actions', 'Empty Trash')
  await expect(page.getByText('Nothing in Trash.')).toBeVisible()
  await context.close()
})

test("the selection bar's buttons sit on one line in a list of the usual width", async ({
  browser,
}) => {
  for (const n of [1, 2]) {
    deliver({ subject: `Lined phalarope ${n}`, body: '<p>A phalarope.</p>' })
  }
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'phalarope')
  await expect(messageRow(page, 'Lined phalarope')).toHaveCount(2)
  const list = page.getByRole('region', { name: 'Messages' })
  expect((await list.boundingBox())!.width).toBeCloseTo(380, 0)
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await expect(bulk).toContainText('2 selected')
  const buttons = bulk.getByRole('button', {
    name: /^(Stop selecting|Delete|Spam|Mark read|Mark unread|Star)$/,
  })
  await expect(buttons).toHaveCount(6)
  const tops = await buttons.evaluateAll((all) =>
    all.map((button) => button.getBoundingClientRect().top)
  )
  expect(new Set(tops).size, `tops: ${tops.join(', ')}`).toBe(1)
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
  await spamFromReader(page)
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    'Message moved to Spam and pushy@sender.example blocked'
  )
  await expect(messageRow(page, 'Pushy grebe')).toHaveCount(0)

  // New mail from the address goes to Spam, by its From address
  deliver({ subject: 'Pushy grebe again', body: '<p>Last chance.</p>', from })
  await waitDrained()
  await folder(page, 'Spam')
  await expect(page).toHaveURL(/#alice\/spam$/)
  await expect(messageRow(page, 'Pushy grebe')).toHaveCount(2)

  await navItem(page, 'Blocked senders')
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
  await refreshList(page)
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
  await selectAll(page)
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

// Snow has the mailbox snipe, Tern skua and Uma auklet, with seeded mail in
// Trash
const SNOW = '4b'.repeat(32)
const TERN = '4c'.repeat(32)
const UMA = '4d'.repeat(32)

// The seeded mail of a mailbox of its own, in Trash, shown there
async function seededTrash(
  browser: Browser,
  local: string,
  seed: string
): Promise<{ context: BrowserContext; page: Page; uids: bigint[] }> {
  joinMailbox(local, seed)
  backend('dev_seed', `("${local}", 1 : nat64, 120 : nat64)`)
  const member = await asUser(seed, env.url, env.backend)
  const uids = Array.from({ length: 120 }, (_, n) => BigInt(n + 1))
  const [moved] = await member.mail_move(local, uids, FOLDER_TRASH)
  expect(moved).toBe(120n)
  const { context, page } = await signedIn(browser, seed)
  await expect(page.getByTestId('address')).toHaveText(`${local}@${DOMAIN}`)
  await folder(page, 'Trash')
  await expect(page.locator('button.message')).toHaveCount(50)
  return { context, page, uids }
}

test('Empty Trash refused part way leaves only what is still there', async ({
  browser,
}) => {
  const { context, page } = await seededTrash(browser, 'snipe', SNOW)
  // The first part goes, the second is refused
  let deletes = 0
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_delete') && ++deletes > 1
      ? route.abort('failed')
      : route.fallback()
  )
  page.once('dialog', (dialog) => dialog.accept())
  await menuItem(page, 'List actions', 'Empty Trash')
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
    callsTo(route.request(), 'mail_list') && ++lists > 1
      ? route.abort('failed')
      : route.fallback()
  )
  page.once('dialog', (dialog) => dialog.accept())
  await menuItem(page, 'List actions', 'Empty Trash')
  // One page holds the rest. The reload and the agent's 3 tries more, then at
  // once, not at the next timed refresh.
  await expect.poll(() => lists, { timeout: 60_000 }).toBe(5)
  await expect(
    page.getByRole('region', { name: 'Messages' }).getByRole('alert')
  ).toBeVisible({ timeout: 2_000 })
  await context.close()
})

// The block follows the move: a refused move blocks no one
test('a move to Spam that is refused blocks no one', async ({ browser }) => {
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
  await spamFromReader(page)
  // The refusal shows beside the message, after the agent's own retries
  await expect(reader(page).getByRole('alert')).toBeVisible({
    timeout: 60_000,
  })
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
  await navItem(page, 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('hasty@sender.example')
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(blocked).not.toContainText('hasty@sender.example')
  expect(dialogs).toEqual([])
  await context.close()
})

test('Spam in the reader blocks the sender, and Undo unblocks them and brings the message back', async ({
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
  // The Inbox's reader has Spam, which blocks, and no Block sender of its own
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
  // One click: moved and blocked
  await expect(note.locator('span')).toHaveText(
    'Message moved to Spam and brash@sender.example blocked'
  )
  await expect(messageRow(page, 'Brash kittiwake')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Block sender' })).toHaveCount(
    0
  )
  await navItem(page, 'Blocked senders')
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

test('ticked messages to Spam block each sender once, and Undo lifts only those blocks', async ({
  browser,
}) => {
  for (const n of [1, 2]) {
    deliver({
      subject: `Flocking starling ${n}`,
      body: '<p>A starling.</p>',
      from: 'Flock <Flock@sender.example>',
    })
  }
  deliver({
    subject: 'Flocking rook',
    body: '<p>A rook.</p>',
    from: 'Rook <rook@sender.example>',
  })
  await waitDrained()
  // Blocked before the move: its Undo leaves this block alone, also when a
  // read of the blocked senders lags behind it
  const alice = await asAlice()
  await alice.mail_block('alice', 'rook@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  await stale(
    page,
    'mail_blocked',
    () => alice.mail_unblock('alice', 'rook@sender.example'),
    () => alice.mail_block('alice', 'rook@sender.example')
  )
  await search(page, 'Flocking')
  await expect(messageRow(page, 'Flocking')).toHaveCount(3)
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await bulk.getByRole('button', { name: 'Spam', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    '3 messages moved to Spam and flock@sender.example blocked'
  )
  await expect(messageRow(page, 'Flocking')).toHaveCount(0)
  expect(await blockedAddresses(alice)).toEqual(
    expect.arrayContaining(['flock@sender.example', 'rook@sender.example'])
  )

  await undo(page)
  await expect(messageRow(page, 'Flocking')).toHaveCount(3)
  const after = await blockedAddresses(alice)
  expect(after).not.toContain('flock@sender.example')
  expect(after).toContain('rook@sender.example')
  await alice.mail_unblock('alice', 'rook@sender.example')
  await context.close()
})

test('a block whose reply is lost leaves the other senders blocked, and Undo lifts only theirs', async ({
  browser,
}) => {
  for (const bird of ['ruff', 'reeve']) {
    deliver({
      subject: `Wading ${bird}`,
      body: `<p>A ${bird}.</p>`,
      from: `Wader <${bird}@sender.example>`,
    })
  }
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'Wading')
  await expect(messageRow(page, 'Wading')).toHaveCount(2)
  // ruff's block reaches the canister, and its reply is lost
  await page.route('**/api/*/canister/*/*', async (route) => {
    const request = route.request()
    if (
      callsTo(request, 'mail_block') &&
      !callsTo(request, 'mail_blocked') &&
      argOf(request).includes('ruff@sender.example')
    ) {
      await route.fetch()
      await route.abort('failed')
    } else {
      await route.fallback()
    }
  })
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await bulk.getByRole('button', { name: 'Spam', exact: true }).click()
  // reeve's block is not held up by ruff's, nor skipped after it
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    /^2 messages moved to Spam and reeve@sender\.example blocked\. Blocking ruff@sender\.example failed: /,
    { timeout: 60_000 }
  )
  await note.hover()
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).toEqual(
    expect.arrayContaining(['reeve@sender.example', 'ruff@sender.example'])
  )
  // ruff may have been blocked before: with no reply, its block stays
  await undo(page)
  await expect(messageRow(page, 'Wading')).toHaveCount(2)
  const after = await blockedAddresses(alice)
  expect(after).not.toContain('reeve@sender.example')
  expect(after).toContain('ruff@sender.example')
  await alice.mail_unblock('alice', 'ruff@sender.example')
  await context.close()
})

test('an unblock refused in Undo still brings the message back, and the note says what to do', async ({
  browser,
}) => {
  deliver({
    subject: 'Stuck sanderling',
    body: '<p>A sanderling.</p>',
    from: 'Sanderling <sanderling@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'sanderling')
  await expect(page.getByTestId('subject')).toHaveText('Stuck sanderling')
  await spamFromReader(page)
  const note = page.getByTestId('toast').locator('span')
  await expect(note).toHaveText(
    'Message moved to Spam and sanderling@sender.example blocked'
  )
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_unblock')
      ? route.abort('failed')
      : route.fallback()
  )
  await undo(page)
  // After the agent's own retries; the message is back, so no Undo again
  await expect(note).toHaveText(
    "Message moved to the Inbox. Couldn't unblock " +
      'sanderling@sender.example: unblock it under Blocked senders',
    { timeout: 60_000 }
  )
  await expect(
    page.getByTestId('toast').getByRole('button', { name: 'Undo' })
  ).toHaveCount(0)
  await expect(messageRow(page, 'Stuck sanderling')).toHaveCount(1)
  await page.unrouteAll({ behavior: 'wait' })
  const alice = await asAlice()
  await alice.mail_unblock('alice', 'sanderling@sender.example')
  await context.close()
})

// The canister says whether a block is new, so Spam reads no list first
test('Spam blocks the sender when the blocked senders cannot be read', async ({
  browser,
}) => {
  deliver({
    subject: 'Unlisted godwit',
    body: '<p>A godwit.</p>',
    from: 'Godwit <godwit@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_blocked')
      ? route.abort('failed')
      : route.fallback()
  )
  await openMail(page, 'godwit')
  await expect(page.getByTestId('subject')).toHaveText('Unlisted godwit')
  await spamFromReader(page)
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    'Message moved to Spam and godwit@sender.example blocked'
  )
  await expect(messageRow(page, 'Unlisted godwit')).toHaveCount(0)
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).toContain('godwit@sender.example')
  await alice.mail_unblock('alice', 'godwit@sender.example')
  await context.close()
})

test("Spam blocks no address of the mailbox's own domain", async ({
  browser,
}) => {
  // Spam often claims to be from the recipient, or from the domain's own
  // services
  for (const [subject, address] of [
    ['Spoofed heron', `alice@${DOMAIN}`],
    ['Spoofed egret', `alerts@lists.${DOMAIN}`],
  ]) {
    deliver({ subject, body: '<p>Pay now.</p>', from: `Us <${address}>` })
  }
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  const alice = await asAlice()
  for (const [subject, address] of [
    ['Spoofed heron', `alice@${DOMAIN}`],
    ['Spoofed egret', `alerts@lists.${DOMAIN}`],
  ]) {
    await openMail(page, subject)
    await expect(page.getByTestId('subject')).toHaveText(subject)
    await spamFromReader(page)
    await expect(page.getByTestId('toast').locator('span')).toHaveText(
      'Message moved to Spam'
    )
    expect(await blockedAddresses(alice)).not.toContain(address)
  }
  await context.close()
})

test('Not spam unblocks the sender, its Undo blocks them again, and Spam links to Blocked senders', async ({
  browser,
}) => {
  const alice = await asAlice()
  await alice.mail_block('alice', 'stray@sender.example')
  deliver({
    subject: 'Stray plover',
    body: '<p>A plover.</p>',
    from: 'Stray <Stray@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  // The Spam folder's list leads to the senders it blocks
  await page
    .getByRole('region', { name: 'Messages' })
    .getByRole('button', { name: 'Blocked senders', exact: true })
    .click()
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('stray@sender.example')

  await folder(page, 'Spam')
  await messageRow(page, 'Stray plover').click()
  await expect(page.getByTestId('subject')).toHaveText('Stray plover')
  await page.getByRole('button', { name: 'Not spam', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    'Message moved to the Inbox and stray@sender.example unblocked'
  )
  await expect(messageRow(page, 'Stray plover')).toHaveCount(0)
  expect(await blockedAddresses(alice)).not.toContain('stray@sender.example')

  // Undo blocks the address again, and the message is back in Spam
  await undo(page)
  await expect(messageRow(page, 'Stray plover')).toHaveCount(1)
  expect(await blockedAddresses(alice)).toContain('stray@sender.example')
  await alice.mail_unblock('alice', 'stray@sender.example')
  await context.close()
})

test('a block refused after the move to Spam shows why, and Undo still brings the message back', async ({
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
  // The block fails; mail_blocked, whose name holds mail_block too, would
  // go through
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_block') &&
    !callsTo(route.request(), 'mail_blocked')
      ? route.abort('failed')
      : route.fallback()
  )
  await spamFromReader(page)
  // The reader closed with the move: the note says what failed, after the
  // agent's own retries, with the move's Undo
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(
    /^Message moved to Spam\. Blocking gannet@sender\.example failed: /,
    { timeout: 60_000 }
  )
  await expect(messageRow(page, 'Refused gannet')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
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

test('mail marked as Spam more than 30 days after it arrived is deleted for good, with Unblock and no Undo', async ({
  browser,
}) => {
  deliver({
    subject: 'Ancient auk',
    body: '<p>An auk.</p>',
    from: 'Auk <auk@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Ancient auk')
  backdate('alice', uid, 'received_ns', 31)
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'auk')
  await expect(page.getByTestId('subject')).toHaveText('Ancient auk')
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    'Message deleted for good: it arrived more than 30 days ago. ' +
      'auk@sender.example blocked'
  )
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  for (const folder of [FOLDER_INBOX, FOLDER_SPAM]) {
    const { items } = await alice.mail_search('alice', {
      query: 'auk',
      folder,
      cursor: [],
      limit: 1n,
    })
    expect(items).toHaveLength(0)
  }
  // The block alone can be taken back; held, so the note waits for that
  await note.hover()
  expect(await blockedAddresses(alice)).toContain('auk@sender.example')
  await toastButton(page, 'Unblock')
  await expect
    .poll(() => blockedAddresses(alice))
    .not.toContain('auk@sender.example')
  await context.close()
})

test('mail in Trash past its 30 days is restored to the Inbox, and stays there', async ({
  browser,
}) => {
  deliver({ subject: 'Expired murrelet', body: '<p>A murrelet.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Expired murrelet')
  await alice.mail_move('alice', [uid], FOLDER_TRASH)
  // Its arrival too: only a move to Spam counts from that
  backdate('alice', uid, 'received_ns', 31)
  backdate('alice', uid, 'folder_ns', 31)
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Trash')
  await messageRow(page, 'Expired murrelet').click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText('Message moved to the Inbox')
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
  // Kept by every cleanup since
  await expect
    .poll(() => backend('dev_clean_due', '("alice")'))
    .toContain('false')
  await openMail(page, 'murrelet')
  await expect(page.getByTestId('subject')).toHaveText('Expired murrelet')
  await context.close()
})

test('a move of mail another member moved already says it was no longer here', async ({
  browser,
}) => {
  deliver({ subject: 'Departed curlew', body: '<p>A curlew.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Departed curlew')
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'curlew')
  await expect(messageRow(page, 'Departed curlew')).toHaveCount(1)
  // As another member would, while the list still shows it
  await alice.mail_move('alice', [uid], FOLDER_TRASH)
  await messageRow(page, 'Departed curlew').hover()
  await page.getByRole('button', { name: 'Delete: Departed curlew' }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText('Message was no longer here')
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await context.close()
})

test('an Undo whose move back is refused keeps the block, and offers Undo again', async ({
  browser,
}) => {
  deliver({
    subject: 'Stubborn puffin',
    body: '<p>A puffin.</p>',
    from: 'Puffin <puffin@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'puffin')
  await expect(page.getByTestId('subject')).toHaveText('Stubborn puffin')
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    'Message moved to Spam and puffin@sender.example blocked'
  )
  let refusing = true
  await page.route('**/api/*/canister/*/*', (route) =>
    refusing && callsTo(route.request(), 'mail_move')
      ? route.abort('failed')
      : route.fallback()
  )
  await undo(page)
  // The refusal, after the agent's own retries, with Undo once more
  await expect(note.locator('span')).toHaveText(
    /^(?!Message moved to Spam)\S/,
    {
      timeout: 60_000,
    }
  )
  await note.hover()
  await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
  const alice = await asAlice()
  expect(await blockedAddresses(alice)).toContain('puffin@sender.example')
  await expect(messageRow(page, 'Stubborn puffin')).toHaveCount(0)

  refusing = false
  await undo(page)
  await expect(messageRow(page, 'Stubborn puffin')).toHaveCount(1)
  await expect
    .poll(() => blockedAddresses(alice))
    .not.toContain('puffin@sender.example')
  await context.close()
})

test('Undo of Not spam blocks again only the senders that click unblocked', async ({
  browser,
}) => {
  const alice = await asAlice()
  for (const bird of ['brant', 'scaup']) {
    deliver({
      subject: `Judged ${bird}`,
      body: `<p>A ${bird}.</p>`,
      from: `Bird <${bird}@sender.example>`,
    })
  }
  await waitDrained()
  for (const bird of ['brant', 'scaup']) {
    const uid = await uidOf(alice, 'alice', `Judged ${bird}`)
    await alice.mail_move('alice', [uid], FOLDER_SPAM)
  }
  await alice.mail_block('alice', 'brant@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  // A read of the blocked senders that lags behind scaup's unblock
  await stale(
    page,
    'mail_blocked',
    () => alice.mail_block('alice', 'scaup@sender.example'),
    () => alice.mail_unblock('alice', 'scaup@sender.example')
  )
  await folder(page, 'Spam')
  await search(page, 'Judged')
  await expect(messageRow(page, 'Judged')).toHaveCount(2)
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await bulk.getByRole('button', { name: 'Not spam', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    '2 messages moved to the Inbox and brant@sender.example unblocked'
  )
  expect(await blockedAddresses(alice)).not.toContain('brant@sender.example')
  await undo(page)
  await expect(messageRow(page, 'Judged')).toHaveCount(2)
  const after = await blockedAddresses(alice)
  expect(after).toContain('brant@sender.example')
  expect(after).not.toContain('scaup@sender.example')
  await alice.mail_unblock('alice', 'brant@sender.example')
  await context.close()
})

test('Block sender blocks the address the canister read, not the one the browser reads', async ({
  browser,
}) => {
  // The browser reads "odd petrel"@sender.example, which the canister does not
  // take: it gives no From address, so the envelope's is blocked
  deliver({
    subject: 'Quoted petrel',
    body: '<p>A petrel.</p>',
    from: '"odd petrel"@sender.example',
    envelopeUser: 'petrel',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Quoted petrel')
  await alice.mail_move('alice', [uid], FOLDER_SPAM)
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  await messageRow(page, 'Quoted petrel').click()
  await expect(page.getByTestId('subject')).toHaveText('Quoted petrel')
  await menuItem(page, 'More actions', 'Block sender')
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    'Blocked petrel@sender.example'
  )
  expect(await blockedAddresses(alice)).toContain('petrel@sender.example')
  await alice.mail_unblock('alice', 'petrel@sender.example')
  await context.close()
})

test('an unblock stays, with no read after it, and later reads that lag behind it leave it off', async ({
  browser,
}) => {
  deliver({ subject: 'Marked smew', body: '<p>A smew.</p>' })
  await waitDrained()
  const alice = await asAlice()
  await alice.mail_block('alice', 'lagging@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  // A note whose Undo reloads the page later
  await search(page, 'Marked smew')
  await messageRow(page, 'Marked smew').hover()
  await page.getByRole('button', { name: 'Delete: Marked smew' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await navItem(page, 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('lagging@sender.example')
  // Every read from here on lags behind the unblock: it lists the same block,
  // made at the same time
  const [lagging] = (await alice.mail_blocked('alice')).filter(
    (b) => b.address === 'lagging@sender.example'
  )
  const sql = (statement: string) =>
    Promise.resolve(backend('dev_file_exec', `("alice", "${statement}")`))
  await stale(
    page,
    'mail_blocked',
    () =>
      sql(
        'INSERT INTO blocked(address, blocked_by, at_ns) VALUES(' +
          `'lagging@sender.example', '${lagging.blocked_by.toText()}', ` +
          `${lagging.at_ns})`
      ),
    () => sql("DELETE FROM blocked WHERE address = 'lagging@sender.example'")
  )
  const reads = watch(page, 'mail_blocked')
  // Held by the focus until the Unblock, then 8 seconds more
  await note.getByRole('button', { name: 'Undo' }).focus()
  const unblocked = page.waitForResponse((response) =>
    callsTo(response.request(), 'mail_unblock')
  )
  await blocked
    .getByRole('listitem')
    .filter({ hasText: 'lagging@sender.example' })
    .getByRole('button', { name: 'Unblock' })
    .click()
  await unblocked
  await expect(blocked).not.toContainText('lagging@sender.example')
  await note.hover()
  // A later load, whose reply shows by a block made since
  await alice.mail_block('alice', 'marker@sender.example')
  await undo(page)
  await expect(blocked).toContainText('marker@sender.example')
  await expect(blocked).not.toContainText('lagging@sender.example')
  // That load's read alone: none followed the unblock
  expect(reads).toHaveLength(1)
  expect(await blockedAddresses(alice)).not.toContain('lagging@sender.example')
  await alice.mail_unblock('alice', 'marker@sender.example')
  await context.close()
})

test('Empty Trash goes on past a page that lists mail no longer there', async ({
  browser,
}) => {
  const { context, page, uids } = await seededTrash(browser, 'skua', TERN)
  const tern = await asUser(TERN, env.url, env.backend)
  // Its first page is read before the mail it lists leaves Trash, as a
  // replica that lags would read it
  const listing = await hold(page, 'mail_list', { late: true })
  page.once('dialog', (dialog) => dialog.accept())
  await menuItem(page, 'List actions', 'Empty Trash')
  await listing.seen
  const [moved] = await tern.mail_move('skua', uids.slice(20), FOLDER_INBOX)
  expect(moved).toBe(100n)
  listing.release()
  await expect(page.getByText('Nothing in Trash.')).toBeVisible()
  const { items } = await tern.mail_list('skua', {
    folder: FOLDER_TRASH,
    cursor: [],
    limit: 10n,
  })
  expect(items).toHaveLength(0)
  await context.close()
})

test('a search made while Trash empties is the one the list shows after', async ({
  browser,
}) => {
  const { context, page } = await seededTrash(browser, 'auklet', UMA)
  // The first part goes once the search is made, the second is refused
  let deletes = 0
  const deleting = await hold(page, 'mail_delete')
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_delete') && ++deletes > 1
      ? route.abort('failed')
      : route.fallback()
  )
  page.once('dialog', (dialog) => dialog.accept())
  await menuItem(page, 'List actions', 'Empty Trash')
  await deleting.seen
  // Seeded message 7 is among the 20 the refusal leaves
  await search(page, 'word7')
  deleting.release()
  await expect(
    page.getByRole('region', { name: 'Messages' }).getByRole('alert')
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('button.message')).toHaveCount(1)
  await expect(messageRow(page, 'seeded 7')).toHaveCount(1)
  await context.close()
})

test('a search goes on past pages the canister ended before a match, and never says No matches while it can go on', async ({
  browser,
}) => {
  // The match is the oldest: the search reaches the newer ones in Trash first
  deliver({ subject: 'Hidden dotterel', body: '<p>A dotterel.</p>' })
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    deliver({ subject: `Binned dotterel ${n}`, body: '<p>A dotterel.</p>' })
  }
  await waitDrained()
  const alice = await asAlice()
  const binned = await alice.mail_search('alice', {
    query: 'Binned',
    folder: FOLDER_INBOX,
    cursor: [],
    limit: 10n,
  })
  expect(binned.items).toHaveLength(7)
  await alice.mail_move(
    'alice',
    binned.items.map((m) => m.uid),
    FOLDER_TRASH
  )
  const { context, page } = await signedIn(browser, USER_A)
  await expect(page.locator('button.message').first()).toBeVisible()
  // Every page of a search then looks at one message
  const budgets = (instructions: string) =>
    backend(
      'dev_set_budgets',
      `(${instructions} : nat64, 1_073_741_824 : nat64)`
    )
  budgets('1')
  try {
    await search(page, 'dotterel')
    await expect(page.getByText('No matches yet.')).toBeVisible()
    await expect(page.getByText('No matches.', { exact: true })).toHaveCount(0)
    // A new search never goes on from the cursor of the search before it
    const next = await hold(page, 'mail_search')
    await search(page, 'plover')
    await next.seen
    await expect(
      page.getByRole('button', { name: 'Keep searching' })
    ).toHaveCount(0)
    next.release()
    await page.unrouteAll({ behavior: 'wait' })
    await search(page, 'dotterel')
    await page.getByRole('button', { name: 'Keep searching' }).click()
    await expect(messageRow(page, 'Hidden dotterel')).toHaveCount(1)
    await expect(
      page.getByRole('button', { name: 'Keep searching' })
    ).toHaveCount(0)
  } finally {
    budgets('3_000_000_000')
  }
  await context.close()
})

test('Undo of a Delete brings back only what it moved, not mail another member moved already', async ({
  browser,
}) => {
  for (const n of [1, 2]) {
    deliver({ subject: `Shared ibis ${n}`, body: '<p>An ibis.</p>' })
  }
  await waitDrained()
  const alice = await asAlice()
  const first = await uidOf(alice, 'alice', 'Shared ibis 1')
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'ibis')
  await expect(messageRow(page, 'Shared ibis')).toHaveCount(2)
  // As another member would, while the list still shows it
  await alice.mail_move('alice', [first], FOLDER_TRASH)
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    'Message moved to Trash. 1 was no longer here'
  )
  await undo(page)
  await expect(messageRow(page, 'Shared ibis 2')).toHaveCount(1)
  await expect(messageRow(page, 'Shared ibis 1')).toHaveCount(0)
  const { items } = await alice.mail_search('alice', {
    query: 'ibis',
    folder: FOLDER_TRASH,
    cursor: [],
    limit: 10n,
  })
  expect(items.map((m) => m.uid)).toEqual([first])
  await context.close()
})

test('Undo of Not spam on mail that arrived more than 30 days ago says it was deleted for good, also when its block is refused', async ({
  browser,
}) => {
  deliver({
    subject: 'Elderly scoter',
    body: '<p>A scoter.</p>',
    from: 'Scoter <scoter@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Elderly scoter')
  await alice.mail_move('alice', [uid], FOLDER_SPAM)
  await alice.mail_block('alice', 'scoter@sender.example')
  // After the move, which then kept it: the move back into Spam does not
  backdate('alice', uid, 'received_ns', 31)
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  await messageRow(page, 'Elderly scoter').click()
  await page.getByRole('button', { name: 'Not spam', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    'Message moved to the Inbox and scoter@sender.example unblocked'
  )
  // The block again is refused: the note says that, and what was deleted,
  // with no message left to block from
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_block') &&
    !callsTo(route.request(), 'mail_blocked')
      ? route.abort('failed')
      : route.fallback()
  )
  await undo(page)
  await expect(note.locator('span')).toHaveText(
    'Message deleted for good: it arrived more than 30 days ago. ' +
      "Couldn't block scoter@sender.example again",
    { timeout: 60_000 }
  )
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
  expect(await blockedAddresses(alice)).not.toContain('scoter@sender.example')
  for (const folder of [FOLDER_INBOX, FOLDER_SPAM]) {
    const { items } = await alice.mail_search('alice', {
      query: 'scoter',
      folder,
      cursor: [],
      limit: 1n,
    })
    expect(items).toHaveLength(0)
  }
  await context.close()
})

test('a block made before stays after Undo when its block during Spam was refused', async ({
  browser,
}) => {
  deliver({
    subject: 'Prior razorbill',
    body: '<p>A razorbill.</p>',
    from: 'Razorbill <razorbill@sender.example>',
  })
  await waitDrained()
  // After the delivery, so the message stays in the Inbox
  const alice = await asAlice()
  await alice.mail_block('alice', 'razorbill@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'razorbill')
  await expect(page.getByTestId('subject')).toHaveText('Prior razorbill')
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_block') &&
    !callsTo(route.request(), 'mail_blocked')
      ? route.abort('failed')
      : route.fallback()
  )
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    /^Message moved to Spam\. Blocking razorbill@sender\.example failed: /,
    { timeout: 60_000 }
  )
  await undo(page)
  await expect(messageRow(page, 'Prior razorbill')).toHaveCount(1)
  expect(await blockedAddresses(alice)).toContain('razorbill@sender.example')
  await alice.mail_unblock('alice', 'razorbill@sender.example')
  await context.close()
})

test('an address unblocked on Blocked senders shows once it is blocked again', async ({
  browser,
}) => {
  deliver({ subject: 'Reblocked pintail', body: '<p>A pintail.</p>' })
  await waitDrained()
  const alice = await asAlice()
  await alice.mail_block('alice', 'pintail@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  // A note whose Undo reloads the page later
  await search(page, 'pintail')
  await messageRow(page, 'Reblocked pintail').hover()
  await page.getByRole('button', { name: 'Delete: Reblocked pintail' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await navItem(page, 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await note.getByRole('button', { name: 'Undo' }).focus()
  await blocked
    .getByRole('listitem')
    .filter({ hasText: 'pintail@sender.example' })
    .getByRole('button', { name: 'Unblock' })
    .click()
  await expect(blocked).not.toContainText('pintail@sender.example')
  // Blocked again, by another member: a new block, which the next read shows
  await alice.mail_block('alice', 'pintail@sender.example')
  await note.hover()
  await undo(page)
  await expect(blocked).toContainText('pintail@sender.example')
  await alice.mail_unblock('alice', 'pintail@sender.example')
  await context.close()
})

for (const [ending, bird] of [
  ['answered', 'eider'],
  ['refused', 'goldeneye'],
] as const) {
  test(`a slow Undo's own note gives way to a newer note, which keeps its Undo, ${ending}`, async ({
    browser,
  }) => {
    for (const age of ['Aged', 'Young']) {
      deliver({ subject: `${age} ${bird}`, body: `<p>A ${bird}.</p>` })
    }
    await waitDrained()
    const alice = await asAlice()
    const aged = await uidOf(alice, 'alice', `Aged ${bird}`)
    const young = await uidOf(alice, 'alice', `Young ${bird}`)
    await alice.mail_move('alice', [aged, young], FOLDER_SPAM)
    // An Undo of its Not spam deletes it, which the Undo's own note would say
    backdate('alice', aged, 'received_ns', 31)
    const { context, page } = await signedIn(browser, USER_A)
    await folder(page, 'Spam')
    await search(page, bird)
    await expect(messageRow(page, bird)).toHaveCount(2)
    await messageRow(page, `Aged ${bird}`).hover()
    await page.getByRole('button', { name: `Not spam: Aged ${bird}` }).click()
    const note = page.getByTestId('toast')
    await expect(note.locator('span')).toHaveText('Message moved to the Inbox')
    // The Undo's move is held: answered at once with its reply held, or
    // refused, its agent's retries too
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    let reached = () => {}
    const seen = new Promise<void>((resolve) => (reached = resolve))
    let first = true
    let refusing = false
    await page.route('**/api/*/canister/*/*', async (route) => {
      if (!callsTo(route.request(), 'mail_move')) return route.fallback()
      if (refusing) return route.abort('failed')
      if (!first) return route.fallback()
      first = false
      if (ending === 'refused') {
        reached()
        await released
        refusing = true
        return route.abort('failed')
      }
      const url = new URL(route.request().url())
      url.hostname = '127.0.0.1'
      const response = await route.fetch({ url: url.toString() })
      reached()
      await released
      await route.fulfill({ response })
    })
    await undo(page)
    await seen
    await messageRow(page, `Young ${bird}`).hover()
    await page.getByRole('button', { name: `Not spam: Young ${bird}` }).click()
    await expect(note.locator('span')).toHaveText('Message moved to the Inbox')
    await note.hover()
    // The Undo's reload comes after its note was decided on
    const reloaded = page.waitForRequest(
      (request) =>
        callsTo(request, 'mail_search') || callsTo(request, 'mail_list'),
      { timeout: 60_000 }
    )
    release()
    await reloaded
    await expect(note.locator('span')).toHaveText('Message moved to the Inbox')
    await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible()
    await context.close()
  })
}

test("Spam from the reader blocks the From address the reader read, when the list's copy has none", async ({
  browser,
}) => {
  deliver({
    subject: 'Blank shearwater',
    body: '<p>A shearwater.</p>',
    from: 'Shearwater <shearwater@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Blank shearwater')
  const sql = (statement: string) =>
    backend('dev_file_exec', `("alice", "${statement}")`)
  // Listed as before its parse, with no From address
  sql(`UPDATE messages SET sender = '', sender_address = '' WHERE uid = ${uid}`)
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'shearwater')
  await expect(messageRow(page, 'Blank shearwater')).toHaveCount(1)
  // Parsed since: the reader reads it with its address
  sql(
    "UPDATE messages SET sender = 'Shearwater <shearwater@sender.example>', " +
      `sender_address = 'shearwater@sender.example' WHERE uid = ${uid}`
  )
  await messageRow(page, 'Blank shearwater').click()
  await expect(page.getByTestId('subject')).toHaveText('Blank shearwater')
  await spamFromReader(page)
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    'Message moved to Spam and shearwater@sender.example blocked'
  )
  expect(await blockedAddresses(alice)).toContain('shearwater@sender.example')
  await alice.mail_unblock('alice', 'shearwater@sender.example')
  await context.close()
})

test('an Unblock that ends after a block made again leaves that block shown', async ({
  browser,
}) => {
  deliver({ subject: 'Twice phalarope', body: '<p>A phalarope.</p>' })
  await waitDrained()
  const alice = await asAlice()
  await alice.mail_block('alice', 'twice@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  // A note whose Undo reloads the page later
  await search(page, 'Twice phalarope')
  await messageRow(page, 'Twice phalarope').hover()
  await page.getByRole('button', { name: 'Delete: Twice phalarope' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await navItem(page, 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  const row = blocked
    .getByRole('listitem')
    .filter({ hasText: 'twice@sender.example' })
  await expect(row).toHaveCount(1)
  // The unblock goes through; its reply comes after a block made again
  const unblocking = await hold(page, 'mail_unblock', { late: true })
  await note.getByRole('button', { name: 'Undo' }).focus()
  await row.getByRole('button', { name: 'Unblock' }).click()
  await unblocking.seen
  await expect
    .poll(() => blockedAddresses(alice))
    .not.toContain('twice@sender.example')
  await alice.mail_block('alice', 'twice@sender.example')
  // The reload shows that new block before the unblock's reply lands
  const reloaded = page.waitForResponse((response) =>
    callsTo(response.request(), 'mail_blocked')
  )
  await note.hover()
  await undo(page)
  await reloaded
  unblocking.release()
  await page.waitForTimeout(2_000)
  await expect(row).toHaveCount(1)
  await alice.mail_unblock('alice', 'twice@sender.example')
  await context.close()
})

test("Not spam from the reader unblocks the From address the reader read, when the list's copy has none", async ({
  browser,
}) => {
  deliver({
    subject: 'Blank turnstone',
    body: '<p>A turnstone.</p>',
    from: 'Turnstone <turnstone@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Blank turnstone')
  await alice.mail_move('alice', [uid], FOLDER_SPAM)
  await alice.mail_block('alice', 'turnstone@sender.example')
  const sql = (statement: string) =>
    backend('dev_file_exec', `("alice", "${statement}")`)
  // Listed as before its parse, with no From address
  sql(`UPDATE messages SET sender = '', sender_address = '' WHERE uid = ${uid}`)
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Spam')
  await search(page, 'turnstone')
  await expect(messageRow(page, 'Blank turnstone')).toHaveCount(1)
  // Parsed since: the reader reads it with its address
  sql(
    "UPDATE messages SET sender = 'Turnstone <turnstone@sender.example>', " +
      `sender_address = 'turnstone@sender.example' WHERE uid = ${uid}`
  )
  await messageRow(page, 'Blank turnstone').click()
  await expect(
    reader(page).getByRole('button', { name: 'Reply' })
  ).toBeEnabled()
  await reader(page)
    .getByRole('button', { name: 'Not spam', exact: true })
    .click()
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    'Message moved to the Inbox and turnstone@sender.example unblocked'
  )
  expect(await blockedAddresses(alice)).not.toContain(
    'turnstone@sender.example'
  )
  await context.close()
})

// Vera has the mailbox stilt, filled with seeded mail from one sender
const VERA = '52'.repeat(32)

test('an Undo whose move back is refused part way says what moved back, and leaves the blocks', async ({
  browser,
}) => {
  joinMailbox('stilt', VERA)
  backend('dev_seed', '("stilt", 1 : nat64, 120 : nat64)')
  // Seeded mail has no arrival time, and Spam would delete it as old
  backend(
    'dev_file_exec',
    `("stilt", "UPDATE messages SET sender_address = 'seed@sender.example', ` +
      `received_ns = ${BigInt(Date.now()) * 1_000_000n}")`
  )
  const vera = await asUser(VERA, env.url, env.backend)
  const { context, page } = await signedIn(browser, VERA)
  await expect(page.getByTestId('address')).toHaveText(`stilt@${DOMAIN}`)
  for (const shown of [100, 120]) {
    await page.getByRole('button', { name: 'Older mail' }).click()
    await expect(page.locator('button.message')).toHaveCount(shown)
  }
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await selectAll(page)
  await expect(bulk).toContainText('120 selected')
  await bulk.getByRole('button', { name: 'Spam', exact: true }).click()
  const note = page.getByTestId('toast')
  await expect(note.locator('span')).toHaveText(
    '120 messages moved to Spam and seed@sender.example blocked'
  )
  // The move back's first part goes, the second is refused
  let moves = 0
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_move') && ++moves > 1
      ? route.abort('failed')
      : route.fallback()
  )
  await undo(page)
  await expect(note.locator('span')).toHaveText(
    /^100 messages moved to the Inbox\. Couldn't move 20 back: .+\. Senders' blocks unchanged$/,
    { timeout: 60_000 }
  )
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  expect((await vera.mail_blocked('stilt')).map((b) => b.address)).toContain(
    'seed@sender.example'
  )
  await context.close()
})
