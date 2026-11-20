// Buttons that look and read the same wherever they appear

import { Icon } from './Icon'

// Back to the list; shown at phone width only, where a toolbar is short of room
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="back" aria-label="Back" title="Back" onClick={onClick}>
      <Icon name="back" />
    </button>
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
      title={flagged ? 'Starred' : 'Not starred'}
      onClick={onClick}
    >
      <Icon name="star" />
    </button>
  )
}
