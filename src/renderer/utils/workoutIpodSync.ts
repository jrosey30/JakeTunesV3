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
  }
}

export async function buildWorkoutIpodSyncPayload(
  allTracks: Track[],
  regularPlaylists: Playlist[],
  brief?: ActivityBrief | null,
): Promise<{ ok: true; payload: WorkoutSyncPayload } | { ok: false; error: string }> {
  const res = await window.electronAPI.buildWorkoutSyncSet?.(
    allTracks.map(toWorkoutTrack),
    brief ? { brief, saveProfile: true } : undefined,
  )
  if (!res?.ok || !res.trackIds?.length) {
    return { ok: false, error: res?.error || 'Could not build activity sync set.' }
  }

  const idSet = new Set(res.trackIds)
  const byId = new Map(allTracks.map((t) => [t.id, t]))
  const tracks = res.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
  if (tracks.length === 0) {
    return { ok: false, error: 'Activity set produced no matching library tracks.' }
  }

  const basePlaylists = buildSmartPlaylistsForSync(tracks, regularPlaylists)
  const filteredRegular = basePlaylists.map((p) => ({
    ...p,
    trackIds: (p.trackIds || []).filter((id) => idSet.has(id)),
  })).filter((p) => (p.trackIds?.length || 0) > 0)

  const workoutPlaylist: Playlist = {
    id: 'workout-sync',
    name: res.name || 'Activity Sync',
    trackIds: tracks.map((t) => t.id),
  }

  const w = res.weather
  const weatherLine = w
    ? `${w.placeLabel || brief?.place || ''}: ${w.tempF}°F, ${w.description || w.condition}`
    : undefined

  return {
    ok: true,
    payload: {
      tracks,
      playlists: [workoutPlaylist, ...filteredRegular],
      name: res.name || 'Activity Sync',
      commentary: res.commentary || '',
      alacCount: res.alacCount ?? 0,
      total: tracks.length,
      weatherLine,
    },
  }
}
