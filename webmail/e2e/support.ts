// The webmail in a real browser against real canisters on a local replica:
// what the spec files share, the test users, the backend and helpers.
// Run e2e/setup.sh first. Sign-in uses fixed keys, as the e2e build does;
// signin.spec.ts signs in through the local Internet Identity, and only a
// passkey sign-in on id.ai itself is checked by hand.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Request,
} from '@playwright/test'
import { Cbor } from '@icp-sdk/core/agent'
import { type Backend } from '../src/api'
import { asUser, identityOf } from './as_user'
import { env, icp } from './local'

export const DOMAIN = 'mail.example'
export const ADMIN = 'a1'.repeat(32)
export const USER_A = 'b2'.repeat(32)
export const USER_B = 'c3'.repeat(32)
// Members of the shared mailbox "team" only, so that it is the one they see
export const USER_C = 'd4'.repeat(32)
export const USER_D = 'e5'.repeat(32)
// The flags, as src/api.ts has them: importing that runs the page's own code
export const FLAG_SEEN = 1n
export const FLAG_FLAGGED = 2n
export const FOLDER_INBOX = 0n
export const FOLDER_TRASH = 1n
export const FOLDER_SPAM = 2n
export const principalOf = (seed: string) =>
  identityOf(seed).getPrincipal().toText()

export const backend = (method: string, arg = '()') =>
  icp('canister', 'call', 'email-canister-test', method, arg)
export const stub = (method: string, arg = '()') =>
  icp('canister', 'call', 'relay_stub', method, arg)

const candid = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`

let serial = 0

export type Mail = {
  subject: string
  body: Buffer | string
  contentType?: string
  from?: string
  envelopeUser?: string
  envelopeDomain?: string
  to?: string
  extraHeaders?: Record<string, string>
}

export function deliver(mail: Mail): void {
  serial += 1
  const headers: Record<string, string> = {
    'Message-ID': `<e2e-${serial}@sender.example>`,
    From: mail.from ?? 'Sender <sender@sender.example>',
    Date: 'Mon, 9 Nov 2026 12:00:00 +0100',
    Subject: mail.subject,
    'MIME-Version': '1.0',
    'Content-Type': mail.contentType ?? 'text/html; charset=utf-8',
    ...mail.extraHeaders,
  }
  const headerText = Object.entries(headers)
    .map(
      ([name, value]) =>
        `record { name = ${candid(name)}; value = ${candid(` ${value}\r\n`)} }`
    )
    .join('; ')
  const body = Buffer.from(mail.body)
  const blob = Array.from(
    body,
    (b) => `\\${b.toString(16).padStart(2, '0')}`
  ).join('')
  const argument =
    `(record { message_id = opt "gw"; gateway_flags = null; envelope = opt record { ` +
    `from = record { user = ${candid(mail.envelopeUser ?? 'sender')}; domain = ${candid(mail.envelopeDomain ?? 'sender.example')} }; ` +
    `to = vec { record { user = ${candid(mail.to ?? 'alice')}; domain = ${candid(DOMAIN)} } } }; ` +
    `message = opt record { headers = vec { ${headerText} }; body = blob "${blob}" } })`
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-')), 'arg.did')
  writeFileSync(file, argument)
  const output = icp(
    'canister',
    'call',
    'email-canister-test',
    'smtp_request',
    '--args-file',
    file
  )
  expect(output).toMatch(/Ok/)
}

export function waitDrained(): Promise<void> {
  return expect
    .poll(() => /queued = (\d+)/.exec(backend('admin_ingest_stats'))?.[1], {
      timeout: 60_000,
    })
    .toBe('0')
}

export async function signedIn(
  browser: Browser,
  seed: string,
  options = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options)
  await context.addInitScript(
    (value) => window.sessionStorage.setItem('e2e-seed', value),
    seed
  )
  const page = await context.newPage()
  await page.goto(env.url)
  return { context, page }
}

export const sha256 = (data: Buffer | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')

// The file a download saves, started by a click on the button `name`, or by
// `start`
export async function download(
  page: Page,
  start: RegExp | (() => Promise<unknown>)
): Promise<Buffer> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    start instanceof RegExp
      ? page.getByRole('button', { name: start }).click()
      : start(),
  ])
  return readFileSync(await file.path())
}

// Whether a request is the page's call or query of `method`: the agent sends
// it as CBOR, in which the method name is plain text
export const callsTo = (request: Request, method: string) =>
  /\/api\/v\d\/canister\/[^/]+\/(call|query)$/.test(
    new URL(request.url()).pathname
  ) &&
  (request.postDataBuffer()?.includes(method) ?? false)

// The Candid argument of a request: the same for every try of one read, while
// its signed body changes when the expiry rounds to the next minute
export const argOf = (request: Request) =>
  Buffer.from(
    Cbor.decode<{ content: { arg: Uint8Array } }>(
      request.postDataBuffer() ?? Buffer.alloc(0)
    ).content.arg
  )

// Holds the page's requests for `method` until release(). With `late`, each is
// answered at once but its reply reaches the page only at release(), so it
// holds what was stored before. `seen` resolves at the first one, once it is
// answered when late.
export async function hold(
  page: Page,
  method: string,
  { late = false } = {}
): Promise<{ seen: Promise<void>; release: () => void }> {
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let reached = () => {}
  const seen = new Promise<void>((resolve) => (reached = resolve))
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), method)) return route.fallback()
    if (!late) {
      reached()
      await released
      return route.continue()
    }
    // From the test, which cannot resolve the page's *.localhost name; the
    // path names the canister
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    const response = await route.fetch({ url: url.toString() })
    reached()
    await released
    await route.fulfill({ response })
  })
  return { seen, release }
}

// Answers the page's reads of `method` as a replica that lags would: `back`
// takes a change back while the canister answers, and `again` makes it once
// more before the reply reaches the page
export async function stale(
  page: Page,
  method: string,
  back: () => Promise<unknown>,
  again: () => Promise<unknown>
): Promise<void> {
  await page.route('**/api/*/canister/*/*', async (route) => {
    if (!callsTo(route.request(), method)) return route.fallback()
    const url = new URL(route.request().url())
    url.hostname = '127.0.0.1'
    await back()
    let response
    try {
      response = await route.fetch({ url: url.toString() })
    } finally {
      // Also when the read failed, so the mailbox is left as it was
      await again()
    }
    await route.fulfill({ response })
  })
}

// The page's requests for `method`, as they are sent
export function watch(page: Page, method: string): Request[] {
  const seen: Request[] = []
  page.on('request', (request) => {
    if (callsTo(request, method)) seen.push(request)
  })
  return seen
}

// alice, called from the test itself
// One agent for every call: each fetches the root key
let aliceBackend: Promise<Backend> | undefined
export const asAlice = () =>
  (aliceBackend ??= asUser(USER_A, env.url, env.backend).catch((error) => {
    aliceBackend = undefined // the next call tries again
    throw error
  }))

// Opens Compose with a message to friend@example.org, for the test to add to
// and send
export async function compose(page: Page, subject: string): Promise<void> {
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByLabel('To', { exact: true }).fill('friend@example.org')
  await page.getByLabel('Subject', { exact: true }).fill(subject)
}

export const send = (page: Page) =>
  page.getByRole('button', { name: 'Send', exact: true }).click()

// A download of alice's mailbox can start: none is under way
export async function noDownloadHeld(backend?: Backend): Promise<void> {
  const alice = backend ?? (await asAlice())
  const info = await alice.mail_export_freeze('alice', [])
  await alice.mail_export_thaw('alice', info.started_ns)
}

export const toastButton = (page: Page, name: string) =>
  page.getByTestId('toast').getByRole('button', { name }).click()

// After a send the folder shown stays: the note it leaves opens the Sent
// folder of the mailbox it went from
export const viewSent = (page: Page) => toastButton(page, 'View in Sent')

export const messageRow = (page: Page, text: string) =>
  page.locator('button.message', { hasText: text })

// A ⋮ menu, by the label of its button: More in the header, More actions in
// the reader
export const menu = (page: Page, label: string) =>
  page
    .locator('details.menu')
    .filter({ has: page.getByLabel(label, { exact: true }) })

export const openMenu = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).click()

// Opens a ⋮ menu and chooses one of its items, which closes it
export async function menuItem(
  page: Page,
  label: string,
  name: string
): Promise<void> {
  await openMenu(page, label)
  await menu(page, label).getByRole('button', { name, exact: true }).click()
}

// A download of the mailbox shown, started from the header's menu
export const downloadCopy = (page: Page) =>
  menuItem(page, 'More', 'Download a copy')

// The list of mailboxes and folders beside the mail
export const nav = (page: Page) =>
  page.getByRole('navigation', { name: 'Folders' })

// What a download shows while it runs, below the folders. Gone once it has
// ended, its thaw included: the menu's button is enabled again then.
export const downloadStatus = (page: Page) => nav(page).getByRole('status')

export async function search(page: Page, text: string): Promise<void> {
  await page.getByLabel('Search mail').fill(text)
  await page.getByLabel('Search mail').press('Enter')
}

export async function openMail(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Inbox' }).click()
  await search(page, text)
  // By its text: until the search returns, the list still shows earlier mail
  await messageRow(page, text).first().click()
}

// The colour a brand role resolves to on the page, as the browser reports it
export function roleColour(page: Page, role: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }, role)
}

export const bodyOf = (page: Page) =>
  page.frameLocator('iframe.body').locator('body')

// Makes the users members of the mailbox `local`, created by the first test
// that needs it
export function joinMailbox(local: string, ...seeds: string[]): void {
  if (!backend('admin_list_entries').includes(`local = "${local}"`)) {
    backend(
      'admin_create_mailbox',
      `(record { local = "${local}"; quota_bytes = null; first_member = null })`
    )
  }
  for (const seed of seeds) {
    try {
      backend(
        'admin_add_member',
        `("${local}", principal "${principalOf(seed)}", null)`
      )
    } catch (e) {
      if (!String(e).includes('already a member')) throw e
    }
  }
}

export const joinTeam = (...seeds: string[]) => joinMailbox('team', ...seeds)

// The uid of the message in `local` that `query` finds, once delivered
export async function uidOf(
  user: Awaited<ReturnType<typeof asUser>>,
  local: string,
  query: string
): Promise<bigint> {
  let uid = 0n
  await expect
    .poll(async () => {
      const { items } = await user.mail_search(local, {
        query,
        folder: 0n,
        cursor: [],
        limit: 1n,
      })
      uid = items[0]?.uid ?? 0n
      return uid
    })
    .not.toBe(0n)
  return uid
}

// Sets a message's arrival (received_ns), or when it left the Inbox
// (folder_ns), `days` earlier
export const backdate = (
  local: string,
  uid: bigint,
  column: 'received_ns' | 'folder_ns',
  days: number
) =>
  backend(
    'dev_file_exec',
    `("${local}", "UPDATE messages SET ${column} = ${column} - ` +
      `${BigInt(days) * 86_400_000_000_000n} WHERE uid = ${uid}")`
  )

// Ends the page's sign-in, as an expiry would
export const endSignIn = (page: Page) =>
  page.evaluate(() => {
    window.sessionStorage.removeItem('e2e-seed')
    window.dispatchEvent(new Event('e2e-session-end'))
  })

export async function signInAgain(page: Page, seed: string): Promise<void> {
  await page.evaluate(
    (value) => window.sessionStorage.setItem('e2e-seed', value),
    seed
  )
  await page
    .getByRole('button', { name: 'Sign in with Internet Identity' })
    .click()
}

// Answers the page's dialogs in turn: text for a prompt, true or false for a
// confirm. Returns the messages they showed.
export function answer(page: Page, ...answers: (string | boolean)[]): string[] {
  const shown: string[] = []
  page.on('dialog', async (dialog) => {
    shown.push(dialog.message())
    const next = answers.shift()
    if (next === false || next === undefined) await dialog.dismiss()
    else await dialog.accept(next === true ? undefined : next)
  })
  return shown
}

export const undo = (page: Page) => toastButton(page, 'Undo')

// A folder or page of the mailbox shown, from the list beside the mail
export const folder = (page: Page, name: string) =>
  nav(page).getByRole('button', { name, exact: true }).click()

export const reader = (page: Page) => page.locator('article.reader')

// The open message to Spam, once it has loaded: Reply waits for that
export async function spamFromReader(page: Page): Promise<void> {
  await expect(
    reader(page).getByRole('button', { name: 'Reply' })
  ).toBeEnabled()
  await reader(page).getByRole('button', { name: 'Spam', exact: true }).click()
}

// Each spec file gets a backend of its own: reinstalled, so no file sees what
// another left, and configured as the deployment would be. alice and bob are
// onboarded too, unless the file onboards them itself. The relay stub starts
// over as well, once the old backend can send it nothing more.
export function freshBackend({ onboard = true } = {}): void {
  icp('deploy', 'email-canister-test', '--mode', 'reinstall', '--yes')
  stub('stub_reset')
  icp(
    'canister',
    'settings',
    'update',
    'email-canister-test',
    '--add-controller',
    principalOf(ADMIN)
  )
  backend('admin_set_domain', `("${DOMAIN}")`)
  backend('admin_set_bridge', `(principal "${env.stub}")`)
  backend(
    'dev_outbox_timing',
    '(1_000_000_000 : nat64, 600_000_000_000 : nat64, 86_400_000_000_000 : nat64)'
  )
  if (onboard) {
    joinMailbox('alice', USER_A)
    joinMailbox('bob', USER_B)
  }
}
