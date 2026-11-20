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
    version++
    for (const f of subs) { try { f() } catch { /* a row must not stop the others */ } }
  })
}
