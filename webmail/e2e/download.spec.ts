// The webmail tests of downloading a copy of the mailbox.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { readFileSync } from 'node:fs'
import {
  type BrowserContext,
  expect,
  type Request,
  test,
} from '@playwright/test'
import {
  argOf,
  asAlice,
  backend,
  callsTo,
  deliver,
  DOMAIN,
  download,
  downloadCopy,
  downloadStatus,
  freshBackend,
  hold,
  joinMailbox,
  navButton,
  noDownloadHeld,
  openMail,
  principalOf,
  refreshList,
  signedIn,
  signInAgain,
  USER_A,
  USER_B,
  waitDrained,
  watch,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend())

test('downloads a copy of the mailbox, as its SQLite file', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    downloadCopy(page),
  ])
  expect(file.suggestedFilename()).toMatch(
    new RegExp(`^alice@${DOMAIN}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`)
  )
  const data = readFileSync(await file.path())
  expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
  expect(data.length % 4096).toBe(0)

  // The download ends its freeze: new mail moves in at once
  await expect(downloadStatus(page)).toHaveCount(0)
  deliver({
    subject: 'After the copy',
    body: '<p>A <b>pelican</b> arrives.</p>',
  })
  await waitDrained()
  await openMail(page, 'pelican')
  await expect(page.getByTestId('subject')).toHaveText('After the copy')
  await context.close()
})

test('a failed chunk ends the download with an error, and frees the mailbox', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await page.route('**/api/*/canister/*/*', (route) =>
    callsTo(route.request(), 'mail_export_chunk')
      ? route.abort('failed')
      : route.fallback()
  )
  await downloadCopy(page)
  // Below the bar, where the download shows
  await expect(page.locator('.notices').getByRole('alert')).toBeVisible({
    timeout: 30_000,
  })
  await expect(downloadStatus(page)).toHaveCount(0)
  await noDownloadHeld()
  await context.close()
})

test('a chunk that fails once is read again', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  // One read fails 4 times, as many as the agent tries a query by itself, so
  // only a fifth try, the page's own, saves it: only the count tells the
  // page's retry from the agent's. The reads of the other chunks have other
  // arguments, and pass.
  let failed = 0
  let tries = 0
  let first: Buffer | undefined
  await page.route('**/api/*/canister/*/*', (route) => {
    const request = route.request()
    if (!callsTo(request, 'mail_export_chunk')) return route.fallback()
    const arg = argOf(request)
    first ??= arg
    if (!first.equals(arg)) return route.fallback()
    tries += 1
    if (failed === 4) return route.fallback()
    failed += 1
    return route.abort('failed')
  })
  const data = await download(page, () => downloadCopy(page))
  expect(failed).toBe(4)
  expect(tries).toBeGreaterThan(4)
  expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
  // The thaw follows the save: closing the page first could cancel it
  await expect(downloadStatus(page)).toHaveCount(0)
  await context.close()
})

test('a renewal that fails does not end the download', async ({ browser }) => {
  // A hold of 5 s, renewed every 2 s
  backend(
    'dev_set_export_timing',
    '(5_000_000_000 : nat64, 7_200_000_000_000 : nat64)'
  )
  let context: BrowserContext | undefined
  try {
    const signed = await signedIn(browser, USER_A)
    context = signed.context
    const page = signed.page
    // The first renewal fails, with every retry the agent makes of it: a
    // retry sends the same signed request again, and the start's retries are
    // the start's. The renewals after it pass.
    let start: Buffer | undefined
    let failed: Buffer | undefined
    let renewed = 0
    await page.route('**/api/*/canister/*/*', (route) => {
      const request = route.request()
      if (!callsTo(request, 'mail_export_freeze')) return route.fallback()
      const body = request.postDataBuffer() ?? Buffer.alloc(0)
      start ??= body
      if (start.equals(body)) return route.fallback()
      failed ??= body
      if (failed.equals(body)) return route.abort('failed')
      renewed += 1
      return route.fallback()
    })
    const chunk = await hold(page, 'mail_export_chunk')
    const data = await download(page, async () => {
      await downloadCopy(page)
      await chunk.seen
      // The failed renewal, then one that holds the download again
      await expect.poll(() => renewed, { timeout: 30_000 }).toBeGreaterThan(0)
      // Well past the hold: only the renewals after it keep the download
      await page.waitForTimeout(8_000)
      chunk.release()
    })
    expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
    // The thaw follows the save: closing the page first could cancel it
    await expect(downloadStatus(page)).toHaveCount(0)
  } finally {
    await context?.close()
    backend(
      'dev_set_export_timing',
      '(300_000_000_000 : nat64, 7_200_000_000_000 : nat64)'
    )
  }
})

test('a renewal that hangs does not hold up the next', async ({ browser }) => {
  // A hold of 5 s, renewed every 2 s
  backend(
    'dev_set_export_timing',
    '(5_000_000_000 : nat64, 7_200_000_000_000 : nat64)'
  )
  let unhang = () => {}
  const unhung = new Promise<void>((resolve) => (unhang = resolve))
  let context: BrowserContext | undefined
  try {
    const signed = await signedIn(browser, USER_A)
    context = signed.context
    const page = signed.page
    let freezes = 0
    await page.route('**/api/*/canister/*/*', async (route) => {
      if (!callsTo(route.request(), 'mail_export_freeze'))
        return route.fallback()
      freezes += 1 // the start, then the renewals
      if (freezes !== 2) return route.fallback()
      await unhung // the first renewal gets no answer
      // By then the page may have closed
      await route.fallback().catch(() => undefined)
    })
    const chunk = await hold(page, 'mail_export_chunk')
    const data = await download(page, async () => {
      await downloadCopy(page)
      await chunk.seen
      // The next renewal goes out while the first still hangs
      await expect.poll(() => freezes, { timeout: 30_000 }).toBeGreaterThan(2)
      // Longer than the hold: only the later renewals keep it
      await page.waitForTimeout(6_000)
      chunk.release()
    })
    expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
    // The download ends while the first renewal still hangs
    await expect(downloadStatus(page)).toHaveCount(0)
    await noDownloadHeld()
  } finally {
    unhang()
    await context?.close()
    backend(
      'dev_set_export_timing',
      '(300_000_000_000 : nat64, 7_200_000_000_000 : nat64)'
    )
  }
})

test("a message's load error stays beside a flag or a refused delete", async ({
  browser,
}) => {
  deliver({ subject: 'Unloaded merganser', body: '<p>A <b>merganser</b>.</p>' })
  await waitDrained()
  const alice = await asAlice()
  let context: BrowserContext | undefined
  let freezing = false
  let started: bigint | undefined
  try {
    const signed = await signedIn(browser, USER_A)
    context = signed.context
    const page = signed.page
    await page.route('**/api/*/canister/*/*', (route) =>
      callsTo(route.request(), 'mail_get')
        ? route.abort('failed')
        : route.fallback()
    )
    await openMail(page, 'merganser')
    const alerts = page.locator('article.reader').getByRole('alert')
    await expect(alerts).toHaveCount(1)
    const loadError = (await alerts.first().textContent()) ?? ''
    expect(loadError).not.toBe('')
    await page.getByRole('button', { name: 'Star', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Unstar', exact: true })
    ).toBeVisible()
    // The reader still says why the message is missing
    await expect(alerts).toHaveCount(1)
    await expect(alerts.first()).toHaveText(loadError)

    // A delete refused during a download says why, beside the load error
    freezing = true
    started = (await alice.mail_export_freeze('alice', [])).started_ns
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(alerts).toHaveCount(2)
    await expect(alerts.first()).toHaveText(loadError)
    await expect(alerts.nth(1)).toContainText('downloaded')
  } finally {
    await context?.close()
    if (started !== undefined) await alice.mail_export_thaw('alice', started)
    // A freeze without a reply may still hold the mailbox: this test reports
    // it, rather than the next one
    else if (freezing) await noDownloadHeld(alice)
  }
})

test('flagging during a download says why it is refused', async ({
  browser,
}) => {
  deliver({ subject: 'Frozen heron', body: '<p>A <b>heron</b>.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const info = await alice.mail_export_freeze('alice', [])
  let context: BrowserContext | undefined
  try {
    const signed = await signedIn(browser, USER_A)
    context = signed.context
    const page = signed.page
    await openMail(page, 'heron')
    await expect(page.getByTestId('subject')).toHaveText('Frozen heron')
    const flag = page.getByRole('button', { name: 'Star', exact: true })
    await flag.click()
    await expect(page.getByRole('alert')).toContainText('downloaded')
    // Once the download ends, flagging works and the refusal goes away
    await alice.mail_export_thaw('alice', info.started_ns)
    await flag.click()
    await expect(
      page.getByRole('button', { name: 'Unstar', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await context?.close()
    await alice
      .mail_export_thaw('alice', info.started_ns)
      .catch(() => undefined)
  }
})

test('the Download button waits until the download has ended', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const thaw = await hold(page, 'mail_export_thaw')
  await download(page, () => downloadCopy(page))
  await thaw.seen
  // Saved, but the freeze has not ended yet: a new download would be refused
  const button = navButton(page, 'Download a copy')
  await expect(button).toBeDisabled()
  await expect(downloadStatus(page)).toBeVisible()
  thaw.release()
  await expect(button).toBeEnabled()
  await expect(downloadStatus(page)).toHaveCount(0)
  await noDownloadHeld()
  await context.close()
})

test('signing out ends a download under way, and the next sign-in shows none', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const chunk = await hold(page, 'mail_export_chunk')
  const thaws = watch(page, 'mail_export_thaw')
  let downloaded = false
  page.on('download', () => (downloaded = true))
  await downloadCopy(page)
  await chunk.seen
  await page.getByRole('button', { name: 'Sign out' }).click()
  // Signed in again before the old download's chunk comes back, so that
  // anything it shows late lands on the new sign-in
  await signInAgain(page, USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  chunk.release()
  await expect.poll(() => thaws.length, { timeout: 30_000 }).toBe(1)
  // The thaw was sent; it may not have ended yet
  await expect(noDownloadHeld).toPass({ timeout: 10_000 })
  expect(downloaded).toBe(false)

  // Nothing of it is left on the new sign-in: a new download can start
  await expect(downloadStatus(page)).toHaveCount(0)
  await expect(page.locator('.notices')).toHaveCount(0)
  await expect(navButton(page, 'Download a copy')).toBeEnabled()
  await context.close()
})

const LARK = '51'.repeat(32)

test('a download ends when its person no longer has a mailbox, saving nothing', async ({
  browser,
}) => {
  joinMailbox('scaup', LARK)
  const { context, page } = await signedIn(browser, LARK)
  await expect(page.getByTestId('address')).toHaveText(`scaup@${DOMAIN}`)
  // Answered while lark is a member, so the chunk is whole: a download that
  // went on would save it
  const chunk = await hold(page, 'mail_export_chunk', { late: true })
  const thaws = watch(page, 'mail_export_thaw')
  let downloaded = false
  page.on('download', () => (downloaded = true))
  await downloadCopy(page)
  await chunk.seen
  backend('admin_remove_member', `("scaup", principal "${principalOf(LARK)}")`)
  await refreshList(page)
  await expect(
    page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()
  chunk.release()
  await expect.poll(() => thaws.length, { timeout: 30_000 }).toBe(1)
  // Time for a save to reach the page, had the download made one
  await page.waitForTimeout(500)
  expect(downloaded).toBe(false)
  await context.close()
})

test('reading new mail during a download shows no error', async ({
  browser,
}) => {
  deliver({ subject: 'Frozen ibis', body: '<p>An <b>ibis</b>.</p>' })
  await waitDrained()
  const alice = await asAlice()
  const info = await alice.mail_export_freeze('alice', [])
  let context: BrowserContext | undefined
  try {
    const signed = await signedIn(browser, USER_A)
    context = signed.context
    const page = signed.page
    const flags = watch(page, 'mail_set_flags')
    await openMail(page, 'ibis')
    await expect(page.getByTestId('subject')).toHaveText('Frozen ibis')
    // The seen flag was refused, quietly: the download holds the file
    await expect.poll(() => flags.length).toBeGreaterThan(0)
    await flags[0].response()
    // Time for a refusal to reach the page, had it shown one
    await page.waitForTimeout(500)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await context?.close()
    await alice.mail_export_thaw('alice', info.started_ns)
  }
})

test('a mailbox that is briefly busy is read again, without an error', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_B)
  try {
    await expect(page.getByLabel('List actions', { exact: true })).toBeVisible()
    // Each read of the mailbox: whether it started after a "busy:" answer,
    // and whether its own answer was one (undefined until read)
    const reads = new Map<Request, { afterBusy: boolean; busy?: boolean }>()
    const answeredBusy = () => [...reads.values()].some((r) => r.busy)
    page.on('request', (request) => {
      if (callsTo(request, 'mail_list')) {
        reads.set(request, { afterBusy: answeredBusy() })
      }
    })
    page.on('response', async (response) => {
      const read = reads.get(response.request())
      if (!read) return
      try {
        read.busy = (await response.body()).includes('busy:')
      } catch {
        // the page closed first
      }
    })
    backend('dev_hide_file', '("bob", true)')
    try {
      await refreshList(page)
      await expect.poll(answeredBusy).toBe(true)
    } finally {
      backend('dev_hide_file', '("bob", false)')
    }
    // Read again once the file is back, by a read started after the busy one
    await expect
      .poll(
        () => [...reads.values()].some((r) => r.afterBusy && r.busy === false),
        { timeout: 10_000 }
      )
      .toBe(true)
    // Longer than a busy retry's wait, so no read is still pending
    await page.waitForTimeout(2_000)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
