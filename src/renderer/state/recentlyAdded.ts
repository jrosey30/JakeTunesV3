// ════════════════════════════════════════════════════════════════════════
//  Recently Added — renderer-side state for Bandcamp library arrivals
//
//  When the main-process download-router imports a Bandcamp purchase,
//  it emits bandcamp:track-imported with the track record. This module:
//    1. Holds the imported track IDs in a Set with a 10s expiration
//    2. Aggregates rapid bursts (album .zip imports fire many events
//       within ~1s) into a single toast notification window
//    3. Notifies subscribers (SongsView, Toast component) on changes
//
//  Singleton on purpose — there's only one library view at a time, only
//  one user, and useSyncExternalStore wants a stable external source.
// ════════════════════════════════════════════════════════════════════════

const MARKER_TTL_MS = 10_000
const TOAST_TTL_MS = 4_000
const AGGREGATION_WINDOW_MS = 2_000

export interface ImportedTrack {
  id?: number
  title?: string
  artist?: string
  album?: string
}

export type ToastKind =
  | { kind: 'success'; message: string }
  | { kind: 'failure'; filename: string; error: string }

interface State {
  /** Track IDs currently marked as recently added (decays per-id at MARKER_TTL_MS). */
  recent: Set<number>
  /** Latest toast to display, or null if none. Replaced (not queued) on new events. */
  toast: ToastKind | null
}

let state: State = { recent: new Set(), toast: null }
let version = 0
const listeners = new Set<() => void>()

// Aggregation buffer: collects ImportedTrack events arriving within the
// 2s window so we can emit one summary toast for an album-zip purchase
// instead of N back-to-back single-track toasts.
let aggregateBuffer: ImportedTrack[] = []
let aggregateTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
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

export function isRecentlyAdded(id: number): boolean {
  return state.recent.has(id)
}

export function getToast(): ToastKind | null {
  return state.toast
}

export function dismissToast(): void {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
  if (state.toast !== null) {
    state = { ...state, toast: null }
    notify()
  }
}

function showToast(toast: ToastKind): void {
  if (toastTimer) clearTimeout(toastTimer)
  state = { ...state, toast }
  notify()
  toastTimer = setTimeout(() => {
    state = { ...state, toast: null }
    toastTimer = null
    notify()
  }, TOAST_TTL_MS)
}

function flushAggregate(): void {
  const batch = aggregateBuffer
  aggregateBuffer = []
  aggregateTimer = null
  if (batch.length === 0) return

  if (batch.length === 1) {
    const t = batch[0]
    const label = t.title ? `'${t.title}'` : 'track'
    showToast({ kind: 'success', message: `Added ${label} to your library` })
  } else {
    // Most-common album in the batch wins the headline. Real-world album
    // zips have all the same album, so this is almost always trivially
    // unambiguous; the modal collapse is for the edge case of two purchases
    // landing inside the same aggregation window.
    const albumCounts = new Map<string, number>()
    for (const t of batch) {
      const a = (t.album || '').trim()
      if (a) albumCounts.set(a, (albumCounts.get(a) || 0) + 1)
    }
    let topAlbum = ''
    let topCount = 0
    for (const [a, c] of albumCounts) if (c > topCount) { topAlbum = a; topCount = c }
    const label = topAlbum ? `'${topAlbum}'` : 'your purchase'
    showToast({ kind: 'success', message: `Added ${batch.length} tracks from ${label} to your library` })
  }
}

function onTrackImported(track: ImportedTrack): void {
  // Marker — only if we have a real track id.
  if (typeof track.id === 'number') {
    const next = new Set(state.recent)
    next.add(track.id)
    state = { ...state, recent: next }
    notify()
    const expiringId = track.id
    setTimeout(() => {
      if (state.recent.has(expiringId)) {
        const next = new Set(state.recent)
        next.delete(expiringId)
        state = { ...state, recent: next }
        notify()
      }
    }, MARKER_TTL_MS)
  }

  // Toast — collect, debounce-flush at 2s of silence.
  aggregateBuffer.push(track)
  if (aggregateTimer) clearTimeout(aggregateTimer)
  aggregateTimer = setTimeout(flushAggregate, AGGREGATION_WINDOW_MS)
}

function onImportFailed(reason: { filename: string; error: string }): void {
  // Failures bypass aggregation — the user needs to know immediately.
  showToast({ kind: 'failure', filename: reason.filename, error: reason.error })
}

let wired = false

/** Call once at app startup to subscribe to the main-process events.
 *  Idempotent: repeat calls are no-ops. */
export function initRecentlyAdded(): void {
  if (wired) return
  wired = true
  // Wrap in try/catch so a single malformed payload in a long burst
  // (4.5.0: 20-track squid Drake-Views import SIGTRAP'd the renderer
  // mid-stream) can't tear down the whole UI.
  window.electronAPI.onBandcampTrackImported((t) => {
    try { onTrackImported(t) } catch (err) {
      console.error('[recentlyAdded:track] crash-guard:', err, t)
    }
  })
  window.electronAPI.onBandcampImportFailed((r) => {
    try { onImportFailed(r) } catch (err) {
      console.error('[recentlyAdded:failed] crash-guard:', err, r)
    }
  })
}
