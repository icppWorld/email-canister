// Turns a stored message into what the reader shows. The message is hostile
// input: its HTML only ever goes into the sandboxed frame built here.

import DOMPurify from 'dompurify'
import PostalMime from 'postal-mime'
import { shown } from './format'

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
  const addresses = (list?: unknown) =>
    shown(((list ?? []) as Address[]).map(formatAddress).join(', '))
  return {
    from: shown(formatAddress(from)),
    fromAddress: from?.address ?? '',
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: shown(mail.subject ?? ''),
    date: mail.date ?? '',
    html: mail.html,
    text: mail.text ?? '',
    attachments: mail.attachments.map((a) => ({
      filename: shown(a.filename ?? '') || 'attachment',
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
// message's own. It is plain with the attributes and styles such pixels
// carry; anything that could
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

// An attribute as a URL: URL parsing drops tabs and newlines anywhere
const attributeUrl = (element: Element, name: string) =>
  (element.getAttribute(name) ?? '').replace(/[\t\n\r]/g, '')

function unshownImage(element: Element): boolean {
  if (element.localName !== 'img') return false
  if (
    // A browser skips control characters and spaces before a URL's scheme
    // eslint-disable-next-line no-control-regex
    /^[\x00-\x20]*data:/i.test(attributeUrl(element, 'src')) ||
    /(^|[\s,])data:/i.test(attributeUrl(element, 'srcset'))
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
// from where. An <img>, <picture> or <input type=image> source, a video's
// poster, a background attribute, or a CSS url() or image-set() in a style
// attribute or a <style> element. A URL without a scheme
// takes the page's. Styles in an attribute are read as the browser parsed
// them, a <style> element as written: an escape there can hide a URL, which
// only leaves the button out, as the frame's policy is what blocks it.
// eslint-disable-next-line no-control-regex
const REMOTE_URL = /^[\x00-\x20]*(https?:)?\/\//i
// eslint-disable-next-line no-control-regex
const REMOTE_SRCSET = /(^|,)[\x00-\x20]*(https?:)?\/\//i
// The second run of spaces only after a quote: two runs side by side would
// take time with the square of a long run's length, on a message's own text
const REMOTE_CSS = /(url|image-set)\(\s*(['"]\s*)?(https?:)?\/\//i
const SOURCES: [selector: string, attribute: string][] = [
  ['img', 'src'],
  ['input[type=image i]', 'src'],
  ['video', 'poster'],
]

function hasRemoteImages(doc: Document): boolean {
  const remote = (element: Element, name: string) =>
    REMOTE_URL.test(attributeUrl(element, name))
  return Array.from(doc.querySelectorAll('*')).some(
    (element) =>
      SOURCES.some(
        ([selector, name]) => element.matches(selector) && remote(element, name)
      ) ||
      REMOTE_SRCSET.test(attributeUrl(element, 'srcset')) ||
      remote(element, 'background') ||
      REMOTE_CSS.test((element as HTMLElement).style?.cssText ?? '') ||
      (element.localName === 'style' &&
        REMOTE_CSS.test(element.textContent ?? ''))
  )
}

export type FramedBody = { body: string; paper: boolean; remote: boolean }

// Elements the frame leaves out. Its policy does not cover a link that
// connects ahead, such as preconnect, which would tell the sender the message
// was read; a meta could loosen the frame's referrer policy; a template can
// become a shadow root, and a frame holds a document of its own, which a check
// here does not see into; a base would make a relative address a remote one;
// one engine loads a model outside the policy. A <frame> needs no entry: a
// body cannot hold one.
const LEFT_OUT = 'link, meta, template, iframe, base, model'
// Drawings and formulas, SVG and MathML, are shown as their text alone: they
// bring links of their own kinds, which an animation can give another address
// after a check, and mail services do not draw them either.
const AS_TEXT = 'svg, math'
// An element's own referrer policy, which would win over the frame's
const LEFT_OUT_ATTRIBUTE = 'referrerpolicy'

// A link opens in a new tab, on the reader's click, which is all the frame's
// sandbox lets a message open. Only an address written out in full, over http
// or https, that the browser can read: any other, a script or one relative to
// the webmail's own address among them, loses its href. The new page gets no
// referrer and no handle on the webmail, and the link cannot report the click
// with `ping`.
// eslint-disable-next-line no-control-regex
const LINK_URL = /^[\x00-\x20]*https?:\/\//i
const LINK_REL = 'noopener noreferrer'
const LINK_EXTRAS = ['xlink:href', 'ping']

function readable(url: string): boolean {
  try {
    return Boolean(new URL(url))
  } catch {
    return false
  }
}

function opens(link: Element): boolean {
  const url = attributeUrl(link, 'href')
  return link instanceof HTMLElement && LINK_URL.test(url) && readable(url)
}

// Whether the link is as the frame may hold it
const safeLink = (link: Element) =>
  !LINK_EXTRAS.some((name) => link.hasAttribute(name)) &&
  (!link.hasAttribute('href') ||
    (opens(link) &&
      link.getAttribute('target') === '_blank' &&
      link.getAttribute('rel') === LINK_REL))

function makeSafe(link: Element): void {
  LINK_EXTRAS.forEach((name) => link.removeAttribute(name))
  if (!opens(link)) return link.removeAttribute('href')
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', LINK_REL)
}

// What a drawing or a formula says, without its style sheets and its
// descriptions for tools
function textOf(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy
    .querySelectorAll('style, script, title, desc')
    .forEach((hidden) => hidden.remove())
  return copy.textContent ?? ''
}

// The message as the frame parses it: inside the body of the frame's document
function parsedInFrame(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${body}</body></html>`,
    'text/html'
  )
}

// Only what a maintained list of HTML's elements and attributes allows goes
// on to the frame (DOMPurify), so an element no rule here knows of, a new one
// in some browser among them, is left out too. Text in an element the list
// drops stays, but for a few the list drops whole: a title, a noscript, a
// form whose fields are named to stand in for the form's own.
// - The whole document, as mail sets colours on its body and styles in its head.
// - Added: presentation that older mail sets with attributes of its own.
// - An address: http or https, an inline image by its cid, the data: address
//   such an image has become by now, or one relative to the frame's own. The
//   list itself also takes any data: address as an image's src: an image runs
//   no script and loads nothing, whatever its kind.
// - An id or a name that would stand in for something of a document's or a
//   form's own is dropped (SANITIZE_DOM, on unless turned off), so the checks
//   below read what they ask for. A style sheet's rule for such an id finds
//   nothing.
// - SAFE_FOR_XML guards markup that is read again as XML, or inside a drawing
//   or a formula, and would drop a style sheet for a "<" in it, as in the
//   wrapping older mail gives one. It can be off as long as these hold: the
//   frame reads its document as HTML; a drawing or a formula is text by then;
//   a style sheet is the only element kept whose text is not escaped when
//   written out; the list drops every comment; no template is kept.
const ALLOW_LIST = {
  USE_PROFILES: { html: true },
  WHOLE_DOCUMENT: true,
  SAFE_FOR_XML: false,
  FORBID_TAGS: ['template'],
  ADD_ATTR: [
    'text',
    'link',
    'vlink',
    'alink',
    'leftmargin',
    'topmargin',
    'rightmargin',
    'bottommargin',
    'marginwidth',
    'marginheight',
    'hspace',
    'vspace',
    'bordercolor',
    'frame',
    'rules',
  ],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|cid):|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

// Asked of the element's kind and not of the element: a form's field named
// "matches" would stand in for the form's own, and the list has not been over
// the names yet when its hooks run
const is = (element: Element, selector: string): boolean =>
  Element.prototype.matches.call(element, selector)

// The webmail's own rules run inside the list, as its hooks, so that nothing
// changes a message once the list has passed it: a drawing or a formula
// becomes its text before the list would drop it whole, and a link is made
// safe once the list has been over its attributes
const list = DOMPurify(window)
list.addHook('uponSanitizeElement', (node) => {
  if (node instanceof Element && is(node, AS_TEXT))
    node.replaceWith(textOf(node))
})
list.addHook('afterSanitizeAttributes', (node) => {
  if (is(node, 'a, area') && !safeLink(node)) makeSafe(node)
})

// What the frame may not hold, in the parse it makes of a message: an element
// or attribute it leaves out, a drawing or a formula, a link that is not safe
function refused(doc: Document): Element[] {
  const found = doc.querySelectorAll(
    `${LEFT_OUT}, ${AS_TEXT}, [${LEFT_OUT_ATTRIBUTE}]`
  )
  const links = doc.querySelectorAll('a, area')
  return [...found, ...Array.from(links).filter((link) => !safeLink(link))]
}

// The message as the frame may hold it: what came out of the list, as the
// list wrote it, checked on the parse the frame makes of that. Markup written
// out and parsed again can grow elements the first parse did not have: a
// message that does, or one in a browser the list cannot work in, is shown as
// its text. White space before the document would end up in its body.
function listed(html: string): { body: string; doc: Document } {
  const body = list.sanitize(html.trimStart(), ALLOW_LIST)
  const doc = parsedInFrame(body)
  if (list.isSupported && refused(doc).length === 0) return { body, doc }
  const text = `<div style="white-space:pre-wrap">${escapeHtml(doc.body.textContent ?? '')}</div>`
  return { body: text, doc: parsedInFrame(text) }
}

// The message as the frame shows it, whether it wants a white page, and
// whether it has remote images, decided on what the frame shows: an inline
// image is a data: URL by then. None depends on the theme, so a theme change
// need not parse or encode it again.
export function frameBody(
  html: string,
  attachments: ParsedAttachment[]
): FramedBody {
  const { body, doc } = listed(embedInlineImages(html, attachments))
  return { body, paper: wantsWhitePage(doc), remote: hasRemoteImages(doc) }
}

// What the frame's sandbox allows a message: to open a link in a new tab,
// which is then a page like any other. No script, no form, and no move of the
// webmail's own tab.
export const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox'

// The document for the sandboxed frame. The policy comes first, so it applies
// to everything the message contains, and allows nothing from the network but
// https: images, and those only with `images`, after Show images. An image
// loaded then sends no Referer. Looking up the hosts of the message's links
// ahead of a click is switched off, which no policy covers and one engine
// does in a frame like this one. The page style comes before the message, so
// the message's own styles win. A zoom below 1 shrinks a message wider than
// the frame to fit it: in the style sheet, as an attribute of the root would
// stand in for the message's own, and marked important to win over them.
export function sandboxDocument(
  body: string,
  paper: boolean,
  page: PageStyle,
  images = false,
  zoom = 1
): string {
  const policy = `default-src 'none'; img-src data:${images ? ' https:' : ''}; style-src 'unsafe-inline'`
  const fit = zoom < 1 ? `:root{zoom:${zoom}!important}` : ''
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    `<style>${pageStyleSheet(paper, page)}${fit}</style>` +
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
