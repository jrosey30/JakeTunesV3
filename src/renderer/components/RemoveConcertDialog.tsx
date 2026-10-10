/**
 * The one way to remove a concert (spec-03, 2026-10-09). The concert page
 * and the album page both ask with this, in the same words: the album page
 * said "Undeclare Live Mode", the concert page a click-twice "Undeclare"
 * that forgot itself if the pointer left the button.
 *
 * Removing deletes only the merged full-show file (identity-gated on the
 * mergedTrackId by the callers); the songs it was made from stay.
 */
import ConfirmDialog from './ConfirmDialog'

export const REMOVE_CONCERT_LABEL = 'Remove Concert'

export default function RemoveConcertDialog({ name, onConfirm, onCancel }: {
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      message={`Remove the concert “${name}”?`}
      detail="The full-show file is deleted. The songs stay in your library, exactly as they were."
      confirmLabel={REMOVE_CONCERT_LABEL}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
