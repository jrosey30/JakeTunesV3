/**
 * The toolbar search's two scopes (Brief 254, Jake 2026-11-20: "a switch thats
 * either all of jaketunes search or library/page search … i think they have
 * this in apple music").
 *
 *  - 'jaketunes': the dropdown over the whole library (SearchPanel), plus one
 *    last row that takes the words to the Record Shop's Search.
 *  - 'page': the box filters the page on screen, in place, no dropdown.
 *
 * Pure: no React, no window. SearchPill wires it; node tests pin it
 * (src/main/__tests__/search-scope.test.ts).
 */

export type SearchScope = 'jaketunes' | 'page'

/** ui-state.json key for the remembered choice (per Mac, like the other UI prefs). */
export const SEARCH_SCOPE_KEY = 'searchScope'

/** Pages that have a real page filter. Genres is not here: it has no filter
 *  of its own (GenresView.tsx is do-not-touch; see the brief). */
export const PAGE_SCOPE_VIEWS = ['songs', 'albums', 'artists', 'playlist', 'smart-playlist'] as const

/** Pages whose filter is their own box (utils/pageFilter.ts), not
 *  lib.searchQuery: they stay mounted under album/artist pages, so the filter
 *  survives a trip into a record and back, where SET_VIEW would clear it. */
export const OWN_FILTER_VIEWS = ['albums', 'artists'] as const
export type OwnFilterView = (typeof OWN_FILTER_VIEWS)[number]

export function hasPageScope(view: string): boolean {
  return (PAGE_SCOPE_VIEWS as readonly string[]).includes(view)
}

export function ownsFilterBox(view: string): view is OwnFilterView {
  return (OWN_FILTER_VIEWS as readonly string[]).includes(view)
}

/** What was saved, read defensively: anything but 'page' is JakeTunes. */
export function parseSearchScope(v: unknown): SearchScope {
  return v === 'page' ? 'page' : 'jaketunes'
}

/** The scope in force: the remembered choice where the page has one. */
export function resolveSearchScope(pref: SearchScope, view: string): SearchScope {
  return pref === 'page' && hasPageScope(view) ? 'page' : 'jaketunes'
}

export const PAGE_LABEL_MAX = 16

export function shorten(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

/** The page's name on the switch, or null where there is no page scope. */
export function pageScopeLabel(view: string, names: { playlistName?: string | null; smartName?: string | null } = {}): string | null {
  switch (view) {
    case 'songs': return 'Songs'
    case 'albums': return 'Albums'
    case 'artists': return 'Artists'
    case 'playlist': return names.playlistName?.trim() ? shorten(names.playlistName, PAGE_LABEL_MAX) : 'Playlist'
    case 'smart-playlist': return names.smartName?.trim() ? shorten(names.smartName, PAGE_LABEL_MAX) : 'Playlist'
    default: return null
  }
}

/** The box's placeholder. */
export function searchPlaceholder(scope: SearchScope, label: string | null): string {
  return scope === 'page' && label ? `Search ${label}` : 'Search'
}

/** Which page a page filter belongs to: a playlist is its own page. */
export function pageKey(view: string, playlistId?: string | null, smartId?: string | null): string {
  if (view === 'playlist') return `playlist:${playlistId ?? ''}`
  if (view === 'smart-playlist') return `smart-playlist:${smartId ?? ''}`
  return view
}

export const SHOP_QUERY_MAX = 40

/** The dropdown's last row, or null with no words. */
export function recordShopRowLabel(query: string): string | null {
  const q = query.trim()
  if (!q) return null
  return `Search the Record Shop for “${shorten(q, SHOP_QUERY_MAX)}”`
}

/** What the row sends the Record Shop's Search (the jaketunes-download-prefill
 *  detail DownloadView takes): the whole words, typed by Jake. */
export function recordShopPrefill(query: string): { query: string; target: 'browse'; how: 'typed' } | null {
  const q = query.trim()
  return q ? { query: q, target: 'browse', how: 'typed' } : null
}
