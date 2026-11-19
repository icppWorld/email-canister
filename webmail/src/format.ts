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
