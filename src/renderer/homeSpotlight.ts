// Home spotlight — renderer store (launch page "G", 2026-10-18).
//
// Same module-store idiom as syncedPicks.ts: module state + a
// useSyncExternalStore pair. Main owns the network, the cache and the
// offline fallback (src/main/home-spotlight-client.ts) and keeps it fresh
// (boot, every 10 min, window focus); this store draws what main says and
// asks for one look when the Home mounts.

import { useEffect, useSyncExternalStore } from 'react'
import type { HomeSpotlightState } from '../common/home-spotlight-doc'

let snap: HomeSpotlightState = { doc: null, source: 'none', reachable: null, fetchedAt: null }
let loaded = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): HomeSpotlightState => snap

function put(state: HomeSpotlightState | undefined): void {
  if (!state || typeof state !== 'object' || !('source' in state)) return
  snap = state
  for (const l of listeners) l()
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const api = window.electronAPI
  api.onHomeSpotlightUpdated?.((state) => put(state))
  void api.homeSpotlightGet?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
    console.warn('[home-spotlight] read failed:', err instanceof Error ? err.message : err)
  })
}

/** The spotlight to draw. Mounting asks main for a fresh look (main
 *  throttles it to once a minute; a 304 costs nothing). */
export function useHomeSpotlight(): HomeSpotlightState {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    ensureLoaded()
    void window.electronAPI.homeSpotlightRefresh?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
      console.warn('[home-spotlight] refresh failed:', err instanceof Error ? err.message : err)
    })
  }, [])
  return s
}
