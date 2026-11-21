// Turns a stored message into what the reader shows. The message is hostile
// input: its HTML only ever goes into the sandboxed frame built here.

import PostalMime from 'postal-mime'

export type ParsedAttachment = {
  filename: string
  mimeType: string
  content: Uint8Array
  contentId?: string
  inline: boolean
}

export type ParsedMail = {
  from: string
  fromAddress: string
  to: string
  cc: string
  subject: string
  date: string
  html?: string
  text: string
  attachments: ParsedAttachment[]
}

type Address = { name?: string; address?: string }

function formatAddress(a?: Address): string {
  if (!a) return ''
  if (a.name && a.address) return `${a.name} <${a.address}>`
  return a.address || a.name || ''
}

export async function parseMail(raw: Uint8Array): Promise<ParsedMail> {
  const mail = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer',
  })
  const from = mail.from as Address | undefined
  return {
    from: formatAddress(from),
    fromAddress: from?.address ?? '',
    to: ((mail.to ?? []) as Address[]).map(formatAddress).join(', '),
    cc: ((mail.cc ?? []) as Address[]).map(formatAddress).join(', '),
    subject: mail.subject ?? '',
    date: mail.date ?? '',
    html: mail.html,
    text: mail.text ?? '',
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      mimeType: a.mimeType,
      content: new Uint8Array(a.content as ArrayBuffer),
      contentId: a.contentId?.replace(/^<|>$/g, ''),
      inline: a.disposition === 'inline',
    })),
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// Images the message carries itself. SVG is left out: it is a document format.
function embedInlineImages(
  html: string,
  attachments: ParsedAttachment[]
): string {
  return html.replace(/cid:([^"'\s)>]+)/gi, (match, id: string) => {
    const image = attachments.find(
      (a) =>
        a.contentId === id && /^image\/(png|jpe?g|gif|webp)$/i.test(a.mimeType)
    )
    return image
      ? `data:${image.mimeType};base64,${toBase64(image.content)}`
      : match
  })
}

// The brand's values as the page resolved them: CSS variables do not reach into
// an srcdoc frame. brand.mjs refuses unsafe values when it writes brand.css.
export type PageStyle = {
  background: string
  ink: string
  link: string
  font: string
  scheme: string
}

// Plain mail is text, links and simple layout, as the composer and most mail
// clients write it, and only that takes the brand's page. Anything else may
// bring colours or images of its own, dark on transparent perhaps, so it keeps
// the white page it was designed for. Styles are read as the browser parsed
// them, so comments and escapes hide nothing. A parsed document is inert: it
// runs no scripts and loads nothing.
// Quote bars, a border-left as webmail services draw them, are allowed: their
// colour is decoration, not content. The border shorthand is not: it also sets
// border-image, which can carry an image, and it draws boxes. Thunderbird
// marks quotes with type, cite and wrap, a webmail service puts a
// <br clear="all"> before the signature of a reply, and data-* and xmlns
// attributes style nothing.
const PLAIN_ELEMENTS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'body',
  'div',
  'p',
  'br',
  'wbr',
  'span',
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])
const PLAIN_ATTRIBUTES = new Set([
  'dir',
  'lang',
  'class',
  'id',
  'title',
  'href',
  'name',
  'target',
  'rel',
  'align',
  'style',
  'charset',
  'content',
  'http-equiv',
  'type',
  'cite',
  'wrap',
  'clear',
])
const PLAIN_STYLE =
  /^(white-space(-collapse)?|text-wrap(-mode|-style)?|margin-.+|padding-.+|border-(top|right|bottom|left)-(width|style|color)|text-align|text-indent|font-.+|line-height|line-break|direction|unicode-bidi|overflow-wrap|word-wrap|word-break)$/

// Whether every attribute and every style property of the element is allowed
function allowedParts(
  element: Element,
  attribute: (name: string) => boolean,
  style: (property: string) => boolean
): boolean {
  return (
    Array.from(element.attributes).every(
      ({ name }) =>
        attribute(name) || name.startsWith('data-') || /^xmlns(:|$)/.test(name)
    ) && Array.from((element as HTMLElement).style ?? []).every(style)
  )
}

function plainElement(element: Element): boolean {
  return (
    PLAIN_ELEMENTS.has(element.localName) &&
    allowedParts(
      element,
      (name) => PLAIN_ATTRIBUTES.has(name),
      (property) => PLAIN_STYLE.test(property)
    )
  )
}

// Until Show images the frame allows only data: images, so any other image,
// such as a mail service's remote tracking pixel, shows nothing of the
// message's own. It is
// plain with the attributes and styles such pixels carry; anything that could
// paint, such as a background, keeps the white page. The border:0 such
// pixels carry also sets border-image, which is plain only while its source is
// none, or "initial" as some engines report it: a var() reads as "" and could
// hide an image. URL parsing drops tabs and newlines anywhere and spaces
// around, so "da&#9;ta:" is a data: URL too.
const IMAGE_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'alt',
  'width',
  'height',
  'border',
  'loading',
  'decoding',
])
const IMAGE_STYLE = /^(display|visibility|opacity|(min-|max-)?(width|height))$/

function unshownImage(element: Element): boolean {
  if (element.localName !== 'img') return false
  const url = (name: string) =>
    (element.getAttribute(name) ?? '').replace(/[\t\n\r]/g, '')
  if (
    // A browser skips control characters and spaces before a URL's scheme
    // eslint-disable-next-line no-control-regex
    /^[\x00-\x20]*data:/i.test(url('src')) ||
    /(^|[\s,])data:/i.test(url('srcset'))
  )
    return false
  const noBorderImage = /^(none|initial)$/.test(
    (element as HTMLElement).style?.getPropertyValue('border-image-source') ??
      ''
  )
  return allowedParts(
    element,
    (name) => PLAIN_ATTRIBUTES.has(name) || IMAGE_ATTRIBUTES.has(name),
    (property) =>
      PLAIN_STYLE.test(property) ||
      IMAGE_STYLE.test(property) ||
      (noBorderImage && property.startsWith('border-image-'))
  )
}

function wantsWhitePage(doc: Document): boolean {
  // Walked, so the first element that is not plain decides
  const walker = doc.createTreeWalker(
    doc.documentElement,
    NodeFilter.SHOW_ELEMENT
  )
  for (
    let node: Node | null = walker.currentNode;
    node;
    node = walker.nextNode()
  ) {
    const element = node as Element
    if (!plainElement(element) && !unshownImage(element)) return true
  }
  return false
}

// A white page paints nothing in the frame, so whatever background the message
// sets, on html, body or bgcolor, shows as it would anywhere. The frame
// element is white, and light like the frame, so the canvas lets it show.
// Zero specificity, so any rule in the message wins. The fonts are not loaded
// in the frame, so the stack ends in a generic family.
function pageStyleSheet(paper: boolean, page: PageStyle): string {
  if (paper) return ':root{color-scheme:light}'
  return (
    `:root{color-scheme:${page.scheme}}` +
    `:where(body){background:${page.background};color:${page.ink};` +
    `font:${page.font},system-ui,sans-serif}:where(a[href]){color:${page.link}}`
  )
}

// Images the message would load from the network, which the frame blocks until
// Show images: loading them tells the sender when the message was read, and
// from where. An <img> or <picture> source, a background attribute, or a CSS
// url() in a style attribute or a <style> element. A URL without a scheme
// takes the page's. Styles in an attribute are read as the browser parsed
// them, a <style> element as written: an escape there can hide a URL, which
// only leaves the button out, as the frame's policy is what blocks it.
// eslint-disable-next-line no-control-regex
const REMOTE_URL = /^[\x00-\x20]*(https?:)?\/\//i
// eslint-disable-next-line no-control-regex
const REMOTE_SRCSET = /(^|,)[\x00-\x20]*(https?:)?\/\//i
const REMOTE_CSS = /url\(\s*['"]?\s*(https?:)?\/\//i

function hasRemoteImages(doc: Document): boolean {
  const url = (element: Element, name: string) =>
    (element.getAttribute(name) ?? '').replace(/[\t\n\r]/g, '')
  return Array.from(doc.querySelectorAll('*')).some(
    (element) =>
      (element.localName === 'img' && REMOTE_URL.test(url(element, 'src'))) ||
      REMOTE_SRCSET.test(url(element, 'srcset')) ||
      REMOTE_URL.test(url(element, 'background')) ||
      REMOTE_CSS.test((element as HTMLElement).style?.cssText ?? '') ||
      (element.localName === 'style' &&
        REMOTE_CSS.test(element.textContent ?? ''))
  )
}

export type FramedBody = { body: string; paper: boolean; remote: boolean }

// The message as the frame shows it, whether it wants a white page, and
// whether it has remote images, decided on what the frame shows: an inline
// image is a data: URL by then. None depends on the theme, so a theme change
// need not parse or encode it again.
export function frameBody(
  html: string,
  attachments: ParsedAttachment[]
): FramedBody {
  const body = embedInlineImages(html, attachments)
  const doc = new DOMParser().parseFromString(body, 'text/html')
  return { body, paper: wantsWhitePage(doc), remote: hasRemoteImages(doc) }
}

// The document for <iframe sandbox="">. The policy comes first, so it applies
// to everything the message contains, and allows nothing from the network but
// https: images, and those only with `images`, after Show images. An image
// loaded then sends no Referer. The page style comes before the message, so
// the message's own styles win.
export function sandboxDocument(
  body: string,
  paper: boolean,
  page: PageStyle,
  images = false
): string {
  const policy = `default-src 'none'; img-src data:${images ? ' https:' : ''}; style-src 'unsafe-inline'`
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<style>${pageStyleSheet(paper, page)}</style>` +
    `</head><body>${body}</body></html>`
  )
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// The provider only sends HTML, so plain text from the composer is wrapped
export function textToHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`
}

// Compared as written, so a Unicode From domain never matches its punycode
// envelope: the "via" it gets is the one hint that a lookalike, such as a
// Cyrillic "а" in a familiar name, is not the domain it seems.
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

// What delivered the mail, shown after "via" when it is not the From domain.
// The gateway passes no SPF, DKIM or DMARC result, and mail services commonly
// send from their own bounce domain, so this is shown as "via", not as a forgery.
export function deliveredVia(
  fromAddress: string,
  envelopeFrom: string
): string | null {
  const from = domainOf(fromAddress)
  const envelope = domainOf(envelopeFrom)
  // An empty envelope sender, as delivery reports have, names no domain to vouch for the From
  if (!envelope) return 'an unnamed domain'
  // Only the same domain, and even that proves nothing: the gateway refuses only
  // a failed SPF check or DKIM signature, which a domain with no SPF record, or
  // a subdomain of it, never gets. "via" names a difference; it verifies no
  // sender. A From with no address, such as a group, matches nothing.
  return from === envelope ? null : envelope
}

// A large file can come in parts, which the browser joins without a copy here
export function saveFile(filename: string, content: Uint8Array | Blob[]): void {
  const parts = Array.isArray(content) ? content : [content]
  // Never rendered: the type makes the browser save it, whatever it contains
  const blob = new Blob(parts as BlobPart[], {
    type: 'application/octet-stream',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
