import type { ViewName } from '../types'

const BACK_LABELS: Partial<Record<ViewName, string>> = {
  home: '← Home',
  albums: '← Albums',
  artists: '← Artists',
  'artist-detail': '← Artist',
  songs: '← Songs',
  genres: '← Genres',
  'listen-to-the-list': '← Listen to the List',
  discovery: '← Discovery',
  playlist: '← Playlist',
  'smart-playlist': '← Playlist',
  musicman: '← Music Man',
}

export function albumDetailBackLabel(returnView: ViewName | null): string {
  if (returnView && BACK_LABELS[returnView]) return BACK_LABELS[returnView]!
  return '← Albums'
}
