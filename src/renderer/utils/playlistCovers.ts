// The covers for the playlists JakeTunes makes itself (Jake, 2026-10-20: "make
// the cover for that something noticeable", "best of 2026 needs its own
// distinct logo too"; 2026-11-02: "all the default playlists need their own
// unique cover similar to listen more, best of 2026 and more"). Shown in the
// sidebar and the playlist header.
//
// The three 2026-10-20 covers were made by hand; the rest are drawn by
// JakeTunesMobile tools/make-playlist-covers.py (one script, both id schemes,
// deterministic) — rerun it there and copy the desktop set here.
// ⚠️ TWIN: JakeTunesMobile backend/assets/playlist-covers/<id>.jpg —
// the same art the phone shows; change both together.
// Top 1000 (top-1000.jpg) is the Original's silver iPod mini since 2026-11-09,
// and every iPod list wears its own iPod: utils/ipodCovers.ts (the iPODS rows
// and the playlist header ask useIpodPlaylistCover first).
import listenMoreWeeklyCover from '../assets/playlist-covers/listen-more-weekly.jpg'
import bestOf2026Cover from '../assets/playlist-covers/best-of-2026.jpg'
import onRepeatCover from '../assets/playlist-covers/on-repeat.jpg'
import recentlyAddedCover from '../assets/playlist-covers/recently-added.jpg'
import recentlyPlayedCover from '../assets/playlist-covers/recently-played.jpg'
import top25Cover from '../assets/playlist-covers/top-25.jpg'
import top1000Cover from '../assets/playlist-covers/top-1000.jpg'
import starredCover from '../assets/playlist-covers/top-rated.jpg'
import tiktokCover from '../assets/playlist-covers/tiktok.jpg'
import bandcampCover from '../assets/playlist-covers/bandcamp.jpg'
import savantCover from '../assets/playlist-covers/savant.jpg'
import { BEST_OF_YEAR } from './smartPlaylists'
import { parseMonthPlaylistId } from '../../common/release-months'
import { parseIpodListPlaylistId } from '../../common/ipod-list-doc'
import type { SmartPlaylistId } from '../types'

/** Best of <year> art exists per year — a year without one keeps the plain icon. */
const BEST_OF_COVERS: Readonly<Record<number, string>> = { 2026: bestOf2026Cover }

const FIXED_COVERS: Readonly<Partial<Record<SmartPlaylistId, string>>> = {
  'listen-more-weekly': listenMoreWeeklyCover,
  'on-repeat': onRepeatCover,
  'recently-added': recentlyAddedCover,
  'recently-played': recentlyPlayedCover,
  'top-25': top25Cover,
  'top-1000': top1000Cover,
  'top-rated': starredCover,
  'tiktok': tiktokCover,
  'bandcamp': bandcampCover,
  'savant': savantCover,
}

/** One cover per month of this year's releases ('month-2026-09' →
 *  month-2026-09.jpg). Drawn for 2026 and 2027; a month without a file keeps
 *  the plain icon. Vite resolves the glob at build time. */
const MONTH_COVERS = import.meta.glob('../assets/playlist-covers/month-*.jpg', { eager: true, import: 'default' }) as Record<string, string>

export function smartPlaylistCover(id: SmartPlaylistId): string | null {
  // An iPod list wears its own iPod (2026-11-09): utils/ipodCovers.ts useIpodPlaylistCover.
  if (parseIpodListPlaylistId(id)) return null
  if (id === 'best-of-year') return BEST_OF_COVERS[BEST_OF_YEAR] ?? null
  const fixed = FIXED_COVERS[id]
  if (fixed) return fixed
  const ym = parseMonthPlaylistId(id)
  if (ym) return MONTH_COVERS[`../assets/playlist-covers/month-${ym}.jpg`] ?? null
  return null
}
