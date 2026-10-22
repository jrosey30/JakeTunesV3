/**
 * Lyrics for the playing song (parity audit #6) — the phone's LyricsStore.
 *
 * One small cache keyed by track id, filled through `get-track-lyrics` (the
 * local lyrics.json sidecar) and shaped by the phone's rules
 * (common/lyrics-rules.ts). Three states, exactly as on the phone:
 *   • missing key  → not asked yet / in flight ("pending": hold a blank sheet);
 *   • null value   → asked, there are none ("No lyrics for this song");
 *   • a sheet      → synced lines, a plain sheet, or "Instrumental".
 * Bounded: the last few dozen songs' sheets, never the library.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/Lyrics.swift `LyricsStore`
 *    (same three states, same 48-song bound, same prefetch of this song and
 *    the next). Change one, change both.
 */
import { useSyncExternalStore } from 'react'
import { trackLyricsFrom, type TrackLyrics } from '../common/lyrics-rules'

const cache = new Map<number, TrackLyrics | null>()
const inflight = new Set<number>()
const subs = new Set<() => void>()

function emit(): void { for (const f of subs) f() }

export function subscribeLyrics(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** The sheet; `null` = this song has none; `undefined` = not answered yet. */
export function lyricsFor(trackId: number | null | undefined): TrackLyrics | null | undefined {
  if (trackId == null) return undefined
  return cache.get(trackId)
}

/** Ask once per song; a second ask while one is in flight is a no-op. */
export function prefetchLyrics(trackId: number | null | undefined): void {
  if (trackId == null || cache.has(trackId) || inflight.has(trackId)) return
  inflight.add(trackId)
  window.electronAPI.getTrackLyrics(trackId)
    .then((r) => trackLyricsFrom(r?.ok ? r : null))
    .catch((err: unknown) => {
      console.warn('[dx.lyrics]', trackId, 'failed:', err)
      return null
    })
    .then((sheet) => {
      if (cache.size > 48) cache.clear()
      cache.set(trackId, sheet)
      inflight.delete(trackId)
      emit()
    })
}

/** React view of one song's sheet (re-renders only when an answer lands). */
export function useTrackLyrics(trackId: number | null | undefined): TrackLyrics | null | undefined {
  return useSyncExternalStore(subscribeLyrics, () => lyricsFor(trackId))
}
