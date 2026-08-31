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

/** Printed-setlist display title — strips "(Live …)" AND "[Live]" tag
 *  suffixes. Shared by ConcertDetailView + AlbumDetailView so the two
 *  setlist surfaces can never disagree on what a song is called. */
export function cleanLiveTitle(t: string): string {
  return t.replace(/\s*[[(]Live[\])].*$|\s*[[(]Live\b.*$/i, '').trim() || t
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

/** Merge companion metadata (facts/notes/details/poster) onto a concert entry. */
export async function updateConcertMeta(albumKey: string, partial: NonNullable<LiveSetEntry['concert']>): Promise<void> {
  const entry = state.sets[albumKey]
  if (!entry) return
  const next: LiveSetEntry = { ...entry, concert: { ...entry.concert, ...partial } }
  await window.electronAPI.saveLiveSet(albumKey, next)
  setState({ ...state, sets: { ...state.sets, [albumKey]: next } })
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
  const i = cueIndexAt(entry.cues, positionMs)
  return i < 0 ? null : { cue: entry.cues[i], index: i }
}

/**
 * THE cue-lookup: which slot of a merged file is playing at positionMs.
 * Returns -1 for an empty cue list.
 *
 * Deliberately typed to the minimum it needs (anything with startMs) so
 * mixtapes can share it — a merged tape (2026-08-08) answers exactly the
 * same question as a merged live set, and this codebase's most expensive
 * failures have come from two copies of one comparator drifting apart.
 * Tape cues carry only {trackId,startMs,durationMs} and resolve their
 * titles from the library, because a tape's songs stay in the library as
 * individual tracks and should follow any retitle there.
 */
export function cueIndexAt(cues: Array<{ startMs: number }>, positionMs: number): number {
  if (cues.length === 0) return -1
  let hit = 0
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].startMs <= positionMs) hit = i
    else break
  }
  return hit
}
