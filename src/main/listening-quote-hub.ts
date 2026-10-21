/**
 * The phone's Listening Memory quote, read from homemini
 * (GET {MOBILE_BACKEND_URL}/api/listening-memory → `observation`).
 *
 * homemini computes that line over BOTH devices' plays, so reading it here
 * makes the desktop's Home say exactly what the phone's Home says
 * (common/listening-quote.ts has the rule and the local fallback).
 *
 *   • a fresh answer (≤ 10 min) is reused — the Home asks on every mount;
 *   • otherwise one GET (coalesced), but the Home never waits on it longer
 *     than `waitMs`: a slow homemini gets the last answer (≤ 1 day old) or
 *     "no answer", and the GET still lands for next time;
 *   • unreachable / not the document → the last answer while it is under a
 *     day old, else "no answer" (the caller then says the line from this
 *     Mac's own log, by the same rule).
 *
 * Read-only toward homemini (GET only); nothing is written anywhere. Pure of
 * electron — fetch and the clock are injected (__tests__/listening-quote.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import { hubListeningQuote } from '../common/listening-quote.ts'

export interface QuoteFetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type QuoteFetchLike = (url: string, init?: Record<string, unknown>) => Promise<QuoteFetchReply>

export const LISTENING_MEMORY_PATH = '/api/listening-memory'

export interface HubQuoteOptions {
  /** homemini backend origin, e.g. http://homemini:3000. */
  baseUrl: string
  fetchImpl?: QuoteFetchLike
  now?: () => number
  /** Reuse an answer this young without asking again. */
  freshMs?: number
  /** Keep showing the last answer this long while homemini is away. */
  keepMs?: number
  /** The longest the Home waits for a GET in flight. */
  waitMs?: number
  /** Abort the GET itself after this long. */
  timeoutMs?: number
}

export interface HubQuote {
  /** homemini's answer: `answered` false = no answer under a day old (use
   *  this Mac's own log); true = say `text` — null when the phone says
   *  nothing either (too few plays, nothing worth a line). */
  get(): Promise<{ answered: boolean; text: string | null }>
}

export function createHubListeningQuote(o: HubQuoteOptions): HubQuote {
  const fetchImpl: QuoteFetchLike = o.fetchImpl ?? (fetch as unknown as QuoteFetchLike)
  const now = o.now ?? Date.now
  const freshMs = o.freshMs ?? 10 * 60_000
  const keepMs = o.keepMs ?? 24 * 60 * 60_000
  const waitMs = o.waitMs ?? 1500
  const timeoutMs = o.timeoutMs ?? 6000
  const url = `${o.baseUrl.replace(/\/audio$/, '').replace(/\/+$/, '')}${LISTENING_MEMORY_PATH}`

  // The last real answer. `text` may be null: homemini said "nothing to say".
  let last: { text: string | null; at: number } | null = null
  let inFlight: Promise<void> | null = null

  const kept = (): { answered: boolean; text: string | null } =>
    (last && now() - last.at <= keepMs ? { answered: true, text: last.text } : { answered: false, text: null })

  function ask(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const r = await fetchImpl(url, withCompanionInit({ signal: ctrl.signal }) as Record<string, unknown> | undefined)
        if (!r.ok) return
        const body = await r.json()
        // Only the document counts as an answer; HTML from a proxy or a torn
        // body leaves the last answer standing.
        if (!body || typeof body !== 'object' || typeof (body as { totalLoggedPlays?: unknown }).totalLoggedPlays !== 'number') return
        last = { text: hubListeningQuote(body), at: now() }
      } catch {
        /* homemini away — the last answer (or the local line) stands */
      } finally {
        clearTimeout(timer)
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    async get() {
      if (last && now() - last.at <= freshMs) return { answered: true, text: last.text }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([ask(), new Promise<void>((res) => { timer = setTimeout(res, waitMs) })])
      if (timer) clearTimeout(timer)
      return kept()
    },
  }
}
