import type { ViewName } from '../types'

/** Every page's name as Back says it — the sidebar's name where the sidebar
 *  has one, the page's own title elsewhere. EVERY ViewName has an entry (the
 *  type says so; back-label.test.ts walks the union), so "← Back" is only ever
 *  shown for a view this map has never heard of. */
const BACK_LABELS: Record<ViewName, string> = {
  home: '← Home',
  songs: '← Songs',
  artists: '← Artists',
  'artist-detail': '← Artist',
  albums: '← Albums',
  'album-detail': '← Album',
  genres: '← Genres',
  musicman: '← The Music Man',
  playlist: '← Playlist',
  'smart-playlist': '← Playlist',
  device: '← iPod',
  'cd-import': '← CD Import',
  store: '← Bandcamp Store',
  download: '← Downloads',
  scotus: '← Beck v. Prupis',
  recordstore: '← Record Store',
  'listen-to-the-list': '← Listen List',
  'new-for-you': '← New For You',
  discovery: '← Record Shop',
  'mix-detail': '← Mix',
  concerts: '← Live Concerts',
  'concert-detail': '← Concert',
  'mixtape-detail': '← Mixtape',
  dj: '← DJ',
  'activity-pool': '← iPod Pool',
  'year-in-review': '← Year in Review',
  top1000: '← Top 1000 Quiz',
}

/** The names a history step only holds ids for, resolved by the caller
 *  (hooks/useBackLabel.ts does it once for every pill): the album's title for
 *  an album page, the playlist's name for a playlist or smart playlist. */
export interface BackNames {
  album?: string | null
  playlist?: string | null
}

/** Label for where the history's back step ACTUALLY lands. The back button
 *  navigates by history (same as the titlebar ‹ and ⌘[), so its label must
 *  come from history too — Jake, 2026-10-20: "the back arrow says back to
 *  albums, but it takes me back to artists". Names the page: "← Geese" for an
 *  artist page, "← Perfecth" for an album page and "← Road Trip" for a playlist
 *  when the caller resolved the name; "← Album" / "← Playlist" when it didn't.
 *  Null when there's no history step (callers fall back to their stored
 *  return view, matching their fallback action). */
export function backLabelForLocation(
  to: { view: string; artist?: string | null } | null,
  toSearch = false,
  names: BackNames = {},
): string | null {
  if (toSearch) return '← Search'
  if (!to) return null
  if (to.view === 'artist-detail' && to.artist) return `← ${to.artist}`
  if (to.view === 'album-detail' && names.album) return `← ${names.album}`
  if ((to.view === 'playlist' || to.view === 'smart-playlist') && names.playlist) return `← ${names.playlist}`
  return BACK_LABELS[to.view as ViewName] ?? '← Back'
}

export function albumDetailBackLabel(returnView: ViewName | null): string {
  if (returnView && BACK_LABELS[returnView]) return BACK_LABELS[returnView]
  return '← Albums'
}
