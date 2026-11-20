/**
 * The Record Shop's lossless dots, renderer side (Brief 256).
 *
 * A page (the search's results, an artist, an album) asks main ONE question
 * for all its rows: Qobuz's catalogue search on the page's own words. The
 * answer is kept here by those words (common/answer-cache.ts: 30 minutes, a
 * failed question left alone for a minute, two pages asking the same words
 * share one request), and each row is matched against it synchronously
 * (common/shop-lossless.ts losslessOf). No answer, or a row the answer doesn't
 * name, shows no dot: never a false "no".
 */
import { createAnswerCache } from '../../../common/answer-cache.ts'
import { losslessIndex, losslessScope, LOSSLESS_FAIL_QUIET_MS, LOSSLESS_MAX_SCOPES, LOSSLESS_TTL_MS, type LosslessIndex } from '../../../common/shop-lossless.ts'
import { planKey, planRowOfJob, resolvePlan, PLAN_FAIL_QUIET_MS, PLAN_MAX_ENTRIES, PLAN_ROWS_PER_ASK, PLAN_TTL_MS, type PlanRow, type QobuzPlan } from '../../../common/shop-qobuz-id.ts'

const cache = createAnswerCache<LosslessIndex>({ ttlMs: LOSSLESS_TTL_MS, failQuietMs: LOSSLESS_FAIL_QUIET_MS, maxEntries: LOSSLESS_MAX_SCOPES, now: () => Date.now() })
const subs = new Set<() => void>()
let version = 0

const keyOf = (words: string, limit: number): string => `${limit}|${losslessScope(words)}`

export function subscribeLossless(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
/** Changes whenever an answer lands (useSyncExternalStore's snapshot). */
export const losslessVersion = (): number => version

/** The page's answer, if one has landed and is still fresh. */
export function losslessFor(words: string, limit = 50): LosslessIndex | undefined {
  return words.trim().length >= 2 ? cache.get(keyOf(words, limit)) : undefined
}

/** Asks for a page's dots (once per words while the answer is fresh). */
export function askLossless(words: string, limit = 50): void {
  const w = words.trim()
  if (w.length < 2) return
  const k = keyOf(w, limit)
  if (cache.get(k) || cache.quiet(k)) return
  const api = typeof window !== 'undefined' ? window.electronAPI?.shopQobuzLossless : undefined
  if (!api) return
  void cache.ask(k, async () => {
    const r = await api(w, limit).catch(() => null)
    return r?.ok ? losslessIndex(r.hits) : null
  }).then((idx) => {
    if (!idx) return
    bump()
  })
}

// ── The store assumes it's on Qobuz (Brief 261) ───────────────────────────
// A row on screen is resolved to one Qobuz id: first against its page's own
// answer above (no question asked), then by main in the background (the row's
// words, a song's ISRC, an album's UPC: 'shop-qobuz-resolve'), in batches of
// at most 20, only for rows that were drawn. A plan lets Save go by id
// (downloadQueue.ts); no plan shows nothing and Save walks as before.
const plans = createAnswerCache<{ plan: QobuzPlan | null }>({ ttlMs: PLAN_TTL_MS, failQuietMs: PLAN_FAIL_QUIET_MS, maxEntries: PLAN_MAX_ENTRIES, now: () => Date.now() })
const waiting = new Map<string, PlanRow>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const bump = (): void => {
  version++
  for (const f of subs) { try { f() } catch { /* a row must not stop the others */ } }
}

function flushPlans(): void {
  flushTimer = null
  const api = typeof window !== 'undefined' ? window.electronAPI?.shopQobuzResolve : undefined
  if (!api) { waiting.clear(); return }
  const batch = [...waiting.entries()].slice(0, PLAN_ROWS_PER_ASK)
  for (const [key] of batch) waiting.delete(key)
  const call = Promise.resolve(api(batch.map(([, row]) => row))).catch(() => null)
  for (const [key] of batch) {
    void plans.ask(key, async () => {
      const r = await call
      const p = r?.ok ? r.plans[key] : undefined
      return p === undefined ? null : { plan: p }
    }).then((got) => { if (got?.plan) bump() })
  }
  if (waiting.size) flushTimer = setTimeout(flushPlans, 400)
}

/**
 * The plan for a row on screen, or null for now. Called while drawing the
 * row: the page's own answer is read at once; a row it doesn't settle is
 * asked of main once (after the page's answer has landed, so the cheap way
 * always goes first) and the row is drawn again when a plan lands.
 */
export function notePlanRow(row: PlanRow | null, scopeWords?: string, limit = 50): QobuzPlan | null {
  if (!row) return null
  const key = planKey(row)
  const have = plans.get(key)
  if (have) return have.plan
  const idx = scopeWords ? losslessFor(scopeWords, limit) : undefined
  if (idx?.hits) {
    const p = resolvePlan(row, idx.hits)
    if (p) { plans.put(key, { plan: p }); return p }
  }
  if ((scopeWords && !idx) || plans.quiet(key) || waiting.has(key)) return null
  waiting.set(key, row)
  if (!flushTimer) flushTimer = setTimeout(flushPlans, 250)
  return null
}

/** The plan a queued job may download by (none yet: the walk, as before). */
export function planForJob(r: Parameters<typeof planRowOfJob>[0]): QobuzPlan | null {
  const row = planRowOfJob(r)
  return row ? plans.get(planKey(row))?.plan ?? null : null
}

/** Tests: a plan as if it had been resolved. */
export function putPlanForTests(row: PlanRow, plan: QobuzPlan | null): void {
  plans.put(planKey(row), { plan })
}
