// Download queue — the "no surprises" engine for the Download view. You can
// queue as many results as you want; they run one at a time (streamrip is a
// CLI — serial is the reliable choice), and every item carries its OWN visible
// lifecycle so nothing is ever a black box:
//   queued → downloading (with a live elapsed clock) → done (✓ in your library,
//   N tracks) OR failed (with one-click retry).
// Module-level + pub/sub so the state survives navigating away and back (same
// pattern as the view's pageCache) and any mounted view re-renders on change.

// Two kinds of queue entries:
//  - id: a raw streamrip catalog id (legacy path, still used by pasted links)
//  - query: an iTunes-picked song/album resolved on Qobuz at download time
//    (artist+title or artist+album) — the v2 search flow.
export interface QResult {
  source: string
  mediaType: string
  id: string
  desc: string
  kind?: 'id' | 'query'
  artist?: string
  title?: string
  album?: string
  /** Exact-version length from the iTunes pick — main verifies the Qobuz
   *  file against it before import (wrong-version guard, 2026-08-07). */
  durationMs?: number
  /** The iTunes row this came from is a CENSORED edition, so its runtime is
   *  not a fingerprint for the explicit master we are actually going to fetch.
   *  Amended cuts are genuinely different lengths — Mo Money Mo Problems is
   *  258s amended vs 251s explicit, Sky's the Limit 277s vs 254s — so pinning
   *  the guard to ±5s of the clean edit rejected every one of them. */
  cleanedSource?: boolean
  explicitSource?: boolean
  /** Release year of the clicked row — part of the identity contract. */
  releaseYear?: number
  /** Album rows: the iTunes collection id and its track count — main fetches
   *  the ordered tracklist by id and verifies the EDITION before import
   *  (album identity contract, 6.0 Phase 1). */
  collectionId?: number
  trackCount?: number
}
export type QStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'
export interface QItem {
  key: string
  result: QResult
  status: QStatus
  imported?: number
  dupes?: number
  error?: string
  /** Structured verdict behind `error` (6.0 Phase 1): 'exact-not-found'
   *  means sources answered and every candidate was judged and refused —
   *  `alternatives` lists them with the reason each failed. */
  outcome?: string
  alternatives?: Array<{ provider: string; desc: string; reason: string }>
  /** Short readable status ("Exact version not found") + the full,
   *  never-truncated explanation for the details panel. */
  primary?: string
  detail?: string
  startedAt?: number
  endedAt?: number
}

export function queueKey(r: QResult): string {
  return `${r.source}|${r.mediaType}|${r.id}`
}

let queue: QItem[] = []
let running = false
const subs = new Set<() => void>()
const emit = (): void => { for (const f of subs) f() }

export function subscribeQueue(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
export function getQueue(): QItem[] { return queue }
export function itemFor(r: QResult): QItem | undefined { return queue.find((q) => q.key === queueKey(r)) }

export function queueSummary(): { active: number; queued: number; done: number; failed: number } {
  let active = 0, queued = 0, done = 0, failed = 0
  for (const q of queue) {
    if (q.status === 'downloading') active++
    else if (q.status === 'queued') queued++
    else if (q.status === 'done') done++
    else if (q.status === 'failed') failed++
  }
  return { active, queued, done, failed }
}

/** Add a result to the queue (or re-arm a failed one). No-op if already queued,
 *  running, or done — clicking twice never double-grabs. */
export function enqueue(r: QResult): void {
  const key = queueKey(r)
  const existing = queue.find((q) => q.key === key)
  if (existing) {
    if (existing.status === 'failed' || existing.status === 'canceled') { existing.status = 'queued'; existing.error = undefined; emit(); void pump() }
    return
  }
  queue = [...queue, { key, result: r, status: 'queued' }]
  emit()
  void pump()
}

/** Cancel a queued item (drop it) or an in-flight one (kill the rip
 *  process; main's staging cleanup handles the partial files). */
export async function cancel(key: string): Promise<void> {
  const it = queue.find((q) => q.key === key)
  if (!it) return
  if (it.status === 'queued') {
    queue = queue.filter((q) => q.key !== key)
    emit()
    return
  }
  if (it.status === 'downloading') {
    it.status = 'canceled'
    it.endedAt = Date.now()
    emit()
    await window.electronAPI.streamripCancelActive?.().catch(() => {})
  }
}

export function retry(key: string): void {
  const it = queue.find((q) => q.key === key)
  if (!it || it.status === 'downloading' || it.status === 'queued') return
  it.status = 'queued'
  it.error = undefined
  it.imported = undefined
  it.dupes = undefined
  emit()
  void pump()
}

/** Re-arm every failed/canceled item. The queue bar's Retry uses this so
 *  three stacked misses aren't a click-each-one scavenger hunt. */
export function retryFailed(): void {
  let any = false
  for (const it of queue) {
    if (it.status !== 'failed' && it.status !== 'canceled') continue
    it.status = 'queued'
    it.error = undefined
    it.imported = undefined
    it.dupes = undefined
    any = true
  }
  if (!any) return
  emit()
  void pump()
}

/** Drop the done/failed items — a "clear finished" affordance. */
export function clearFinished(): void {
  queue = queue.filter((q) => q.status === 'queued' || q.status === 'downloading')
  emit()
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const it = queue.find((q) => q.status === 'queued')
      if (!it) break
      it.status = 'downloading'
      it.startedAt = Date.now()
      it.imported = undefined
      it.dupes = undefined
      it.error = undefined
      it.outcome = undefined
      it.alternatives = undefined
      it.primary = undefined
      it.detail = undefined
      emit()
      try {
        const r: { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string; alternatives?: Array<{ provider: string; desc: string; reason: string }>; primary?: string; detail?: string } | undefined = it.result.kind === 'query'
          ? await window.electronAPI.streamripDownloadByQuery?.({ artist: it.result.artist, title: it.result.title, album: it.result.album, durationMs: it.result.durationMs, cleanedSource: it.result.cleanedSource, explicitSource: it.result.explicitSource, releaseYear: it.result.releaseYear, collectionId: it.result.collectionId, trackCount: it.result.trackCount })
          : await window.electronAPI.streamripDownloadId?.(it.result.source, it.result.mediaType, it.result.id)
        // Read through a widened alias. TypeScript narrows it.status to
        // 'downloading' before the await and cannot see that cancel() mutates
        // it DURING the await, so it calls this comparison unreachable. The
        // runtime behaviour is correct and load-bearing — without this branch a
        // download the user cancelled mid-flight would be overwritten with
        // 'done' or 'failed' and the cancel would appear to do nothing.
        const statusNow = it.status as QStatus
        if (statusNow === 'canceled') { /* user killed it mid-flight — keep that verdict */ }
        else if (r?.ok) {
          it.status = 'done'
          it.imported = r.imported ?? 0
          it.dupes = r.dupes ?? 0
        } else {
          it.status = 'failed'
          it.error = r?.error || 'Download failed.'
          it.outcome = r?.outcome
          it.alternatives = r?.alternatives
          it.primary = r?.primary || primaryFor(r?.outcome, it.error)
          it.detail = r?.detail || it.error
        }
      } catch (e) {
        const statusAfterThrow = it.status as QStatus
        if (statusAfterThrow !== 'canceled') {
          it.status = 'failed'
          it.error = e instanceof Error ? e.message : 'Download failed.'
          it.primary = 'Download failed'
          it.detail = it.error
        }
      }
      it.endedAt = Date.now()
      emit()
    }
  } finally {
    running = false
  }
}

/** The short status for an outcome when main did not send one (older
 *  paths, thrown errors). ⚠️ TWIN: src/main/exact-recording.ts describeOutcome. */
export function primaryFor(outcome: string | undefined, error?: string): string {
  switch (outcome) {
    case 'exact-not-found': return 'Exact version not found'
    case 'unverifiable': return 'Couldn’t verify recording'
    case 'provider-unavailable': return 'Provider unavailable'
    case 'not-found': return 'Not found'
    case 'not-released': return 'Not out yet'
    case 'canceled': return 'Canceled'
    case 'provider-failed': return 'Download failed'
    default: return /not out yet/i.test(error || '') ? 'Not out yet' : 'Download failed'
  }
}
