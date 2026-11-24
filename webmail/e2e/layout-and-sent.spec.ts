// The webmail tests of the menus, the layout, the compose window and Sent.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Response,
  type Route,
  test,
} from '@playwright/test'
import { readFileSync } from 'node:fs'

import { asUser } from './as_user'
import { env } from './local'
import {
  ADMIN,
  answer,
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
  sentMessage,
  signedIn,
  spamFromReader,
  stub,
  uidOf,
  USER_A,
  USER_C,
  USER_D,
  waitDrained,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

test('the header menu holds Blocked senders, Download a copy, Admin for a controller, and Reload', async ({
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

  // A controller with no mailbox has only Admin and Reload there
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
  await expect(adminMenu.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(adminMenu.getByRole('button')).toHaveCount(2)
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
  const last = more.getByRole('button', { name: 'Reload' })
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
  // Spam's icons fit on one row, so the ⋮ is put first, at the left, where a
  // toolbar that wraps puts it at the start of its second row
  await page.addStyleTag({ content: '.reader > .toolbar .menu { order: -1 }' })
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
  await spamFromReader(page)
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/rash@sender.example blocked/)
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

test('a note that takes the place of a focused one has buttons of its own, none of them focused, and closes by itself', async ({
  browser,
}) => {
  deliver({ subject: 'Keyed avocet', body: '<p>An avocet.</p>' })
  deliver({ subject: 'Keyed stilt', body: '<p>A stilt.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  const rows = page.locator('li.message-row')
  await search(page, 'avocet')
  await expect(rows).toHaveCount(1)
  await messageRow(page, 'Keyed avocet').hover()
  await page.getByRole('button', { name: 'Delete: Keyed avocet' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  await search(page, 'stilt')
  await expect(rows).toHaveCount(1)
  const moving = await hold(page, 'mail_move')
  await messageRow(page, 'Keyed stilt').hover()
  await page.getByRole('button', { name: 'Delete: Keyed stilt' }).click()
  await moving.seen
  // The first note's Undo holds the focus when the second takes its place
  const first = note.getByRole('button', { name: 'Undo' })
  await first.focus()
  await expect(first).toBeFocused()
  moving.release()
  await expect(messageRow(page, 'Keyed stilt')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Undo' })).not.toBeFocused()
  // The focus went with the old note's button, so nothing holds the new one.
  // Without the fix this fails only where the browser removes a focused button
  // without a blur, as Chromium does.
  await expect(note.locator('span')).toHaveCount(0, { timeout: 12_000 })
  await context.close()
})

test("a focused button in a note has a ring in the note's text colour, light and dark", async ({
  browser,
}) => {
  deliver({ subject: 'Ringed dunlin', body: '<p>A dunlin.</p>' })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await search(page, 'dunlin')
  await messageRow(page, 'Ringed dunlin').hover()
  await page.getByRole('button', { name: 'Delete: Ringed dunlin' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/moved to Trash/)
  // By the keyboard, which :focus-visible needs
  const undo = note.getByRole('button', { name: 'Undo' })
  await page.keyboard.press('Tab')
  await undo.focus()
  expect(await undo.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const look = await undo.evaluate((el) => {
      const button = getComputedStyle(el)
      return {
        ring: button.outlineColor,
        style: button.outlineStyle,
        text: button.color,
        background: getComputedStyle(el.closest('.toast')!).backgroundColor,
      }
    })
    expect(look.style, colorScheme).toBe('solid')
    expect(look.ring, colorScheme).toBe(look.text)
    expect(look.ring, colorScheme).not.toBe(look.background)
  }
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
  // A Sent list that shows something before its replies slow down
  const alice = await asAlice()
  await alice.mail_send('alice', {
    client_id: crypto.randomUUID(),
    to: ['friend@example.org'],
    cc: [],
    bcc: [],
    subject: 'Prompt grebe',
    html_body: '<p>A grebe.</p>',
    attachments: [],
  })
  const { context, page } = await signedIn(browser, USER_A)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(sent).toContainText('Prompt grebe')
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

// Every button shown, apart from a ⋮ menu's items, the list's rows, the files
// of a message and the folders and mailboxes beside the mail, which their text
// names: those with text, with a title other than their name, or with no icon
const textButtons = (page: Page) =>
  page.locator('button:visible').evaluateAll((buttons) =>
    buttons
      .filter(
        (button) =>
          // The calendar's events and days are its content, like rows
          !button.closest(
            '.menu-items, li.message-row, .attachments, .month .day, .agenda'
          ) && !button.matches('nav button[aria-current]')
      )
      .filter(
        (button) =>
          (button.textContent ?? '').trim() !== '' ||
          !button.getAttribute('aria-label') ||
          button.getAttribute('title') !== button.getAttribute('aria-label') ||
          !button.querySelector('svg')
      )
      .map((button) => button.outerHTML.slice(0, 160))
  )

const IRIS = '51'.repeat(32)

test('every button is an icon, with its name as its tooltip', async ({
  browser,
}) => {
  joinMailbox('iris', IRIS)
  deliver({ subject: 'Iconic avocet', body: '<p>An avocet.</p>', to: 'iris' })
  deliver({ subject: 'Iconic stint', body: '<p>A stint.</p>', to: 'iris' })
  await waitDrained()
  const box = await asUser(IRIS, env.url, env.backend)
  const stint = await uidOf(box, 'iris', 'Iconic stint')
  await box.mail_move('iris', [stint], FOLDER_SPAM)
  await box.mail_block('iris', 'pest@sender.example')
  await box.mail_send('iris', {
    client_id: crypto.randomUUID(),
    to: ['friend@example.org'],
    cc: [],
    bcc: [],
    subject: 'Iconic tern',
    html_body: '<p>A tern.</p>',
    attachments: [],
  })
  const { context, page } = await signedIn(browser, IRIS)
  const allIcons = async (screen: string) =>
    expect(await textButtons(page), screen).toEqual([])

  // The header and the list, searched and with a message ticked
  await search(page, 'avocet')
  await expect(messageRow(page, 'Iconic avocet')).toHaveCount(1)
  await page.getByLabel('Select Iconic avocet', { exact: true }).check()
  await allIcons('the Inbox')
  // The reader, then the note of what it did
  await messageRow(page, 'Iconic avocet').click()
  await expect(
    reader(page).getByRole('button', { name: 'Reply' })
  ).toBeEnabled()
  await allIcons("the Inbox's reader")
  await reader(page)
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(page.getByTestId('toast')).toHaveText(/moved to Trash/)
  await allIcons('the note')

  // Spam, with Blocked senders and Empty Spam, and its reader
  await folder(page, 'Spam')
  await messageRow(page, 'Iconic stint').click()
  await expect(page.getByTestId('subject')).toHaveText('Iconic stint')
  await allIcons('Spam')
  await page
    .getByRole('button', { name: 'Blocked senders', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Blocked senders' })
  ).toContainText('pest@sender.example')
  await allIcons('Blocked senders')

  // Sent and its reader
  await folder(page, 'Sent')
  await messageRow(page, 'Iconic tern').click()
  await expect(page.getByTestId('outbox-state')).not.toHaveText('')
  await allIcons('Sent')

  // The calendar, its event form, and its secret address
  await folder(page, 'Calendar')
  await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible()
  await allIcons('the calendar')
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'New event' })
  await expect(form).toBeVisible()
  await allIcons('the event form')
  await form.getByRole('button', { name: 'Close' }).click()
  await page
    .getByRole('button', { name: 'Subscribe from a calendar app' })
    .click()
  answer(page, true)
  await page.getByRole('button', { name: 'Make a secret address' }).click()
  await expect(page.getByLabel('Secret address', { exact: true })).toHaveValue(
    /\.ics$/
  )
  await allIcons('the calendar address')
  await page
    .getByRole('dialog', { name: 'Subscribe from a calendar app' })
    .getByRole('button', { name: 'Close' })
    .click()

  // The compose window
  await page.getByRole('button', { name: 'Compose' }).click()
  const window = page.getByRole('dialog', { name: 'New message' })
  await expect(window).toBeVisible()
  await allIcons('compose')
  await window.getByRole('button', { name: 'Close' }).click()

  // The sign-in page
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(
    page.getByRole('button', { name: 'Sign in with Internet Identity' })
  ).toBeVisible()
  await allIcons('sign-in')
  await context.close()

  // The Admin panel
  const admin = await signedIn(browser, ADMIN)
  await expect(admin.page.getByTestId('entry-iris')).toBeVisible()
  expect(await textButtons(admin.page), 'Admin').toEqual([])
  await admin.context.close()
})

// The divider between the list and the reader, and the list's width
const divider = (page: Page) =>
  page.getByRole('separator', { name: 'Resize the message list' })
const widthOf = async (locator: Locator) => (await locator.boundingBox())!.width

test('dragging the divider widens the list, in every folder, and the width stays after a reload', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const list = page.getByRole('region', { name: 'Messages' })
  await expect(list).toBeVisible()
  expect(await widthOf(list)).toBeCloseTo(380, 0)
  const handle = (await divider(page).boundingBox())!
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  const dragged = async (button: 'left' | 'right') => {
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    await page.mouse.move(x + 100, y, { steps: 5 })
    await page.mouse.up({ button })
    // A frame on, for a width drawn on the page
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }
  // Another button moves nothing
  await dragged('right')
  expect(await widthOf(list)).toBeCloseTo(380, 0)
  // Grabbed off its middle, it moves as far as the pointer, without a jump
  await dragged('left')
  await expect.poll(() => widthOf(list)).toBeCloseTo(480, 0)
  const wider = 480
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(wider))

  await page.reload()
  await expect(list).toBeVisible()
  await expect.poll(() => widthOf(list)).toBeCloseTo(wider, 0)
  // Sent shares it
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect.poll(() => widthOf(sent)).toBeCloseTo(wider, 0)
  // A double-click puts it back
  await divider(page).dblclick()
  await expect.poll(() => widthOf(sent)).toBeCloseTo(380, 0)
  await context.close()
})

test('the arrow keys move the divider, Home and End take it to its limits, and it stays within them', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const list = page.getByRole('region', { name: 'Messages' })
  await expect(list).toBeVisible()
  const handle = divider(page)
  const at = async (width: number) => {
    await expect(handle).toHaveAttribute('aria-valuenow', String(width))
    await expect.poll(() => widthOf(list)).toBeCloseTo(width, 0)
  }
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await at(396)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await at(364)
  await page.keyboard.press('Home')
  await at(260)
  await page.keyboard.press('ArrowLeft')
  await at(260)
  // The reader keeps 320 pixels beside the divider
  const split = (await page.locator('.split').boundingBox())!
  const bar = (await handle.boundingBox())!
  const max = Math.round(split.width - 320 - bar.width)
  await expect(handle).toHaveAttribute('aria-valuemax', String(max))
  await page.keyboard.press('End')
  await at(max)
  await page.keyboard.press('ArrowRight')
  await at(max)
  const end = (await handle.boundingBox())!
  expect(split.x + split.width - (end.x + end.width)).toBeGreaterThanOrEqual(
    320
  )
  // The list never scrolls sideways
  expect(
    await list.evaluate((el) => el.scrollWidth - el.clientWidth)
  ).toBeLessThanOrEqual(0)
  await context.close()
})

test('at phone width the divider is hidden, and the list keeps the whole width', async ({
  browser,
}) => {
  const viewport = { width: 390, height: 844 }
  const { context, page } = await signedIn(browser, USER_A, { viewport })
  // Also with a width chosen on a wider screen
  await page.evaluate(() => window.localStorage.setItem('list-width', '600'))
  await page.reload()
  const list = page.getByRole('region', { name: 'Messages' })
  await expect(list).toBeVisible()
  await expect(divider(page)).toBeHidden()
  expect(await widthOf(list)).toBe(await widthOf(page.locator('.split')))
  await context.close()
})

// Sent mail of a mailbox of its own, once the bridge accepted it all: a
// delete keeps mail being sent. Long enough that deleting it shows in the
// usage, which counts kilobytes.
async function sentMail(local: string, seed: string, subjects: string[]) {
  joinMailbox(local, seed)
  const box = await asUser(seed, env.url, env.backend)
  for (const subject of subjects) {
    await box.mail_send(local, {
      client_id: crypto.randomUUID(),
      to: ['friend@example.org'],
      cc: [],
      bcc: [],
      subject,
      html_body: `<p>${'A long line. '.repeat(400)}</p>`,
      attachments: [],
    })
  }
  const ACCEPTED = 2n // as src/api.ts has it
  await expect
    .poll(
      async () => {
        const { items } = await box.mail_outbox_list(local, {
          cursor: [],
          limit: 100n,
        })
        return items.filter((m) => m.state === ACCEPTED).length
      },
      { timeout: 60_000 }
    )
    .toBe(subjects.length)
  return box
}

const SORREL = '52'.repeat(32)

test('ticked Sent mail is deleted for good, and the usage drops', async ({
  browser,
}) => {
  const box = await sentMail('sorrel', SORREL, [
    'Sorrel 1',
    'Sorrel 2',
    'Sorrel 3',
  ])
  const used = async () =>
    (await box.mail_me()).mailboxes.find((m) => m.local === 'sorrel')!
      .used_bytes
  const before = await used()
  const { context, page } = await signedIn(browser, SORREL)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(sent.getByRole('listitem')).toHaveCount(3)
  const dialogs = answer(page, true)
  await page.getByLabel('Select Sorrel 1', { exact: true }).check()
  await page.getByLabel('Select Sorrel 2', { exact: true }).check()
  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await expect(bulk).toContainText('2 selected')
  await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    '2 sent messages deleted'
  )
  expect(dialogs).toEqual(['Delete 2 sent messages for good?'])
  await expect(sent.getByRole('listitem')).toHaveCount(1)
  await expect(sent).toContainText('Sorrel 3')
  const { items } = await box.mail_outbox_list('sorrel', {
    cursor: [],
    limit: 10n,
  })
  expect(items.map((m) => m.subject)).toEqual(['Sorrel 3'])
  // The usage drops, and the page shows it at once
  const after = await used()
  expect(after).toBeLessThan(before)
  await expect(page.getByTestId('usage')).toHaveText(
    new RegExp(`^${Math.ceil(Number(after) / 1024)} KB of`),
    { timeout: 10_000 }
  )
  await context.close()
})

const SEDGE = '53'.repeat(32)

test("a Sent row's own Delete deletes it, and Select all ticks the rest", async ({
  browser,
}) => {
  await sentMail('sedge', SEDGE, ['Sedge 1', 'Sedge 2', 'Sedge 3'])
  const { context, page } = await signedIn(browser, SEDGE)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(sent.getByRole('listitem')).toHaveCount(3)
  const dialogs = answer(page, true, true)
  // Shown on hover
  await messageRow(page, 'Sedge 2').hover()
  await page.getByRole('button', { name: 'Delete: Sedge 2' }).click()
  await expect(page.getByTestId('toast').locator('span')).toHaveText(
    '1 sent message deleted'
  )
  await expect(sent.getByRole('listitem')).toHaveCount(2)

  const bulk = page.getByRole('toolbar', { name: 'Selected messages' })
  await bulk.getByLabel('Select all').check()
  await expect(bulk).toContainText('2 selected')
  for (const n of [1, 3]) {
    await expect(
      page.getByLabel(`Select Sedge ${n}`, { exact: true })
    ).toBeChecked()
  }
  await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sent).toContainText('Nothing sent yet.')
  expect(dialogs).toEqual([
    'Delete this sent message for good?',
    'Delete 2 sent messages for good?',
  ])
  await context.close()
})

const SPURGE = '54'.repeat(32)

test('Empty Sent deletes all but mail being sent, which the note says it could not delete', async ({
  browser,
}) => {
  const box = await sentMail('spurge', SPURGE, ['Spurge 1', 'Spurge 2'])
  // The bridge holds the next one as being sent, until the test lets it finish
  stub('stub_set_mode', '("sending")')
  let context: BrowserContext | undefined
  try {
    await box.mail_send('spurge', {
      client_id: crypto.randomUUID(),
      to: ['friend@example.org'],
      cc: [],
      bcc: [],
      subject: 'Held spurge',
      html_body: '<p>Held.</p>',
      attachments: [],
    })
    const signed = await signedIn(browser, SPURGE)
    context = signed.context
    const { page } = signed
    await folder(page, 'Sent')
    const sent = page.getByRole('region', { name: 'Sent mail' })
    const held = page.locator('li.message-row', { hasText: 'Held spurge' })
    await expect(held).toContainText('Sending', { timeout: 30_000 })
    // It has no box to tick, and no Delete of its own
    await expect(held.getByRole('checkbox')).toBeDisabled()
    await held.hover()
    await expect(held.getByRole('button', { name: /^Delete/ })).toHaveCount(0)

    const dialogs = answer(page, true)
    await page
      .getByRole('toolbar', { name: 'Selected messages' })
      .getByRole('button', { name: 'Empty Sent' })
      .click()
    await expect(page.getByTestId('toast').locator('span')).toHaveText(
      '2 sent messages deleted. 1 could not be deleted: it is being sent, ' +
        'or was deleted already'
    )
    expect(dialogs).toEqual([
      'Delete every message in Sent for good? Mail waiting to be sent is ' +
        'deleted and not sent; mail being sent is kept.',
    ])
    await expect(sent.getByRole('listitem')).toHaveCount(1)
    await expect(held).toHaveCount(1)
  } finally {
    await context?.close()
    stub('stub_set_mode', '("sent")')
    stub('stub_finish', '("sent")')
  }
})

const SAGE = '57'.repeat(32)

test('mail ticked while waiting is unticked once it starts sending, and stays so once sent', async ({
  browser,
}) => {
  const box = await sentMail('sage', SAGE, ['Sage 1'])
  // The next one waits to be sent, and then is held as being sent, until
  // the test lets it go
  backend('dev_outbox_crash', '("before_call")')
  stub('stub_set_mode', '("sending")')
  let context: BrowserContext | undefined
  try {
    await box.mail_send('sage', {
      client_id: crypto.randomUUID(),
      to: ['friend@example.org'],
      cc: [],
      bcc: [],
      subject: 'Waiting sage',
      html_body: '<p>Waiting.</p>',
      attachments: [],
    })
    const signed = await signedIn(browser, SAGE)
    context = signed.context
    const { page } = signed
    await folder(page, 'Sent')
    const row = page.locator('li.message-row', { hasText: 'Waiting sage' })
    await expect(row).toContainText('Waiting to send')
    await row.getByRole('checkbox').check()
    backend('dev_outbox_crash', '("")')
    await expect(row).toContainText('Sending', { timeout: 30_000 })
    stub('stub_set_mode', '("sent")')
    stub('stub_finish', '("sent")')
    const pick = row.getByRole('checkbox')
    await expect(pick).toBeEnabled({ timeout: 30_000 })
    await expect(pick).not.toBeChecked()
    await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)
  } finally {
    await context?.close()
    backend('dev_outbox_crash', '("")')
    stub('stub_set_mode', '("sent")')
    stub('stub_finish', '("sent")')
  }
})

const SUNDEW = '55'.repeat(32)

test('a refused delete in Sent shows at once, while the list reloads, and leaves its mail unticked', async ({
  browser,
}) => {
  await sentMail('sundew', SUNDEW, ['Sundew 1', 'Sundew 2'])
  const { context, page } = await signedIn(browser, SUNDEW)
  await folder(page, 'Sent')
  const sent = page.getByRole('region', { name: 'Sent mail' })
  await expect(sent.getByRole('listitem')).toHaveCount(2)
  const boxes = [1, 2].map((n) =>
    page.getByLabel(`Select Sundew ${n}`, { exact: true })
  )
  for (const box of boxes) await box.check()
  // The reload after it waits, and every attempt of the delete fails: the
  // agent tries a failed call again
  const loading = await hold(page, 'mail_outbox_list')
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_outbox_delete_many')
      ? route.abort()
      : route.fallback()
  )
  const dialogs = answer(page, true, true)
  await page
    .getByRole('toolbar', { name: 'Selected messages' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(sent.getByRole('alert')).toBeVisible()
  expect(dialogs).toEqual(['Delete 2 sent messages for good?'])
  // Once the list is back, the mail is still there, unticked, and the
  // refusal still shows
  await loading.seen
  const reloaded = page.waitForResponse((r) =>
    callsTo(r.request(), 'mail_outbox_list')
  )
  loading.release()
  await reloaded
  await expect(sent.getByRole('listitem')).toHaveCount(2)
  for (const box of boxes) await expect(box).not.toBeChecked()
  await expect(sent.getByRole('alert')).toBeVisible()
  // A delete from the reader that goes through clears the refusal
  await messageRow(page, 'Sundew 1').click()
  await page
    .locator('article.reader')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(sent.getByRole('listitem')).toHaveCount(1)
  await expect(sent.getByRole('alert')).toHaveCount(0)
  expect(dialogs).toEqual([
    'Delete 2 sent messages for good?',
    'Delete this message permanently?',
  ])
  await context.close()
})

const SUMAC = '56'.repeat(32)

test('deleting mail waiting to be sent says it is then not sent', async ({
  browser,
}) => {
  const box = await sentMail('sumac', SUMAC, ['Sumac 1'])
  // The next one waits to be sent, until the test lets it go
  backend('dev_outbox_crash', '("before_call")')
  let context: BrowserContext | undefined
  try {
    await box.mail_send('sumac', {
      client_id: crypto.randomUUID(),
      to: ['friend@example.org'],
      cc: [],
      bcc: [],
      subject: 'Waiting sumac',
      html_body: '<p>Waiting.</p>',
      attachments: [],
    })
    const signed = await signedIn(browser, SUMAC)
    context = signed.context
    const { page } = signed
    await folder(page, 'Sent')
    const sent = page.getByRole('region', { name: 'Sent mail' })
    await expect(messageRow(page, 'Waiting sumac')).toContainText(
      'Waiting to send'
    )
    const dialogs = answer(page, false, false, true)
    // The reader's own Delete warns too
    await messageRow(page, 'Waiting sumac').click()
    await page
      .locator('article.reader')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    for (const subject of ['Sumac 1', 'Waiting sumac']) {
      await messageRow(page, subject).hover()
      await page.getByRole('button', { name: `Delete: ${subject}` }).click()
    }
    await expect(page.getByTestId('toast').locator('span')).toHaveText(
      '1 sent message deleted'
    )
    expect(dialogs).toEqual([
      'Delete this message permanently? Mail waiting to be sent is ' +
        'deleted and not sent.',
      'Delete this sent message for good?',
      'Delete this sent message for good? Mail waiting to be sent is ' +
        'deleted and not sent.',
    ])
    await expect(sent.getByRole('listitem')).toHaveCount(1)
    await expect(sent).toContainText('Sumac 1')
  } finally {
    await context?.close()
    backend('dev_outbox_crash', '("")')
  }
})

test('each pick adds its files, replacing one attached already, and Remove takes one off', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await page.getByRole('button', { name: 'Compose' }).click()
  const window = page.getByRole('dialog', { name: 'New message' })
  const picker = window.getByLabel('Attachments')
  const file = (name: string, size: number) => ({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.alloc(size, 'x'),
  })
  const attached = window
    .getByRole('list', { name: 'Attached files' })
    .getByRole('listitem')
  await picker.setInputFiles(file('a.txt', 2048))
  await picker.setInputFiles([file('b.txt', 10), file('a.txt', 2048)])
  await expect(attached).toHaveText(['a.txt (2 KB)', 'b.txt (1 KB)'])
  // A cancelled pick
  await picker.setInputFiles([])
  await expect(attached).toHaveText(['a.txt (2 KB)', 'b.txt (1 KB)'])
  await window.getByRole('button', { name: 'Remove: a.txt' }).click()
  await expect(attached).toHaveText(['b.txt (1 KB)'])
  // Removed, it can be picked again
  await picker.setInputFiles(file('a.txt', 2048))
  await expect(attached).toHaveText(['b.txt (1 KB)', 'a.txt (2 KB)'])
  await context.close()
})

test('a file picked again after an edit is sent as it is now', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await compose(page, 'Repicked kestrel')
  const window = page.getByRole('dialog', { name: 'New message' })
  const picker = window.getByLabel('Attachments')
  const file = (fill: string) => ({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(100, fill),
  })
  await picker.setInputFiles(file('o'))
  // The same name and size, with what the file holds now
  await picker.setInputFiles(file('n'))
  await expect(
    window.getByRole('list', { name: 'Attached files' }).getByRole('listitem')
  ).toHaveText(['notes.txt (1 KB)'])
  await send(page)
  await expect
    .poll(async () =>
      (await sentMessage('Repicked kestrel'))?.attachments.map((a) =>
        Buffer.from(a.content as Uint8Array).toString()
      )
    )
    .toEqual(['n'.repeat(100)])
  await context.close()
})

// A mark that reverses what follows, U+202E, in a sender's address and the
// domain that delivered it shows as U+FFFD wherever the webmail shows it: the
// "via" line, the Spam note, Blocked senders, and Sent, with a file named with
// the mark. The block is of the address as it came; a reply's To is left empty.
test('a reversing mark in an address shows as a replacement character wherever the webmail shows it', async ({
  browser,
}) => {
  const marked = 'in\u202Evoice@sender.example'
  const seen = 'in\uFFFDvoice@sender.example'
  deliver({
    subject: 'Marked scoter',
    body: '<p>x</p>',
    from: `Scoter <${marked}>`,
    envelopeDomain: 'in\u202Evoice.example',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'scoter')
  await expect(page.getByTestId('via')).toHaveText('via in\uFFFDvoice.example')
  await reader(page).getByRole('button', { name: 'Reply' }).click()
  const reply = page.getByRole('dialog', { name: 'New message' })
  await expect(reply.getByLabel('To', { exact: true })).toHaveValue('')
  await reply.getByRole('button', { name: 'Close' }).click()
  await expect(reply).toHaveCount(0)
  await spamFromReader(page)
  await expect(page.getByTestId('toast')).toContainText(`${seen} blocked`)
  const alice = await asAlice()
  expect((await alice.mail_blocked('alice')).map((b) => b.address)).toContain(
    marked
  )
  await menuItem(page, 'More', 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  const address = page.locator('.blocked-address', { hasText: 'voice' })
  const entry = blocked.locator(address)
  await expect(entry).toHaveText(seen)
  await blocked
    .getByRole('listitem')
    .filter({ has: address })
    .getByRole('button', { name: 'Unblock' })
    .click()
  await expect(entry).toHaveCount(0)
  await compose(page, 'Marked \u202Escoter')
  await page.getByLabel('To', { exact: true }).fill(marked)
  await page
    .getByRole('dialog', { name: 'New message' })
    .getByLabel('Attachments')
    .setInputFiles({
      name: 'invoice\u202Efdp.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('x'),
    })
  await send(page)
  await expect(page.getByRole('dialog', { name: 'New message' })).toHaveCount(0)
  await folder(page, 'Sent')
  const row = messageRow(page, 'scoter')
  await expect(row.locator('.who')).toHaveText(seen)
  await expect(row.locator('.subject')).toHaveText('Marked \uFFFDscoter')
  await row.click()
  const sent = reader(page)
  await expect(sent.getByRole('heading', { level: 2 })).toHaveText(
    'Marked \uFFFDscoter'
  )
  await expect(sent.locator('dd', { hasText: 'voice' })).toHaveText(seen)
  await expect(
    sent.getByRole('list', { name: 'Attachments' }).getByRole('button')
  ).toHaveText(/^invoice\uFFFDfdp\.exe \(1 KB\)$/)
  await context.close()
})

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version

// A mark on the page that a load of it again takes away
const markPage = (page: Page) =>
  page.evaluate(() => Object.assign(window, { notReloaded: true }))
const reloaded = (page: Page) =>
  page.waitForFunction(() => !('notReloaded' in window))

test('the header menu shows the release, and its Reload loads the page again', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await openMenu(page, 'More')
  await expect(menu(page, 'More').getByTestId('version')).toHaveText(
    `Webmail v${VERSION}`
  )
  await markPage(page)
  await menu(page, 'More').getByRole('button', { name: 'Reload' }).click()
  await reloaded(page)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)

  // With a message being written, the webmail asks first, and staying keeps it
  await compose(page, 'Unsent loon')
  await markPage(page)
  // No, then yes
  const asked = answer(page, false, true)
  await menuItem(page, 'More', 'Reload')
  expect(asked).toEqual([expect.stringContaining('message being written')])
  await page.waitForTimeout(1_000)
  expect(await page.evaluate(() => 'notReloaded' in window)).toBe(true)
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(
    'Unsent loon'
  )
  // and a yes reloads, losing it
  await menuItem(page, 'More', 'Reload')
  await reloaded(page)
  await expect(page.getByRole('dialog', { name: 'New message' })).toHaveCount(0)
  await context.close()
})

// A phone shows an open tab again without loading it: the check runs when the
// page comes back into view
test('a newer webmail deployed shows a banner when the page comes back into view, whose Reload loads it', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  const banner = page.getByRole('status').filter({ hasText: 'newer version' })
  const asksServer = (r: Response) =>
    new URL(r.url()).pathname === '/' && r.request().resourceType() === 'fetch'
  const backInView = async () => {
    const asked = page.waitForResponse(asksServer)
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange'))
    )
    await asked
  }
  // The same build: no banner, also with a style sheet of something else on
  // the page, such as a browser extension, added before the webmail's script
  // runs, and one of the webmail's own origin added after
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('extension-sheet')) return
    window.sessionStorage.removeItem('extension-sheet')
    new MutationObserver((_, observer) => {
      if (!document.head) return
      observer.disconnect()
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'chrome-extension://abcdefghijklmnop/content.css'
      // Still parsing: the webmail's module script runs only after that
      link.dataset.early = String(document.readyState === 'loading')
      document.head.append(link)
    }).observe(document, { childList: true, subtree: true })
  })
  await page.evaluate(() =>
    window.sessionStorage.setItem('extension-sheet', '1')
  )
  await page.reload()
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await expect(page.locator('link[href^="chrome-extension:"]')).toHaveAttribute(
    'data-early',
    'true'
  )
  await page.evaluate(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/late.css'
    document.head.append(link)
  })
  await backInView()
  await page.waitForTimeout(500)
  await expect(banner).toHaveCount(0)

  // The server's page names another script, as after a deploy
  const newer = async (route: Route) => {
    const response = await route.fetch()
    const html = (await response.text()).replace(
      /\/assets\/index-[^"]+\.js/,
      '/assets/index-newer.js'
    )
    await route.fulfill({ response, body: html })
  }
  const serveNewer = () =>
    page.route(
      (url) => url.pathname === '/',
      (route) =>
        route.request().resourceType() === 'fetch'
          ? newer(route)
          : route.fallback()
    )
  await serveNewer()
  await backInView()
  await expect(banner).toBeVisible()
  await page.unrouteAll()
  await markPage(page)
  // The check a page makes as it starts, which finds the same build
  const started = page.waitForResponse(asksServer)
  await banner.getByRole('button', { name: 'Reload' }).click()
  await reloaded(page)
  await started
  await page.waitForTimeout(500)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await expect(banner).toHaveCount(0)

  // Closed, it leaves the page as it is
  await serveNewer()
  await backInView()
  await banner.getByRole('button', { name: 'Close' }).click()
  await expect(banner).toHaveCount(0)

  // A check the server never answers ends, and a later one asks again: the
  // first check of the page loaded again is left unanswered, the next ones
  // name another script
  await page.unrouteAll()
  let answered = false
  const hung = page.waitForRequest(
    (r) => new URL(r.url()).pathname === '/' && r.resourceType() === 'fetch'
  )
  await page.route(
    (url) => url.pathname === '/',
    (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback()
      if (answered) return newer(route)
      answered = true
      return new Promise<void>(() => {})
    }
  )
  await page.reload()
  await hung
  await page.waitForTimeout(16_000)
  await backInView()
  await expect(banner).toBeVisible()
  await context.close()
})
