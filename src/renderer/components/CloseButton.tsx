import { CloseIcon } from './TransportIcons'

/**
 * The one close button for sheets and Preferences (V7: close was drawn as ×
 * and ✕). Vector art, so it sits the same in every font: TransportIcons.
 */
export default function CloseButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" className="imp-close" onClick={onClick} disabled={disabled} title="Close" aria-label="Close">
      <CloseIcon size={10} />
    </button>
  )
}
