// Home shelves — renderer store (2026-10-20, the three rows under launch page "G").
//
// Same module-store idiom as homeSpotlight.ts. Main owns the network and the
// cache (src/main/home-shelves-client.ts) and keeps it fresh (boot, every
// 10 min, window focus). When main has no fresh copy (homemini away, nothing
// cached in 24 h) this store builds the same rows from THIS Mac's library and
// play history with the shared rulebook — here, because the taste score the
// hidden gems rank by lives in the renderer (utils/tasteScore.ts). No stars
// anywhere = no taste signal = the hidden-gem row hides; nothing is invented.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { localHomeShelves, type HomeShelves, type HomeShelvesState, type ShelvesSource } from '../common/home-shelves-doc'
import { isTop25Rankable } from '../common/top25-rankable'
import type { ShelfPlay } from '../common/home-shelves'
import { buildTasteProfile, tasteScore } from './utils/tasteScore'
import { albumKeyOf } from './utils/albumKey'
import type { Track } from './types'

let snap: HomeShelvesState = { doc: null, source: 'none', reachable: null, fetchedAt: null }
/** main has answered at least once — until then "none" means "not asked yet". */
let answered = false
let loaded = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): HomeShelvesState => snap

function put(state: HomeShelvesState | undefined): void {
  if (!state || typeof state !== 'object' || !('source' in state)) return
  snap = state
  answered = true
  for (const l of listeners) l()
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const api = window.electronAPI
  api.onHomeShelvesUpdated?.((state) => put(state))
  void api.homeShelvesGet?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
    console.warn('[home-shelves] read failed:', err instanceof Error ? err.message : err)
  })
}

/** This Mac's play history, asked for only when the local rows are needed. */
async function localPlays(): Promise<ShelfPlay[]> {
  try {
    const r = await window.electronAPI.homeShelvesLocalPlays?.()
    return r?.ok && Array.isArray(r.plays) ? r.plays : []
  } catch (err) {
    console.warn('[home-shelves] local plays failed:', err instanceof Error ? err.message : err)
    return []
  }
}

export interface ShelvesView {
  shelves: HomeShelves | null
  source: ShelvesSource
}

/**
 * The rows to draw. `tracks` is the whole library, `regular` HomeView's
 * concert-free projection of it (a declared show's songs never appear).
 * Mounting asks main for a fresh look (main throttles it to once a minute).
 */
export function useHomeShelves(tracks: Track[], regular: Track[]): ShelvesView {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    ensureLoaded()
    void window.electronAPI.homeShelvesRefresh?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
      console.warn('[home-shelves] refresh failed:', err instanceof Error ? err.message : err)
    })
  }, [])

  const needLocal = answered && !s.doc
  const [plays, setPlays] = useState<ShelfPlay[] | null>(null)
  useEffect(() => {
    if (!needLocal || plays) return
    let cancelled = false
    void localPlays().then((p) => { if (!cancelled) setPlays(p) })
    return () => { cancelled = true }
  }, [needLocal, plays])

  const local = useMemo((): HomeShelves | null => {
    if (!needLocal || !plays) return null
    const visible = new Set(regular.map((t) => t.id))
    const hidden = new Set<string>()
    for (const t of tracks) if (!visible.has(t.id)) hidden.add(String(t.id))
    const profile = buildTasteProfile(tracks)
    return localHomeShelves<Track>({
      tracks,
      plays,
      now: Date.now(),
      rules: { hidden, rankable: (t) => isTop25Rankable(t) },
      score: profile.prior > 0 ? (t) => tasteScore(t, profile) : null,
      albumKeyOf: (t) => albumKeyOf(t),
    })
  }, [needLocal, plays, tracks, regular])

  if (s.doc) return { shelves: s.doc, source: s.source }
  return local ? { shelves: local, source: 'local' } : { shelves: null, source: 'none' }
}
