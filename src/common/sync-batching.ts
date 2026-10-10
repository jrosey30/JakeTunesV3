/**
 * When does the next laptop → homemini sync run? (2026-10-10)
 *
 * Every library save on the laptop (a play count, a star, a rating, a
 * playlist add) used to fire its own quick sync after a 5 s debounce, so
 * anything spaced more than 5 s apart synced separately: 267 syncs on
 * 2026-10-10, peaking at 99 in one hour. Replaying that day's real
 * triggers, a fixed 5-minute batch window leaves 34 (peak 9/h).
 *
 * Two kinds of trigger:
 *   - URGENT ('import', 'artwork', 'manual', 'nas-recovery', 'safety-net'):
 *     new music, new covers, a sync Jake asked for. 5 s trailing debounce,
 *     as before — an album of 12 imports is still one sync — and it carries
 *     any batched change along with it.
 *   - BATCHED ('metadata-edit', 'playlist', 'startup'): routine state. The
 *     first one opens a 5-minute window; everything inside rides along. The
 *     window never slides, so a steady stream of edits still syncs every
 *     5 minutes instead of waiting for quiet.
 *
 * Pure (no electron, no timers) so the policy is tested directly;
 * src/main/sync-orchestrator.ts owns the clock and the single-flight gate.
 */

export const SYNC_URGENT_DELAY_MS = 5_000
export const SYNC_BATCH_WINDOW_MS = 300_000

const BATCHED: ReadonlySet<string> = new Set(['metadata-edit', 'playlist', 'startup'])

export function syncUrgency(reason: string): 'urgent' | 'batched' {
  return BATCHED.has(reason) ? 'batched' : 'urgent'
}

/** The epoch-ms moment the pending sync should run after `reason` arrives.
 *  `currentDueAt` is the pending sync's moment, or null if none is pending. */
export function nextDueAt(currentDueAt: number | null, reason: string, now: number): number {
  if (syncUrgency(reason) === 'urgent') return now + SYNC_URGENT_DELAY_MS
  return currentDueAt ?? now + SYNC_BATCH_WINDOW_MS
}

/** The reason the pending sync runs under. A routine change never replaces a
 *  pending urgent one (a pending 'safety-net' full pass must not be quietly
 *  turned into a quick pass by a play count landing inside its 5 s). */
export function mergePendingReason<R extends string>(pending: R | null, incoming: R): R {
  if (pending !== null && syncUrgency(incoming) === 'batched' && syncUrgency(pending) === 'urgent') return pending
  return incoming
}

/** A run just finished and another sync is pending: keep its moment, but
 *  never closer than the urgent delay (a moment that passed mid-run). */
export function dueAfterRun(dueAt: number | null, now: number): number {
  return Math.max(dueAt ?? 0, now + SYNC_URGENT_DELAY_MS)
}
