/**
 * Tiny pub/sub store for "background activity" — things the iTunes-style
 * LCD pill at the top should surface when nothing is playing: CD rip
 * progress and iPod sync progress.
 *
 * Stored at module scope so every view can read/write without threading
 * state through props or adding another React context. `subscribe` +
 * `getSnapshot` are shaped to work with `useSyncExternalStore`.
 */

export interface RipActivity {
  active: boolean          // true while mid-rip; flips false when done/cancelled/errored
  current: number          // tracks completed so far
  total: number            // total tracks being ripped
  trackTitle: string       // most recent track title (the one being ripped or just finished)
  errors: number           // count of tracks that failed during this rip
}

export interface SyncActivity {
  active: boolean          // true during an iPod sync
  step: string             // human-readable current step, e.g. "Copying 12 new tracks to iPod..."
}

// 4.4.12: lightweight transient notice for surfacing failures the user
// would otherwise miss. Used (so far) for set-custom-artwork failures —
// when sips conversion errors out, the IPC returns ok:false and the
// renderer's `if (result.ok)` gate correctly skips ADD_ARTWORK, but
// the user already saw the art in the Get Info modal (localArtHash)
// and assumes it stuck. setNotice surfaces a short LCD-pill message
// so they know it failed and can retry.
export interface NoticeActivity {
  message: string
  kind: 'error' | 'info'
}

let rip: RipActivity | null = null
let sync: SyncActivity | null = null
let notice: NoticeActivity | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null

// Bumped on every mutation. `getSnapshot` returns this number, which
// is cheap to compare by reference in React's external-store check.
// The actual fields are read via separate getters.
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

export function getRip(): RipActivity | null { return rip }
export function getSync(): SyncActivity | null { return sync }
export function getNotice(): NoticeActivity | null { return notice }

export function setRip(next: RipActivity | null): void {
  rip = next
  notify()
}

export function setSync(next: SyncActivity | null): void {
  sync = next
  notify()
}

// 4.4.12: push a transient notice. Auto-clears after `durationMs`
// (default 4 sec). Calling again before the timer fires replaces the
// message and restarts the timer. Pass null to clear immediately.
export function setNotice(message: string | null, opts?: { kind?: 'error' | 'info'; durationMs?: number }): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  if (message === null || message === '') {
    notice = null
    notify()
    return
  }
  const kind = opts?.kind || 'info'
  const durationMs = opts?.durationMs ?? 4000
  notice = { message, kind }
  notify()
  noticeTimer = setTimeout(() => {
    notice = null
    noticeTimer = null
    notify()
  }, durationMs)
}
