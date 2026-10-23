/**
 * Overlooked client (2026-10-22) — the desktop's half of
 * GET {MOBILE_BACKEND_URL}/api/overlooked (contract: common/overlooked-doc.ts).
 * One GET, remembered for MEMO_MS; when homemini is away the last good
 * document is still served (it rotates daily, so a stale one is honest enough
 * for a browse page) and with none the page says so. Read-only toward
 * homemini. Pure of electron — fetch and the clock are injected so it runs
 * under node:test (__tests__/overlooked-client.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import { parseOverlooked, type Overlooked } from '../common/overlooked-doc.ts'

export const OVERLOOKED_PATH = '/api/overlooked'
export const MEMO_MS = 5 * 60_000

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export interface OverlookedClientOptions {
  baseUrl: string
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  warn?: (msg: string) => void
}

export interface OverlookedState { doc: Overlooked | null; source: 'homemini' | 'memo' | 'none' }

export function createOverlookedClient(opts: OverlookedClientOptions): { get(force?: boolean): Promise<OverlookedState> } {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? 8000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${OVERLOOKED_PATH}`
  let last: { doc: Overlooked; at: number } | null = null
  let inflight: Promise<OverlookedState> | null = null

  async function load(): Promise<OverlookedState> {
    try {
      const res = await fetchImpl(url, withCompanionInit({ signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = parseOverlooked(await res.json())
      if (!doc) throw new Error('not an Overlooked document')
      last = { doc, at: now() }
      return { doc, source: 'homemini' }
    } catch (err) {
      warn(`[overlooked] fetch failed: ${(err as Error)?.message ?? err}`)
      return last ? { doc: last.doc, source: 'memo' } : { doc: null, source: 'none' }
    }
  }

  return {
    async get(force = false) {
      if (!force && last && now() - last.at < MEMO_MS) return { doc: last.doc, source: 'memo' }
      inflight ??= load().finally(() => { inflight = null })
      return inflight
    },
  }
}
