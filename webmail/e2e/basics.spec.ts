// The webmail tests of the basics: onboarding, reading, rendering, composing
// and sending.
// Each spec file runs on a backend of its own (freshBackend in support.ts).

import { expect, test } from '@playwright/test'
import { asUser } from './as_user'
import { env } from './local'
import {
  ADMIN,
  asAlice,
  backend,
  bodyOf,
  compose,
  deliver,
  DOMAIN,
  download,
  endSignIn,
  freshBackend,
  joinTeam,
  menu,
  openMail,
  openMenu,
  principalOf,
  roleColour,
  send,
  sha256,
  signedIn,
  signInAgain,
  stub,
  USER_A,
  USER_B,
  USER_D,
  viewSent,
  waitDrained,
} from './support'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => freshBackend({ onboard: false }))

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

test('the page is checked for a new version on each load, and its hashed files are kept', async ({
  page,
}) => {
  const scripts: string[] = []
  page.on('response', (reply) => {
    if (/\/assets\/[^/]+\.js$/.test(reply.url())) scripts.push(reply.url())
  })
  const response = await page.goto(env.url)
  const headers = await response!.allHeaders()
  expect(headers['cache-control']).toBe('no-cache')
  // The other rules still apply to the page
  expect(headers['content-security-policy']).toContain("default-src 'none'")
  await expect.poll(() => scripts.length).toBeGreaterThan(0)
  // Through the browser, because Node does not resolve *.localhost
  const script = await page.evaluate(async (url) => {
    const reply = await fetch(url, { cache: 'no-store' })
    return {
      cache: reply.headers.get('cache-control'),
      policy: reply.headers.get('content-security-policy'),
    }
  }, scripts[0])
  expect(script.cache).toBe('public, max-age=31536000, immutable')
  expect(script.policy).toContain("default-src 'none'")
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
  const role = (name: string) =>
    page.evaluate(
      (role) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue(role)
          .trim(),
      name
    )
  expect(await role('--action')).toBe('#1d5e8c')
  expect(await role('--action-text')).toBe('#0b4a75')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.currentSrc))
    .toMatch(/logo-dark\.svg$/)
  expect(await role('--action')).toBe('#7fc1f0')
  expect(await role('--action-text')).toBe('#9ccff3')

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
      admin.page
        .getByTestId(`entry-${local}`)
        .getByTitle(principal, { exact: true })
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
    admin.page
      .getByTestId('entry-alice')
      .getByTitle(principalB, { exact: true })
  ).toHaveCount(0)

  await a.page.reload()
  await expect(a.page.getByTestId('address')).toHaveText(`alice@${DOMAIN}`)
  await openMenu(a.page, 'More')
  await expect(
    menu(a.page, 'More').getByRole('button', { name: 'Blocked senders' })
  ).toBeVisible()
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
    if (word === 'wren') {
      // e2e/brand gives links a colour apart from the button's
      const link = await roleColour(page, '--action-text')
      expect(link).not.toBe(await roleColour(page, '--action'))
      await expect(bodyOf(page).locator('a')).toHaveCSS('color', link)
    }
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
  await expect(page.getByTestId('attached')).toHaveText(
    'Attached: notes.txt (1 KB)'
  )

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
