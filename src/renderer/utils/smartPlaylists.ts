/**
 * 4.4.46 — THE single source of truth for the four built-in smart
 * playlists (Recently Added, Recently Played, Top 25 Most Played, My
 * Top Rated).
 *
 * Why this file exists:
 * Before 4.4.46 there were TWO divergent evaluators —
 *   - `SmartPlaylistView.tsx`'s `smartTracks` useMemo (what the app
 *     DISPLAYS), and
 *   - `DeviceView.tsx`'s `refreshSmartPlaylists` (what gets SYNCED to
 *     the iPod).
 * They disagreed: Recently Added was 50 in the view but 100 for sync;
 * My Top Rated was 50 vs 25; and Recently Played was skipped entirely
 * for sync ("we don't have reliable cross-session data"). On top of
 * that, the iPod AUTO-sync path in `App.tsx` never called the sync
 * evaluator at all — it shipped only the user's regular playlists, so
 * the built-in smart playlists never reached the device on a
 * plug-in-and-go sync.
 *
 * Per CLAUDE.md's twin-discovery rule: the fix is ONE definition, two
 * consumers. `evaluateSmartPlaylist` is the definition. `SmartPlaylistView`
 * calls it for display; `buildSmartPlaylistsForSync` calls it to build
 * the Playlist[] handed to `syncToIpod`. Change a rule here and both
 * the app and the iPod move together — they can't drift again.
 *
 * Recently Played note: the old display path used the in-memory
 * `PlaybackState.recentlyPlayed` (a session-only list that resets on
 * app restart — which is exactly why it could never sync meaningfully).
 * This file uses the PERSISTENT `Track.lastPlayedAt` instead — epoch ms
 * written on every natural completion (`useAudio` `runNaturalEndRef`).
 * It survives restarts and syncs to the iPod cleanly. Semantically it's
 * "recently played to completion," which is a sound definition.
 *
 * AI Picks (musicman / megan / dj-hands) are intentionally NOT handled
 * here — they require an async fetch from main and stay inline in
 * `SmartPlaylistView`. They are not part of the iPod-sync set.
 */

import type { Track, Playlist, SmartPlaylistId } from '../types'
import { buildTasteProfile, tasteScore } from './tasteScore'
import { pickBestOfYear } from '../../common/best-of-year'

/** The four built-in, sync-eligible smart playlists and their iPod /
 *  sidebar display names. Keep these names in lockstep with
 *  `SMART_PLAYLIST_NAMES` in `Sidebar.tsx`. */
export const BEST_OF_YEAR = new Date().getFullYear()
export const BEST_OF_YEAR_NAME = `Best of ${BEST_OF_YEAR}`

export const BUILTIN_SMART_PLAYLISTS: ReadonlyArray<{ id: SmartPlaylistId; name: string }> = [
  { id: 'best-of-year',    name: BEST_OF_YEAR_NAME },
  { id: 'recently-added',  name: 'Recently Added' },
  { id: 'recently-played', name: 'Recently Played' },
  { id: 'top-25',          name: 'Top 25 Most Played' },
  { id: 'top-rated',       name: 'Starred' },
  // 'youd-star' RETIRED from the roster (2026-08-07, Jake: "songs id star
  // should be eliminated") — evaluator case kept so stale state degrades
  // gracefully; SMART_PLAYLIST_NAMES keeps the name to hide iPod dupes.
]

// Selection limits — ONE place. Display and sync read the same numbers
// so the iPod playlist is exactly what the app shows.
const RECENTLY_ADDED_LIMIT  = 50
const RECENTLY_PLAYED_LIMIT = 50
const TOP_25_LIMIT          = 25
const YOUD_STAR_LIMIT       = 50
const YOUD_STAR_PER_ARTIST  = 4   // diversity cap so the list spreads across artists
// Starred has no limit — every starred track is in.

/**
 * Evaluate one of the four built-in smart playlists to a concrete,
 * ordered `Track[]`. Returns `[]` for the AI-pick ids (handled
 * elsewhere) and anything unrecognized.
 */
export function evaluateSmartPlaylist(id: SmartPlaylistId, tracks: Track[]): Track[] {
  switch (id) {
    case 'recently-added':
      return [...tracks]
        .filter(t => t.dateAdded)
        .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''))
        .slice(0, RECENTLY_ADDED_LIMIT)

    case 'recently-played':
      return [...tracks]
        .filter(t => typeof t.lastPlayedAt === 'number' && t.lastPlayedAt > 0)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
        .slice(0, RECENTLY_PLAYED_LIMIT)

    case 'top-25':
      return [...tracks]
        .filter(t => t.playCount > 0)
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, TOP_25_LIMIT)

    case 'top-rated': {
      // 4.5: Jake renamed this to "Starred" and reframed it as a pure
      // toggle list — every starred track, no limit, no
      // play-count-fallback. The smart playlist mirrors the binary
      // star: star a track -> it's here, unstar -> it's gone.
      // Sort: most recently added starred first (so newly-starred
      // shows up at the top).
      return [...tracks]
        .filter(t => (Number(t.rating) || 0) > 0)
        .sort((a, b) => {
          const ad = a.dateAdded ? new Date(a.dateAdded).getTime() : 0
          const bd = b.dateAdded ? new Date(b.dateAdded).getTime() : 0
          return bd - ad
        })
    }

    case 'best-of-year':
      // Jake, 2026-08-22: "best of 2026. no more than 2 songs per album.
      // mix them up. 40 songs." Definition + mix live in
      // common/best-of-year.ts (node-tested); seeded by the year so the
      // order holds steady all year and rolls fresh next January.
      return pickBestOfYear(tracks, { year: BEST_OF_YEAR })

    case 'youd-star': {
      // 4.5: the taste model, deployed. The data-validated identity model
      // (album > artist > genre > era affinity; AUC 0.78, 2026-06-26 study)
      // surfaces UNSTARRED tracks Jake is most likely to star — the hidden
      // gems in records/artists he already loves. Ranked best-first; the
      // view preserves this order when no column header is clicked.
      const profile = buildTasteProfile(tracks)
      const ranked = tracks
        .filter(t => (Number(t.rating) || 0) === 0)
        .map(t => ({ t, s: tasteScore(t, profile) }))
        .sort((a, b) => b.s - a.s)
      // Diversity cap: at most a few per artist, so the list spreads across
      // everything you love instead of 30 Beatles tracks in a row.
      const perArtist = new Map<string, number>()
      const out: Track[] = []
      for (const { t } of ranked) {
        const k = (t.albumArtist || t.artist || '?').trim().toLowerCase()
        const n = perArtist.get(k) || 0
        if (n >= YOUD_STAR_PER_ARTIST) continue
        perArtist.set(k, n + 1)
        out.push(t)
        if (out.length >= YOUD_STAR_LIMIT) break
      }
      return out
    }

    default:
      // AI picks (musicman/megan/dj-hands) + anything unknown.
      return []
  }
}

/**
 * Build the COMPLETE `Playlist[]` to hand to `syncToIpod`: the user's
 * regular playlists kept as-is, plus the four built-in smart playlists
 * freshly evaluated against the current library.
 *
 * IMPORTANT — the iTunesDB writer (`core/db_reader.py` `write_itunesdb`)
 * treats whatever it's handed as THE complete playlist set; it does NOT
 * preserve playlists that aren't in the input. So this function must
 * return regular playlists too, or they'd be dropped from the device.
 *
 * An existing playlist whose name matches a built-in smart playlist
 * (e.g. an iPod-imported "Recently Added") has its `trackIds` replaced
 * with a fresh evaluation. Built-in smart playlists not already present
 * are appended — even when empty, so the playlist EXISTS on the device
 * (an empty "Recently Played" is honest; a missing one is the bug Jake
 * reported).
 */
export function buildSmartPlaylistsForSync(
  tracks: Track[],
  existingPlaylists: Playlist[],
): Playlist[] {
  const smartByName = new Map<string, number[]>()
  for (const { id, name } of BUILTIN_SMART_PLAYLISTS) {
    smartByName.set(name, evaluateSmartPlaylist(id, tracks).map(t => t.id))
  }

  const result: Playlist[] = []
  const refreshed = new Set<string>()

  for (const pl of existingPlaylists) {
    const fresh = smartByName.get(pl.name)
    if (fresh) {
      result.push({ ...pl, trackIds: fresh })
      refreshed.add(pl.name)
    } else {
      result.push(pl)
    }
  }

  for (const { name } of BUILTIN_SMART_PLAYLISTS) {
    if (refreshed.has(name)) continue
    result.push({
      id: `smart-${name.toLowerCase().replace(/\s+/g, '-')}`,
      name,
      trackIds: smartByName.get(name) || [],
    })
  }

  return result
}
