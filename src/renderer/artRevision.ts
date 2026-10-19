// Per-cover revision for album-art:// URLs (2026-10-19).
//
// Chromium keeps an `immutable` album-art:// image in memory for the life of
// the renderer: proven in the Concerts-page harness, a row whose thumb was
// deleted on disk and then re-mounted — and even a full webContents.reload() —
// sent ZERO requests to main. So when a cover's BYTES change under the same
// versioned name (the replica artwork mirror replacing a jpg in place, the
// 894-key case), the page keeps the old image until the app relaunches. Main
// tells us which hashes changed; their URLs gain `r=<n>`, which the protocol
// handler ignores (album-art-serve.ts parses only `s=`), so Chromium fetches
// the new bytes once and caches those.
//
// Module store, same idiom as liveSets.ts: outside the do-not-touch contexts.
import { useSyncExternalStore } from 'react'

const revs = new Map<string, number>()
const listeners = new Set<() => void>()
let seq = 0

const bare = (hash: string): string => hash.replace(/_\d+$/, '')

export function bumpArtRevisions(hashes: readonly string[]): void {
  if (!hashes.length) return
  seq++
  for (const h of hashes) revs.set(bare(h), seq)
  for (const l of listeners) l()
}

/** 0 until main reports a byte change for this cover in this session. */
export function artRevision(hash: string | null | undefined): number {
  return hash ? revs.get(bare(hash)) ?? 0 : 0
}

export function subscribeArtRevisions(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Re-renders the caller only when THIS cover's revision moves. */
export function useArtRevision(hash: string | null | undefined): number {
  return useSyncExternalStore(subscribeArtRevisions, () => artRevision(hash))
}

/** The one album-art:// URL shape: `?s=` thumb tier, `r=` cache-buster. */
export function albumArtUrl(hash: string, size?: number, rev = 0): string {
  const q = [size ? `s=${size}` : '', rev ? `r=${rev}` : ''].filter(Boolean).join('&')
  return `album-art://${hash}.jpg${q ? `?${q}` : ''}`
}
