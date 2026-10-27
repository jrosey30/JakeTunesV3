// Listen More Weekly — renderer store (2026-10-20). Jake: "turn you should
// listen to more into like how spotify has discover weekly. see all should
// take me to a new playlist". homemini mints the week (50 songs since 2026-10-27, one per
// artist, new every Monday 05:00 Eastern); main fetches and caches it
// (src/main/listen-more-weekly-client.ts); this store holds the song ids for
// the sidebar's Listen More Weekly, the Home row's "See all" and the view.
//
// Same module-store idiom as homeShelves.ts.

import { useEffect, useSyncExternalStore } from 'react'
import type { ListenMoreWeeklyState, WeeklyPlaylist } from '../common/listen-more-weekly'

let snap: ListenMoreWeeklyState = { playlist: null, source: 'none', fetchedAt: null }
let loaded = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): ListenMoreWeeklyState => snap

function put(state: ListenMoreWeeklyState | undefined): void {
  if (!state || typeof state !== 'object' || !('source' in state)) return
  snap = state
  for (const l of listeners) l()
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const api = window.electronAPI
  api.onListenMoreWeeklyUpdated?.((state) => put(state))
  void api.listenMoreWeeklyGet?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
    console.warn('[listen-more-weekly] read failed:', err instanceof Error ? err.message : err)
  })
}

/** This week's playlist (name + song ids in order), or null when homemini has
 *  never answered and nothing is cached. Mounting asks main for a fresh look. */
export function useListenMoreWeekly(): WeeklyPlaylist | null {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    ensureLoaded()
    void window.electronAPI.listenMoreWeeklyRefresh?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
      console.warn('[listen-more-weekly] refresh failed:', err instanceof Error ? err.message : err)
    })
  }, [])
  return s.playlist
}
