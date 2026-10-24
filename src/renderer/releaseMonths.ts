// Release months — renderer store (2026-10-24). homemini dates this year's
// releases (JakeTunesMobile util/releaseMonths.ts); main keeps a copy
// (src/main/release-months.ts); this store holds the months and their song
// rows for the sidebar's per-month smart playlists and SmartPlaylistView.
//
// Same module-store idiom as listenMoreWeekly.ts / homeShelves.ts.

import { useEffect, useSyncExternalStore } from 'react'
import type { MonthRow } from '../common/release-months'

export interface ReleaseMonthsSnapshot { months: string[]; tracks: MonthRow[] }

let snap: ReleaseMonthsSnapshot | null = null
let loaded = false
const listeners = new Set<() => void>()
const REFRESH_MS = 15 * 60_000

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): ReleaseMonthsSnapshot | null => snap

function put(r: { ok: boolean; months?: string[]; tracks?: MonthRow[] } | undefined): void {
  if (!r?.ok || !Array.isArray(r.months) || !Array.isArray(r.tracks)) return
  snap = { months: r.months, tracks: r.tracks }
  for (const l of listeners) l()
}

function load(): void {
  void window.electronAPI.getReleaseMonths?.().then(put).catch((err: unknown) => {
    console.warn('[release-months] read failed:', err instanceof Error ? err.message : err)
  })
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  load()
  setInterval(load, REFRESH_MS)
}

/** This year's releases by month (months ascending + song rows in playlist order), or null until main has a copy. */
export function useReleaseMonths(): ReleaseMonthsSnapshot | null {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { ensureLoaded() }, [])
  return s
}
