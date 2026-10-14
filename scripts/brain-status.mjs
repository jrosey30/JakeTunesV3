/**
 * brain-status.mjs — the ONE place that knows the shape of brain-status.json.
 *
 * Brief 176: before this module, the trainer wrote the status file from a
 * local helper that only its handled paths reached — a crash mid-run left
 * last night's `ok:true` on disk (the 2026-07-21 five-silent-nights failure
 * mode, in its crash form). Now every writer/reader of the status file goes
 * through here:
 *
 *   - scripts/brain-trainer.mjs  writes on EVERY exit path (success, handled
 *     failure via fatal(), and the top-level catch for crashes).
 *   - scripts/brain-watchdog.mjs reads + ages it and shouts when it's stale.
 *
 * The file itself: { ok, at (ISO), host, ...counts, error? } written next to
 * the brain (STATE_DIR) plus a local fallback copy, so the signal survives
 * the NAS being the thing that's broken. Writes are best-effort per path —
 * reporting must never break the run it reports on.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

/** A nightly job that hasn't reported in ~26 h has missed a night. */
export const STALE_AFTER_MS = 26 * 3600 * 1000

/** Build the status record for a payload (pure — exported for tests). */
export function makeStatus(payload, now = new Date()) {
  return { ...payload, at: now.toISOString(), host: hostname() }
}

/**
 * Write the status record to every path given (usually [STATE_DIR copy,
 * local fallback copy]). Returns the paths that succeeded.
 */
export function writeBrainStatus(paths, payload, now = new Date()) {
  const body = JSON.stringify(makeStatus(payload, now), null, 2)
  const written = []
  for (const p of new Set(paths)) {
    try { writeFileSync(p, body); written.push(p) } catch { /* best-effort per path */ }
  }
  return written
}

/** Read + parse a status file. Returns null when missing or unparseable. */
export function readBrainStatus(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return s && typeof s === 'object' && typeof s.at === 'string' ? s : null
  } catch { return null }
}

/** Age of a status record in ms, or null when its timestamp is unusable. */
export function statusAgeMs(status, nowMs = Date.now()) {
  if (!status || typeof status.at !== 'string') return null
  const at = Date.parse(status.at)
  if (!Number.isFinite(at)) return null
  return nowMs - at
}

/** Stale = no usable record, or older than the threshold. */
export function isStale(status, nowMs = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  const age = statusAgeMs(status, nowMs)
  return age === null || age > staleAfterMs
}
