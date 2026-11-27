// The bar along the top at phone width, in place of the header and the
// folders beside the mail: ☰ opens the drawer (Drawer.tsx), then the page's
// title over the open mailbox's address, then the page's own actions. A mode,
// such as selecting messages, puts its own button and title in their place,
// or, as the search field does, takes the whole bar. Mounted at phone width
// only.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { IconButton } from './Buttons'

// The phone layout's breakpoint, as in styles.css: matches says, at the
// moment of an event, whether the page is at phone width
export const phoneWidth = window.matchMedia('(max-width: 760px)')

const watchWidth = (changed: () => void) => {
  phoneWidth.addEventListener('change', changed)
  return () => phoneWidth.removeEventListener('change', changed)
}

// Whether the page is at phone width, rendered again as that changes
export const usePhone = () =>
  useSyncExternalStore(watchWidth, () => phoneWidth.matches)

// What App gives every page's bar
export const PageBar = createContext({
  title: '',
  address: '',
  openDrawer: () => {},
})

export function AppBar({
  lead,
  title,
  bare = false,
  children,
}: {
  lead?: ReactNode // in place of ☰
  title?: string // a mode's own, in place of the page's title and address
  bare?: boolean // only the children, with no ☰ or title
  children?: ReactNode
}) {
  const page = useContext(PageBar)
  return (
    <div className="appbar">
      {!bare && (
        <>
          {lead ?? (
            <IconButton label="Menu" icon="menu" onClick={page.openDrawer} />
          )}
          <div className="appbar-title">
            <strong>{title ?? page.title}</strong>
            {title === undefined && <span>{page.address}</span>}
          </div>
        </>
      )}
      {children}
    </div>
  )
}
