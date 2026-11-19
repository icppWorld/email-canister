// The webmail in a real browser against real canisters on a local replica.
// Run e2e/setup.sh first. Sign-in uses fixed keys, as the e2e build does;
// signin.spec.ts signs in through the local Internet Identity, and only a
// passkey sign-in on id.ai itself is checked by hand.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from '@playwright/test'
import { Cbor } from '@icp-sdk/core/agent'

import type { Backend } from '../src/api'
import { asUser, identityOf } from './as_user'
import { env, icp } from './local'

const DOMAIN = 'mail.example'
const ADMIN = 'a1'.repeat(32)
const USER_A = 'b2'.repeat(32)
const USER_B = 'c3'.repeat(32)
// Members of the shared mailbox "team" only, so that it is the one they see
const USER_C = 'd4'.repeat(32)
const USER_D = 'e5'.repeat(32)
// The flags, as src/api.ts has them: importing that runs the page's own code
const FLAG_SEEN = 1n
const FLAG_FLAGGED = 2n
const FOLDER_INBOX = 0n
const FOLDER_TRASH = 1n
const FOLDER_SPAM = 2n
const principalOf = (seed: string) => identityOf(seed).getPrincipal().toText()

const backend = (method: string, arg = '()') =>
  icp('canister', 'call', 'email-canister-test', method, arg)
const stub = (method: string, arg = '()') =>
  icp('canister', 'call', 'relay_stub', method, arg)

const candid = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`

let serial = 0

type Mail = {
  subject: string
  body: Buffer | string
  contentType?: string
  from?: string
  envelopeUser?: string
  envelopeDomain?: string
  to?: string
  extraHeaders?: Record<string, string>
}

function deliver(mail: Mail): void {
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

function waitDrained(): Promise<void> {
  return expect
    .poll(() => /queued = (\d+)/.exec(backend('admin_ingest_stats'))?.[1], {
      timeout: 60_000,
    })
    .toBe('0')
}

async function signedIn(
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

const sha256 = (data: Buffer | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')

async function download(page: Page, name: RegExp): Promise<Buffer> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name }).click(),
  ])
  return readFileSync(await file.path())
}

// Whether a request is the page's call or query of `method`: the agent sends
// it as CBOR, in which the method name is plain text
const callsTo = (request: Request, method: string) =>
  /\/api\/v\d\/canister\/[^/]+\/(call|query)$/.test(
    new URL(request.url()).pathname
  ) &&
  (request.postDataBuffer()?.includes(method) ?? false)

// The Candid argument of a request: the same for every try of one read, while
// its signed body changes when the expiry rounds to the next minute
const argOf = (request: Request) =>
  Buffer.from(
    Cbor.decode<{ content: { arg: Uint8Array } }>(
      request.postDataBuffer() ?? Buffer.alloc(0)
    ).content.arg
  )

// Holds the page's requests for `method` until release(). With `late`, each is
// answered at once but its reply reaches the page only at release(), so it
// holds what was stored before. `seen` resolves at the first one, once it is
// answered when late.
async function hold(
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

// The page's requests for `method`, as they are sent
function watch(page: Page, method: string): Request[] {
  const seen: Request[] = []
  page.on('request', (request) => {
    if (callsTo(request, method)) seen.push(request)
  })
  return seen
}

// alice, called from the test itself
// One agent for every call: each fetches the root key
let aliceBackend: Promise<Backend> | undefined
const asAlice = () =>
  (aliceBackend ??= asUser(USER_A, env.url, env.backend).catch((error) => {
    aliceBackend = undefined // the next call tries again
    throw error
  }))

// Opens Compose with a message to friend@example.org, for the test to add to
// and send
async function compose(page: Page, subject: string): Promise<void> {
  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByLabel('To', { exact: true }).fill('friend@example.org')
  await page.getByLabel('Subject', { exact: true }).fill(subject)
}

const send = (page: Page) =>
  page.getByRole('button', { name: 'Send', exact: true }).click()

// A download of alice's mailbox can start: none is under way
async function noDownloadHeld(backend?: Backend): Promise<void> {
  const alice = backend ?? (await asAlice())
  const info = await alice.mail_export_freeze('alice', [])
  await alice.mail_export_thaw('alice', info.started_ns)
}

const toastButton = (page: Page, name: string) =>
  page.getByTestId('toast').getByRole('button', { name }).click()

// After a send the folder shown stays: the note it leaves opens the Sent
// folder of the mailbox it went from
const viewSent = (page: Page) => toastButton(page, 'View in Sent')

const messageRow = (page: Page, text: string) =>
  page.locator('button.message', { hasText: text })

async function search(page: Page, text: string): Promise<void> {
  await page.getByLabel('Search mail').fill(text)
  await page.getByLabel('Search mail').press('Enter')
}

async function openMail(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Inbox' }).click()
  await search(page, text)
  // By its text: until the search returns, the list still shows earlier mail
  await messageRow(page, text).first().click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
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
})

test('serves a strict content security policy and the SMTP handoff', async ({
  page,
}) => {
  // Through the browser, because Node does not resolve *.localhost
  const response = await page.goto(env.url)
  const policy = (await response!.allHeaders())['content-security-policy']
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain("script-src 'self'")
  expect(policy).toContain("font-src 'self';")
  expect(policy).toContain("connect-src 'self' https://icp0.io;")
  expect(policy).toContain("frame-ancestors 'none'")
  const handoff = await page.evaluate(async () => {
    const reply = await fetch('/.well-known/ic-smtp-canister-id')
    return reply.text()
  })
  expect(handoff.trim()).toBe(env.backend)
})

test("shows the deployment's brand, from e2e/brand", async ({ page }) => {
  await page.goto(env.url)
  expect(await page.title()).toBe('Test <Mail> & Co')
  await expect(page.getByRole('heading', { name: 'Test Mail' })).toBeVisible()
  await expect(page.getByText('A brand for the browser tests.')).toBeVisible()
  const logo = page.locator('img.logo')
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  expect(
    await logo.evaluate((image: HTMLImageElement) => image.currentSrc)
  ).toMatch(/logo-light\.svg$/)
  const action = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--action')
        .trim()
    )
  expect(await action()).toBe('#1d5e8c')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.currentSrc))
    .toMatch(/logo-dark\.svg$/)
  expect(await action()).toBe('#7fc1f0')

  const icon = await page.evaluate(async () => {
    const reply = await fetch(
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href
    )
    return { status: reply.status, type: reply.headers.get('content-type') }
  })
  expect(icon).toEqual({ status: 200, type: 'image/svg+xml' })
})

test('onboards two users through the Admin panel', async ({ browser }) => {
  const a = await signedIn(browser, USER_A)
  await expect(
    a.page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()
  const principalA = (await a.page.getByTestId('principal').textContent())!
  expect(principalA).toBe(principalOf(USER_A))

  const b = await signedIn(browser, USER_B)
  const principalB = (await b.page.getByTestId('principal').textContent())!

  const admin = await signedIn(browser, ADMIN)
  await expect(
    admin.page.getByRole('heading', { name: 'Administration' })
  ).toBeVisible()
  for (const [principal, local] of [
    [principalA, 'alice'],
    [principalB, 'bob'],
  ]) {
    await admin.page.getByLabel('User ID').fill(principal)
    await admin.page.getByLabel('Address').fill(local)
    await admin.page
      .getByRole('button', { name: 'Create', exact: true })
      .click()
    await expect(
      admin.page.getByTestId(`entry-${local}`).getByTitle(principal)
    ).toBeVisible()
  }

  // Creating never adds anyone to a mailbox that exists
  await admin.page.getByLabel('User ID').fill(principalB)
  await admin.page.getByLabel('Address').fill('alice')
  await admin.page.getByRole('button', { name: 'Create', exact: true }).click()
  // and says what each way on does, sharing and purging alike
  await expect(admin.page.getByRole('alert')).toHaveText(
    'alice already exists. To give someone access to all of its mail, add them as a member. To give the address to someone new, disable and purge it first, which deletes its mail.'
  )
  await expect(
    admin.page.getByTestId('entry-alice').getByTitle(principalB)
  ).toHaveCount(0)

  await a.page.reload()
  await expect(a.page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await expect(a.page.getByRole('button', { name: 'Admin' })).toHaveCount(0)
  await expect(a.page.locator('.brand img.logo')).toBeVisible()
  await b.page.reload()
  await expect(b.page.getByTestId('address')).toHaveText(`bob@${DOMAIN}`)

  await Promise.all([
    a.context.close(),
    b.context.close(),
    admin.context.close(),
  ])
})

test('reads, flags, searches and deletes mail, privately', async ({
  browser,
}) => {
  deliver({
    subject: 'Quarterly walrus',
    body: '<p>The <b>walrus</b> budget.</p>',
  })
  await waitDrained()

  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'walrus')
  await expect(page.getByTestId('subject')).toHaveText('Quarterly walrus')
  await expect(page.frameLocator('iframe.body').locator('b')).toHaveText(
    'walrus'
  )
  await expect(page.locator('iframe.body')).toHaveAttribute('sandbox', '')
  await expect(page.locator('button.message').first()).not.toHaveClass(/unread/)

  const other = await signedIn(browser, USER_B)
  await other.page.getByLabel('Search mail').fill('walrus')
  await other.page.getByLabel('Search mail').press('Enter')
  await expect(other.page.getByText('No matches.')).toBeVisible()
  await other.context.close()

  const admin = await signedIn(browser, ADMIN)
  await expect(admin.page.getByTestId('entry-alice')).toBeVisible()
  expect(await admin.page.content()).not.toContain('walrus')
  await admin.context.close()

  // To Trash, at once, with an Undo
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No matches.')).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveText(/Message moved to Trash/)
  await context.close()
})

// The envelope's domain, shown when it is not exactly the From domain
for (const [word, from, envelopeUser, envelopeDomain, via] of [
  [
    'otter',
    'Bank <ceo@bank.example>',
    'sender',
    'amazonses.com',
    'via amazonses.com',
  ],
  // A group names no address, so nothing matches
  [
    'marten',
    'Bank: ceo@bank.example;',
    'sender',
    'attacker.example',
    'via attacker.example',
  ],
  [
    'vole',
    'Bank <ceo@bank.example>',
    'sender',
    'x.bank.example',
    'via x.bank.example',
  ],
  // A lookalike with a Cyrillic "а", sent from the punycode domain it owns
  [
    'lynx',
    'Bank <ceo@bаnk.example>',
    'sender',
    'xn--bnk-6cd.example',
    'via xn--bnk-6cd.example',
  ],
  // The null reverse-path, <>
  ['stoat', 'Bank <ceo@bank.example>', '', '', 'via an unnamed domain'],
] as const) {
  test(`names the delivering domain, ${word}`, async ({ browser }) => {
    deliver({
      subject: `Delivered ${word}`,
      body: '<p>x</p>',
      from,
      envelopeUser,
      envelopeDomain,
    })
    await waitDrained()
    const { context, page } = await signedIn(browser, USER_A)
    await openMail(page, word)
    await expect(page.getByTestId('via')).toContainText(via)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await context.close()
  })
}

// The colour a brand role resolves to on the page, as the browser reports it
function roleColour(page: Page, role: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }, role)
}

const bodyOf = (page: Page) => page.frameLocator('iframe.body').locator('body')

// As the composer writes it (the provider only sends HTML), and as mail clients write text, links and quotes
for (const [colorScheme, word, body] of [
  ['light', 'heron', '<div style="white-space:pre-wrap">heron</div>'],
  ['dark', 'egret', '<div style="white-space:pre-wrap">egret</div>'],
  [
    'dark',
    'wren',
    '<div dir="ltr">wren <a href="https://example.com/">a link</a></div>',
  ],
  [
    'dark',
    'robin',
    '<div dir="ltr">robin</div><div class="quote"><blockquote class="quote" ' +
      'style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">quoted</blockquote></div>' +
      '<div dir="ltr" class="signature" data-mail="signature">Robin</div>',
  ],
  // A reply from a webmail service: the quote holds the composer's mail and its pixel,
  // and a <br clear="all"> comes before the signature
  [
    'dark',
    'turnstone',
    '<div dir="ltr">turnstone</div><br><div class="quote quote_container">' +
      '<div dir="ltr" class="attr">On Wed, Nov 18, 2026 at 9:01\u202fPM &lt;<a href="mailto:team@example.com">' +
      'team@example.com</a>&gt; wrote:<br></div><blockquote class="quote" ' +
      'style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
      '<div style="white-space:pre-wrap">quoted</div>\n<img alt="" src="https://a1b2c3d4.r.us-east-1.awstrack.me/I0/' +
      '0100000000000000-00000000-0000-0000-0000-000000000000-000000/AAAAAAAAAAAAAAAAAAAAAAAAAAA=473" ' +
      'style="display: none; width: 1px; height: 1px;">\n</blockquote></div><div><br clear="all"></div><div><br></div>' +
      '<span class="signature_prefix">-- </span><br><div dir="ltr" class="signature"><div dir="ltr">' +
      '<div style="font-size:small">Robin</div></div></div>',
  ],
  [
    'dark',
    'finch',
    '<p>finch</p><blockquote type="cite" cite="mid:x@example.com"><pre class="moz-quote-pre" wrap="">quoted</pre></blockquote>',
  ],
  // A mail service's open-tracking pixel, which the frame never loads
  [
    'dark',
    'sanderling',
    '<div style="white-space:pre-wrap">sanderling</div><img alt src="https://a1b2c3d4.r.us-east-1.awstrack.me/I0/' +
      '0100000000000000-00000000-0000-0000-0000-000000000000-000000/AAAAAAAAAAAAAAAAAAAAAAAAAAA=473" ' +
      'style="display: none; width: 1px; height: 1px;">',
  ],
  // Other services' pixels, and "data:" in a remote image's query
  [
    'dark',
    'knot',
    '<p>knot</p><img src="https://t.example/o.gif?ref=data:x" width="1" height="1" border="0" ' +
      'style="border:0;opacity:0;max-height:1px" loading="lazy" alt="" data-id="123">',
  ],
] as const) {
  test(`plain mail takes the brand's colours, ${colorScheme}, ${word}`, async ({
    browser,
  }) => {
    deliver({ subject: `Plain ${word}`, body })
    await waitDrained()
    const { context, page } = await signedIn(browser, USER_A, { colorScheme })
    await openMail(page, word)
    await expect(bodyOf(page)).toHaveCSS(
      'background-color',
      await roleColour(page, '--surface-raised')
    )
    await expect(bodyOf(page)).toHaveCSS(
      'color',
      await roleColour(page, '--ink')
    )
    if (word === 'wren')
      await expect(bodyOf(page).locator('a')).toHaveCSS(
        'color',
        await roleColour(page, '--action')
      )
    await expect(page.getByTestId('via')).toHaveCount(0)
    await context.close()
  })
}

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
// An inline image the message carries itself, which the frame shows
const RELATED =
  `--related\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>dotterel</p><img src="cid:logo@sender.example">\r\n` +
  `--related\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n` +
  `Content-ID: <logo@sender.example>\r\nContent-Disposition: inline\r\n\r\n${PIXEL}\r\n--related--\r\n`
for (const [word, body, contentType] of [
  ['puffin', '<p style="color:#000000">puffin</p>'],
  ['gannet', '<p style=color:#000000>gannet</p>'],
  ['shag', `<p>shag</p><img src="data:image/png;base64,${PIXEL}">`],
  [
    'skua',
    '<div style="background-image:linear-gradient(#ffffff,#ffffff)"><p>skua</p></div>',
  ],
  [
    'guillemot',
    '<p>guillemot</p><svg width="8" height="8"><rect width="8" height="8" fill="#000000"/></svg>',
  ],
  ['tern', '<body link="#000080"><p>tern</p></body>'],
  ['petrel', `<p>petrel</p><img srcset="data:image/png;base64,${PIXEL}">`],
  ['fulmar', '<p>fulmar</p><hr color="#000000">'],
  ['kestrel', '<p style="font-size:12px;/*x*/color:#000000">kestrel</p>'],
  ['plover', '<p style="border:1px solid #cccccc">plover</p>'],
  ['dotterel', RELATED, 'multipart/related; boundary="related"'],
  [
    'sandpiper',
    '<table style="background:#f4f4f4"><tr><td><p>sandpiper</p></td></tr></table>',
  ],
  // URL parsing drops the tab, so the frame shows this data: image
  ['stint', `<p>stint</p><img src="da&#9;ta:image/png;base64,${PIXEL}">`],
  // An image the frame cannot load may still paint something of its own
  [
    'dunlin',
    '<p>dunlin</p><img src="https://t.example/p.gif" width="600" height="400" style="background-color:#000000">',
  ],
  [
    'whimbrel',
    `<p>whimbrel</p><img src="https://t.example/p.gif" style="content:url(data:image/png;base64,${PIXEL})">`,
  ],
  [
    'redshank',
    `<p>redshank</p><img src="https://t.example/p.gif" style="border:0;border-image:url(data:image/png;base64,${PIXEL}) 1">`,
  ],
  [
    'greenshank',
    '<p>greenshank</p><img src="https://t.example/p.gif" width="600" height="400" ' +
      `style="border:10px solid;border-image:var(--n, url(data:image/png;base64,${PIXEL})) 30 fill">`,
  ],
]) {
  test(`HTML mail that sets its own colours keeps a white page, ${word}`, async ({
    browser,
  }) => {
    deliver({ subject: `Styled ${word}`, body, contentType })
    await waitDrained()
    const { context, page } = await signedIn(browser, USER_A, {
      colorScheme: 'dark',
    })
    await openMail(page, word)
    await expect(page.locator('iframe.body')).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)'
    )
    await expect(page.frameLocator('iframe.body').locator('html')).toHaveCSS(
      'color-scheme',
      'light'
    )
    await expect(bodyOf(page).locator('p')).toHaveCSS('color', 'rgb(0, 0, 0)')
    await context.close()
  })
}

for (const [word, element, body] of [
  [
    'cormorant',
    'body',
    '<body bgcolor="#000000" text="#ffffff">cormorant</body>',
  ],
  [
    'kittiwake',
    'html',
    '<style>html{background:#000000;color:#ffffff}</style><p>kittiwake</p>',
  ],
]) {
  test(`HTML mail keeps its own page colours, on ${element}`, async ({
    browser,
  }) => {
    deliver({ subject: `Night ${word}`, body })
    await waitDrained()
    const { context, page } = await signedIn(browser, USER_A)
    await openMail(page, word)
    const frame = page.frameLocator('iframe.body')
    await expect(frame.locator(element)).toHaveCSS(
      'background-color',
      'rgb(0, 0, 0)'
    )
    await expect(frame.locator('body')).toHaveCSS(
      'background-color',
      element === 'body' ? 'rgb(0, 0, 0)' : 'rgba(0, 0, 0, 0)'
    )
    await expect(frame.locator('body')).toHaveCSS('color', 'rgb(255, 255, 255)')
    await context.close()
  })
}

test('the Refresh button shows new mail straight away', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_B)
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true })
  ).toBeVisible()
  deliver({ to: 'bob', subject: 'Refresh ibis', body: '<p>x</p>' })
  await waitDrained()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(
    page.locator('button.message', { hasText: 'Refresh ibis' })
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true })
  ).toBeEnabled()
  await context.close()
})

// Makes the users members of the mailbox `local`, created by the first test
// that needs it
function joinMailbox(local: string, ...seeds: string[]): void {
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

const joinTeam = (...seeds: string[]) => joinMailbox('team', ...seeds)

// The uid of the message in `local` that `query` finds, once delivered
async function uidOf(
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

// Ends the page's sign-in, as an expiry would
const endSignIn = (page: Page) =>
  page.evaluate(() => {
    window.sessionStorage.removeItem('e2e-seed')
    window.dispatchEvent(new Event('e2e-session-end'))
  })

async function signInAgain(page: Page, seed: string): Promise<void> {
  await page.evaluate(
    (value) => window.sessionStorage.setItem('e2e-seed', value),
    seed
  )
  await page
    .getByRole('button', { name: 'Sign in with Internet Identity' })
    .click()
}

test('a draft kept over a new sign-in is sent from the mailbox it was started in', async ({
  browser,
}) => {
  joinTeam(USER_D)
  const { context, page } = await signedIn(browser, USER_D)
  await expect(page.getByTestId('address')).toHaveText(`team@${DOMAIN}`)
  await compose(page, 'Bound tern')
  await endSignIn(page)
  // A mailbox that sorts first
  backend(
    'admin_create_mailbox',
    '(record { local = "aardvark"; quota_bytes = null; first_member = null })'
  )
  const member = `("aardvark", principal "${principalOf(USER_D)}"`
  backend('admin_add_member', `${member}, null)`)
  try {
    // The new sign-in shows the mailbox open before it; another one is
    // opened, the draft stays from team
    await page.evaluate(() => window.localStorage.clear())
    await signInAgain(page, USER_D)
    await expect(page.getByTestId('address')).toHaveText(`team@${DOMAIN}`)
    await page
      .getByRole('list', { name: 'Mailboxes' })
      .getByRole('button', { name: /^aardvark/ })
      .click()
    await expect(page.getByTestId('address')).toHaveText(`aardvark@${DOMAIN}`)
    await expect(page.getByLabel('Subject')).toHaveValue('Bound tern')
    await expect(page.getByLabel('From')).toHaveValue('team')
    await send(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The Sent folder it was sent from opens from the note
    await viewSent(page)
    await expect(page.getByTestId('address')).toHaveText(`team@${DOMAIN}`)
    await expect(page.getByRole('button', { name: /Bound tern/ })).toBeVisible()
    const user = await asUser(USER_D, env.url, env.backend)
    const sent = async (local: string) =>
      (
        await user.mail_outbox_list(local, { cursor: [], limit: 10n })
      ).items.map((item) => item.subject)
    expect(await sent('team')).toContain('Bound tern')
    expect(await sent('aardvark')).not.toContain('Bound tern')
  } finally {
    // The other tests see team as this user's first mailbox
    backend('admin_remove_member', `${member})`)
    await context.close()
  }
})

test('an ended sign-in returns to the sign-in page, keeping the draft for the same user only', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_B)
  const end = () => endSignIn(page)
  const signInAs = (seed: string) => signInAgain(page, seed)

  await page.getByRole('button', { name: 'Compose' }).click()
  await page.getByLabel('Subject').fill('Kept heron')
  await page.getByRole('textbox', { name: 'Message' }).fill('Half written')
  await page.getByLabel('Attachments').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await end()
  await expect(page.getByRole('status')).toContainText(
    'Your sign-in has ended. Please sign in again.'
  )
  await expect(page.getByRole('status')).toContainText(
    'Your unsent message reopens'
  )
  await expect(page.getByTestId('address')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await signInAs(USER_B)
  await expect(page.getByTestId('address')).toHaveText(`bob@${DOMAIN}`)
  await expect(page.getByLabel('Subject')).toHaveValue('Kept heron')
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Half written'
  )
  await expect(page.getByTestId('attached')).toHaveText('Attached: notes.txt')

  await end()
  await signInAs(USER_A)
  await expect(page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await context.close()
})

const XSS: string[] = [
  `<script>top.__xss=1;parent.__xss=1</script>`,
  `<img src=x onerror="top.__xss=1">`,
  `<svg onload="top.__xss=1"></svg>`,
  `<body onload="top.__xss=1">`,
  `<iframe src="javascript:top.__xss=1"></iframe>`,
  `<iframe srcdoc="<script>top.__xss=1</script>"></iframe>`,
  `<a id=x href="javascript:top.__xss=1">click</a><script>x.click()</script>`,
  `<meta http-equiv=refresh content="0;url=http://evil.test/nav">`,
  `<img src="http://evil.test/pixel.png">`,
  `<link rel=stylesheet href="http://evil.test/s.css">`,
  `<style>@import 'http://evil.test/i.css'; body{background:url(http://evil.test/bg.png)}</style>`,
  `<form action="http://evil.test/f"><input autofocus onfocus="top.__xss=1"></form>`,
  `<object data="http://evil.test/o"></object><embed src="http://evil.test/e">`,
  `<video src="http://evil.test/v" autoplay onerror="top.__xss=1"></video>`,
  `<base href="http://evil.test/"><img src="relative.png">`,
  `</iframe><script>top.__xss=1</script>`,
  `"><script>top.__xss=1</script>`,
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=top.__xss=1&gt;">`,
  `<meta http-equiv="Content-Security-Policy" content="default-src *"><img src="http://evil.test/after-meta.png">`,
  `<img src="cid:&quot;&gt;&lt;script&gt;top.__xss=1&lt;/script&gt;">`,
  `<details open ontoggle="top.__xss=1">x</details>`,
]

for (const bypassCSP of [false, true]) {
  const label = bypassCSP
    ? "with the page's CSP bypassed, by the sandbox and the message's own policy"
    : 'with the CSP'
  test(`hostile HTML executes nothing, ${label}`, async ({ browser }) => {
    test.setTimeout(420_000)
    const { context, page } = await signedIn(browser, USER_B, { bypassCSP })
    const dialogs: string[] = []
    const external: string[] = []
    page.on('dialog', async (d) => {
      dialogs.push(d.message())
      await d.dismiss()
    })
    page.on('request', (r) => {
      if (/^https?:/.test(r.url()) && !r.url().startsWith(env.url))
        external.push(r.url())
    })
    // Chrome can report a load and then block it: only what the CSP stopped is not a leak
    page.on('requestfailed', (r) => {
      if (r.failure()?.errorText !== 'csp') return
      const attempt = external.indexOf(r.url())
      if (attempt >= 0) external.splice(attempt, 1)
    })

    const tag = bypassCSP ? 'bypass' : 'strict'
    XSS.forEach((payload, index) => {
      deliver({
        to: 'bob',
        subject: `Corpus ${tag}${index}`,
        body: `<p id="shown">visible${tag}${index}</p>${payload}`,
      })
    })
    await waitDrained()

    for (let index = 0; index < XSS.length; index += 1) {
      await page.getByLabel('Search mail').fill(`${tag}${index}`)
      await page.getByLabel('Search mail').press('Enter')
      // By its subject: until the search returns, the list still shows the last result
      await page
        .locator('button.message', { hasText: `Corpus ${tag}${index}` })
        .click()
      await expect(page.getByTestId('subject')).toHaveText(
        `Corpus ${tag}${index}`
      )
      await expect(page.locator('iframe.body')).toHaveAttribute('sandbox', '')
      await page.waitForTimeout(300)
      expect(
        await page.evaluate(
          () => (window as unknown as { __xss?: number }).__xss
        ),
        XSS[index]
      ).toBeUndefined()
      expect(page.url().startsWith(env.url), XSS[index]).toBe(true)
    }

    expect(dialogs).toEqual([])
    if (bypassCSP) {
      // Proves the listener works: with the page's policy bypassed, this one goes out
      const control = 'http://evil.test/control.png'
      await page.evaluate((url) => {
        new Image().src = url
      }, control)
      await expect.poll(() => external).toEqual([control])
    } else {
      expect(external).toEqual([])
    }
    await context.close()
  })
}

test('hostile headers and file names stay text', async ({ browser }) => {
  const payload = `<img src=x onerror=top.__xss=1>`
  deliver({
    to: 'bob',
    subject: `Header ${payload} pelican`,
    body: `plain ${payload} pelican`,
    contentType: 'text/plain; charset=utf-8',
  })
  deliver({
    to: 'bob',
    subject: 'Name toucan',
    from: `"${payload}" <a@sender.example>`,
    body: '<p>x</p>',
  })
  const attachment =
    `--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n` +
    `--b\r\nContent-Type: text/html; name="x.html"\r\nContent-Disposition: attachment; filename="<img src=x onerror=top.__xss=1>.html"\r\n\r\n<script>top.__xss=1</script>\r\n--b--\r\n`
  deliver({
    to: 'bob',
    subject: 'File heron',
    contentType: 'multipart/mixed; boundary=b',
    body: attachment,
  })
  await waitDrained()

  const { context, page } = await signedIn(browser, USER_B)
  for (const word of ['pelican', 'toucan', 'heron']) {
    await page.getByLabel('Search mail').fill(word)
    await page.getByLabel('Search mail').press('Enter')
    await page.locator('button.message', { hasText: word }).first().click()
    await expect(page.getByTestId('subject')).toBeVisible()
    await page.waitForTimeout(300)
  }
  await page.getByRole('button', { name: /onerror/ }).waitFor()
  const saved = await download(page, /onerror/)
  expect(saved.toString()).toContain('<script>')
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)
  ).toBeUndefined()
  await context.close()
})

test('a 1.4 MB attachment survives receiving and sending, by hash', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const content = Buffer.alloc(1_400_000)
  for (let i = 0; i < content.length; i += 1)
    content[i] = (i * 37 + (i >> 8)) & 255
  const expected = sha256(content)

  const base64Lines = content.toString('base64').replace(/(.{76})/g, '$1\r\n')
  deliver({
    subject: 'Large capybara',
    contentType: 'multipart/mixed; boundary=b',
    body:
      `--b\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n` +
      `--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="big.bin"\r\n\r\n${base64Lines}\r\n--b--\r\n`,
  })
  await waitDrained()

  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'capybara')
  const received = await download(page, /big\.bin/)
  expect(sha256(received)).toBe(expected)

  stub('stub_reset')
  await compose(page, 'Sending the file')
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('<b>not markup</b>\nline two')
  await page.getByRole('dialog').getByLabel('Attachments').setInputFiles({
    name: 'up.bin',
    mimeType: 'application/octet-stream',
    buffer: content,
  })
  await send(page)

  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await page.getByRole('button', { name: /Sending the file/ }).click()
  await expect(page.getByTestId('outbox-state')).toHaveText(
    'Accepted for delivery',
    { timeout: 60_000 }
  )

  const stats = stub('stub_stats')
  expect(/last_attachment = "([^"]*)"/.exec(stats)?.[1]).toBe(
    content.toString('base64')
  )
  expect(/last_from = "([^"]*)"/.exec(stats)?.[1]).toBe('alice')
  expect(stats).toMatch(/max_sends_per_key = 1\b/)

  const sent = await download(page, /up\.bin/)
  expect(sha256(sent)).toBe(expected)
  await context.close()
})

test('refuses an oversize attachment before sending', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  await page.getByRole('button', { name: 'Compose' }).click()
  await page
    .getByRole('dialog')
    .getByLabel('Attachments')
    .setInputFiles({
      name: 'x.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(1_600_000),
    })
  await expect(page.getByRole('alert')).toContainText('too large')
  await expect(
    page.getByRole('button', { name: 'Send', exact: true })
  ).toBeDisabled()
  await context.close()
})

test('shows an unknown outcome and warns before sending again', async ({
  browser,
}) => {
  stub('stub_reset')
  stub('stub_set_mode', '("unknown")')
  const { context, page } = await signedIn(browser, USER_A)
  await compose(page, 'Doubtful message')
  await send(page)
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await page.getByRole('button', { name: /Doubtful message/ }).click()
  await expect(page.getByTestId('outbox-state')).toHaveText('Outcome unknown', {
    timeout: 60_000,
  })

  stub('stub_set_mode', '("sent")')
  let warning = ''
  page.once('dialog', async (dialog) => {
    warning = dialog.message()
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Send again' }).click()
  await expect.poll(() => warning).toContain('twice')
  // The pane closes when the resend returns; opening it sooner would be undone
  await expect(
    page.getByText('Select a message to see its status.')
  ).toBeVisible()
  await page.getByRole('button', { name: /Doubtful message/ }).click()
  await expect(page.getByTestId('outbox-state')).toHaveText(
    'Accepted for delivery',
    { timeout: 60_000 }
  )
  await context.close()
})

test('shows mail the gateway refused, with its reason, and sends it again', async ({
  browser,
}) => {
  stub('stub_reset')
  stub('stub_set_mode', '("rejected")')
  const { context, page } = await signedIn(browser, USER_A)
  page.on('dialog', (dialog) => dialog.accept())
  await compose(page, 'Refused message')
  await send(page)
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await page.getByRole('button', { name: /Refused message/ }).click()
  await expect(page.getByTestId('outbox-state')).toHaveText('Not sent', {
    timeout: 60_000,
  })
  await expect(page.getByText('HTTP 400: bad request')).toBeVisible()

  stub('stub_set_mode', '("sent")')
  await page.getByRole('button', { name: 'Send again' }).click()
  await expect(
    page.getByText('Select a message to see its status.')
  ).toBeVisible()
  await page.getByRole('button', { name: /Refused message/ }).click()
  await expect(page.getByTestId('outbox-state')).toHaveText(
    'Accepted for delivery',
    { timeout: 60_000 }
  )
  await context.close()
})

test('sends to every Cc and Bcc address, however they are separated', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  await compose(page, 'Many readers')
  await page
    .getByLabel('Cc', { exact: true })
    .fill('a@example.org, b@example.org;c@example.org')
  await page
    .getByLabel('Bcc', { exact: true })
    .fill(' d@example.org \n e@example.org ')
  await send(page)
  await expect(page.getByRole('dialog', { name: 'New message' })).toHaveCount(0)
  const alice = await asAlice()
  const { items } = await alice.mail_outbox_list('alice', {
    cursor: [],
    limit: 1n,
  })
  expect(items[0].subject).toBe('Many readers')
  expect(items[0].to).toEqual(['friend@example.org'])
  expect(items[0].cc).toEqual([
    'a@example.org',
    'b@example.org',
    'c@example.org',
  ])
  expect(items[0].bcc).toEqual(['d@example.org', 'e@example.org'])
  await context.close()
})

test('a reply goes to the sender and quotes the message', async ({
  browser,
}) => {
  deliver({
    subject: 'Question about an emu',
    body: 'Is the emu well?\r\nIt looked tired.\r\n',
    contentType: 'text/plain; charset=utf-8',
    from: 'Erin <erin@sender.example>',
  })
  deliver({
    subject: 'Re: Emu follow-up',
    body: 'Still asking.\r\n',
    contentType: 'text/plain; charset=utf-8',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'tired')
  await page.getByRole('button', { name: 'Reply' }).click()
  const compose = page.getByRole('dialog', { name: 'New message' })
  await expect(compose.getByLabel('To', { exact: true })).toHaveValue(
    'erin@sender.example'
  )
  await expect(compose.getByLabel('Subject')).toHaveValue(
    'Re: Question about an emu'
  )
  await expect(compose.getByLabel('Message')).toHaveValue(
    /> Is the emu well\?\n> It looked tired\./
  )
  await compose.getByRole('button', { name: 'Close' }).click()

  // A subject that starts with Re: keeps a single one
  await openMail(page, 'Still asking')
  await page.getByRole('button', { name: 'Reply' }).click()
  await expect(compose.getByLabel('Subject')).toHaveValue('Re: Emu follow-up')
  await context.close()
})

test('downloads a copy of the mailbox, as its SQLite file', async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser, USER_A)
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download a copy' }).click(),
  ])
  expect(file.suggestedFilename()).toMatch(
    new RegExp(`^alice@${DOMAIN}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`)
  )
  const data = readFileSync(await file.path())
  expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
  expect(data.length % 4096).toBe(0)

  // The download ends its freeze: new mail moves in at once
  await expect(
    page.getByRole('button', { name: 'Download a copy' })
  ).toBeEnabled()
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
  const button = page.getByRole('button', { name: 'Download a copy' })
  await button.click()
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled()
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
  const data = await download(page, /Download a copy/)
  expect(failed).toBe(4)
  expect(tries).toBeGreaterThan(4)
  expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
  // The thaw follows the save: closing the page first could cancel it
  await expect(
    page.getByRole('button', { name: 'Download a copy' })
  ).toBeEnabled()
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
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.getByRole('button', { name: 'Download a copy' }).click()
        await chunk.seen
        // The failed renewal, then one that holds the download again
        await expect.poll(() => renewed, { timeout: 30_000 }).toBeGreaterThan(0)
        // Well past the hold: only the renewals after it keep the download
        await page.waitForTimeout(8_000)
        chunk.release()
      })(),
    ])
    const data = readFileSync(await file.path())
    expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
    // The thaw follows the save: closing the page first could cancel it
    await expect(
      page.getByRole('button', { name: 'Download a copy' })
    ).toBeEnabled()
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
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.getByRole('button', { name: 'Download a copy' }).click()
        await chunk.seen
        // The next renewal goes out while the first still hangs
        await expect.poll(() => freezes, { timeout: 30_000 }).toBeGreaterThan(2)
        // Longer than the hold: only the later renewals keep it
        await page.waitForTimeout(6_000)
        chunk.release()
      })(),
    ])
    const data = readFileSync(await file.path())
    expect(data.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0')
    // The download ends while the first renewal still hangs
    await expect(
      page.getByRole('button', { name: 'Download a copy' })
    ).toBeEnabled()
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
    await page.getByRole('button', { name: 'Flag', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Unflag', exact: true })
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
    const flag = page.getByRole('button', { name: 'Flag', exact: true })
    await flag.click()
    await expect(page.getByRole('alert')).toContainText('downloaded')
    // Once the download ends, flagging works and the refusal goes away
    await alice.mail_export_thaw('alice', info.started_ns)
    await flag.click()
    await expect(
      page.getByRole('button', { name: 'Unflag', exact: true })
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
  const button = page.getByRole('button', { name: 'Download a copy' })
  await download(page, /Download a copy/)
  await thaw.seen
  // Saved, but the freeze has not ended yet: a new download would be refused
  await expect(button).toBeDisabled()
  thaw.release()
  await expect(button).toBeEnabled()
  await noDownloadHeld()
  await context.close()
})

test('signing out ends a download under way', async ({ browser }) => {
  const { context, page } = await signedIn(browser, USER_A)
  const chunk = await hold(page, 'mail_export_chunk')
  const thaws = watch(page, 'mail_export_thaw')
  let downloaded = false
  page.on('download', () => (downloaded = true))
  await page.getByRole('button', { name: 'Download a copy' }).click()
  await chunk.seen
  await page.getByRole('button', { name: 'Sign out' }).click()
  chunk.release()
  await expect.poll(() => thaws.length, { timeout: 30_000 }).toBe(1)
  // The thaw was sent; it may not have ended yet
  await expect(noDownloadHeld).toPass({ timeout: 10_000 })
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
    await expect(
      page.getByRole('button', { name: 'Refresh', exact: true })
    ).toBeVisible()
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
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
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

// Answers the page's dialogs in turn: text for a prompt, true or false for a
// confirm. Returns the messages they showed.
function answer(page: Page, ...answers: (string | boolean)[]): string[] {
  const shown: string[] = []
  page.on('dialog', async (dialog) => {
    shown.push(dialog.message())
    const next = answers.shift()
    if (next === false || next === undefined) await dialog.dismiss()
    else await dialog.accept(next === true ? undefined : next)
  })
  return shown
}

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
    await expect(row.getByTitle(member)).toHaveCount(0)

    await row.getByRole('button', { name: 'Add member' }).click()
    await expect(row.getByTitle(member)).toBeVisible()

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
  await expect(row.getByTitle(petrel)).toBeVisible()
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(row.getByTitle(shag)).toBeVisible()

  // People lists everyone who is a member somewhere, and names them
  const person = page.getByTestId(`person-${petrel}`)
  await expect(person).toContainText('deck')
  await person.getByLabel('Name').fill('Petrel P')
  await person.getByRole('button', { name: 'Save name' }).click()
  await expect(row).toContainText('Petrel P')
  await expect(person.getByLabel('Name')).toHaveValue('Petrel P')

  // A saved name stays shown while the list reloads, so a second Save
  // cannot write the old one back
  const reload = await hold(page, 'admin_list_entries')
  await person.getByLabel('Name').fill('Petrel Q')
  await person.getByRole('button', { name: 'Save name' }).click()
  await reload.seen
  await expect(person.getByRole('button', { name: 'Save name' })).toBeEnabled()
  await expect(person.getByLabel('Name')).toHaveValue('Petrel Q')
  // and the reload shows the name stored, even one set meanwhile elsewhere
  backend('admin_set_name', `(principal "${petrel}", "Petrel R")`)
  backend('admin_set_name', `(principal "${shag}", "Petrel R")`)
  reload.release()
  await expect(person.getByLabel('Name')).toHaveValue('Petrel R')

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
  await expect(row.getByTitle(shag)).toHaveCount(0)
  await expect(page.getByTestId(`person-${shag}`)).toHaveCount(0)
  await member.page.reload()
  await expect(
    member.page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()

  // An empty name removes it
  await person.getByLabel('Name').fill('')
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
  await expect(row.getByTitle(member)).toHaveCount(0)
  // Reloaded, as the refusal says, the list names the new mailbox
  await page.reload()
  await expect(row).toBeVisible()
  // The anonymous principal is never a member
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'the anonymous principal cannot be a member'
  )
  await row.getByRole('button', { name: 'Add member' }).click()
  await expect(row.getByTitle(member)).toBeVisible()
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
    page.getByLabel('Domain'),
    page.getByLabel('Bridge'),
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
  const domain = page.getByLabel('Domain')
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
  const domain = page.getByLabel('Domain')
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
  const domain = page.getByLabel('Domain')
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
    page.getByTestId('entry-zcrew').getByTitle(principalOf(USER_C))
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

test('a flag set while the message loads stays set', async ({ browser }) => {
  deliver({ subject: 'Slow avocet', body: '<p>Flag me early</p>' })
  const { context, page } = await signedIn(browser, USER_A)
  // The message's reply is answered at once but arrives late, so it holds
  // the flags from before the click
  const reply = await hold(page, 'mail_get', { late: true })
  await openMail(page, 'Slow avocet')
  await reply.seen
  await page.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unflag', exact: true })
  ).toBeVisible()
  reply.release()
  // Read once the message has loaded, and still flagged
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Unflag', exact: true })
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
    page.getByRole('button', { name: 'Unflag', exact: true })
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
  await page.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unflag', exact: true })
  ).toBeVisible()
  release()
  // The list shows the message read only once the held call has completed
  await expect(page.locator('button.message.unread')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Unflag', exact: true })
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

const mailboxButton = (page: Page, local: string) =>
  page
    .getByRole('list', { name: 'Mailboxes' })
    .getByRole('button', { name: new RegExp(`^${local}`) })

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
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(badge).toHaveText(String(before + 1))
  // Read here, and counted at once: well before the 30 s refresh
  await mailboxButton(page, 'shore').click()
  await openMail(page, 'Counted dunlin')
  const soon = { timeout: 5_000 }
  if (before === 0) await expect(badge).toHaveCount(0, soon)
  else await expect(badge).toHaveText(String(before), soon)
  await context.close()
})

test('at phone width a select chooses the mailbox', async ({ browser }) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN, {
    viewport: { width: 390, height: 844 },
  })
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  await expect(mailboxButton(page, 'heron')).toBeHidden()
  await page.getByLabel('Mailbox', { exact: true }).selectOption('shore')
  await expect(page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(page.getByRole('button', { name: 'Inbox' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sent' })).toBeVisible()
  // The select's long option text does not widen the page
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  // Compose covers an open Seen by list
  deliver({ subject: 'Covered stint', body: '<p>Under</p>', to: 'shore' })
  await waitDrained()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await openMail(page, 'Covered stint')
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
  await page.getByRole('button', { name: 'Flag', exact: true }).click()
  await page.getByRole('button', { name: 'Unflag', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Flag', exact: true })
  ).toBeVisible()
  reply.release()
  // Read once the message has loaded, and still not flagged, as stored
  await expect(
    page.locator('button.message.unread', { hasText: 'Late plover' })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Flag', exact: true })
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

test('a download keeps going, and names its mailbox, when another one opens', async ({
  browser,
}) => {
  fernAndGail()
  const { context, page } = await signedIn(browser, FERN)
  await expect(page.getByTestId('address')).toHaveText(`heron@${DOMAIN}`)
  const chunks = await hold(page, 'mail_export_chunk')
  const saved = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download a copy' }).click()
  await chunks.seen
  await mailboxButton(page, 'shore').click()
  await expect(page.getByTestId('address')).toHaveText(`shore@${DOMAIN}`)
  await expect(page.locator('.download [role=status]')).toContainText(
    `heron@${DOMAIN}`
  )
  chunks.release()
  expect((await saved).suggestedFilename()).toMatch(/^heron@/)
  // The download has ended its hold, so later tests can write to heron
  await expect(
    page.getByRole('button', { name: 'Download a copy' })
  ).toBeEnabled()
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
  // Compose again keeps the open draft, with its From
  await page.getByRole('button', { name: 'Compose' }).click()
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
  await page.getByRole('button', { name: 'Refresh' }).click()
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
  await page.getByRole('button', { name: 'Refresh' }).click()
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
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
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
  const refresh = page.getByRole('button', { name: 'Refresh' })
  await refresh.click()
  await first.seen
  // Registered last, so it comes before the held one
  let failed = false
  await page.route('**/api/*/canister/*/*', (route) => {
    if (!callsTo(route.request(), 'mail_me')) return route.fallback()
    failed = true
    return route.abort()
  })
  await expect(refresh).toBeEnabled()
  await refresh.click()
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

const undo = (page: Page) => toastButton(page, 'Undo')
// A folder or page of the mailbox shown, from the list beside the mail
const folder = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name, exact: true })
    .click()

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
  await openMail(page, 'Pushy grebe')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
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

  await folder(page, 'Blocked senders')
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
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/again@sender.example was blocked already/)
  await expect(note.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await alice.mail_unblock('alice', 'again@sender.example')
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

test('a block whose move is refused still offers Undo', async ({ browser }) => {
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
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Blocked dipper@sender.example/, {
    timeout: 60_000,
  })
  await page.unrouteAll({ behavior: 'wait' })
  await note.getByRole('button', { name: 'Undo' }).click()
  const alice = await asAlice()
  await expect
    .poll(async () => (await alice.mail_blocked('alice')).map((b) => b.address))
    .not.toContain('dipper@sender.example')
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
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
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

test('Undo of a block shows on the Blocked senders page', async ({
  browser,
}) => {
  deliver({
    subject: 'Hasty jay',
    body: '<p>A jay.</p>',
    from: 'Hasty <hasty@sender.example>',
  })
  await waitDrained()
  const { context, page } = await signedIn(browser, USER_A)
  await openMail(page, 'jay')
  await expect(page.getByTestId('subject')).toHaveText('Hasty jay')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Blocked hasty@sender.example/)
  await folder(page, 'Blocked senders')
  const blocked = page.getByRole('region', { name: 'Blocked senders' })
  await expect(blocked).toContainText('hasty@sender.example')
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(blocked).not.toContainText('hasty@sender.example')
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
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Block sender' }).click()
  const note = page.getByTestId('toast')
  await expect(note).toHaveText(/Blocked rash@sender.example/)
  await folder(page, 'Blocked senders')
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
  expect(bar.x + bar.width).toBeGreaterThan(1200)
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
  await context.close()
})

const QUILL = '4c'.repeat(32)

test('a message sent while older mail is shown in Sent shows there', async ({
  browser,
}) => {
  joinMailbox('quill', QUILL)
  const quill = await asUser(QUILL, env.url, env.backend)
  // More than one page
  await Promise.all(
    Array.from({ length: 51 }, (_, i) =>
      quill.mail_send('quill', {
        client_id: crypto.randomUUID(),
        to: ['friend@example.org'],
        cc: [],
        bcc: [],
        subject: `Quill page ${i}`,
        html_body: '<p>Filler</p>',
        attachments: [],
      })
    )
  )
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
