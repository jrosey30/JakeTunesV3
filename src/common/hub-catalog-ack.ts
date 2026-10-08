/**
 * When a replica may tell the hub poller "I have this version."
 *
 * The poller (src/main/hub-catalog.ts) will not resend a version once it
 * is acked. The renderer's library save is debounced, and main can refuse
 * it (save locked, catastrophic shrink, external-write conflict). Acking
 * at merge time — before that save lands — drops the delta forever: the
 * next poll asks `since=<version>` and the hub answers unchanged.
 *
 * Ack only for a version whose tracks were actually written. A refused
 * or failed save leaves the cursor where it was so the next poll retries.
 */

export type HubAdoptDecision = 'ack-now' | 'save-then-ack' | 'hold'

export function hubAdoptAfterMerge(opts: {
  changed: boolean
  ignoredReason?: string
  /** A previous merge was applied in memory and its save has not succeeded. */
  hasUnpersistedMerge: boolean
}): HubAdoptDecision {
  // Empty / truncated full snapshots are not decisions. Hold the cursor
  // so the next poll tries again. A mass-removal guard IS a decision:
  // those removals are withheld on purpose (torn delta), and there is
  // nothing new to save unless the upserts themselves changed.
  const withheld =
    !!opts.ignoredReason &&
    !opts.ignoredReason.startsWith('mass-removal-guard') &&
    !opts.changed
  if (withheld) return 'hold'
  if (opts.changed || opts.hasUnpersistedMerge) return 'save-then-ack'
  return 'ack-now'
}

export function trackIdKey(ids: Array<string | number>): string {
  return ids.map(String).join('\0')
}

/**
 * Version to ack after a save attempt, or null to leave the cursor.
 * A later successful save of a DIFFERENT id set (the refusal path reloads
 * the pre-adoption library and that write succeeds) must not ack.
 */
export function ackVersionAfterSave(opts: {
  ok: boolean
  savedIdKey: string
  launched: { version: string; idKey: string } | null
  current: { version: string; idKey: string } | null
}): string | null {
  if (!opts.ok || !opts.launched || !opts.current) return null
  if (opts.current.version !== opts.launched.version) return null
  if (opts.savedIdKey !== opts.launched.idKey) return null
  return opts.launched.version
}
