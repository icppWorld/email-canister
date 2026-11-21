// Buttons that look and read the same wherever they appear

import type { ButtonHTMLAttributes } from 'react'

import { Icon, type IconName } from './Icon'

// A button that is only its icon: the label is its name, and its tooltip
export function IconButton({
  label,
  icon,
  variant,
  className,
  ...props
}: {
  label: string
  icon: IconName
  variant?: 'primary' | 'danger'
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'title' | 'children'
>) {
  return (
    <button
      {...props}
      className={['icon-button', variant, className].filter(Boolean).join(' ')}
      aria-label={label}
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
  const label = flagged ? 'Unstar' : 'Star'
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
