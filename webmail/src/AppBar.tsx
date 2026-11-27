// The bar along the top at phone width, in place of the header and the
// folders beside the mail: ☰ opens the drawer (Drawer.tsx), then the page's
// title over the open mailbox's address, then the page's own actions. A mode,
// such as selecting messages, puts its own button and title in their place.
// The bar is hidden at desktop width.

import { createContext, useContext, type ReactNode } from 'react'

import { IconButton } from './Buttons'

// As the phone layout's breakpoint in styles.css
const PHONE = '(max-width: 760px)'

export const atPhoneWidth = () => window.matchMedia(PHONE).matches

// What App gives every page's bar
export const PageBar = createContext({
  title: '',
  address: '',
  openDrawer: () => {},
})

export function AppBar({
  lead,
  title,
  children,
}: {
  lead?: ReactNode // in place of ☰
  title?: string // a mode's own, in place of the page's title and address
  children?: ReactNode
}) {
  const page = useContext(PageBar)
  return (
    <div className="appbar">
      {lead ?? (
        <IconButton label="Menu" icon="menu" onClick={page.openDrawer} />
      )}
      <div className="appbar-title">
        <strong>{title ?? page.title}</strong>
        {title === undefined && <span>{page.address}</span>}
      </div>
      {children}
    </div>
  )
}
