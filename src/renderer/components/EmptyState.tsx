/**
 * 4.5.0-86 — unified empty state for the flat list views (Songs,
 * Albums, Artists, Genres), since extended to Listen to the List.
 *
 * Pre-fix: when a search filter matched zero rows, every view rendered
 * an empty header + empty body — no signal whether the search was
 * intentional and just had no matches, vs the user "broke" the library.
 * Consistent across all views; differentiates the two cases by
 * checking whether a query is active.
 */
interface Props {
  /** The current search query (empty string if none active). */
  query?: string
  /** The lowercase noun for "no <noun> found" messages: "tracks", "albums", "artists", "genres", "recommendations". */
  noun: string
  /** Override the no-query sub-message (defaults to the library-import copy) — Listen to
   *  the List uses this for "Jot down a song to start your list." instead. */
  subMessage?: string
}

export default function EmptyState({ query, noun, subMessage }: Props) {
  const q = (query || '').trim()
  return (
    <div className="empty-state">
      <div className="empty-state-glyph" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="14" cy="14" r="9" stroke="currentColor" strokeWidth="1.6" />
          <line x1="21" y1="21" x2="27" y2="27" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="empty-state-title">
        {q ? <>No {noun} match "<strong>{q}</strong>"</> : <>No {noun} here yet</>}
      </div>
      <div className="empty-state-sub">
        {q ? 'Try a shorter or different search.' : (subMessage ?? 'Import some music to fill out this view.')}
      </div>
    </div>
  )
}
