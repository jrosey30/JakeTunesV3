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

let rip: RipActivity | null = null
let sync: SyncActivity | null = null

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

export function setRip(next: RipActivity | null): void {
  rip = next
  notify()
}

export function setSync(next: SyncActivity | null): void {
  sync = next
  notify()
}
