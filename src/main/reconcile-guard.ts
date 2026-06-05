/**
 * Reconciliation safety guard — the gate that decides whether it is SAFE to
 * remove "dead" (file-missing) tracks from library.json.
 *
 * Why this exists (the workmini incident):
 * When JakeTunes was deployed to a second Mac, a reconcile pass dropped the
 * library from 7,447 → 7,182 tracks — 265 entries silently deleted because
 * their audio files weren't found at the resolved music root, even though the
 * files existed on disk (8,542 audio files total, just not all under the one
 * root the app happened to resolve to). The per-track "file missing?" check is
 * identity-based (exact path + audioFingerprint), which is correct — but a
 * WRONG or INCOMPLETE music root makes that check fail uniformly, turning an
 * identity check into a mass silent deletion.
 *
 * This module is the environmental sanity net layered ON TOP of the identity
 * check. It refuses to auto-remove when the "missing" signal is unreliable:
 *   - no music root present at all (drive/NAS unmounted)
 *   - the root is present but empty (mounted mid-sync, or pointed at the wrong
 *     place)
 *   - the root holds far fewer audio files than the library expects (an
 *     incomplete mirror — the workmini shape)
 *   - the removal would be catastrophic in proportion (>50% of the library)
 *   - the removal exceeds a conservative one-shot cap (a flood of "dead"
 *     tracks is the signature of an environment fault, not routine cleanup)
 *
 * Honors the project rule: destructive operations must gate on stable
 * identity OR explicit per-item confirmation, and must never fire en masse off
 * an unreliable/fuzzy signal. The caller still does the identity check; this
 * decides whether that signal can be TRUSTED right now.
 *
 * ⚠️ TWIN: scripts/remove-dead-tracks.mjs — the CLI dead-track remover applies
 * the same guard inline (it can't import this .ts). Keep the thresholds and
 * reasons in lockstep; change both in the same commit.
 */

/** A library with more dead tracks than this in one pass is almost certainly
 *  hitting an environment fault (wrong/incomplete root), not legitimate
 *  cleanup. A healthy library accrues dead entries a few at a time. Above the
 *  cap we refuse the one-shot auto-remove and tell the user to verify their
 *  music location (or use the CLI, which writes a backup). */
export const MAX_SAFE_ONE_SHOT_REMOVAL = 100

/** If the resolved root(s) hold fewer than this fraction of the files the
 *  library expects, the mirror is incomplete and "missing" is unreliable. */
export const MIN_ROOT_COMPLETENESS = 0.5

/** A removal that wipes more than this fraction of the library is catastrophic
 *  regardless of absolute count (mirrors save-library's shrink circuit-breaker). */
export const MAX_REMOVAL_FRACTION = 0.5

export type DeadTrackRemovalReason =
  | 'ok'
  | 'nothing-to-remove'
  | 'no-music-root'
  | 'music-root-empty'
  | 'music-root-incomplete'
  | 'catastrophic-fraction'
  | 'over-cap'

export interface DeadTrackRemovalInput {
  /** Total tracks currently in library.json. */
  totalTracks: number
  /** Tracks the identity check flagged as file-missing across ALL mounts. */
  deadCount: number
  /** How many candidate music roots existed and were actually scanned. */
  mountsChecked: number
  /** Total audio files found on disk across those scanned roots. */
  diskAudioCount: number
}

export interface DeadTrackRemovalAssessment {
  safe: boolean
  reason: DeadTrackRemovalReason
  message: string
}

/**
 * Decide whether the caller may proceed to remove `deadCount` tracks. Pure and
 * deterministic so it can be unit-tested without touching the filesystem.
 */
export function assessDeadTrackRemoval(input: DeadTrackRemovalInput): DeadTrackRemovalAssessment {
  const { totalTracks, deadCount, mountsChecked, diskAudioCount } = input

  if (deadCount <= 0) {
    return { safe: true, reason: 'nothing-to-remove', message: 'No dead tracks to remove.' }
  }

  if (mountsChecked <= 0) {
    return {
      safe: false,
      reason: 'no-music-root',
      message:
        'Music library folder not found — the drive or NAS holding your music ' +
        'may be disconnected. No tracks were removed. Reconnect it and try again.',
    }
  }

  if (diskAudioCount <= 0) {
    return {
      safe: false,
      reason: 'music-root-empty',
      message:
        'The music library folder is present but contains no audio files yet ' +
        '(it may still be syncing, or points to the wrong location). No tracks ' +
        'were removed.',
    }
  }

  // Incomplete mirror: the root holds far fewer files than the library expects.
  // This is the workmini shape — a partial copy makes "missing" untrustworthy.
  if (totalTracks > 0 && diskAudioCount < totalTracks * MIN_ROOT_COMPLETENESS) {
    return {
      safe: false,
      reason: 'music-root-incomplete',
      message:
        `Only ${diskAudioCount} audio files found on disk for a library of ` +
        `${totalTracks} tracks — the music mirror looks incomplete. Refusing to ` +
        'remove tracks until the full library is present. No tracks were removed.',
    }
  }

  if (totalTracks > 0 && deadCount > totalTracks * MAX_REMOVAL_FRACTION) {
    return {
      safe: false,
      reason: 'catastrophic-fraction',
      message:
        `Removal would drop ${deadCount} of ${totalTracks} tracks (over half the ` +
        'library). This is never routine cleanup — refusing. No tracks were removed.',
    }
  }

  if (deadCount > MAX_SAFE_ONE_SHOT_REMOVAL) {
    return {
      safe: false,
      reason: 'over-cap',
      message:
        `${deadCount} tracks look dead — that is more than a safe one-time cleanup ` +
        `(cap ${MAX_SAFE_ONE_SHOT_REMOVAL}) and usually means a drive/mirror is ` +
        'incomplete or the wrong music folder is selected. No tracks were removed. ' +
        'Verify your music location, or run scripts/remove-dead-tracks.mjs --commit ' +
        '(it writes a backup first).',
    }
  }

  return { safe: true, reason: 'ok', message: `Safe to remove ${deadCount} dead track(s).` }
}
