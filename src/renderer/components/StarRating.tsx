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
import { isStarred, planStarToggle } from '../../common/star-toggle'

type StarDispatch = (action: { type: 'UPDATE_TRACKS'; updates: { id: number; field: string; value: string }[] }) => void

/**
 * Perform a binary star toggle on `tracks` and persist it — the one writer
 * behind the menu's Star/Unstar and ⇧⌘S (star the playing song), so
 * starredAt is stamped identically from both. A mixed selection stars
 * everyone (see planStarToggle). Returns the target: 5 starred, 0 unstarred.
 */
export function applyStarToggle(tracks: { id: number; rating?: number }[], dispatch: StarDispatch): 0 | 5 {
  const plan = planStarToggle(tracks, Date.now())
  dispatch({ type: 'UPDATE_TRACKS', updates: plan.ratingUpdates })
  for (const u of plan.ratingUpdates) window.electronAPI.saveMetadataOverride(u.id, 'rating', u.value)
  // 4.5: stamp starredAt on bulk star-ON. Recent-first sort of the
  // Starred smart playlist uses this; legacy stars without the field
  // sort to the bottom.
  if (plan.stampUpdates.length > 0) {
    dispatch({ type: 'UPDATE_TRACKS', updates: plan.stampUpdates })
    for (const u of plan.stampUpdates) window.electronAPI.saveMetadataOverride(u.id, 'starredAt', u.value)
  }
  return plan.target
}

export function ratingMenuEntries(
  tracks: { id: number; rating?: number }[],
  dispatch: StarDispatch,
): MenuEntry[] {
  const someStarred = tracks.some(isStarred)
  const allStarred  = tracks.every(isStarred)

  return [
    { separator: true as const },
    {
      label: allStarred ? 'Unstar' : 'Star',
      checked: someStarred && allStarred,
      onClick: () => { applyStarToggle(tracks, dispatch) },
    },
  ]
}
