/**
 * Tiny bridge to re-open the universal search dropdown with a given query.
 *
 * Used so that "back" out of a detail page that was opened FROM a search result
 * returns the user to their search results (search-as-destination). The
 * NavigationContext fires reopenSearch() when a back lands on a search waypoint;
 * SearchPill subscribes and restores its query + focus, which re-shows the
 * SearchPanel. Kept out of React state/context because the search query lives
 * in SearchPill-local state by design (it intentionally never touches
 * lib.searchQuery).
 */
type ReopenListener = (query: string) => void

const listeners = new Set<ReopenListener>()

export function reopenSearch(query: string): void {
  for (const l of listeners) l(query)
}

export function onReopenSearch(cb: ReopenListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
