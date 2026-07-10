// V5 Live Concert Mode — renderer-side live-sets store.
//
// Same module-store idiom as previewPlayer.ts: module state + a
// useSyncExternalStore-compatible subscribe/snapshot pair, deliberately
// OUTSIDE the do-not-touch contexts. Loads live-sets.json once via IPC,
// exposes declare/undeclare mutations that write through to main, and
// gives NowPlaying a tiny pure helper mapping (mergedTrackId, positionMs)
// → the current setlist cue.

import type { LiveSetEntry, LiveSetCue, Track } from './types'

interface LiveSetsState {
  loaded: boolean
  sets: Record<string, LiveSetEntry>   // albumKey → entry
}

let state: LiveSetsState = { loaded: false, sets: {} }
const listeners = new Set<() => void>()
let loadPromise: Promise<void> | null = null

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: LiveSetsState): void {
  state = next
  emit()
}

export function subscribeLiveSets(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getLiveSetsSnapshot(): LiveSetsState {
  return state
}

/** Idempotent initial load — call from anywhere, first caller wins. */
export function ensureLiveSetsLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const res = await window.electronAPI.loadLiveSets()
      setState({ loaded: true, sets: res.ok ? res.sets : {} })
    } catch {
      setState({ loaded: true, sets: {} })
    }
  })()
  return loadPromise
}

/**
 * Self-healing read used by the UI: entries whose merged track no longer
 * exists in the library (e.g. Jake deleted the merged file from Songs
 * directly instead of undeclaring) are treated as not-declared. The stale
 * sidecar row is also swept from disk, so the two stores re-converge.
 */
export function liveSetFor(albumKey: string, tracks: Track[]): LiveSetEntry | null {
  const entry = state.sets[albumKey]
  if (!entry) return null
  if (!tracks.some(t => t.id === entry.mergedTrackId)) {
    void window.electronAPI.removeLiveSet(albumKey)
    const next = { ...state.sets }
    delete next[albumKey]
    setState({ ...state, sets: next })
    return null
  }
  return entry
}

/** Record a newly-merged set (called after the import queue lands the track). */
export async function registerLiveSet(albumKey: string, entry: LiveSetEntry): Promise<void> {
  await window.electronAPI.saveLiveSet(albumKey, entry)
  setState({ ...state, sets: { ...state.sets, [albumKey]: entry } })
}

/** Remove a set's sidecar entry (the caller owns deleting the library track). */
export async function unregisterLiveSet(albumKey: string): Promise<void> {
  await window.electronAPI.removeLiveSet(albumKey)
  const next = { ...state.sets }
  delete next[albumKey]
  setState({ ...state, sets: next })
}

/** The merged track ids of every declared set — O(1) membership for the pill. */
export function mergedTrackIndex(): Map<number, LiveSetEntry> {
  const map = new Map<number, LiveSetEntry>()
  for (const entry of Object.values(state.sets)) {
    map.set(entry.mergedTrackId, entry)
  }
  return map
}

/**
 * The set of track ids that a declared concert HIDES from the regular library
 * (count / Songs / Albums / Artists) — the merged "Full Set" track PLUS every
 * constituent that hasn't been reimported (promoted). A concert doesn't count
 * as songs in the library; only individually-promoted songs re-appear.
 *
 * `liveTrackIds` is the id set of the current library.tracks — a set whose
 * merged track is no longer present is treated as not-declared (parity with
 * liveSetFor's self-heal), so a hand-deleted merged file re-reveals its
 * constituents instead of hiding phantom rows. Pure: no IPC/side effects, safe
 * to call every render.
 */
export function libraryHiddenTrackIds(liveTrackIds: Set<number>): Set<number> {
  const hidden = new Set<number>()
  for (const entry of Object.values(state.sets)) {
    if (!liveTrackIds.has(entry.mergedTrackId)) continue      // stale set — don't hide
    hidden.add(entry.mergedTrackId)                            // the merged concert track
    const promoted = new Set(entry.promotedTrackIds || [])
    for (const c of entry.cues) if (!promoted.has(c.trackId)) hidden.add(c.trackId)
  }
  return hidden
}

/**
 * Reimport ONE setlist song into the regular library: mark its constituent
 * track id "promoted" on the concert's sidecar entry so the (untouched)
 * original track re-appears as a normal song. Additive + idempotent — never
 * deletes or re-encodes; the audio was never removed.
 */
export async function promoteTrackToLibrary(albumKey: string, trackId: number): Promise<void> {
  const entry = state.sets[albumKey]
  if (!entry) return
  const promoted = new Set(entry.promotedTrackIds || [])
  if (promoted.has(trackId)) return
  promoted.add(trackId)
  const next: LiveSetEntry = { ...entry, promotedTrackIds: [...promoted] }
  await window.electronAPI.saveLiveSet(albumKey, next)
  setState({ ...state, sets: { ...state.sets, [albumKey]: next } })
}

/**
 * Map a playhead position within a merged set to its current cue.
 * Cues are sorted by startMs at merge time; linear scan is fine at
 * setlist sizes (10-40 songs), binary search would be overkill.
 */
export function cueAt(entry: LiveSetEntry, positionMs: number): { cue: LiveSetCue; index: number } | null {
  if (entry.cues.length === 0) return null
  let hit = 0
  for (let i = 0; i < entry.cues.length; i++) {
    if (entry.cues[i].startMs <= positionMs) hit = i
    else break
  }
  return { cue: entry.cues[hit], index: hit }
}
