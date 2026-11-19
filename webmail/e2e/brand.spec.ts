// brand/brand.mjs on the generic build: what it writes, and what it refuses.
// Needs no replica.

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const webmail = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const scratch = mkdtempSync(path.join(tmpdir(), 'brand-'))
const dist = path.join(scratch, 'dist')

test.beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'build',
      '--outDir',
      dist,
      '--emptyOutDir',
    ],
    {
      cwd: webmail,
      stdio: 'pipe',
    }
  )
})
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type Options = {
  brand?: string
  backend?: string
  network?: string
  origin?: string
  out?: string
  customDomains?: string[]
}

function brand(options: Options): { ok: boolean; output: string; out: string } {
  const out =
    options.out ?? path.join(mkdtempSync(path.join(scratch, 'out-')), 'webmail')
  const args = [
    'brand/brand.mjs',
    '--dist',
    dist,
    '--out',
    out,
    '--backend',
    options.backend ?? 'aaaaa-aa',
  ]
  if (options.brand) args.push('--brand', options.brand)
  args.push('--network', options.network ?? 'local')
  if (options.origin) args.push('--origin', options.origin)
  for (const host of options.customDomains ?? [])
    args.push('--custom-domain', host)
  // Both streams, also on success: contrast warnings go to stderr
  const run = spawnSync(process.execPath, args, {
    cwd: webmail,
    encoding: 'utf8',
  })
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`, out }
}

function brandCopy(change: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(scratch, 'brand-'))
  cpSync(path.join(webmail, 'e2e', 'brand'), dir, { recursive: true })
  change(dir)
  return dir
}

// A copy of e2e/brand with these settings of brand.json added or replaced
const editBrand = (patch: Record<string, unknown>) =>
  brandCopy((d) => {
    const file = path.join(d, 'brand.json')
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch })
    )
  })

const brandCss = (out: string) =>
  readFileSync(path.join(out, 'brand.css'), 'utf8')

const settingsOf = (html: string) =>
  JSON.parse(
    /<script type="application\/json" id="settings">(.*?)<\/script>/.exec(
      html
    )![1]
  )

test('the build itself is generic: no settings, brand or handoff file', () => {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8')
  expect(html).toContain('<title>Mail</title>')
  expect(html).not.toContain('id="settings"')
  expect(existsSync(path.join(dist, 'brand.css'))).toBe(false)
  expect(existsSync(path.join(dist, '.well-known'))).toBe(false)
})

test('without a brand the webmail is greyscale', () => {
  const { ok, output, out } = brand({})
  expect(ok, output).toBe(true)
  expect(output).not.toContain('below')
  const css = brandCss(out)
  const colours = css.match(/#[0-9a-f]{3,8}\b/gi)!
  expect(colours.length).toBeGreaterThan(20)
  for (const colour of colours) {
    const hex =
      colour.length === 4
        ? [...colour.slice(1)].map((c) => c + c).join('')
        : colour.slice(1, 7)
    expect(
      new Set([hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)]).size,
      colour
    ).toBe(1)
  }
  const html = readFileSync(path.join(out, 'index.html'), 'utf8')
  expect(html).toContain('<title>Mail</title>')
  expect(html).not.toContain('rel="icon"')
  expect(settingsOf(html)).toMatchObject({
    backend: 'aaaaa-aa',
    network: 'local',
    brand: { name: 'Mail', logo: null },
  })
  expect(
    readFileSync(path.join(out, '.well-known', 'ic-smtp-canister-id'), 'utf8')
  ).toBe('aaaaa-aa')
})

test("escapes the brand's name in the title and the settings", () => {
  const { ok, output, out } = brand({ brand: 'e2e/brand' })
  expect(ok, output).toBe(true)
  const html = readFileSync(path.join(out, 'index.html'), 'utf8')
  expect(html).toContain('<title>Test &lt;Mail&gt; &amp; Co</title>')
  expect(html).not.toContain('Test <Mail>')
  expect(settingsOf(html).brand.name).toBe('Test <Mail> & Co')
  expect(existsSync(path.join(out, 'brand', 'logo-dark.svg'))).toBe(true)
})

test('checks the deployment settings', () => {
  expect(brand({ backend: 'not a principal' }).output).toContain(
    "give the backend canister's id"
  )
  expect(brand({ network: 'ic' }).output).toContain(
    '--origin is required on ic'
  )
  expect(
    brand({ network: 'ic', origin: 'http://mail.example' }).output
  ).toContain('give an origin like')
  expect(
    brand({ network: 'ic', origin: 'https://mail.example/path' }).output
  ).toContain('give an origin like')
  expect(brand({ network: 'staging' }).output).toContain('use ic or local')
  expect(brand({ network: 'ic', origin: 'https://mail.example' }).ok).toBe(true)
})

// The webmail canister's own address, where Internet Identity reads the custom domains
const CANISTER_ORIGIN = 'https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io'

test('writes the custom domains for the IC and Internet Identity, and nothing without them', () => {
  const origin = CANISTER_ORIGIN
  const run = brand({
    network: 'ic',
    origin,
    customDomains: ['mail.example.com', 'post.example.org'],
  })
  expect(run.ok).toBe(true)
  const read = (file: string) =>
    readFileSync(path.join(run.out, '.well-known', file), 'utf8')
  expect(read('ic-domains')).toBe('mail.example.com\npost.example.org\n')
  expect(JSON.parse(read('ii-alternative-origins'))).toEqual({
    alternativeOrigins: [
      'https://mail.example.com',
      'https://post.example.org',
    ],
  })
  // The origin, which fixes the principals, stays as given
  expect(
    settingsOf(readFileSync(path.join(run.out, 'index.html'), 'utf8'))
      .derivationOrigin
  ).toBe(origin)

  const plain = brand({ network: 'ic', origin })
  expect(plain.ok).toBe(true)
  for (const file of ['ic-domains', 'ii-alternative-origins']) {
    expect(existsSync(path.join(plain.out, '.well-known', file))).toBe(false)
  }
})

test('refuses custom domains that are not hosts, are canister addresses or exceed the limit', () => {
  const origin = CANISTER_ORIGIN
  const refused = (
    customDomains: string[],
    options: Options = { network: 'ic', origin }
  ) => {
    const run = brand({ ...options, customDomains })
    expect(run.ok).toBe(false)
    return run.output
  }
  // Internet Identity reads the list only from the canister's own address
  const backendOrigin = {
    network: 'ic',
    backend: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
    origin,
  }
  for (const options of [
    { network: 'local' },
    { network: 'ic', origin: 'https://mail.example' },
    backendOrigin,
  ]) {
    expect(refused(['mail.example.com'], options)).toContain(
      '--custom-domain needs --origin https://<webmail id>.icp0.io'
    )
  }
  const long = `${'a'.repeat(64)}.example.com`
  for (const host of [
    'Mail.example.com',
    'mail',
    '1.2.3.4',
    'https://mail.example.com',
    'mail.example.com:8443',
    '-x.example.com',
    long,
  ]) {
    expect(refused([host])).toContain('give a lower-case host')
  }
  for (const host of [
    new URL(origin).hostname,
    'rrkah-fqaaa-aaaaa-aaaaq-cai.ic0.app',
    'other.raw.icp0.io',
    'icp0.io',
    'x.icp-api.io',
  ]) {
    expect(refused([host])).toContain('is a canister address')
  }
  expect(refused(['mail.example.com', 'mail.example.com'])).toContain(
    'is given twice'
  )
  const eleven = Array.from({ length: 11 }, (_, i) => `m${i}.example.com`)
  expect(refused(eleven)).toContain('at most 10 --custom-domain')
  expect(
    brand({ network: 'ic', origin, customDomains: eleven.slice(0, 10) }).ok
  ).toBe(true)
  const legacy = 'https://rrkah-fqaaa-aaaaa-aaaaq-cai.ic0.app'
  expect(
    brand({
      network: 'ic',
      origin: legacy,
      customDomains: ['mail.example.com'],
    }).ok
  ).toBe(true)
})

test('writes only into an empty folder or its own earlier output', () => {
  const out = path.join(scratch, 'occupied')
  mkdirSync(out)
  writeFileSync(path.join(out, 'keep.txt'), 'mine')
  expect(brand({ out }).output).toContain('was not written by this script')
  expect(readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('mine')

  const again = path.join(scratch, 'again')
  expect(brand({ out: again }).ok).toBe(true)
  expect(brand({ out: again, brand: 'e2e/brand' }).ok).toBe(true)
  expect(existsSync(path.join(again, 'brand', 'icon.svg'))).toBe(true)
})

test('refuses an output that is or overlaps the input, and deletes nothing', () => {
  const same = path.join(scratch, 'same')
  expect(brand({ out: same }).ok).toBe(true)
  const run = spawnSync(
    process.execPath,
    [
      'brand/brand.mjs',
      '--dist',
      same,
      '--out',
      same,
      '--backend',
      'aaaaa-aa',
      '--network',
      'local',
    ],
    {
      cwd: webmail,
      encoding: 'utf8',
    }
  )
  expect(run.stderr).toContain('must not be --dist')
  expect(existsSync(path.join(same, 'index.html'))).toBe(true)
  expect(brand({ out: path.join(dist, 'inside') }).output).toContain(
    'must not be --dist'
  )
})

test('a run that fails on its input leaves an earlier output in place', () => {
  const out = path.join(scratch, 'kept')
  expect(brand({ out }).ok).toBe(true)
  const generic = path.join(scratch, 'no-placeholder')
  cpSync(dist, generic, { recursive: true })
  writeFileSync(path.join(generic, 'index.html'), '<html><head></head></html>')
  const run = spawnSync(
    process.execPath,
    [
      'brand/brand.mjs',
      '--dist',
      generic,
      '--out',
      out,
      '--backend',
      'aaaaa-aa',
      '--network',
      'local',
    ],
    {
      cwd: webmail,
      encoding: 'utf8',
    }
  )
  expect(run.stderr).toContain('has no <title>Mail</title>')
  expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain(
    'id="settings"'
  )
  expect(brand({ out }).ok).toBe(true)
})

test('runs when started through a symlink', () => {
  const link = path.join(mkdtempSync(path.join(scratch, 'link-')), 'brand.mjs')
  symlinkSync(path.join(webmail, 'brand', 'brand.mjs'), link)
  const out = path.join(scratch, 'via-link')
  const run = spawnSync(
    process.execPath,
    [
      link,
      '--dist',
      dist,
      '--out',
      out,
      '--backend',
      'aaaaa-aa',
      '--network',
      'local',
    ],
    {
      encoding: 'utf8',
    }
  )
  expect(run.status, run.stderr).toBe(0)
  expect(existsSync(path.join(out, 'index.html'))).toBe(true)
})

test('keeps $ patterns in brand text literally, and refuses text that is not a string', () => {
  const { ok, output, out } = brand({
    brand: editBrand({ tagline: "Save $' and $& and $$ now" }),
  })
  expect(ok, output).toBe(true)
  expect(
    settingsOf(readFileSync(path.join(out, 'index.html'), 'utf8')).brand.tagline
  ).toBe("Save $' and $& and $$ now")
  expect(brand({ brand: editBrand({ tagline: 2026 }) }).output).toContain(
    'tagline must be text'
  )
  expect(brand({ brand: editBrand({ name: 123 }) }).output).toContain(
    'name must be text'
  )
})

test('refuses a brand file that is a symlink, so nothing outside the brand is published', () => {
  const secret = path.join(scratch, 'secret.svg')
  writeFileSync(secret, '<svg>not for publishing</svg>')
  const dir = brandCopy((d) => {
    rmSync(path.join(d, 'manifest.json'))
    rmSync(path.join(d, 'icon.svg'))
    symlinkSync(secret, path.join(d, 'icon.svg'))
  })
  const { ok, output } = brand({ brand: dir })
  expect(ok).toBe(false)
  expect(output).toContain('must be a regular file inside')
})

test('refuses a file that differs from the manifest', () => {
  const dir = brandCopy((d) =>
    writeFileSync(
      path.join(d, 'icon.svg'),
      readFileSync(path.join(d, 'icon.svg'), 'utf8') + ' '
    )
  )
  const { ok, output } = brand({ brand: dir })
  expect(ok).toBe(false)
  expect(output).toContain('icon.svg differs from manifest.json')
})

test('reads files, tokens and manifest from a shared package', () => {
  const shared = brandCopy(() => {})
  const settings = JSON.parse(
    readFileSync(path.join(shared, 'brand.json'), 'utf8')
  )
  rmSync(path.join(shared, 'brand.json'))
  const app = mkdtempSync(path.join(scratch, 'app-'))
  writeFileSync(
    path.join(app, 'brand.json'),
    JSON.stringify({ ...settings, package: path.relative(app, shared) })
  )
  const { ok, output, out } = brand({ brand: app })
  expect(ok, output).toBe(true)
  expect(brandCss(out)).toContain('--action: #1d5e8c;')
  writeFileSync(path.join(shared, 'icon.svg'), ' ', { flag: 'a' })
  expect(brand({ brand: app }).output).toContain(
    'icon.svg differs from manifest.json'
  )
})

test('takes font families from the tokens file', () => {
  const edit = (families: Record<string, string>) =>
    brandCopy((d) => {
      rmSync(path.join(d, 'manifest.json'))
      const tokens = path.join(d, 'tokens.json')
      writeFileSync(
        tokens,
        JSON.stringify({
          ...JSON.parse(readFileSync(tokens, 'utf8')),
          type: { families: { sans: '"Test Sans", sans-serif' } },
        })
      )
      const file = path.join(d, 'brand.json')
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), families })
      )
    })
  const { ok, output, out } = brand({ brand: edit({ body: '{sans}' }) })
  expect(ok, output).toBe(true)
  expect(brandCss(out)).toContain('--font-body: "Test Sans", sans-serif;')
  expect(brand({ brand: edit({ body: '{serif}' }) }).output).toContain(
    'font family {serif} is not in the type families'
  )
})

test("action-text follows the brand's action unless set, and is checked on its grounds", () => {
  // The brand's roles, which each case below adds to or changes
  const { roles } = JSON.parse(
    readFileSync(path.join(webmail, 'e2e', 'brand', 'brand.json'), 'utf8')
  )

  // e2e/brand sets action, not action-text: links and the bar take its action
  const follows = brand({ brand: 'e2e/brand' })
  expect(follows.ok, follows.output).toBe(true)
  const followsCss = brandCss(follows.out)
  expect(followsCss).toContain('--action-text: #1d5e8c;')
  expect(followsCss).toContain('--action-text: #7fc1f0;')

  const own = brand({
    brand: editBrand({
      roles: {
        ...roles,
        'action-text': { light: '#0b4a75', dark: '#9ccff3' },
      },
    }),
  })
  expect(own.ok, own.output).toBe(true)
  const ownCss = brandCss(own.out)
  expect(ownCss).toContain('--action-text: #0b4a75;')
  expect(ownCss).toContain('--action-text: #9ccff3;')
  expect(ownCss).toContain('--action: #1d5e8c;')

  // Too faint for the bar beside the selected folder
  const faint = brand({
    brand: editBrand({
      roles: {
        ...roles,
        'action-text': { light: '#a0a0a0', dark: '#7fc1f0' },
      },
    }),
  })
  expect(faint.ok, faint.output).toBe(true)
  expect(faint.output).toMatch(
    /brand: action-text on selected in light is \d+\.\d{2}:1, below 3:1/
  )

  // A button colour too dark for text in dark mode, with links of their own
  const dark = brand({
    brand: editBrand({
      roles: {
        ...roles,
        action: { light: '#1d5e8c', dark: '#0b2a40' },
        'action-text': { light: '#1d5e8c', dark: '#7fc1f0' },
      },
    }),
  })
  expect(dark.ok, dark.output).toBe(true)
  expect(dark.output).not.toContain('on surface-raised')
  expect(dark.output).not.toContain('action-text on selected')
})

test('refuses an unknown role, a missing token, a path outside the brand and unsafe CSS', () => {
  expect(
    brand({ brand: editBrand({ roles: { accent: '#000000' } }) }).output
  ).toContain('unknown role "accent"')
  expect(
    brand({ brand: editBrand({ roles: { action: '{nope}' } }) }).output
  ).toContain('token {nope} is not in tokens.json')
  expect(
    brand({ brand: editBrand({ icons: [{ file: '../brand.json' }] }) }).output
  ).toContain('use a plain relative path')
  expect(
    brand({
      brand: editBrand({ roles: { action: 'red; background: url(x)' } }),
    }).output
  ).toContain('role action')
  // Each would swallow the rules after it in a style sheet
  for (const value of [
    'rgb(20,20,20',
    'rgb)20(',
    'red /* note',
    '"red',
    'red [',
  ])
    expect(
      brand({ brand: editBrand({ roles: { ink: value } }) }).output
    ).toContain('role ink')
  // The last two are not CSS identifiers, and would void the whole font variable
  for (const value of [
    '"Inter',
    `'"' "x`,
    'Inter /* x',
    '"In\nter", serif',
    '"a</style>"',
    null,
    '.SF NS',
    'Source Sans 3',
  ])
    expect(
      brand({ brand: editBrand({ families: { body: value } }) }).output
    ).toContain('font family')
  // A quote of the other kind inside a quoted name, letters beyond ASCII, and quoted names are fine
  for (const value of [
    `"O'Brien", serif`,
    'Noto Sans 日本語, ".SF NS", "Source Sans 3", sans-serif',
  ])
    expect(brand({ brand: editBrand({ families: { body: value } }) }).ok).toBe(
      true
    )
  expect(
    brand({ brand: editBrand({ roles: { ink: 'var(--brand_ink, #1a1a1a)' } }) })
      .ok
  ).toBe(true)
})

test('the build deployed without settings says it is not configured', async ({
  page,
}) => {
  const port = 4600 + Math.floor(Math.random() * 300)
  const server: ChildProcess = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--outDir',
      dist,
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: webmail, stdio: 'ignore' }
  )
  try {
    await expect
      .poll(async () =>
        fetch(`http://localhost:${port}/`).then(
          (r) => r.status,
          () => 0
        )
      )
      .toBe(200)
    await page.goto(`http://localhost:${port}/`)
    await expect(
      page.getByRole('heading', { name: 'This webmail is not configured' })
    ).toBeVisible()
  } finally {
    server.kill()
  }
})
