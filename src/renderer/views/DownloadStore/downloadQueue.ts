// Download queue — the "no surprises" engine for the Download view. You can
// queue as many results as you want; they run one at a time (streamrip is a
// CLI — serial is the reliable choice), and every item carries its OWN visible
// lifecycle so nothing is ever a black box:
//   queued → downloading (with a live elapsed clock) → done (✓ in your library,
//   N tracks) OR failed (with one-click retry).
// Module-level + pub/sub so the state survives navigating away and back (same
// pattern as the view's pageCache) and any mounted view re-renders on change.

export interface QResult { source: string; mediaType: string; id: string; desc: string }
export type QStatus = 'queued' | 'downloading' | 'done' | 'failed'
export interface QItem {
  key: string
  result: QResult
  status: QStatus
  imported?: number
  dupes?: number
  error?: string
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
    if (existing.status === 'failed') { existing.status = 'queued'; existing.error = undefined; emit(); void pump() }
    return
  }
  queue = [...queue, { key, result: r, status: 'queued' }]
  emit()
  void pump()
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
      emit()
      try {
        const r = await window.electronAPI.streamripDownloadId?.(it.result.source, it.result.mediaType, it.result.id)
        if (r?.ok) {
          it.status = 'done'
          it.imported = r.imported ?? 0
          it.dupes = r.dupes ?? 0
        } else {
          it.status = 'failed'
          it.error = r?.error || 'Download failed.'
        }
      } catch (e) {
        it.status = 'failed'
        it.error = e instanceof Error ? e.message : 'Download failed.'
      }
      it.endedAt = Date.now()
      emit()
    }
  } finally {
    running = false
  }
}
