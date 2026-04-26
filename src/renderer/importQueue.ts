/**
 * Renderer-side import queue.
 *
 * Why this exists:
 * The old design called `importTracks(allPaths)` once per drop, which
 * meant the entire batch lived inside one IPC promise. If the user
 * dropped 50 tracks and #17 errored mid-conversion, the rest could
 * silently drop, the renderer had no per-item state, and a second drop
 * while the first was running raced over the same nextId counter.
 * Files genuinely went missing — exactly the user's complaint.
 *
 * The queue inverts the relationship: every file is an independent
 * queue item with its own status and id. A single worker picks pending
 * items one at a time, calls `importTrack(path)` (a new IPC handler
 * that does ONE file), and records the result. Drops just push more
 * items onto the queue — they never restart or interrupt a running
 * worker, so back-to-back drops accumulate cleanly.
 *
 * Failures stay in the queue marked `failed` so the user can retry
 * them individually. Dupes are kept too (informational — "we skipped
 * these because you already have them"). When `done` items pile up
 * the user can clear them.
 */

import type { Track } from './types'

export type QueueItemStatus =
  | 'pending'    // sitting in the queue, will be processed
  | 'running'    // currently being imported by the worker
  | 'done'       // successfully imported, has track
  | 'dupe'       // skipped — already in library
  | 'failed'     // import errored, can be retried

export interface QueueItem {
  /** Unique to this queue item — NOT the library track id. */
  uid: string
  srcPath: string
  status: QueueItemStatus
  /** Set once the import succeeds. */
  track?: Track
  /** Set if status === 'dupe'. */
  dupe?: { matchedTitle: string; matchedArtist: string }
  /** Set if status === 'failed'. */
  error?: string
  /** Wall-clock when added (for stable ordering). */
  addedAt: number
}

interface QueueState {
  items: QueueItem[]
  /** Format used for next-popped item. Updated on enqueue. */
  format?: string
  /** Set while the worker is mid-flight on an item. */
  workerRunning: boolean
}

let state: QueueState = {
  items: [],
  format: undefined,
  workerRunning: false,
}

let version = 0
const listeners = new Set<() => void>()

function notify() {
  version += 1
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getSnapshot(): number {
  return version
}

export function getQueueState(): Readonly<QueueState> { return state }

export function getActiveItem(): QueueItem | undefined {
  return state.items.find(i => i.status === 'running') ||
         state.items.find(i => i.status === 'pending')
}

export function getPendingCount(): number {
  return state.items.filter(i => i.status === 'pending' || i.status === 'running').length
}

export function getDoneCount(): number {
  return state.items.filter(i => i.status === 'done').length
}

export function getFailedCount(): number {
  return state.items.filter(i => i.status === 'failed').length
}

export function getDupeCount(): number {
  return state.items.filter(i => i.status === 'dupe').length
}

let uidCounter = 0
function nextUid(): string {
  uidCounter += 1
  return `q${Date.now().toString(36)}_${uidCounter}`
}

/**
 * Add files to the queue. Folders are resolved on the main side first
 * (so we expand a dropped album folder into its individual tracks).
 * Duplicates already in the queue (by srcPath) are filtered out so a
 * re-drop of the same files doesn't double-enqueue.
 */
export async function enqueueFiles(paths: string[], format?: string): Promise<number> {
  if (!paths.length) return 0
  const resolved = await window.electronAPI.importResolvePaths(paths)
  const audio = resolved.ok && resolved.paths ? resolved.paths : []
  if (!audio.length) return 0

  const inQueue = new Set(state.items.map(i => i.srcPath))
  const newItems: QueueItem[] = []
  const now = Date.now()
  for (const p of audio) {
    if (inQueue.has(p)) continue
    newItems.push({
      uid: nextUid(),
      srcPath: p,
      status: 'pending',
      addedAt: now,
    })
  }
  if (!newItems.length) return 0

  state = {
    ...state,
    items: [...state.items, ...newItems],
    format: format ?? state.format,
  }
  notify()
  // Kick the worker. If one is already running this is a no-op.
  void runWorker()
  return newItems.length
}

/**
 * Mark a failed item back to pending so the worker picks it up again.
 */
export function retryFailed(uid: string): void {
  let changed = false
  state = {
    ...state,
    items: state.items.map(i => {
      if (i.uid === uid && i.status === 'failed') {
        changed = true
        return { ...i, status: 'pending', error: undefined }
      }
      return i
    }),
  }
  if (changed) {
    notify()
    void runWorker()
  }
}

export function retryAllFailed(): void {
  let changed = false
  state = {
    ...state,
    items: state.items.map(i => {
      if (i.status === 'failed') {
        changed = true
        return { ...i, status: 'pending', error: undefined }
      }
      return i
    }),
  }
  if (changed) {
    notify()
    void runWorker()
  }
}

export function removeItem(uid: string): void {
  const before = state.items.length
  state = { ...state, items: state.items.filter(i => i.uid !== uid) }
  if (state.items.length !== before) notify()
}

export function clearFinished(): void {
  state = {
    ...state,
    items: state.items.filter(i =>
      i.status === 'pending' || i.status === 'running' || i.status === 'failed'
    ),
  }
  notify()
}

export function clearAll(): void {
  // Don't kill a currently-running item — let the worker finish the
  // single file it's on. Anything not yet picked up is dropped.
  state = {
    ...state,
    items: state.items.filter(i => i.status === 'running'),
  }
  notify()
}

/**
 * Hook to call from App.tsx when the library has loaded so the queue
 * worker knows what id to use next. The library's max id is the
 * starting point; we keep advancing as imports succeed.
 */
let nextLibraryId = 1
export function setNextLibraryId(id: number): void {
  if (id > nextLibraryId) nextLibraryId = id
}

/**
 * Subscribe to "track imported" events. App.tsx wires this to the
 * library reducer so each successful import shows up in the UI as
 * soon as it finishes (don't wait for the whole queue).
 */
type TrackHandler = (t: Track) => void
const trackHandlers = new Set<TrackHandler>()
export function onTrackImported(fn: TrackHandler): () => void {
  trackHandlers.add(fn)
  return () => { trackHandlers.delete(fn) }
}

async function runWorker(): Promise<void> {
  if (state.workerRunning) return
  state = { ...state, workerRunning: true }

  try {
    while (true) {
      const next = state.items.find(i => i.status === 'pending')
      if (!next) break

      // Mark running.
      state = {
        ...state,
        items: state.items.map(i => i.uid === next.uid ? { ...i, status: 'running' } : i),
      }
      notify()

      const id = nextLibraryId++
      let res: Awaited<ReturnType<typeof window.electronAPI.importTrack>>
      try {
        res = await window.electronAPI.importTrack(next.srcPath, id, state.format)
      } catch (err) {
        res = { ok: false, error: String(err) }
      }

      if (res.ok && res.track) {
        const track = res.track as Track
        // The main side may have bumped the id past `id` if the slot
        // was already on disk (Apr 26 78-collision bug — see
        // findFreeImportedId in main/index.ts). Advance our counter
        // so the next worker iteration doesn't re-pick a now-taken id.
        if (typeof track.id === 'number' && track.id >= nextLibraryId) {
          nextLibraryId = track.id + 1
        }
        state = {
          ...state,
          items: state.items.map(i =>
            i.uid === next.uid ? { ...i, status: 'done', track } : i
          ),
        }
        for (const fn of trackHandlers) {
          try { fn(track) } catch { /* handler crash shouldn't kill the worker */ }
        }
      } else if (res.ok && res.dupe) {
        state = {
          ...state,
          items: state.items.map(i =>
            i.uid === next.uid
              ? { ...i, status: 'dupe', dupe: { matchedTitle: res.dupe!.matchedTitle, matchedArtist: res.dupe!.matchedArtist } }
              : i
          ),
        }
        // Roll back the id we reserved — nothing landed in the library.
        nextLibraryId = Math.min(nextLibraryId, id)
      } else {
        state = {
          ...state,
          items: state.items.map(i =>
            i.uid === next.uid ? { ...i, status: 'failed', error: res.error || 'Import failed' } : i
          ),
        }
        // Same — id wasn't consumed.
        nextLibraryId = Math.min(nextLibraryId, id)
      }
      notify()
    }
  } finally {
    state = { ...state, workerRunning: false }
    notify()
  }
}
