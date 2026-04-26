/**
 * Inline 5-star rating control used in every track list (Songs,
 * Playlists, Smart Playlists, Album detail, Artist detail). Clicking a
 * star sets the rating; clicking the currently-lit star clears it.
 *
 * Ratings are stored as 0..5 in the library (iTunes' 0..100 scale is
 * normalized on read/write).
 */

interface Props {
  value: number                    // 0..5
  onChange: (rating: number) => void
}

export default function StarRating({ value, onChange }: Props) {
  return (
    <span className="star-rating" onMouseLeave={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map(star => (
        <span
          key={star}
          className={`star-rating-star ${star <= value ? 'star-rating-star--filled' : ''}`}
          onClick={(e) => {
            // stopPropagation so clicking a star doesn't also select
            // the row, start playback, etc.
            e.stopPropagation()
            onChange(star === value ? 0 : star)
          }}
        >
          <svg
            width="10" height="10" viewBox="0 0 10 10"
            fill={star <= value ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round"
          >
            <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
          </svg>
        </span>
      ))}
    </span>
  )
}

/**
 * Build a sequence of "Rate as N stars" entries for any right-click
 * ContextMenu. Lets the user set 0..5 stars on one or many selected
 * tracks from anywhere in the app. Pass the currently-selected tracks
 * plus the same dispatch used elsewhere to update library state and
 * persist overrides. Returns a flat list so it can be spread directly
 * into an items array, with a leading separator.
 */
import type { MenuEntry } from './ContextMenu'

export function ratingMenuEntries(
  tracks: { id: number; rating?: number }[],
  dispatch: (action: { type: 'UPDATE_TRACKS'; updates: { id: number; field: string; value: string }[] }) => void,
): MenuEntry[] {
  // Show a checkmark on the rating shared by every selected track; if
  // ratings disagree, no mark — clicking still applies the new rating
  // uniformly, which is what you'd want when bulk-rating.
  const ratings = new Set(tracks.map(t => Number(t.rating) || 0))
  const common = ratings.size === 1 ? [...ratings][0] : -1

  const apply = (r: number) => {
    const updates = tracks.map(t => ({ id: t.id, field: 'rating', value: String(r) }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    // Fire-and-forget persistence so ratings survive app restart.
    for (const u of updates) window.electronAPI.saveMetadataOverride(u.id, 'rating', u.value)
  }

  return [
    { separator: true as const },
    { label: 'Rating: None',     checked: common === 0, onClick: () => apply(0) },
    { label: 'Rating: ★',        checked: common === 1, onClick: () => apply(1) },
    { label: 'Rating: ★★',       checked: common === 2, onClick: () => apply(2) },
    { label: 'Rating: ★★★',      checked: common === 3, onClick: () => apply(3) },
    { label: 'Rating: ★★★★',     checked: common === 4, onClick: () => apply(4) },
    { label: 'Rating: ★★★★★',    checked: common === 5, onClick: () => apply(5) },
  ]
}
