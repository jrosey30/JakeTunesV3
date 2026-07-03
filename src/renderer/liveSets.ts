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
