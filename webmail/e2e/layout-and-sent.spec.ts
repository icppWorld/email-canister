// The webmail tests of the menus, the layout, the compose window and Sent.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, type Locator, type Route, test } from '@playwright/test'
import { asUser } from './as_user'
import { env } from './local'
import {
  ADMIN,
  argOf,
  asAlice,
  backend,
  bodyOf,
  callsTo,
  compose,
  deliver,
  DOMAIN,
  FLAG_SEEN,
  folder,
  FOLDER_INBOX,
  FOLDER_SPAM,
  freshBackend,
  hold,
  joinMailbox,
  joinTeam,
  menu,
  menuItem,
  messageRow,
  nav,
  openMail,
  openMenu,
  reader,
  roleColour,
  search,
  send,
  signedIn,
  spamAndBlock,
  uidOf,
  USER_A,
  USER_C,
  USER_D,
  waitDrained,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

test('the header menu holds Blocked senders, Download a copy and, for a controller, Admin', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await expect(nav(page).getByRole('button', { name: 'Inbox' })).toBeVisible()
  // No longer among the folders
  for (const name of ['Blocked senders', 'Download a copy', 'Admin']) {
    await expect(nav(page).getByRole('button', { name })).toHaveCount(0)
  }
  const more = menu(page, 'More')
  const blockedItem = more.getByRole('button', { name: 'Blocked senders' })
  await openMenu(page, 'More')
  await expect(blockedItem).toBeVisible()
  await expect(
    more.getByRole('button', { name: 'Download a copy' })
  ).toBeVisible()
  await expect(more.getByRole('button', { name: 'Admin' })).toHaveCount(0)

  // Escape closes it, and so does a click beside it
  await page.keyboard.press('Escape')
  await expect(blockedItem).toBeHidden()
  await openMenu(page, 'More')
  await expect(blockedItem).toBeVisible()
  await page.getByTestId('address').click()
  await expect(blockedItem).toBeHidden()
  // and the item chosen
  await menuItem(page, 'More', 'Blocked senders')
  await expect(
    page.getByRole('region', { name: 'Blocked senders' })
  ).toBeVisible()
  await expect(blockedItem).toBeHidden()
  await context.close()

  // A controller with no mailbox has only Admin there
  const admin = await signedIn(browser, ADMIN)
  await expect(
    admin.page.getByRole('heading', { name: 'Administration' })
  ).toBeVisible()
  await expect(
    nav(admin.page).getByRole('button', { name: 'Admin' })
  ).toHaveCount(0)
  await openMenu(admin.page, 'More')
  const adminMenu = menu(admin.page, 'More')
  await expect(adminMenu.getByRole('button', { name: 'Admin' })).toBeVisible()
  await expect(adminMenu.getByRole('button')).toHaveCount(1)
  await admin.context.close()
})

test('a menu gives the focus back to its button, and closes when the focus leaves it or the window changes size', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  const more = menu(page, 'More')
  const button = page.getByLabel('More', { exact: true })
  const blockedItem = more.getByRole('button', { name: 'Blocked senders' })

  // The item chosen hands the focus back to the ⋮
  await menuItem(page, 'More', 'Blocked senders')
  await expect(blockedItem).toBeHidden()
  await expect(button).toBeFocused()

  // Tab past the last item leaves the menu, which closes behind it
  await openMenu(page, 'More')
  const last = more.getByRole('button', { name: 'Download a copy' })
  await last.focus()
  await page.keyboard.press('Tab')
  await expect(blockedItem).toBeHidden()
  // A closed menu's items are out of the accessibility tree, so the check
  // looks at the menu itself
  expect(await more.evaluate((m) => m.contains(document.activeElement))).toBe(
    false
  )

  // A window that changes width leaves no list behind
  await openMenu(page, 'More')
  await expect(blockedItem).toBeVisible()
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(blockedItem).toBeHidden()
  // Only the height, as a phone's keyboard or toolbar changes it: it stays
  await openMenu(page, 'More')
  await page.setViewportSize({ width: 900, height: 500 })
  await page.waitForTimeout(200)
  await expect(blockedItem).toBeVisible()
  await context.close()
})

test("a click in the message's frame closes the reader's menu", async ({
  browser,
}) => {
  // Long enough that its last line lies well below the menu's list
  const lines = Array.from({ length: 12 }, (_, i) => `<p>Line ${i + 1}</p>`)
  deliver({
    subject: 'Framed shearwater',
    body: `${lines.join('')}<p>The shearwater's last line</p>`,
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'shearwater')
  await expect(page.getByTestId('subject')).toHaveText('Framed shearwater')
  await openMenu(page, 'More actions')
  const item = menu(page, 'More actions').getByRole('button', {
    name: 'Mark unread',
  })
  await expect(item).toBeVisible()
  // The frame's own document: a click there never reaches the page's
  await bodyOf(page).getByText("The shearwater's last line").click()
  await expect(item).toBeHidden()
  await expect(reader(page)).toBeVisible()
  await context.close()
})

test('the selected folder is bold, with a bar in the action-text colour, and a hovered one is not', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const inbox = nav(page).getByRole('button', { name: 'Inbox', exact: true })
  const trash = nav(page).getByRole('button', { name: 'Trash', exact: true })
  await expect(inbox).toHaveAttribute('aria-current', 'true')
  const style = (button: Locator) =>
    button.evaluate((el) => {
      const computed = getComputedStyle(el)
      return {
        weight: computed.fontWeight,
        shadow: computed.boxShadow,
        background: computed.backgroundColor,
      }
    })
  // e2e/brand gives the bar a colour apart from the button's
  const bar = await roleColour(page, '--action-text')
  expect(bar).not.toBe(await roleColour(page, '--action'))
  const selected = await style(inbox)
  expect(selected.weight).toBe('700')
  expect(selected.shadow).toContain(bar)
  expect(selected.shadow).toContain('inset')
  // A bar at the side
  expect(selected.shadow).not.toContain('-3px')
  // Only the folder: the mailbox open above it keeps just the tint
  const mailbox = nav(page).getByRole('button', { name: /^alice/ })
  await expect(mailbox).toHaveAttribute('aria-current', 'true')
  const open = await style(mailbox)
  expect(open.shadow).toBe('none')
  expect(open.weight).not.toBe('700')

  // The hover's tint is the selected one's, and that is all it has
  await trash.hover()
  await expect
    .poll(async () => (await style(trash)).background)
    .toBe(selected.background)
  const hovered = await style(trash)
  expect(hovered.weight).not.toBe('700')
  expect(hovered.shadow).toBe('none')

  // At phone width the folders are tabs, with the bar below
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await style(inbox)).shadow).toContain('-3px')
  const tab = await style(inbox)
  expect(tab.shadow).toContain(bar)
  await context.close()
})

test("at phone width the reader's actions keep to one row, and its menu opens on screen", async ({
  browser,
}) => {
  deliver({ subject: 'Narrow sanderling', body: '<p>A sanderling.</p>' })
  await waitDrained()
  const viewport = { width: 390, height: 844 }
  const { context, page } = await signedIn(browser, USER_A, { viewport })
  await openMail(page, 'Narrow sanderling')
  await expect(page.getByTestId('subject')).toHaveText('Narrow sanderling')
  await openMenu(page, 'More actions')
  const list = menu(page, 'More actions').locator('.menu-items')
  await expect(list).toBeVisible()
  const box = await list.boundingBox()
  if (!box) throw new Error('no menu list')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)

  // By their middles: the buttons differ in height
  const middle = async (locator: Locator) => {
    const found = await locator.boundingBox()
    if (!found) throw new Error('not shown')
    return found.y + found.height / 2
  }
  const more = await middle(page.getByLabel('More actions', { exact: true }))
  for (const name of ['Back', 'Spam']) {
    const button = reader(page).getByRole('button', { name, exact: true })
    expect(Math.abs((await middle(button)) - more), name).toBeLessThan(2)
  }
  await context.close()
})

test('at phone width a ⋮ in the left half opens its list from the left', async ({
  browser,
}) => {
  deliver({ subject: 'Wrapped skua', body: '<p>A skua.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const uid = await uidOf(alice, 'alice', 'Wrapped skua')
  await alice.mail_move('alice', [uid], FOLDER_SPAM)
  const viewport = { width: 390, height: 844 }
  const { context, page } = await signedIn(browser, USER_A, { viewport })
  await folder(page, 'Spam')
  await messageRow(page, 'Wrapped skua').click()
  await expect(page.getByTestId('subject')).toHaveText('Wrapped skua')
  // Spam's actions take more than one row: the ⋮ starts the second, at the
  // left
  const button = page.getByLabel('More actions', { exact: true })
  const at = await button.boundingBox()
  if (!at) throw new Error('no menu button')
  expect(at.x + at.width / 2).toBeLessThan(viewport.width / 2)
  // Its first frame on screen too: where the list lies once the click and
  // React's render after it are done, before any later task, such as the
  // toggle event, has run
  const first = await button.evaluate(async (summary) => {
    ;(summary as HTMLElement).click()
    for (let i = 0; i < 3; i++) await Promise.resolve()
    const items = summary.parentElement?.querySelector('.menu-items')
    if (!items) throw new Error('no menu list')
    const { left, right } = items.getBoundingClientRect()
    return { left, right }
  })
  expect(first.left).toBeGreaterThanOrEqual(0)
  expect(first.right).toBeLessThanOrEqual(viewport.width)
  // and once it has settled
  const list = menu(page, 'More actions').locator('.menu-items')
  await expect(list).toBeVisible()
  const box = await list.boundingBox()
  if (!box) throw new Error('no menu list')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  await context.close()
})

test('a message marked unread while it loads stays unread', async ({
  browser,
}) => {
  joinTeam(USER_C, USER_D)
  deliver({ subject: 'Shared jacana', body: '<p>A jacana.</p>', to: 'team' })
  const other = await asUser(USER_D, env.url, env.backend)
  const uid = await uidOf(other, 'team', 'Shared jacana')
  // Read by the other member: shown read, but this member has not opened it
  await other.mail_set_flags('team', [uid], FLAG_SEEN, 0n)
  const { context, page } = await signedIn(browser, USER_C)
  await search(page, 'jacana')
  await expect(messageRow(page, 'Shared jacana')).toHaveCount(1)
  const loading = await hold(page, 'mail_get')
  await messageRow(page, 'Shared jacana').click()
  await loading.seen
  await messageRow(page, 'Shared jacana').hover()
  await page.getByRole('button', { name: 'Mark unread: Shared jacana' }).click()
  const unread = page.locator('button.message.unread', {
    hasText: 'Shared jacana',
  })
  await expect(unread).toHaveCount(1)
  loading.release()
  await expect(page.getByTestId('subject')).toHaveText('Shared jacana')
  // A moment more, for a write that would mark it read to show
  await page.waitForTimeout(2_000)
  await expect(unread).toHaveCount(1, { timeout: 1_000 })
  const { items } = await other.mail_search('team', {
    query: 'jacana',
    folder: FOLDER_INBOX,
    cursor: [],
    limit: 1n,
  })
  expect(items[0].flags & FLAG_SEEN).toBe(0n)
  await context.close()
})

test('an unblock made while the list reloads stays', async ({ browser }) => {
  deliver({
    subject: 'Rash wren',
    body: '<p>A wren.</p>',
    from: 'Rash <rash@sender.example>',
  })
  await waitDrained()
  const alice = await asAlice()
  await alice.mail_block('alice', 'brisk@sender.example')
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'wren')
  await expect(page.getByTestId('subject')).toHaveText('Rash wren')
  await spamAndBlock(page)
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Blocked rash@sender.example/)
  await menuItem(page, 'More', 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('brisk@sender.example')
  // The reload after Undo reads the list while brisk is still blocked
  const loading = await hold(page, 'mail_blocked', { late: true })
  await note.getByRole('button', { name: 'Undo' }).click()
  await loading.seen
  await blocked
    .getByRole('listitem')
    .filter({ hasText: 'brisk@sender.example' })
    .getByRole('button', { name: 'Unblock' })
    .click()
  await expect(blocked).not.toContainText('brisk@sender.example')
  loading.release()
  await expect(blocked).not.toContainText('rash@sender.example')
  // A moment more, for the earlier read to show
  await page.waitForTimeout(2_000)
  await expect(blocked).not.toContainText('brisk@sender.example', {
    timeout: 1_000,
  })
  await context.close()
})

test('the compose window minimises and fills the screen, keeping what it holds', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await compose(page, 'Window kestrel')
  const window = page.getByRole('dialog', { name: 'New message' })
  // The title bar names the message
  await expect(window.getByRole('heading')).toHaveText('Window kestrel')
  await window.getByLabel('Message').fill('Hovering.')
  await window.getByRole('button', { name: 'Minimise' }).click()
  await expect(window.getByLabel('Subject')).toBeHidden()
  const bar = await window.boundingBox()
  if (!bar) throw new Error('no window')
  expect(bar.height).toBeLessThan(80)
  // At the bottom right, clear of the note at the bottom left
  const width = page.viewportSize()?.width ?? 0
  expect(bar.x + bar.width).toBeGreaterThan(width - 40)
  await window.getByRole('button', { name: 'Restore' }).click()
  await expect(window.getByLabel('Message')).toHaveValue('Hovering.')
  await window.getByRole('button', { name: 'Full screen' }).click()
  const full = await window.boundingBox()
  if (!full) throw new Error('no window')
  expect(full.width).toBeGreaterThan(1100)
  expect(full.height).toBeGreaterThan(600)
  await expect(page.locator('.backdrop')).toBeVisible()
  await window.getByRole('button', { name: 'Exit full screen' }).click()
  const normal = await window.boundingBox()
  if (!normal) throw new Error('no window')
  expect(normal.width).toBeLessThanOrEqual(560)
  await expect(page.locator('.backdrop')).toHaveCount(0)
  await expect(window.getByLabel('Subject')).toHaveValue('Window kestrel')
  await window.getByRole('button', { name: 'Close' }).click()
  await expect(window).toHaveCount(0)
  await context.close()
})

test('at phone width the list and the open message take turns, and compose fills the screen', async ({
  browser,
}) => {
  deliver({ subject: 'Phone plover', body: '<p>A plover.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A, {
    viewport: { width: 390, height: 844 },
  })
  const list = page.getByRole('region', { name: 'Messages' })
  await openMail(page, 'plover')
  await expect(page.getByTestId('subject')).toHaveText('Phone plover')
  await expect(list).toBeHidden()
  // Its actions wrap rather than run off the side
  expect(
    await page
      .locator('article.reader')
      .evaluate((reader) => reader.scrollWidth <= reader.clientWidth)
  ).toBe(true)
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(list).toBeVisible()
  await expect(page.getByTestId('subject')).toHaveCount(0)
  // The list has the screen's height to itself
  const box = await list.boundingBox()
  if (!box) throw new Error('no list')
  expect(box.height).toBeGreaterThan(500)

  await page.getByRole('button', { name: 'Compose' }).click()
  const window = page.getByRole('dialog', { name: 'New message' })
  expect(await window.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  })
  await expect(window.getByRole('button', { name: 'Full screen' })).toBeHidden()
  await window.getByRole('button', { name: 'Minimise' }).click()
  const bar = await window.boundingBox()
  if (!bar) throw new Error('no window')
  expect(bar.height).toBeLessThan(80)
  expect(bar.y + bar.height).toBe(844)
  // The list ends above it, its last row and Older mail within reach
  const above = await list.boundingBox()
  if (!above) throw new Error('no list')
  expect(above.y + above.height).toBeLessThanOrEqual(bar.y + 1)
  await context.close()
})

test('on a touch screen the row box and star are large enough to tap', async ({
  browser,
}) => {
  deliver({ subject: 'Tapped dunlin', body: '<p>A dunlin.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  ).toBe(true)
  await search(page, 'dunlin')
  const row = page.locator('li.message-row', { hasText: 'Tapped dunlin' })
  await expect(row).toHaveCount(1)
  for (const target of [
    row.locator('.pick-area'),
    row.getByRole('button', { name: 'Star Tapped dunlin', exact: true }),
  ]) {
    const box = await target.boundingBox()
    if (!box) throw new Error('no target')
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
  // The box itself keeps its size, and a tap away from it ticks it
  const pick = row.getByRole('checkbox')
  const drawn = await pick.boundingBox()
  if (!drawn) throw new Error('no box')
  expect(drawn.width).toBeLessThan(32)
  await row.locator('.pick-area').tap({ position: { x: 40, y: 40 } })
  await expect(pick).toBeChecked()
  // The compose window's buttons, and its minimised bar still covers nothing
  await page.getByRole('button', { name: 'Compose' }).click()
  const window = page.getByRole('dialog', { name: 'New message' })
  for (const name of ['Minimise', 'Close']) {
    const box = await window.getByRole('button', { name }).boundingBox()
    if (!box) throw new Error(`no ${name}`)
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
  await window.getByRole('button', { name: 'Minimise' }).click()
  const restore = await window
    .getByRole('button', { name: 'Restore' })
    .boundingBox()
  if (!restore) throw new Error('no Restore')
  expect(restore.width).toBeGreaterThanOrEqual(44)
  expect(restore.height).toBeGreaterThanOrEqual(44)
  const bar = await window.boundingBox()
  const list = await page
    .getByRole('region', { name: 'Messages' })
    .boundingBox()
  if (!bar || !list) throw new Error('no bar or list')
  expect(list.y + list.height).toBeLessThanOrEqual(bar.y + 1)
  await context.close()
})

// A mailbox of its own, with more Sent mail than one page holds
async function fullSent(local: string, seed: string): Promise<void> {
  joinMailbox(local, seed)
  const box = await asUser(seed, env.url, env.backend)
  await Promise.all(
    Array.from({ length: 51 }, (_, i) =>
      box.mail_send(local, {
        client_id: crypto.randomUUID(),
        to: ['friend@example.org'],
        cc: [],
        bcc: [],
        subject: `Filler ${i}`,
        html_body: '<p>Filler</p>',
        attachments: [],
      })
    )
  )
}

const QUILL = '4c'.repeat(32)

test('a message sent while older mail is shown in Sent shows there', async ({
  browser,
}) => {
  await fullSent('quill', QUILL)
  const { context, page } = await signedIn(browser, QUILL)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await page.getByRole('button', { name: 'Older mail' }).click()
  await expect(sent.getByRole('listitem')).toHaveCount(51)
  await compose(page, 'Fresh quill')
  await send(page)
  await expect(page.getByRole('dialog', { name: 'New message' })).toHaveCount(0)
  await expect(sent).toContainText('Fresh quill', { timeout: 4_000 })
  await context.close()
})

const QUIRE = '4d'.repeat(32)

test('Older mail clicked while Sent reloads after a send leaves the reload in place', async ({
  browser,
}) => {
  await fullSent('quire', QUIRE)
  const { context, page } = await signedIn(browser, QUIRE)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(page.getByRole('button', { name: 'Older mail' })).toBeVisible()
  const loading = await hold(page, 'mail_outbox_list')
  await compose(page, 'Fresh quire')
  await send(page)
  await loading.seen
  await page.getByRole('button', { name: 'Older mail' }).click()
  loading.release()
  await expect(sent).toContainText('Fresh quire', { timeout: 8_000 })
  await context.close()
})

const QUOIN = '4e'.repeat(32)

test('a reload of Sent that fails while older mail is shown is tried again', async ({
  browser,
}) => {
  await fullSent('quoin', QUOIN)
  const { context, page } = await signedIn(browser, QUOIN)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await page.getByRole('button', { name: 'Older mail' }).click()
  await expect(sent.getByRole('listitem')).toHaveCount(51)
  // Every attempt: the agent tries a failed call again
  const refuse = (route: Route) =>
    callsTo(route.request(), 'mail_outbox_list')
      ? route.abort()
      : route.fallback()
  await page.route('**/api/*/canister/*/*', refuse)
  await compose(page, 'Late quoin')
  await send(page)
  await expect(sent.getByRole('alert')).toBeVisible()
  await page.unroute('**/api/*/canister/*/*', refuse)
  // The next refresh, at most 5 seconds on
  await expect(sent).toContainText('Late quoin', { timeout: 10_000 })
  await context.close()
})

const QUART = '4f'.repeat(32)

test('a send leaves the older mail shown in the Inbox in place', async ({
  browser,
}) => {
  joinMailbox('quart', QUART)
  backend('dev_seed', '("quart", 1 : nat64, 60 : nat64)')
  const { context, page } = await signedIn(browser, QUART)
  await expect(page.getByTestId('address')).toHaveText(`quart@${DOMAIN}`)
  const rows = page.locator('button.message')
  await expect(rows).toHaveCount(50)
  await page.getByRole('button', { name: 'Older mail' }).click()
  await expect(rows).toHaveCount(60)
  await compose(page, 'Quiet quart')
  await send(page)
  await expect(page.getByTestId('toast')).toHaveText(/Message sent/)
  // A moment more, for a reload to replace the list with its first page
  await page.waitForTimeout(2_000)
  await expect(rows).toHaveCount(60, { timeout: 1_000 })
  await context.close()
})

test('a send refused while the window is minimised opens it to show why', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let reached = () => {}
  const seen = new Promise<void>((resolve) => (reached = resolve))
  // Every attempt, once let go: the agent tries a failed call again
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), 'mail_send')) return route.fallback()
    reached()
    await released
    await route.abort()
  })
  await compose(page, 'Refused bunting')
  await send(page)
  await seen
  const window = page.getByRole('dialog', { name: 'New message' })
  await window.getByRole('button', { name: 'Minimise' }).click()
  await expect(window.getByLabel('Subject')).toBeHidden()
  release()
  await expect(window.getByRole('alert')).toBeVisible()
  await expect(window.getByLabel('Subject')).toHaveValue('Refused bunting')
  await context.close()
})

const QUAIL = '50'.repeat(32)

test('a failed reload of Sent is tried again after Older mail goes through', async ({
  browser,
}) => {
  await fullSent('quail', QUAIL)
  const { context, page } = await signedIn(browser, QUAIL)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(page.getByRole('button', { name: 'Older mail' })).toBeVisible()
  // The first page alone, every attempt: the agent tries a failed call again,
  // and Older mail, which names a cursor, goes through
  let firstPage: Buffer | undefined
  const refuse = (route: Route) => {
    if (!callsTo(route.request(), 'mail_outbox_list')) return route.fallback()
    const arg = argOf(route.request())
    firstPage ??= arg
    return arg.equals(firstPage) ? route.abort() : route.fallback()
  }
  await page.route('**/api/*/canister/*/*', refuse)
  await compose(page, 'Retried quail')
  await send(page)
  await expect(sent.getByRole('alert')).toBeVisible()
  // Older mail waits while a retry of the first page is under way: it goes
  // through between two
  const older = page.getByRole('button', { name: 'Older mail' })
  await expect(async () => {
    // Gone once an earlier click went through
    if (await older.isVisible()) await older.click()
    await expect(sent.getByRole('listitem')).toHaveCount(51, { timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
  await page.unroute('**/api/*/canister/*/*', refuse)
  // The next refresh, at most 5 seconds on
  await expect(sent).toContainText('Retried quail', { timeout: 10_000 })
  await context.close()
})

test('a Sent list slower to answer than its refresh still shows a send', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(sent.getByRole('listitem').first()).toBeVisible()
  // Each reply 6 seconds late, past the 5-second refresh
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), 'mail_outbox_list')) return route.fallback()
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    const response = await route.fetch({ url: url.toString() })
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    await route.fulfill({ response }).catch(() => {})
  })
  await compose(page, 'Slow grebe')
  await send(page)
  await expect(sent).toContainText('Slow grebe', { timeout: 20_000 })
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await context.close()
})
