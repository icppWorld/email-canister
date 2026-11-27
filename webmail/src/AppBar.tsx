// Each page's bar along the top: ☰ for the navigation, which opens the
// drawer (Drawer.tsx), or folds a pinned one away and back, then the page's
// title over the open mailbox's address, then the page's own actions. A mode,
// such as selecting messages, puts its own button and title in their place,
// or, as the search field does at phone width, takes the whole bar. Every
// bar is drawn in App's place for it, above the page, so a list's spans the
// list and the reader beside it as any other page's does.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'

import { IconButton } from './Buttons'

// The phone layout's breakpoint, as in styles.css, made on first use
let query: MediaQueryList | undefined
const phoneWidth = () => (query ??= window.matchMedia('(max-width: 760px)'))

const watchWidth = (changed: () => void) => {
  const width = phoneWidth()
  width.addEventListener('change', changed)
  return () => width.removeEventListener('change', changed)
}

// Whether the page is at phone width, rendered again as that changes
export const usePhone = () =>
  useSyncExternalStore(watchWidth, () => phoneWidth().matches)

// What App gives every page's bar
export const PageBar = createContext<{
  title: string
  address: string
  menu: () => void // what ☰ does
  expanded?: boolean // a pinned navigation's: shown or folded away
  slot: HTMLElement | null // where the bar is drawn
}>({ title: '', address: '', menu: () => {}, slot: null })

export function AppBar({
  lead,
  title,
  bare = false,
  label,
  ref,
  children,
}: {
  lead?: ReactNode // in place of ☰
  title?: string // a mode's own, in place of the page's title and address
  bare?: boolean // only the children, with no ☰ or title
  label?: string // a mode's bar is a toolbar of that name
  ref?: Ref<HTMLDivElement>
  children?: ReactNode
}) {
  const page = useContext(PageBar)
  if (!page.slot) return null
  return createPortal(
    <div
      className="appbar"
      role={label ? 'toolbar' : undefined}
      aria-label={label}
      ref={ref}
    >
      {!bare && (
        <>
          {lead ?? (
            <IconButton
              label="Menu"
              icon="menu"
              aria-expanded={page.expanded}
              onClick={page.menu}
            />
          )}
          <div className="appbar-title">
            <strong>{title ?? page.title}</strong>
            {title === undefined && (
              <span data-testid="address">{page.address}</span>
            )}
          </div>
        </>
      )}
      {children}
    </div>,
    page.slot
  )
}
