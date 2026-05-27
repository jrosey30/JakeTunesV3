/**
 * 4.5.2: binary star toggle. Jake: "if I rate a song 3 stars, why
 * would it be in my library?" The 5-star scale was iTunes 8 baggage;
 * for a personal library starred / not-starred is the only meaningful
 * signal. Stored value stays on the 0..5 scale so legacy ratings
 * survive (any value > 0 reads as filled), but clicks toggle binary —
 * 0 -> 5 (lit) and back to 0.
 */

interface Props {
  value: number                    // 0..5 (legacy); any > 0 reads as starred
  onChange: (rating: number) => void
}

export default function StarRating({ value, onChange }: Props) {
  const filled = value > 0
  return (
    <span className="star-rating" onMouseLeave={(e) => e.stopPropagation()}>
      <span
        className={`star-rating-star ${filled ? 'star-rating-star--filled' : ''}`}
        onClick={(e) => {
          // stopPropagation so clicking the star doesn't also select
          // the row, start playback, etc.
          e.stopPropagation()
          onChange(filled ? 0 : 5)
        }}
        title={filled ? 'Unstar' : 'Star'}
      >
        <svg
          width="11" height="11" viewBox="0 0 10 10"
          fill={filled ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round"
        >
          <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
        </svg>
      </span>
    </span>
  )
}

/**
 * Right-click "Star" / "Unstar" entries (replaces the prior 5-rating
 * fan-out). Bulk-rates a selection. Reads any value > 0 as starred so
 * the menu's checkmark stays correct for legacy 1..4 ratings.
 */
import type { MenuEntry } from './ContextMenu'

export function ratingMenuEntries(
  tracks: { id: number; rating?: number }[],
  dispatch: (action: { type: 'UPDATE_TRACKS'; updates: { id: number; field: string; value: string }[] }) => void,
): MenuEntry[] {
  const someStarred = tracks.some(t => (Number(t.rating) || 0) > 0)
  const allStarred  = tracks.every(t => (Number(t.rating) || 0) > 0)
  // If a mixed selection, default to "Star" (apply 5 to everyone so
  // the state becomes consistent). Avoids the trap where toggling on
  // a mixed set leaves you with half starred.
  const target = allStarred ? 0 : 5

  const apply = () => {
    const updates = tracks.map(t => ({ id: t.id, field: 'rating', value: String(target) }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    for (const u of updates) window.electronAPI.saveMetadataOverride(u.id, 'rating', u.value)
    // 4.5: stamp starredAt on bulk star-ON. Recent-first sort of the
    // Starred smart playlist uses this; legacy stars without the field
    // sort to the bottom. All tracks in the bulk get the same stamp,
    // which is fine — they were starred together.
    if (target > 0) {
      const stamp = String(Date.now())
      const stampUpdates = tracks.map(t => ({ id: t.id, field: 'starredAt', value: stamp }))
      dispatch({ type: 'UPDATE_TRACKS', updates: stampUpdates })
      for (const u of stampUpdates) window.electronAPI.saveMetadataOverride(u.id, 'starredAt', u.value)
    }
  }

  return [
    { separator: true as const },
    {
      label: allStarred ? 'Unstar' : 'Star',
      checked: someStarred && allStarred,
      onClick: apply,
    },
  ]
}
