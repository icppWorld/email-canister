// "Message", "this message" or "3 messages": `one` says a single one, and
// `noun` more than one
export const messages = (count: number, one: string, noun = 'messages') =>
  count === 1 ? one : `${count} ${noun}`

export const was = (count: number) => (count === 1 ? 'was' : 'were')

// "was no longer here", of mail another member moved or deleted first
export const noLongerHere = (count: number) => `${was(count)} no longer here`

// A note of what was done to messages, in parts of a count and what happened
// to that many, leaving out a count of none. The first part names the
// messages, as `one` and `noun` say them; the others give only the number.
export function noteOf(
  parts: [count: number, what: string][],
  one: string,
  noun?: string
): string {
  return parts
    .filter(([count]) => count > 0)
    .map(
      ([count, what], i) =>
        `${i === 0 ? messages(count, one, noun) : count} ${what}`
    )
    .join('. ')
}

export function formatBytes(bytes: bigint): string {
  const n = Number(bytes)
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.ceil(n / 1024)} KB`
}

// A member of a mailbox as the others see them: "you", the name an admin gave
// them, or the start of their principal
export function memberName(
  principal: string,
  name: [] | [string],
  me?: string
): string {
  if (principal === me) return 'you'
  return name[0] ?? `${principal.slice(0, 11)}…`
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatTime(ms: number): string {
  return timeFormat.format(ms)
}

// A time the canister gives, in nanoseconds
export function formatNs(ns: bigint): string {
  return formatTime(Number(ns / 1_000_000n))
}

// Text a message brings, without the characters that could show it as
// something else: control characters, and the marks that reverse, embed or
// isolate a run of text, with which "invoice\u202Efdp.exe" reads as
// "invoiceexe.pdf". Tabs and line ends stay.
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g
export const shown = (text: string) => text.replace(HIDDEN, '')
