/**
 * Taste IPC: the append-only verdict ledger + learned per-playlist
 * weights (scripts/taste-ledger-learn.py is the nightly reader/writer).
 * Extracted from main/index.ts (6.0 Phase 1) — bodies verbatim.
 */
import { app } from 'electron'
import { suppressListeningWrites } from '../dev-review.ts'
import { join } from 'path'
import { appendFile, readFile, stat } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error'
import { stripMemoryFor, negativeExamples, type LedgerRowLike } from '../../common/strip-memory.ts'
import { makeImpressionDedupe } from '../impression-dedupe.ts'
import { currentTasteState, isUsable } from '../taste-state.ts'
import { currentTop1000Scores, isTop1000Usable } from '../top1000-scores.ts'
import { elsewhereLedgerRows } from '../taste-elsewhere.ts'
import { unionLedgerRows } from '../../common/taste-shared.ts'
import { triggerSync } from '../sync-orchestrator'

// ── Taste ledger (2026-08-07, "ok go go go") ─────────────────────────
// One append-only stream of every silent verdict Jake gives: strip
// suggestions added vs refreshed past, Discover +Lists vs vetoes, Music
// Man playlists kept vs deleted, review-gate adds/removes. The nightly
// learner (scripts/taste-ledger-learn.py) turns it into per-playlist
// blend weights; the KPI snapshot turns it into the acceptance rate.
// Desktop main is the single writer.
export const TASTE_LEDGER_PATH = () => join(app.getPath('userData'), 'taste-ledger.jsonl')
export const TASTE_WEIGHTS_PATH = () => join(app.getPath('userData'), 'taste-weights.json')
// Verdicts (2026-10-19, taste-engine repairs): 'shown' is an impression
// (the strip's batch, a Discovery card that was really on screen), 'refresh'
// is ↻ pressed while a suggestion was showing, 'reject' is an explicit ✕.
// 'pass' is the pre-10/19 spelling of 'refresh' — kept readable, no longer
// written. "Ignored" (shown, nothing done) and "skipped" (shown beside a pick
// that was taken) are derived from these by the learner, never logged.
const SURFACES = new Set(['strip', 'discover', 'mm-playlist', 'review-gate'])
const VERDICTS = new Set(['accept', 'reject', 'pass', 'refresh', 'shown'])
type TasteEvent = {
  surface: 'strip' | 'discover' | 'mm-playlist' | 'review-gate'
  verdict: 'accept' | 'reject' | 'pass' | 'refresh' | 'shown'
  key?: Record<string, unknown>
  ctx?: Record<string, unknown>
}
const isDuplicateImpression = makeImpressionDedupe()

// Strip rows parsed from the ledger, cached by file size+mtime (the ledger is
// append-only; a few MB at most).
let stripRowsCache: { size: number; mtime: number; rows: LedgerRowLike[] } | null = null
async function localStripRows(): Promise<LedgerRowLike[]> {
  const st = await stat(TASTE_LEDGER_PATH()).catch(() => null)
  if (!st) return []
  if (stripRowsCache && stripRowsCache.size === st.size && stripRowsCache.mtime === st.mtimeMs) return stripRowsCache.rows
  const rows: LedgerRowLike[] = []
  for (const line of (await readFile(TASTE_LEDGER_PATH(), 'utf-8')).split('\n')) {
    if (!line.includes('"strip"')) continue
    try { rows.push(JSON.parse(line) as LedgerRowLike) } catch { /* a torn last line is skipped, not fatal */ }
  }
  stripRowsCache = { size: st.size, mtime: st.mtimeMs, rows }
  return rows
}
// Both Macs (2026-10-20): this Mac's strip rows plus the other Mac's, from
// the copy the sync script pulls (src/main/taste-elsewhere.ts) — a ✕ or two
// refreshes on either Mac hide the song on both. Memoized on the cached
// arrays, so an unchanged pair costs nothing.
let unionMemo: { local: LedgerRowLike[]; elsewhere: LedgerRowLike[][]; rows: LedgerRowLike[] } | null = null
async function stripRows(): Promise<LedgerRowLike[]> {
  const local = await localStripRows()
  const elsewhere = (await elsewhereLedgerRows(app.getPath('userData'))) as LedgerRowLike[][]
  if (unionMemo && unionMemo.local === local && unionMemo.elsewhere.length === elsewhere.length && unionMemo.elsewhere.every((a, i) => a === elsewhere[i])) return unionMemo.rows
  const rows = unionLedgerRows(local, elsewhere.map((a) => a.filter((r) => r.surface === 'strip')))
  unionMemo = { local, elsewhere, rows }
  return rows
}
export function registerTasteIpc(ipc: IpcRegistrar): void {
  ipc.handle('taste-ledger-append', async (_e, events: TasteEvent[]) => {
    if (suppressListeningWrites()) return { ok: true, appended: 0, suppressed: 'dev-review' }
    try {
      if (!Array.isArray(events) || events.length === 0) return { ok: true, appended: 0 }
      const now = new Date().toISOString()
      const lines = events
        .filter((ev) => ev && typeof ev === 'object' && SURFACES.has(ev.surface) && VERDICTS.has(ev.verdict))
        .slice(0, 50)
        .filter((ev) => !isDuplicateImpression(ev, now))
        .map((ev) => JSON.stringify({ ts: now, surface: ev.surface, verdict: ev.verdict, key: ev.key ?? {}, ctx: ev.ctx ?? {} }))
      if (lines.length === 0) return { ok: true, appended: 0 }
      await appendFile(TASTE_LEDGER_PATH(), lines.join('\n') + '\n', 'utf-8')
      // A real verdict (not an impression) heads for the other Mac on the
      // next batched sync, instead of waiting for an unrelated library save.
      if (lines.some((l) => !l.includes('"verdict":"shown"'))) triggerSync('taste')
      return { ok: true, appended: lines.length }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })
  // What the strip remembers for one playlist (src/common/strip-memory.ts):
  // the songs to keep off it, and the explicit "didn't belong" examples the
  // brain uses as negatives. The renderer passes the current members.
  ipc.handle('strip-memory', async (_e, playlistId: string, memberIds: number[]) => {
    try {
      if (typeof playlistId !== 'string' || !playlistId) return { ok: false, hidden: [], negatives: [] }
      const members = new Set((Array.isArray(memberIds) ? memberIds : []).map(Number))
      const memory = stripMemoryFor(await stripRows(), playlistId, members, Date.now())
      return { ok: true, hidden: [...memory.keys()], negatives: negativeExamples(memory) }
    } catch (err) {
      return { ok: false, hidden: [], negatives: [], error: safeIpcError(err, 'unknown') }
    }
  }, { public: true })
  // The nightly taste engine's learned ranking (src/main/taste-state.ts):
  // each song's taste PERCENTILE, served only while the engine's ranking is
  // promoted and fresh — otherwise usable:false and the strip keeps its own
  // stars/plays term (the rollback path).
  ipc.handle('get-taste-state', async () => {
    const s = currentTasteState()
    if (!isUsable(s, Date.now()) || !s) return { ok: true, usable: false, why: s?.why ?? 'no taste state yet' }
    const pct: Record<string, number> = {}
    for (const [id, row] of s.tracks) pct[id] = row[1]
    return { ok: true, usable: true, builtAt: new Date(s.builtAtMs).toISOString(), why: s.why, pct }
  }, { public: true })
  // The Top 1000 Quiz's standings (src/main/top1000-scores.ts): each song's place by his
  // own verdicts plus the brain's belief, 1 = the song he loves most. Leads the strip's
  // taste term when usable; usable:false → the taste engine / stars decide as before.
  ipc.handle('get-top1000-scores', async () => {
    const s = currentTop1000Scores()
    if (!isTop1000Usable(s, Date.now()) || !s) return { ok: true, usable: false }
    const pct: Record<string, number> = {}
    for (const [id, row] of s.tracks) pct[id] = row[0]
    return { ok: true, usable: true, builtAt: new Date(s.builtAtMs).toISOString(), answered: s.answered, pct }
  }, { public: true })
  // Per-playlist blend weights the nightly learner writes; the suggestion
  // strip multiplies its blend components by these. mtime-cached.
  let tasteWeightsCache: { at: number; mtime: number; weights: Record<string, unknown> } | null = null
  ipc.handle('get-taste-weights', async () => {
    try {
      const p = TASTE_WEIGHTS_PATH()
      const st = await stat(p).catch(() => null)
      if (!st) return { ok: true, weights: {} }
      if (tasteWeightsCache && tasteWeightsCache.mtime === st.mtimeMs) {
        return { ok: true, weights: tasteWeightsCache.weights }
      }
      const weights = JSON.parse(await readFile(p, 'utf-8')) as Record<string, unknown>
      tasteWeightsCache = { at: Date.now(), mtime: st.mtimeMs, weights }
      return { ok: true, weights }
    } catch {
      return { ok: true, weights: {} }
    }
  }, { public: true })
}
