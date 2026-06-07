/**
 * 4.5.0-118 — pure save-library data-safety decisions, extracted from the
 * IPC handler so they're unit-tested (__tests__/save-guards.test.ts) and
 * single-sourced. These are the guards that ended the 2026-05-29 data-loss
 * incident: never silently persist an empty or catastrophically-shrunk
 * library, and never mass-delete audio on one ambiguous save.
 *
 * Pure (no Electron / fs) so `node --test` can drive them directly.
 */

/** Fraction of the previous track count below which a non-forced save is
 *  refused outright (a >50% drop is never a legit non-forced action). */
export const SHRINK_FLOOR = 0.5

/** Max audio files a single non-forced save will unlink. Beyond this the files
 *  are kept on disk as recoverable orphans rather than permanently deleted. */
export const UNLINK_CAP = 50

export type SaveRefusal = {
  error: 'refused-empty-overwrite' | 'refused-suspicious-shrink'
  prevCount: number
  newCount: number
}

/**
 * Decide whether to REFUSE a save. Returns the refusal (error code matches the
 * IPC contract) or null to proceed. `force` is the explicit-recovery escape
 * hatch; a genuine first save (prevCount <= 0) is always allowed.
 */
export function shouldRefuseSave(prevCount: number, newCount: number, force?: boolean): SaveRefusal | null {
  if (force || prevCount <= 0) return null
  if (newCount === 0) return { error: 'refused-empty-overwrite', prevCount, newCount }
  if (newCount < prevCount * SHRINK_FLOOR) return { error: 'refused-suspicious-shrink', prevCount, newCount }
  return null
}

/**
 * Whether a save that removed `deletedCount` paths may unlink the underlying
 * audio. Beyond UNLINK_CAP (and not forced) the files are preserved as orphans.
 */
export function mayUnlinkDeletions(deletedCount: number, force?: boolean): boolean {
  return force === true || deletedCount <= UNLINK_CAP
}
