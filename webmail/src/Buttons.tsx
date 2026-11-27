// Buttons that look and read the same wherever they appear

import type { ButtonHTMLAttributes, Ref } from 'react'

import { Icon, type IconName } from './Icon'

// A button that is only its icon: the label is its tooltip, and with `name`,
// which says what it acts on where there are several, its name. A bare one
// keeps the icon's own size, as in a list row. In a form it submits only
// with type="submit": a plain button by default, so that an action such as
// Delete never also saves.
export function IconButton({
  label,
  name,
  icon,
  variant,
  className,
  type = 'button',
  ...props
}: {
  label: string
  name?: string
  icon: IconName
  variant?: 'primary' | 'danger' | 'bare'
  ref?: Ref<HTMLButtonElement>
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'title' | 'children' | 'name'
>) {
  const kind = variant === 'bare' ? ['bare'] : ['icon-button', variant]
  return (
    <button
      {...props}
      type={type}
      className={[...kind, className].filter(Boolean).join(' ')}
      aria-label={name ? `${label}: ${name}` : label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  )
}

// Back to the list; shown at phone width only, where a toolbar is short of room
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton className="back" label="Back" icon="back" onClick={onClick} />
  )
}

// What a message's star does: on, or off again
export const starLabel = (flagged: boolean) => (flagged ? 'Unstar' : 'Star')

// A message's star; name says which message, where there are several
export function StarButton({
  flagged,
  name,
  onClick,
}: {
  flagged: boolean
  name?: string
  onClick: () => void
}) {
  const label = starLabel(flagged)
  return (
    <button
      className={flagged ? 'bare star on' : 'bare star'}
      aria-label={name ? `${label} ${name}` : label}
      aria-pressed={flagged}
      title={label}
      onClick={onClick}
    >
      <Icon name="star" />
    </button>
  )
}
