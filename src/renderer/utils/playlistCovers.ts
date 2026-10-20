// The covers for the playlists homemini makes itself (Jake, 2026-10-20: "make
// the cover for that something noticeable", "best of 2026 needs its own
// distinct logo too"). Shown in the sidebar and the playlist header.
//
// ⚠️ TWIN: JakeTunesMobile backend/assets/playlist-covers/jaketunes-<id>.jpg —
// the same art the phone shows; change both together.
import listenMoreWeeklyCover from '../assets/playlist-covers/listen-more-weekly.jpg'
import bestOf2026Cover from '../assets/playlist-covers/best-of-2026.jpg'
import { BEST_OF_YEAR } from './smartPlaylists'
import type { SmartPlaylistId } from '../types'

/** Best of <year> art exists per year — a year without one keeps the plain icon. */
const BEST_OF_COVERS: Readonly<Record<number, string>> = { 2026: bestOf2026Cover }

export function smartPlaylistCover(id: SmartPlaylistId): string | null {
  if (id === 'listen-more-weekly') return listenMoreWeeklyCover
  if (id === 'best-of-year') return BEST_OF_COVERS[BEST_OF_YEAR] ?? null
  return null
}
