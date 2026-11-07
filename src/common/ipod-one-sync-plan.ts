/**
 * One button per iPod (2026-11-07) — the plan's shape and the Device page's
 * words for it. main/ipod-one-sync.ts decides the plan; the Device page shows
 * it with these lines. Pure — node --test loads it.
 */

export type OneSyncKind = 'original' | 'list'

export interface OneSyncLeftOff { id: number; title: string; artist: string; why: string }

export type OneSyncPlan =
  | {
      ok: true
      kind: OneSyncKind
      ipodName: string
      color: string | null
      /** The playlist name on the iPod. */
      setName: string
      /** What goes on, in order. Never more than 1,000. */
      trackIds: number[]
      /** What can't go on, each with a plain reason (list-only iPods only). */
      leftOff: OneSyncLeftOff[]
      /** One plain line when something is worth saying (homemini away, filler used). */
      note: string | null
    }
  | {
      ok: false
      kind: 'none' | 'unknown' | OneSyncKind
      ipodName: string | null
      color: string | null
      error: string
    }

const n = (v: number): string => v.toLocaleString('en-US')

/** "punkPod · 847 songs ready" */
export function readyLine(plan: Extract<OneSyncPlan, { ok: true }>): string {
  const count = plan.trackIds.length
  return `${plan.ipodName} · ${n(count)} ${count === 1 ? 'song' : 'songs'} ready`
}

/** "12 songs can’t go on" — null when every song can. */
export function leftOffLine(plan: Extract<OneSyncPlan, { ok: true }>): string | null {
  const c = plan.leftOff.length
  if (c === 0) return null
  return `${n(c)} ${c === 1 ? 'song can’t' : 'songs can’t'} go on`
}

/** "Sync punkPod" */
export function syncButtonLabel(ipodName: string | null): string {
  return ipodName ? `Sync ${ipodName}` : 'Sync'
}

/** "Last synced Nov 7, 1:15 PM" — "Not synced yet" with no record. */
export function lastSyncedLine(when: string | number | null | undefined): string {
  if (when == null || when === '') return 'Not synced yet'
  const d = new Date(when)
  if (Number.isNaN(d.getTime())) return 'Not synced yet'
  return `Last synced ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

/** The text the sync status carries into the progress strip; the strip reads
 *  its target from "<N> tracks" (DeviceView's setSyncStatus). */
export function syncingStep(setName: string, count: number): string {
  return `Syncing “${setName}” — ${n(count)} tracks…`
}
