/**
 * enrichment-ledger.mjs — Brief 177: the per-track enrichment ledger.
 *
 * WHY A SIDECAR (documented deviation from the brief's literal text): the
 * brief sketched the ledger as fields inside library.json, but library.json
 * has exactly ONE writer — the desktop app (Lens 2 / Brief 165 discipline).
 * Nightly jobs writing into it would recreate the multi-writer defect that
 * discipline exists to prevent. So the ledger lives in its own file,
 * `enrichment-ledger.json`, in the same state dir the jobs already use
 * (JT_STATE_DIR / the app-support dir), with the brief's exact intent:
 * queryable per-track attempted/done state so no job ever re-attempts
 * blindly and a known-dead file never leads every run again.
 *
 * Shape:
 *   { version: 1, tracks: { "<id>": {
 *       clapAttempted: bool, clapDone: bool,
 *       lyricsDone: bool, taxonomyDone: bool,
 *       clapAttemptedAt: ms|null, clapDoneAt: ms|null,
 *       lyricsAttemptedAt: ms|null, lyricsDoneAt: ms|null,
 *       taxonomyDoneAt: ms|null,
 *       lastError: string|null, lastJob: string|null, updatedAt: ms } } }
 *
 * Writers: scripts/audio-embed.py (CLAP — it carries a Python mirror of
 * this format), scripts/lyrics-fetch.mjs (lyrics outcomes), and
 * scripts/enrichment-catchup.mjs (refreshes lyrics/taxonomy done-state
 * from their source files). Every write is tmp + rename (atomic), and a
 * corrupt ledger is treated as empty rather than fatal — the source files
 * (audio-index.bin, lyrics.json, metadata-overrides.json) can always
 * re-derive the done-state; only attempt history is lost.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** A failed attempt is not retried until this long after it — mirrors
 *  lyrics-fetch.mjs's 30-day MISS_TTL_MS, the codebase's existing answer
 *  to "how long before a dead end is worth one more look". */
export const RETRY_TTL_MS = 30 * 24 * 3600 * 1000

export const LEDGER_FILE = 'enrichment-ledger.json'

export function ledgerPath(stateDir) { return join(stateDir, LEDGER_FILE) }

export function emptyLedger() { return { version: 1, tracks: {} } }

/** Load a ledger; missing/corrupt/shapeless → empty ledger (never throws). */
export function loadLedger(path) {
  try {
    if (!existsSync(path)) return emptyLedger()
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.tracks !== 'object' || raw.tracks === null) return emptyLedger()
    return { version: 1, tracks: raw.tracks }
  } catch { return emptyLedger() }
}

/** Atomic save (tmp + rename), matching every other state writer here. */
export function saveLedger(path, ledger) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger))
  renameSync(tmp, path)
}

export function entryFor(ledger, id) {
  const k = String(id)
  if (!ledger.tracks[k]) {
    ledger.tracks[k] = {
      clapAttempted: false, clapDone: false, lyricsDone: false, taxonomyDone: false,
      clapAttemptedAt: null, clapDoneAt: null, lyricsAttemptedAt: null, lyricsDoneAt: null,
      taxonomyDoneAt: null, lastError: null, lastJob: null, updatedAt: 0,
    }
  }
  return ledger.tracks[k]
}

export function markClapAttempted(ledger, id, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.clapAttempted = true; e.clapAttemptedAt = now; e.lastJob = 'clap'; e.updatedAt = now
  return e
}

export function markClapDone(ledger, id, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.clapAttempted = true; if (!e.clapAttemptedAt) e.clapAttemptedAt = now
  e.clapDone = true; e.clapDoneAt = now; e.lastError = null; e.lastJob = 'clap'; e.updatedAt = now
  return e
}

export function markClapFailed(ledger, id, error, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.clapAttempted = true; e.clapAttemptedAt = now
  e.lastError = String(error || 'unknown error').slice(0, 200); e.lastJob = 'clap'; e.updatedAt = now
  return e
}

export function markLyricsDone(ledger, id, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.lyricsDone = true; e.lyricsDoneAt = e.lyricsDoneAt || now; e.lastJob = 'lyrics'; e.updatedAt = now
  return e
}

export function markLyricsAttempted(ledger, id, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.lyricsAttemptedAt = now; e.lastJob = 'lyrics'; e.updatedAt = now
  return e
}

export function markTaxonomyDone(ledger, id, now = Date.now()) {
  const e = entryFor(ledger, id)
  e.taxonomyDone = true; e.taxonomyDoneAt = e.taxonomyDoneAt || now; e.updatedAt = now
  return e
}

/**
 * Should the CLAP job attempt this track now?
 *   - done → never.
 *   - never attempted → yes, first in line.
 *   - attempted, not done → only once the retry TTL has passed since the
 *     last attempt (a dead file stops leading every run).
 */
export function clapNeedsAttempt(entry, now = Date.now(), ttlMs = RETRY_TTL_MS) {
  if (!entry) return true
  if (entry.clapDone) return false
  if (!entry.clapAttempted || !entry.clapAttemptedAt) return true
  return (now - entry.clapAttemptedAt) > ttlMs
}

/** Partition CLAP candidates: fresh (never attempted or TTL-expired)
 *  first, recently-failed deferred to the back. Input: [{ id, entry }]. */
export function orderClapCandidates(candidates, now = Date.now(), ttlMs = RETRY_TTL_MS) {
  const fresh = [], deferred = []
  for (const c of candidates) {
    if (c.entry && c.entry.clapAttempted && !c.entry.clapDone && c.entry.clapAttemptedAt && (now - c.entry.clapAttemptedAt) <= ttlMs) deferred.push(c)
    else fresh.push(c)
  }
  return { ordered: [...fresh, ...deferred], freshCount: fresh.length, deferredCount: deferred.length }
}
