// Plays heard elsewhere — renderer store (2026-10-20). The phone's and
// workmini's plays, counted in this Mac's views too (Jake: "count all of them").
//
// Same module-store idiom as homeShelves.ts. Main owns the network and the
// cache (src/main/plays-elsewhere-client.ts) and keeps it fresh. This store
// only READS: the overlay sits beside the library and is never dispatched or
// saved — homemini already adds these plays to the counts this Mac publishes
// (src/common/plays-elsewhere.ts has the why; the test locks the wiring).

import { useMemo, useSyncExternalStore } from 'react'
import { overlayOf, withPlaysElsewhere, NO_PLAYS_ELSEWHERE, type ElsewhereOverlay, type PlaysElsewhereState } from '../common/plays-elsewhere'
import type { Track } from './types'

let overlay: ElsewhereOverlay = NO_PLAYS_ELSEWHERE
let loaded = false
const listeners = new Set<() => void>()

function put(state: PlaysElsewhereState | undefined): void {
  if (!state || typeof state !== 'object' || !('source' in state)) return
  overlay = overlayOf(state.doc)
  for (const l of listeners) l()
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const api = window.electronAPI
  api.onPlaysElsewhereUpdated?.((state) => put(state))
  void api.playsElsewhereGet?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
    console.warn('[plays-elsewhere] read failed:', err instanceof Error ? err.message : err)
  })
}

function subscribe(cb: () => void): () => void {
  ensureLoaded()
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): ElsewhereOverlay => overlay

/** Each song's plays and last-played moment heard on the phone and workmini. */
export function usePlaysElsewhere(): ElsewhereOverlay {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * The library as it reads everywhere — for ranking and selecting (Top 25,
 * Recently Played, Best of). Map what you pick back to the library's own
 * tracks by id before showing, playing or saving anything.
 */
export function useTracksEverywhere(tracks: Track[]): Track[] {
  const o = usePlaysElsewhere()
  return useMemo(() => withPlaysElsewhere(tracks, o), [tracks, o])
}
