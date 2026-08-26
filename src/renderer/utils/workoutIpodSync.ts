/**
 * Build the track + playlist payload for iPod sync.
 *
 * Syncs a rotating AI activity set (~1000 tracks) shaped by the pre-sync
 * brief + place weather. Files copy as-is (ALAC preserved).
 */

import type { Track, Playlist } from '../types'
import { buildSmartPlaylistsForSync } from './smartPlaylists'
import type { ActivityBrief } from '../components/ActivitySheet'

export interface WorkoutSyncPayload {
  tracks: Track[]
  playlists: Playlist[]
  name: string
  commentary: string
  alacCount: number
  total: number
  weatherLine?: string
}

function toWorkoutTrack(t: Track) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    genre: t.genre,
    year: t.year,
    playCount: t.playCount,
    skipCount: t.skipCount,
    rating: t.rating,
    bpm: t.bpm,
    codec: t.codec,
    fileSize: t.fileSize,
    duration: t.duration,
    path: t.path,
    audioMissing: t.audioMissing,
  }
}

/**
 * Assemble the playlist list for an activity-set sync: the set itself as
 * a named playlist, plus the user's regular playlists filtered down to
 * members of the set. Exported so the review sheet can re-assemble after
 * the user edits (removes/substitutes) tracks — playlists must always be
 * rebuilt from the FINAL track list or the iPod DB would reference songs
 * that never landed.
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
    name: setName || 'Activity Sync',
    trackIds: tracks.map((t) => t.id),
  }
  return [setPlaylist, ...filteredRegular]
}

export async function buildWorkoutIpodSyncPayload(
  allTracks: Track[],
  regularPlaylists: Playlist[],
  brief?: ActivityBrief | null,
): Promise<{ ok: true; payload: WorkoutSyncPayload } | { ok: false; error: string }> {
  const res = await window.electronAPI.buildWorkoutSyncSet?.(
    allTracks.map(toWorkoutTrack),
    brief ? { brief, saveProfile: true, target: brief.target ?? 1000 } : undefined,
  )
  if (!res?.ok || !res.trackIds?.length) {
    return { ok: false, error: res?.error || 'Could not build activity sync set.' }
  }

  const byId = new Map(allTracks.map((t) => [Number(t.id), t]))
  const requested = Math.max(res.trackIds.length, Number(res.requested) || brief?.target || 1000)
  const tracks: Track[] = []
  const seen = new Set<number>()
  const take = (raw: number | string) => {
    if (tracks.length >= requested) return
    const id = Number(raw)
    if (!Number.isFinite(id) || seen.has(id)) return
    const t = byId.get(id)
    if (!t) return
    seen.add(id)
    tracks.push(t)
  }
  for (const id of res.trackIds) take(id)
  for (const id of res.reserveIds || []) take(id)
  if (tracks.length === 0) {
    return { ok: false, error: 'Activity set produced no matching library tracks.' }
  }
  if (tracks.length < requested) {
    console.warn(`[workout-sync] resolved ${tracks.length}/${requested} — library had no more eligible replacements`)
  }

  const w = res.weather
  const weatherLine = w
    ? `${w.placeLabel || brief?.place || ''}: ${w.tempF}°F, ${w.description || w.condition}`
    : undefined

  return {
    ok: true,
    payload: {
      tracks,
      playlists: assembleSyncPlaylists(tracks, regularPlaylists, res.name || 'Activity Sync'),
      name: res.name || 'Activity Sync',
      commentary: res.commentary || '',
      alacCount: res.alacCount ?? 0,
      total: tracks.length,
      weatherLine,
    },
  }
}
