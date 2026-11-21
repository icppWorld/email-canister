// The webmail tests of the Admin panel.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, test } from '@playwright/test'
import {
  ADMIN,
  answer,
  backend,
  callsTo,
  deliver,
  DOMAIN,
  freshBackend,
  hold,
  openMail,
  principalOf,
  signedIn,
  USER_A,
  USER_B,
  USER_C,
  waitDrained,
  watch,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

test('the Admin panel retries mail that could not be moved', async ({
  browser,
}) => {
  backend('dev_trap_moves', '(true)')
  try {
    deliver({ subject: 'Stuck quokka', body: '<p>A quokka.</p>', to: 'bob' })
    await waitDrained()
  } finally {
    backend('dev_trap_moves', '(false)')
  }
  const admin = await signedIn(browser, ADMIN)
  await expect(admin.page.getByTestId('totals')).toContainText(
    'Quarantined in the queue1'
  )
  await admin.page
    .getByTestId('entry-bob')
    .getByRole('button', { name: 'Retry stuck mail' })
    .click()
  await expect(admin.page.getByTestId('notice')).toHaveText(
    'Queued 1 stuck message for bob again.'
  )
  await waitDrained()
  await admin.context.close()

  const { context, page } = await signedIn(browser, USER_B)
  await openMail(page, 'quokka')
  await expect(page.getByTestId('subject')).toHaveText('Stuck quokka')
  await context.close()
})

test('the Admin panel checks a mailbox and shows one held for repair', async ({
  browser,
}) => {
  const admin = await signedIn(browser, ADMIN)
  const bob = admin.page.getByTestId('entry-bob')
  const checkBob = () => bob.getByRole('button', { name: 'Check' }).click()
  await checkBob()
  await expect(admin.page.getByTestId('notice')).toHaveText(
    'bob: the mailbox is sound.'
  )

  const counters = (change: string) =>
    backend(
      'dev_file_exec',
      `("bob", "UPDATE counters SET next_uid = next_uid ${change}")`
    )
  counters('+ 5')
  try {
    await checkBob()
    await expect(admin.page.getByTestId('notice')).toContainText(
      'bob needs repair: counters.next_uid is'
    )
    const status = bob.getByRole('cell', { name: 'Needs repair' })
    await expect(status).toHaveAttribute('title', /counters\.next_uid/)

    const owner = await signedIn(browser, USER_B)
    await expect(owner.page.getByRole('alert')).toContainText(
      'this mailbox needs repair'
    )
    await owner.context.close()
  } finally {
    counters('- 5')
    backend('admin_check', '("bob", null)') // releases it for the later tests
  }
  await checkBob()
  await expect(admin.page.getByTestId('notice')).toHaveText(
    'bob: the mailbox is sound.'
  )
  await expect(bob.getByRole('cell', { name: 'Active' })).toBeVisible()

  // A file that cannot be opened now is reported, not held
  backend('dev_hide_file', '("bob", true)')
  try {
    await checkBob()
    await expect(admin.page.getByTestId('notice')).toHaveText(
      'bob: the file cannot be opened now. Check it again later.'
    )
    await expect(bob.getByRole('cell', { name: 'Active' })).toBeVisible()
  } finally {
    backend('dev_hide_file', '("bob", false)')
  }
  await admin.context.close()
})

test('a quarantined message opens as plain text, under a warning', async ({
  browser,
}) => {
  deliver({
    subject: 'Odd ferret',
    body: '<p>Hello <b>ferret</b></p>',
    extraHeaders: { 'X-Email-Canister-Test-Trap': 'yes' },
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await page
    .locator('button.message', { hasText: 'could not be processed' })
    .first()
    .click()
  const warning = page.getByTestId('quarantine-warning')
  await expect(warning).toContainText('crafted to cause harm')
  await expect(page.locator('pre.body.text')).toContainText(
    'Hello <b>ferret</b>'
  )
  await expect(page.locator('iframe.body')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0)

  await warning
    .getByRole('button', { name: 'Show it formatted anyway' })
    .click()
  await expect(page.frameLocator('iframe.body').locator('b')).toHaveText(
    'ferret'
  )
  await expect(warning).toBeVisible()
  await context.close()
})

test('an existing mailbox gains a member only through its row, once confirmed', async ({
  browser,
}) => {
  // A principal no other test adds anywhere
  const member = principalOf('b9'.repeat(32))
  const { context, page } = await signedIn(browser, ADMIN)
  const row = page.getByTestId('entry-bob')
  await expect(row).toBeVisible()
  const shown = answer(
    page,
    member,
    false,
    member,
    true,
    principalOf(USER_B),
    true
  )
  try {
    // Declined: nothing changes
    await row.getByRole('button', { name: 'Add member' }).click()
    await expect.poll(() => shown.length).toBe(2)
    expect(shown[1]).toBe(
      `Give ${member} access to all mail in bob@${DOMAIN}? They can read, delete and send from it.`
    )
    await expect(row.getByTitle(member, { exact: true })).toHaveCount(0)

    await row.getByRole('button', { name: 'Add member' }).click()
    await expect(row.getByTitle(member, { exact: true })).toBeVisible()

    // The canister still refuses one already there
    await row.getByRole('button', { name: 'Add member' }).click()
    await expect(page.getByRole('alert')).toContainText(
      'already a member of this mailbox'
    )
  } finally {
    // bob stays bob's alone for the other tests
    backend('admin_remove_member', `("bob", principal "${member}")`)
    await context.close()
  }
})

// Petrel and Shag share deck, made in the Admin panel
const PETREL = 'c1'.repeat(32)

const SHAG = 'c2'.repeat(32)

test('the Admin panel makes a shared mailbox, names its members and removes one', async ({
  browser,
}) => {
  const petrel = principalOf(PETREL)
  const shag = principalOf(SHAG)
  const { context, page } = await signedIn(browser, ADMIN)
  await page.getByLabel('Address').fill('deck')
  // Not a number of GB, or one that rounds to no space at all. Too large to
  // convert comes first: a refusal that throws before showing anything would
  // otherwise pass on the alert of the one before.
  for (const quota of ['9'.repeat(309), 'lots', '0x10', '0.0001']) {
    await page.getByLabel('Quota in GB').fill(quota)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'Enter the quota as a number of GB, at least 0.001, or leave it empty.'
    )
  }
  await expect(page.getByTestId('entry-deck')).toHaveCount(0)

  // No first member: a shared mailbox gets its members one by one
  await page.getByLabel('Quota in GB').fill('1.5')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const row = page.getByTestId('entry-deck')
  await expect(row).toContainText('1.5 GB')
  await expect(row).toContainText('—')
  // The quota dialog starts from the quota as it is, fraction and all
  // (the click ends only once its dialog is handled)
  const quotaDialog = page.waitForEvent('dialog')
  const clicked = row
    .getByRole('button', { name: 'Quota', exact: true })
    .click()
  const dialog = await quotaDialog
  expect(dialog.defaultValue()).toBe('1.5')
  await dialog.dismiss()
  await clicked
  // and leaves a quota it can show only rounded as it is, when accepted
  backend('admin_set_quota', '("deck", 1_000_000_000)')
  await page.reload()
  const sets = watch(page, 'admin_set_quota')
  const roundedDialog = page.waitForEvent('dialog')
  const reopened = row
    .getByRole('button', { name: 'Quota', exact: true })
    .click()
  // OK on the value the dialog proposes
  const rounded = await roundedDialog
  await rounded.accept(rounded.defaultValue())
  await reopened
  // An action after it starts only once any call it made has ended
  await row.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByTestId('notice')).toHaveText(
    'deck: the mailbox is sound.'
  )
  expect(sets).toHaveLength(0)
  expect(backend('admin_list_entries')).toContain('quota_bytes = 1_000_000_000')
  const shown = answer(page, petrel, true, shag, true, true)
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(row.getByTitle(petrel, { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(row.getByTitle(shag, { exact: true })).toBeVisible()

  // People lists everyone who is a member somewhere, and names them
  const person = page.getByTestId(`person-${petrel}`)
  await expect(person).toContainText('deck')
  await person.getByLabel('Name', { exact: true }).fill('Petrel P')
  await person.getByRole('button', { name: 'Save name' }).click()
  await expect(row).toContainText('Petrel P')
  await expect(person.getByLabel('Name', { exact: true })).toHaveValue(
    'Petrel P'
  )

  // A saved name stays shown while the list reloads, so a second Save
  // cannot write the old one back
  const reload = await hold(page, 'admin_list_entries')
  await person.getByLabel('Name', { exact: true }).fill('Petrel Q')
  await person.getByRole('button', { name: 'Save name' }).click()
  await reload.seen
  await expect(person.getByRole('button', { name: 'Save name' })).toBeEnabled()
  await expect(person.getByLabel('Name', { exact: true })).toHaveValue(
    'Petrel Q'
  )
  // and the reload shows the name stored, even one set meanwhile elsewhere
  backend('admin_set_name', `(principal "${petrel}", "Petrel R")`)
  backend('admin_set_name', `(principal "${shag}", "Petrel R")`)
  reload.release()
  await expect(person.getByLabel('Name', { exact: true })).toHaveValue(
    'Petrel R'
  )

  const member = await signedIn(browser, SHAG)
  await expect(member.page.getByTestId('address')).toHaveText(`deck@${DOMAIN}`)

  // Removing a member takes the mailbox away from them, once confirmed by
  // their User ID: two members can have the same name
  const removing = `Petrel R (${shag})`
  await row
    .getByRole('button', { name: `Remove ${removing} from deck` })
    .click()
  await expect.poll(() => shown.length).toBe(5)
  expect(shown[4]).toBe(
    `Remove ${removing} from deck@${DOMAIN}? They lose access to all of its mail at once.`
  )
  await expect(row.getByTitle(shag, { exact: true })).toHaveCount(0)
  await expect(page.getByTestId(`person-${shag}`)).toHaveCount(0)
  await member.page.reload()
  await expect(
    member.page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()

  // An empty name removes it
  await person.getByLabel('Name', { exact: true }).fill('')
  await person.getByRole('button', { name: 'Save name' }).click()
  await expect(row).not.toContainText('Petrel R')
  await Promise.all([context.close(), member.context.close()])
})

test('a member is added only to the mailbox the Admin panel listed', async ({
  browser,
}) => {
  backend(
    'admin_create_mailbox',
    '(record { local = "skerry"; quota_bytes = null; first_member = null })'
  )
  const { context, page } = await signedIn(browser, ADMIN)
  const row = page.getByTestId('entry-skerry')
  await expect(row).toBeVisible()
  // Meanwhile the address is purged and given out again
  backend('admin_set_disabled', '("skerry", true)')
  while (!backend('admin_purge', '("skerry")').includes('remaining = 0 '));
  backend(
    'admin_create_mailbox',
    '(record { local = "skerry"; quota_bytes = null; first_member = null })'
  )
  // A principal no other test uses
  const member = principalOf('c4'.repeat(32))
  answer(page, member, true, '2vxsx-fae', true, member, true)
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'skerry was created again since it was listed. Reload, and check that it is the mailbox you mean.'
  )
  await expect(row.getByTitle(member, { exact: true })).toHaveCount(0)
  // Reloaded, as the refusal says, the list names the new mailbox
  await page.reload()
  await expect(row).toBeVisible()
  // The anonymous principal is never a member
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'the anonymous principal cannot be a member'
  )
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(row.getByTitle(member, { exact: true })).toBeVisible()
  await context.close()
})

test('the Admin panel starts no action while another runs', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  const { seen, release } = await hold(page, 'admin_check')
  await page
    .getByTestId('entry-alice')
    .getByRole('button', { name: 'Check' })
    .click()
  await seen
  const bob = page.getByTestId('entry-bob')
  const waiting = [
    ...['Add member', 'Disable', 'Quota', 'Retry stuck mail', 'Check'].map(
      (name) => bob.getByRole('button', { name })
    ),
    page.getByRole('button', { name: 'Create', exact: true }),
    page.getByRole('button', { name: 'Save domain' }),
    page.getByRole('button', { name: 'Save bridge' }),
    // The reload when it ends would undo what is typed in Domain and Bridge
    page.getByLabel('User ID'),
    page.getByLabel('Address'),
    page.getByLabel('Domain', { exact: true }),
    page.getByLabel('Bridge', { exact: true }),
  ]
  try {
    for (const button of waiting) await expect(button).toBeDisabled()
  } finally {
    release()
  }
  for (const button of waiting) await expect(button).toBeEnabled()
  await context.close()
})

test('the Admin panel gives the focus back when an action ends', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  const domain = page.getByLabel('Domain', { exact: true })
  await expect(domain).toHaveValue(DOMAIN)
  await domain.press('Enter')
  // Only the empty note bar is left: the action has ended
  await expect(page.getByRole('status').filter({ hasText: /./ })).toHaveCount(0)
  await expect(domain).toBeFocused()
  await context.close()
})

test('the Admin panel can act while its list does not load', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  await expect(page.getByTestId('entry-alice')).toBeVisible()
  const { seen, release } = await hold(page, 'admin_list_entries')
  try {
    await page
      .getByTestId('entry-alice')
      .getByRole('button', { name: 'Check' })
      .click()
    await expect(page.getByTestId('notice')).toContainText('alice')
    await seen
    await expect(
      page.getByRole('button', { name: 'Create', exact: true })
    ).toBeEnabled()
  } finally {
    release()
  }
  await context.close()
})

test('the Admin panel keeps a setting being typed while its list reloads', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  const domain = page.getByLabel('Domain', { exact: true })
  await expect(domain).toHaveValue(DOMAIN)
  const { seen, release } = await hold(page, 'admin_list_entries')
  await page
    .getByTestId('entry-alice')
    .getByRole('button', { name: 'Check' })
    .click()
  await seen
  await domain.fill('typed.example')
  release()
  // The reload has ended once a second one starts and ends
  await page
    .getByTestId('entry-alice')
    .getByRole('button', { name: 'Check' })
    .click()
  await expect(page.getByTestId('notice')).toContainText('alice')
  await expect(page.getByRole('status').filter({ hasText: '…' })).toHaveCount(0)
  await expect(domain).toHaveValue('typed.example')
  await context.close()
})

test('the Admin panel shows a saved domain as the canister stores it', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  const domain = page.getByLabel('Domain', { exact: true })
  await expect(domain).toHaveValue(DOMAIN)
  try {
    await domain.fill(DOMAIN.toUpperCase())
    await page.getByRole('button', { name: 'Save domain' }).click()
    await expect(domain).toHaveValue(DOMAIN)
    // and follows a change made elsewhere
    backend('admin_set_domain', '("elsewhere.example")')
    await page
      .getByTestId('entry-alice')
      .getByRole('button', { name: 'Check' })
      .click()
    await expect(domain).toHaveValue('elsewhere.example')
  } finally {
    backend('admin_set_domain', `("${DOMAIN}")`)
    await context.close()
  }
})

test('the Admin panel refuses a user ID that is not a principal', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  await page.getByLabel('User ID').fill('not-a-principal')
  await page.getByLabel('Address').fill('zed')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('entry-zed')).toHaveCount(0)
  await context.close()
})

test('a refused first member creates no mailbox, and the retry creates it', async ({
  browser,
}) => {
  // zcrew sorts after team, which the user sees first
  const { context, page } = await signedIn(browser, ADMIN)
  await page.getByLabel('User ID').fill('2vxsx-fae')
  await page.getByLabel('Address').fill('zcrew')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('anonymous')
  expect(backend('admin_list_entries')).not.toContain('local = "zcrew"')
  await page.getByLabel('User ID').fill(principalOf(USER_C))
  await page.getByLabel('Address').fill('zcrew')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(
    page
      .getByTestId('entry-zcrew')
      .getByTitle(principalOf(USER_C), { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await context.close()
})

test('an address in use the panel does not know of is not shared by mistake', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, ADMIN)
  await expect(page.getByTestId('entry-alice')).toBeVisible()
  // Created elsewhere, after this panel loaded its list
  backend(
    'admin_create_mailbox',
    '(record { local = "zmoor"; quota_bytes = null; first_member = null })'
  )
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'admin_list_entries')
      ? route.fulfill({ status: 500, body: 'down' })
      : route.fallback()
  )
  // A principal no other test adds anywhere
  const member = principalOf('a8'.repeat(32))
  await page.getByLabel('User ID').fill(member)
  await page.getByLabel('Address').fill('zmoor')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'already exists' })
  ).toBeVisible()
  expect(backend('admin_list_entries')).not.toContain(member)
  await context.close()
})
