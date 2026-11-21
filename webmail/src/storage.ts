// Values kept in this browser only. Storage can be missing or refuse, as in
// a private window: a read then finds nothing, and a write is not kept.

export function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Not kept: the default applies next time
  }
}
