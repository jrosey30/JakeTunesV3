/**
 * The filter of a page that has its own box (Albums, Artists), shared with
 * the toolbar search in "This page" mode (Brief 254) so the two boxes always
 * show the same words and filter the same way.
 *
 * Not lib.searchQuery: Back from an album or artist page is a SET_VIEW, which
 * clears that, while these pages stay mounted under the detail page and used
 * to keep their box. The page clears its entry when it unmounts (leaving for
 * anywhere but a detail page), as its local state did.
 */
import type { OwnFilterView } from './searchScope.ts'

const values: Record<OwnFilterView, string> = { albums: '', artists: '' }
const listeners = new Set<() => void>()

export function getPageFilter(view: OwnFilterView): string { return values[view] }

export function setPageFilter(view: OwnFilterView, q: string): void {
  if (values[view] === q) return
  values[view] = q
  for (const l of listeners) l()
}

export function subscribePageFilter(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
