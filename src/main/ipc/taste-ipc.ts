/**
 * Taste IPC: the append-only verdict ledger + learned per-playlist
 * weights (scripts/taste-ledger-learn.py is the nightly reader/writer).
 * Extracted from main/index.ts (6.0 Phase 1) — bodies verbatim.
 */
import { app } from 'electron'
import { join } from 'path'
import { appendFile, readFile, stat } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error'

// ── Taste ledger (2026-08-07, "ok go go go") ─────────────────────────
// One append-only stream of every silent verdict Jake gives: strip
// suggestions added vs refreshed past, Discover +Lists vs vetoes, Music
// Man playlists kept vs deleted, review-gate adds/removes. The nightly
// learner (scripts/taste-ledger-learn.py) turns it into per-playlist
// blend weights; the KPI snapshot turns it into the acceptance rate.
// Desktop main is the single writer.
export const TASTE_LEDGER_PATH = () => join(app.getPath('userData'), 'taste-ledger.jsonl')
export const TASTE_WEIGHTS_PATH = () => join(app.getPath('userData'), 'taste-weights.json')
type TasteEvent = {
  surface: 'strip' | 'discover' | 'mm-playlist' | 'review-gate'
  verdict: 'accept' | 'reject' | 'pass'
  key?: Record<string, unknown>
  ctx?: Record<string, unknown>
}
export function registerTasteIpc(ipc: IpcRegistrar): void {
  ipc.handle('taste-ledger-append', async (_e, events: TasteEvent[]) => {
    try {
      if (!Array.isArray(events) || events.length === 0) return { ok: true, appended: 0 }
      const lines = events
        .filter((ev) => ev && typeof ev === 'object' && ev.surface && ev.verdict)
        .slice(0, 50)
        .map((ev) => JSON.stringify({ ts: new Date().toISOString(), surface: ev.surface, verdict: ev.verdict, key: ev.key ?? {}, ctx: ev.ctx ?? {} }))
      if (lines.length === 0) return { ok: true, appended: 0 }
      await appendFile(TASTE_LEDGER_PATH(), lines.join('\n') + '\n', 'utf-8')
      return { ok: true, appended: lines.length }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })
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
