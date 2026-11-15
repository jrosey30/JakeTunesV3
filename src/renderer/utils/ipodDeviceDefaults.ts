/**
 * The default playlists one iPod carries, as its Sync would write them today
 * (2026-11-14, ~/concert-repair/ipod-playlists-plan.md, approved). Jake:
 * "default playlists are standard for each ipod, like it was back in the day".
 *
 * Nothing new is decided here. It is the sync's own code, run on the iPod's
 * songs without the iPod plugged in:
 *   - workoutIpodSync.ts assembleSyncPlaylists: the iPod's own list first, then
 *     the built-ins (Top 25 Most Played, Starred, Recently Added, Recently
 *     Played, Best of <year>) evaluated against THAT iPod's songs by
 *     smartPlaylists.ts;
 *   - common/ipod-device-playlists.ts devicePlaylistSet: the decades, the BPM
 *     ranges, the empty and the nearly-everything ones left out, one name once,
 *     and the iPod's own list only on the Original (Jake, on a punkPod playlist
 *     under punkPod: it "doesn't make any sense").
 * Only the `set` and `default` playlists are kept: On-The-Go and Jake's own come
 * from homemini (renderer/ipodPlaylists.ts) and go after these.
 *
 * Two inputs can differ from the sync's, by a song or two, and nothing else:
 *   - the songs are the iPod's list on homemini as it stands (the Original: the
 *     Top 1000), the songs this library has. The Original's Sync also fills the
 *     seats of songs that can't go on with the most-loved songs in the library.
 *   - the decades list their songs in the list's order; the sync writes them in
 *     the iPod's catalogue order.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/ipodDefaultPlaylists.ts (GET
 * /api/ipod-playlists/defaults?device=, for the phone) — the same rule on
 * homemini. src/main/__tests__/fixtures/ipod-default-playlists.fixture.json is
 * the same file, byte for byte, in both repos; each repo's test runs its own
 * code on it and expects the playlists written in it.
 *
 * Pure — node --test loads it.
 */
import type { Track } from '../types'
import { assembleSyncPlaylists } from './workoutIpodSync.ts'
import { BEST_OF_YEAR } from './smartPlaylists.ts'
import { compareNames } from './artistSort.ts'
import { devicePlaylistSet, type DevicePlaylistKind } from '../../common/ipod-device-playlists.ts'

export interface IpodDefaultPlaylist {
  /** Stable for this iPod: 'workout-sync', 'default-top-25-most-played', 'default-decade-1990', 'default-bpm-110'… */
  id: string
  name: string
  /** 'set' = the iPod's own list (first); 'default' = everything else here. */
  kind: Extract<DevicePlaylistKind, 'set' | 'default'>
  trackIds: number[]
}

export interface IpodDefaultsInput {
  /** The whole library (rows the renderer holds). */
  library: readonly Track[]
  /** The iPod's songs, in its list's order (the Original: the Top 1000, best first). */
  ipodIds: readonly number[]
  /** The name the iPod's own list is written under: 'Top 1000' on the Original, the list's name otherwise. */
  setName: string
  /** The Original: its own list (the Top 1000, in rank order) is a default. Any other
   *  iPod's own list is the whole iPod, so the sync never writes it (PR 424). */
  original: boolean
  /** Verified foot-tap BPMs (homemini's nightly check), by song id. */
  verifiedBpm: ReadonlyMap<number, number>
}

/** The iPod's songs as library rows, in list order, each once. */
export function ipodTracks(library: readonly Track[], ipodIds: readonly number[]): Track[] {
  const byId = new Map(library.map((t) => [Number(t.id), t]))
  const seen = new Set<number>()
  const out: Track[] = []
  for (const raw of ipodIds) {
    const id = Number(raw)
    const t = byId.get(id)
    if (!t || seen.has(id)) continue
    seen.add(id)
    out.push(t)
  }
  return out
}

/** The defaults (on the Original, its Top 1000 first), in the order the iPod shows them: exactly what the sync writes. */
export function ipodDefaultPlaylists(input: IpodDefaultsInput): IpodDefaultPlaylist[] {
  const tracks = ipodTracks(input.library, input.ipodIds)
  if (tracks.length === 0) return []
  const passed = assembleSyncPlaylists(tracks, [], input.setName)
  const set = devicePlaylistSet({
    passed,
    tracks: tracks.map((t) => ({ id: t.id, year: t.year })),
    // The sync's own year: the built-ins were evaluated under "Best of <BEST_OF_YEAR>".
    year: BEST_OF_YEAR,
    original: input.original,
    verifiedBpm: input.verifiedBpm,
    onTheGo: [],
    assigned: [],
    compareNames,
  })
  return set.playlists
    .filter((p) => p.kind === 'set' || p.kind === 'default')
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind as 'set' | 'default', trackIds: p.trackIds }))
}

