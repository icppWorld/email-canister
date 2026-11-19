#!/usr/bin/env node
// Turns the generic webmail build into one deployment's webmail: its brand,
// its backend canister and its sign-in origin. Plain Node.js 20 or later, with
// no dependencies, so a deployment needs no npm install. README.md describes
// the brand format.
//
//   node brand.mjs --dist <webmail dist> --out <folder> --backend <canister id>
//                  [--origin <https://…>] [--network ic|local] [--brand <folder>]
//                  [--custom-domain <host>]...
//
// --origin is the Internet Identity derivation origin. It decides every user's
// principal, so it is required on ic and must never change once users exist.
// --custom-domain is another address the webmail answers on, with the same
// principals; repeat it for more than one. Internet Identity reads the list
// from the --origin host, so --origin must be this webmail's own address,
// https://<webmail id>.icp0.io (or .ic0.app).

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
}
const IMAGES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const ICONS = ['.svg', '.png', '.ico']
const FONTS = ['.woff2', '.woff']

// No segment may start with a dot, which also rules out ".."
const SAFE_PATH =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/
const PRINCIPAL = /^[a-z0-9]{5}(-[a-z0-9]{5})*(-[a-z0-9]{1,5})?$/
// The same check as domain.mjs: a name within DNS's limits, not an IP address, so the last label holds a letter
const DOMAIN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const isDomain = (name) =>
  DOMAIN.test(name) &&
  name.length <= 253 &&
  name.split('.').every((label) => label.length <= 63) &&
  /[a-z]/.test(name.slice(name.lastIndexOf('.') + 1))
// Internet Identity reads at most this many alternative origins
const MAX_CUSTOM_DOMAINS = 10
const OUTPUT_MARKER = '.brand-output'

// A role a brand leaves out follows this role of the brand, before the default
const FOLLOWS = { 'action-text': 'action' }

// Pairs that must stay readable: text, background, minimum contrast
const CONTRAST = [
  ['ink', 'surface', 4.5],
  ['ink', 'surface-muted', 4.5],
  ['ink', 'surface-raised', 4.5],
  ['action-text', 'surface-raised', 4.5],
  ['ink', 'selected', 4.5],
  ['ink-muted', 'surface', 4.5],
  ['ink-muted', 'surface-muted', 4.5],
  ['ink-muted', 'selected', 4.5],
  // The bar that marks the selected folder
  ['action-text', 'selected', 3],
  ['danger', 'surface', 4.5],
  ['warning', 'warning-surface', 4.5],
  ['on-action', 'action', 4.5],
  ['on-action', 'action-hover', 4.5],
  ['border-strong', 'surface', 3],
  ['focus-ring', 'surface', 3],
]

export class BrandError extends Error {}

function fail(message) {
  throw new BrandError(`brand: ${message}`)
}

// Values go into style sheets, where a comment, or a bracket or quote left
// open, would swallow the rules after them. So a role is a colour, length or
// shadow, with no quotes or square brackets and with its round brackets
// closed, and a font family is a list of names, bare or quoted.
const ROLE_VALUE = /^[A-Za-z0-9#%.,()\s/*_+-]*$/
const COMMENT = /\/\*|\*\//
// A bare name is CSS identifiers separated by spaces, so "Source Sans 3" must
// be quoted. A newline would end a quoted name early, and a quoted name must
// not end the frame's <style> or its rule.
const IDENTIFIER = String.raw`-?[\p{L}_][\p{L}\p{N}_-]*`
const FAMILY = String.raw`(?:"[^"\\\n\r\f;{}<>]*"|'[^'\\\n\r\f;{}<>]*'|${IDENTIFIER}(?: +${IDENTIFIER})*)`
const FAMILY_LIST = new RegExp(
  String.raw`^\s*${FAMILY}(?:\s*,\s*${FAMILY})*\s*$`,
  'u'
)

function safeRole(value) {
  if (
    typeof value !== 'string' ||
    !ROLE_VALUE.test(value) ||
    COMMENT.test(value)
  )
    return false
  let depth = 0
  for (const c of value) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0
    if (depth < 0) return false
  }
  return depth === 0
}

function safeFamily(value) {
  return (
    typeof value === 'string' && FAMILY_LIST.test(value) && !COMMENT.test(value)
  )
}

function readJson(file) {
  if (!existsSync(file)) fail(`${file} not found`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    fail(`${file}: ${e.message}`)
  }
}

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function luminance(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color)?.[1]
  if (!hex) return null
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)]
  if (la === null || lb === null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Loads and checks a brand folder, or the greyscale default without one.
// Returns what the app shows, the generated stylesheet, the <head> links, the
// files to publish under /brand/, and any contrast warnings.
export function loadBrand(folder) {
  const defaults = readJson(path.join(HERE, 'default.json'))
  const dir = folder ? path.resolve(folder) : ''
  const own = folder ? readJson(path.join(dir, 'brand.json')) : {}
  // A package is a brand folder shared with other apps: the files, tokens and
  // manifest live there, and brand.json keeps only this app's settings
  const files = own.package ? path.resolve(dir, own.package) : dir
  if (own.package && !existsSync(files))
    fail(`package ${own.package} not found from ${dir}`)
  const manifest =
    folder && existsSync(path.join(files, 'manifest.json'))
      ? readJson(path.join(files, 'manifest.json'))
      : null
  const outputs = new Map()
  const warnings = []

  // A copied file must match the manifest, so a hand edit stops the build
  const read = (file, types) => {
    if (typeof file !== 'string' || !SAFE_PATH.test(file))
      fail(`${file}: use a plain relative path inside ${files}`)
    const extension = path.extname(file).toLowerCase()
    if (!types.includes(extension))
      fail(`${file}: must be one of ${types.join(' ')}`)
    const full = path.join(files, file)
    if (!existsSync(full)) fail(`${file} not found in ${files}`)
    // Everything copied is published: no symlinks, nothing outside the brand folder
    if (
      !lstatSync(full).isFile() ||
      !realpathSync(full).startsWith(realpathSync(files) + path.sep)
    ) {
      fail(`${file}: must be a regular file inside ${files}, not a link`)
    }
    const bytes = readFileSync(full)
    if (manifest) {
      const expected = manifest.files?.[file]
      if (!expected) fail(`${file} is not listed in manifest.json`)
      if (createHash('sha256').update(bytes).digest('hex') !== expected) {
        fail(
          `${file} differs from manifest.json; refresh the copy from its source instead of editing it`
        )
      }
    }
    return bytes
  }
  const publish = (file, types) => {
    outputs.set(`brand/${file}`, read(file, types))
    return `/brand/${file}`
  }

  // Tokens in the design-system format: lists of { name, value } per family
  const table = new Map()
  let typeFamilies = {}
  let themes = ['light']
  if (own.tokens) {
    const doc = JSON.parse(read(own.tokens, ['.json']).toString('utf8'))
    themes = doc.color?.themes?.map((t) => t.id) ?? themes
    typeFamilies = doc.type?.families ?? {}
    for (const family of Object.values(doc)) {
      const list = family?.tokens
      if (!Array.isArray(list)) continue
      for (const token of list) table.set(token.name, token.value)
    }
  }

  const resolve = (value, seen = []) => {
    if (typeof value !== 'string') {
      if (value?.light === undefined)
        fail(`a value needs "light": ${JSON.stringify(value)}`)
      const light = resolve(value.light, seen).light
      return {
        light,
        dark: value.dark === undefined ? light : resolve(value.dark, seen).dark,
      }
    }
    const alias = ALIAS.exec(value)?.[1]
    if (!alias) return { light: value, dark: value }
    if (seen.includes(alias)) fail(`token {${alias}} refers to itself`)
    const target = table.get(alias)
    if (target === undefined)
      fail(
        `token {${alias}} is not in ${own.tokens ?? 'brand.json, which names no tokens file'}`
      )
    return resolve(target, [...seen, alias])
  }

  for (const role of Object.keys(own.roles ?? {})) {
    if (!(role in defaults.roles))
      fail(
        `unknown role "${role}"; the roles are ${Object.keys(defaults.roles).join(', ')}`
      )
  }
  // A brand without a dark theme stays light, rather than mixing with grey dark defaults
  const hasDark =
    !folder ||
    themes.includes('dark') ||
    Object.values(own.roles ?? {}).some(
      (v) => typeof v !== 'string' && v.dark !== undefined
    )
  const roles = Object.fromEntries(
    Object.entries(defaults.roles).map(([role, fallback]) => {
      const value = resolve(
        own.roles?.[role] ?? own.roles?.[FOLLOWS[role]] ?? fallback
      )
      for (const v of [value.light, value.dark])
        if (!safeRole(v)) fail(`role ${role}: ${v}`)
      return [role, value]
    })
  )
  // A family may name one of the tokens file's type families, as "{body}"
  const families = Object.fromEntries(
    Object.entries({ ...defaults.families, ...own.families }).map(
      ([name, v]) => {
        const alias = ALIAS.exec(v)?.[1]
        const value = alias === undefined ? v : typeFamilies[alias]
        if (value === undefined)
          fail(
            `font family {${alias}} is not in the type families of ${own.tokens ?? 'a tokens file'}`
          )
        if (!safeFamily(value)) fail(`font family ${value}`)
        return [name, value]
      }
    )
  )

  for (const theme of hasDark ? ['light', 'dark'] : ['light']) {
    for (const [text, ground, minimum] of CONTRAST) {
      const ratio = contrast(roles[text][theme], roles[ground][theme])
      if (ratio !== null && ratio < minimum) {
        warnings.push(
          `brand: ${text} on ${ground} in ${theme} is ${ratio.toFixed(2)}:1, below ${minimum}:1`
        )
      }
    }
  }

  const faces = (own.fonts ?? []).map((font) => {
    if (!/^[A-Za-z0-9 _-]+$/.test(font.family))
      fail(`font family name ${font.family}`)
    if (font.weight && !/^\d{3}( \d{3})?$/.test(font.weight))
      fail(`font weight ${font.weight}`)
    if (font.style && !/^(normal|italic)$/.test(font.style))
      fail(`font style ${font.style}`)
    const url = publish(font.file, FONTS)
    const format =
      path.extname(font.file).toLowerCase() === '.woff2' ? 'woff2' : 'woff'
    return (
      `@font-face {\n  font-family: "${font.family}";\n  src: url("${url}") format("${format}");\n` +
      (font.weight ? `  font-weight: ${font.weight};\n` : '') +
      (font.style ? `  font-style: ${font.style};\n` : '') +
      '  font-display: swap;\n}\n'
    )
  })

  const variables = (theme, onlyChanged) =>
    Object.entries(roles)
      .filter(([, v]) => !onlyChanged || v.dark !== v.light)
      .map(([role, v]) => `    --${role}: ${v[theme]};`)
      .join('\n')
  let css =
    `:root {\n  color-scheme: ${hasDark ? 'light dark' : 'light'};\n` +
    variables('light', false).replace(/^ {2}/gm, '') +
    '\n' +
    Object.entries(families)
      .map(([name, v]) => `  --font-${name}: ${v};`)
      .join('\n') +
    '\n}\n'
  if (hasDark)
    css += `@media (prefers-color-scheme: dark) {\n  :root {\n${variables('dark', true)}\n  }\n}\n`
  outputs.set('brand.css', faces.join('') + css)

  // The webmail rejects settings whose text fields are not strings
  const text = (field, value, fallback) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string') fail(`${field} must be text`)
    return value
  }
  const logo = own.logo
    ? (() => {
        const light = publish(own.logo.light, IMAGES)
        return {
          light,
          dark: own.logo.dark ? publish(own.logo.dark, IMAGES) : light,
          alt: text('logo.alt', own.logo.alt, ''),
        }
      })()
    : null
  const links = (own.icons ?? []).map((icon) => {
    if (icon.sizes && !/^(any|\d+x\d+( \d+x\d+)*)$/.test(icon.sizes))
      fail(`icon sizes ${icon.sizes}`)
    const href = publish(icon.file, ICONS)
    const sizes = icon.sizes ? ` sizes="${icon.sizes}"` : ''
    return `<link rel="icon" href="${href}" type="${TYPES[path.extname(icon.file).toLowerCase()]}"${sizes} />`
  })
  if (own.appleTouch)
    links.push(
      `<link rel="apple-touch-icon" href="${publish(own.appleTouch, ['.png'])}" />`
    )

  const name = text('name', own.name, defaults.name)
  return {
    brand: {
      name,
      label: text('label', own.label, name),
      tagline: text('tagline', own.tagline, defaults.tagline),
      logo,
    },
    links,
    outputs,
    warnings,
  }
}

// Checks the deployment settings the app reads at start-up
export function checkSettings({ backend, network = 'ic', origin }) {
  if (!backend || !PRINCIPAL.test(backend))
    fail(`--backend ${backend ?? ''}: give the backend canister's id`)
  if (network !== 'ic' && network !== 'local')
    fail(`--network ${network}: use ic or local`)
  if (network === 'ic' && !origin)
    fail("--origin is required on ic: it fixes every user's principal")
  if (origin !== undefined) {
    let url
    try {
      url = new URL(origin)
    } catch {
      fail(`--origin ${origin}: not a URL`)
    }
    const local =
      url.protocol === 'http:' && /(^|\.)localhost$/.test(url.hostname)
    if ((url.protocol !== 'https:' && !local) || url.origin !== origin) {
      fail(
        `--origin ${origin}: give an origin like https://example.com, with no path`
      )
    }
  }
  return { backend, network, derivationOrigin: origin ?? null }
}

// Checks the other hosts the webmail answers on. Internet Identity derives
// their principals from the origin only if the origin lists them, so they need
// an origin, the one checkSettings checked.
function checkCustomDomains(customDomains, origin, backend) {
  if (customDomains.length === 0) return
  // Internet Identity reads the list from the origin, so the origin must be this canister's own address
  const originHost = origin === undefined ? '' : new URL(origin).hostname
  const [id, ...rest] = originHost.split('.')
  if (
    !PRINCIPAL.test(id) ||
    id === backend ||
    !['icp0.io', 'ic0.app'].includes(rest.join('.'))
  ) {
    fail(
      "--custom-domain needs --origin https://<webmail id>.icp0.io (or .ic0.app), the webmail canister's own address and not the backend's: Internet Identity reads the list there"
    )
  }
  if (customDomains.length > MAX_CUSTOM_DOMAINS)
    fail(
      `at most ${MAX_CUSTOM_DOMAINS} --custom-domain, as Internet Identity allows`
    )
  for (const [i, host] of customDomains.entries()) {
    if (!isDomain(host))
      fail(
        `--custom-domain ${host}: give a lower-case host such as mail.example.com`
      )
    if (/(^|\.)(icp0\.io|ic0\.app|icp-api\.io)$/.test(host))
      fail(`--custom-domain ${host} is a canister address, not a custom domain`)
    if (customDomains.indexOf(host) !== i)
      fail(`--custom-domain ${host} is given twice`)
  }
}

// The files that let the webmail answer on its custom domains: the IC's
// custom-domain service registers only the hosts ic-domains lists, and Internet
// Identity accepts a page on another origin only if the derivation origin
// lists it in ii-alternative-origins
function customDomainFiles(customDomains) {
  if (customDomains.length === 0) return new Map()
  return new Map([
    [
      '.well-known/ic-domains',
      customDomains.map((host) => `${host}\n`).join(''),
    ],
    [
      '.well-known/ii-alternative-origins',
      `${JSON.stringify({ alternativeOrigins: customDomains.map((host) => `https://${host}`) })}\n`,
    ],
  ])
}

// The settings as a JSON block: the browser never runs it, and nothing in it
// can close the script element
function settingsBlock(settings) {
  const json = JSON.stringify(settings)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script type="application/json" id="settings">${json}</script>`
}

// The page's <head> for this deployment, in place of the generic title
export function applyToHtml(html, loaded, settings) {
  const placeholder = '<title>Mail</title>'
  if (!html.includes(placeholder))
    fail(`index.html has no ${placeholder} to replace`)
  const head = [
    `<title>${escapeHtml(loaded.brand.name)}</title>`,
    `<link rel="stylesheet" href="/brand.css" />`,
    ...loaded.links,
    settingsBlock({ ...settings, brand: loaded.brand }),
  ]
  // A function, so "$'" and similar in brand text are not replacement patterns
  return html.replace(placeholder, () => head.join('\n    '))
}

// Writes the deployment's webmail into out, which must be empty or an earlier output
export function writeWebmail({
  dist,
  out,
  brand,
  backend,
  network,
  origin,
  customDomains = [],
}) {
  const settings = checkSettings({ backend, network, origin })
  checkCustomDomains(customDomains, origin, backend)
  const domainFiles = customDomainFiles(customDomains)
  const loaded = loadBrand(brand)
  const index = path.join(dist, 'index.html')
  if (!existsSync(index))
    fail(`${index} not found: --dist must be the webmail build`)
  // Real paths, through the nearest existing parent of a folder not yet created
  const real = (p) => {
    let base = path.resolve(p)
    const rest = []
    while (!existsSync(base)) {
      rest.unshift(path.basename(base))
      base = path.dirname(base)
    }
    return path.join(realpathSync(base), ...rest)
  }
  const from = real(dist)
  const to = real(out)
  const within = (a, b) => a === b || a.startsWith(b + path.sep)
  if (within(to, from) || within(from, to))
    fail(`--out ${out} must not be --dist ${dist} or overlap it`)
  // Everything that can fail on the input runs before out is touched
  const html = applyToHtml(readFileSync(index, 'utf8'), loaded, settings)
  if (existsSync(out) && readdirSync(out).length > 0) {
    if (!existsSync(path.join(out, OUTPUT_MARKER)))
      fail(`${out} is not empty and was not written by this script`)
    rmSync(out, { recursive: true })
  }
  // The marker goes first, so a run that stops halfway can be repeated
  mkdirSync(out, { recursive: true })
  writeFileSync(
    path.join(out, OUTPUT_MARKER),
    'Written by brand.mjs; deleted and rewritten on the next run.\n'
  )
  cpSync(dist, out, { recursive: true })
  for (const [file, content] of loaded.outputs) {
    const target = path.join(out, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  writeFileSync(path.join(out, 'index.html'), html)
  // The SMTP gateway reads this to find the canister that receives the domain's mail
  mkdirSync(path.join(out, '.well-known'), { recursive: true })
  writeFileSync(
    path.join(out, '.well-known', 'ic-smtp-canister-id'),
    settings.backend
  )
  for (const [file, content] of domainFiles)
    writeFileSync(path.join(out, file), content)
  return loaded
}

function parseArgs(argv) {
  const known = new Set([
    'dist',
    'out',
    'brand',
    'backend',
    'network',
    'origin',
    'custom-domain',
  ])
  const args = { customDomains: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    if (!known.has(key) || argv[i + 1] === undefined)
      fail(`unknown or incomplete option ${argv[i]}`)
    // The one option that may be given more than once
    if (key === 'custom-domain') args.customDomains.push(argv[i + 1])
    else args[key] = argv[i + 1]
  }
  if (!args.dist || !args.out) fail('--dist and --out are required')
  return args
}

// Run directly, also through a symlink, rather than imported
const invoked =
  process.argv[1] && existsSync(process.argv[1])
    ? realpathSync(process.argv[1])
    : ''
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const loaded = writeWebmail(parseArgs(process.argv.slice(2)))
    for (const warning of loaded.warnings) console.warn(warning)
    console.log(`brand: wrote the webmail for "${loaded.brand.name}"`)
  } catch (e) {
    if (!(e instanceof BrandError)) throw e
    console.error(e.message)
    process.exit(1)
  }
}
