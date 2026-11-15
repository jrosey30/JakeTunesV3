/**
 * The track + playlist payload for an iPod sync (2026-11-07: one button per
 * iPod). main/ipod-one-sync.ts decides which songs go on the plugged-in iPod —
 * the Original's Top 1000, another iPod's list — and this turns that plan into
 * the rows and playlists sync-to-ipod takes. No size, no brief, no Music Man.
 * Files copy as-is (ALAC preserved).
 */

import type { Track, Playlist } from '../types'
import { buildSmartPlaylistsForSync } from './smartPlaylists.ts'
import type { OneSyncPlan } from '../../common/ipod-one-sync-plan'

/** What main needs to plan a sync: the board check (title, artist, path, codec,
 *  duration) and the Original's most-loved fill order (rating, plays, recency). */
function toPlanTrack(t: Track) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    genre: t.genre,
    playCount: t.playCount,
    rating: t.rating,
    codec: t.codec,
    duration: t.duration,
    path: t.path,
    audioMissing: t.audioMissing,
    lastPlayedAt: t.lastPlayedAt,
    dateAdded: t.dateAdded,
  }
}

/** What one Sync would put on the plugged-in iPod right now (the plan only — nothing is written). */
export async function planIpodSync(allTracks: Track[]): Promise<OneSyncPlan> {
  const api = window.electronAPI.planIpodSync
  if (!api) return { ok: false, kind: 'none', ipodName: null, color: null, error: 'This build can’t sync iPods.' }
  try {
    const plan = await api(allTracks.map(toPlanTrack))
    return plan.ok ? await withPlaylists(plan, allTracks) : plan
  } catch (err) {
    return { ok: false, kind: 'none', ipodName: null, color: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The plan, plus the playlists the next sync writes on that iPod (2026-11-14):
 *  the built-ins evaluated against the plan's songs, exactly as the sync hands
 *  them over, and main works out the rest (main/ipod-device-playlists-run.ts
 *  preview). On any trouble the plan comes back as it was, without the list. */
async function withPlaylists(plan: Extract<OneSyncPlan, { ok: true }>, allTracks: Track[]): Promise<OneSyncPlan> {
  const preview = window.electronAPI.previewIpodPlaylists
  if (!preview) return plan
  try {
    const rows = planTracks(plan, allTracks)
    const passed = assembleSyncPlaylists(rows, [], plan.setName)
      .map((p) => ({ id: String(p.id), name: p.name, trackIds: (p.trackIds || []).map(Number) }))
    const r = await preview(passed, rows.map((t) => ({ id: t.id, year: t.year ?? null })))
    return r ? { ...plan, playlists: r.names, playlistNotes: r.notes } : plan
  } catch {
    return plan
  }
}

/** The plan's ids as library rows, in plan order. */
export function planTracks(plan: Extract<OneSyncPlan, { ok: true }>, allTracks: Track[]): Track[] {
  const byId = new Map(allTracks.map((t) => [Number(t.id), t]))
  const out: Track[] = []
  const seen = new Set<number>()
  for (const id of plan.trackIds) {
    const t = byId.get(Number(id))
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

/**
 * Assemble the playlist list for an iPod sync: the set itself as a named
 * playlist, the built-ins evaluated against the set, plus the user's regular
 * playlists filtered down to members of the set. Always built from the FINAL
 * track list, or the iPod DB would reference songs that never landed.
 *
 * Main keeps only what belongs on that iPod (common/ipod-device-playlists.ts,
 * 2026-11-14): the regular playlists are never written, and the set is written
 * only on the Original ("Top 1000"). Whatever is handed in here, that holds.
 */
export function assembleSyncPlaylists(
  tracks: Track[],
  regularPlaylists: Playlist[],
  setName: string,
): Playlist[] {
  const idSet = new Set(tracks.map((t) => t.id))
  const basePlaylists = buildSmartPlaylistsForSync(tracks, regularPlaylists)
  const filteredRegular = basePlaylists.map((p) => ({
    ...p,
    trackIds: (p.trackIds || []).filter((id) => idSet.has(id)),
  })).filter((p) => (p.trackIds?.length || 0) > 0)
  const setPlaylist: Playlist = {
    id: 'workout-sync',
    name: setName || 'iPod',
    trackIds: tracks.map((t) => t.id),
  }
  return [setPlaylist, ...filteredRegular]
}
