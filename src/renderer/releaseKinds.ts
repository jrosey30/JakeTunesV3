// Release kinds — renderer-side store for release-kinds.json (2026-10-18).
//
// Same module-store idiom as liveSets.ts: module state + a
// useSyncExternalStore-compatible subscribe/snapshot pair. The file is
// resolved in main (src/main/release-kinds.ts) by a slow background
// MusicBrainz pass, so the artist page re-reads it on every visit and the
// grouping improves as answers land. Albums with no stored answer fall back
// to the shared rulebook (title, then shape) — see common/release-sections.ts.

import type { StoredReleaseKinds } from '../common/release-sections'
import { nameKey } from '../common/fold-text'

let albums: StoredReleaseKinds = {}
let updatedAt: string | null = null
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

export function subscribeReleaseKinds(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getReleaseKindsSnapshot(): StoredReleaseKinds {
  return albums
}

/** Re-read release-kinds.json; listeners fire only when the file changed. */
export function refreshReleaseKinds(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await window.electronAPI.loadReleaseKinds?.()
      if (r?.ok && r.updatedAt !== updatedAt) {
        albums = r.albums || {}
        updatedAt = r.updatedAt
        for (const l of listeners) l()
      }
    } catch (err) {
      // Keep what we have: every album still groups by title and shape.
      console.warn('[release-kinds] load failed:', err)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// nameKey runs over every library row when the artist page builds album
// facts; the same few thousand artist / album strings repeat, so remember them.
const folded = new Map<string, string>()
export function foldName(s: string): string {
  let k = folded.get(s)
  if (k === undefined) {
    k = nameKey(s)
    if (folded.size > 50_000) folded.clear()
    folded.set(s, k)
  }
  return k
}
