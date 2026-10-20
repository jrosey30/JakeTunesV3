import type { ViewName } from '../types'

const BACK_LABELS: Partial<Record<ViewName, string>> = {
  home: '← Home',
  albums: '← Albums',
  artists: '← Artists',
  'artist-detail': '← Artist',
  songs: '← Songs',
  genres: '← Genres',
  'listen-to-the-list': '← Listen List',
  discovery: '← Record Shop',
  playlist: '← Playlist',
  'smart-playlist': '← Playlist',
  musicman: '← Music Man',
}

/** Label for where the history's back step ACTUALLY lands. The back button
 *  navigates by history (same as the titlebar ‹ and ⌘[), so its label must
 *  come from history too — Jake, 2026-10-20: "the back arrow says back to
 *  albums, but it takes me back to artists". Null when there's no history
 *  step (callers fall back to their stored return view, matching their
 *  fallback action). */
export function backLabelForLocation(to: { view: string; artist?: string | null } | null, toSearch = false): string | null {
  if (toSearch) return '← Search'
  if (!to) return null
  if (to.view === 'artist-detail' && to.artist) return `← ${to.artist}`
  if (to.view === 'album-detail') return '← Album'
  return BACK_LABELS[to.view as ViewName] ?? '← Back'
}

export function albumDetailBackLabel(returnView: ViewName | null): string {
  if (returnView && BACK_LABELS[returnView]) return BACK_LABELS[returnView]!
  return '← Albums'
}
