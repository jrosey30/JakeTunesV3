/**
 * Publish the sidebar's section order to homemini (2026-11-09). Jake: "cant you
 * group the playlists on mobile like i have on desktop?" The phone draws its
 * Playlists tab's sections (iPODS, the years, PLAYLISTS) in the order Jake
 * dragged them into here. The saved list stays per machine in ui-state.json
 * (common/sidebar-order.ts); only the hub (the MacBook, not a homemini playback
 * client like homemini's or workmini's app) sends it, so the phone follows the
 * MacBook's sidebar and nobody else's.
 *
 * PUT /api/sidebar-order { order } on homemini, companion header.
 * ⚠️ CONTRACT: JakeTunesMobile backend/src/routes/sidebarOrder.ts (the route),
 * ios/JakeTunesMobile/PlaylistGroups.swift (the reader, twin of orderSections).
 *
 * Sent on every save and once at launch (so homemini learns an order saved
 * before this existed). A send that fails is tried again later, newest order
 * only: a minute, then doubling, at most 30 minutes. Never throws; logs one
 * line per failure streak.
 *
 * Pure enough for node --test: fetch, timers, role and auth are injected.
 */
import { parseSavedOrder } from '../common/sidebar-order.ts'

export interface SidebarOrderPublishDeps {
  /** homemini's base, e.g. http://homemini:3000 (no trailing /audio). */
  baseUrl: string
  /** True on a homemini playback client (a replica): it never sends. */
  isReplica: () => Promise<boolean>
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>
  /** Adds the companion header (hub-companion.ts withCompanionInit). */
  withAuth?: (init: RequestInit) => RequestInit | undefined
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  warn?: (m: string) => void
  timeoutMs?: number
}

export type PublishOutcome = 'sent' | 'replica' | 'failed'

export const RETRY_FIRST_MS = 60_000
export const RETRY_MAX_MS = 30 * 60_000

export interface SidebarOrderPublisher {
  /** Send this order (the raw saved list; it is cleaned the way the sidebar reads it). */
  publish(raw: unknown): Promise<PublishOutcome>
  /** Stop any retry. */
  stop(): void
}

export function createSidebarOrderPublisher(deps: SidebarOrderPublishDeps): SidebarOrderPublisher {
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const warn = deps.warn ?? ((m) => console.warn(m))
  const url = `${deps.baseUrl.replace(/\/+$/, '')}/api/sidebar-order`
  let latest: string[] | null = null
  let timer: unknown = null
  let delay = RETRY_FIRST_MS
  let warned = false
  let seq = 0

  const cancelRetry = () => { if (timer !== null) { clearTimer(timer); timer = null } }

  async function send(order: string[], mine: number): Promise<PublishOutcome> {
    if (await deps.isReplica().catch(() => true)) return 'replica'
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    }
    let ok = false
    let why = ''
    try {
      const r = await doFetch(url, deps.withAuth?.(init) ?? init)
      ok = r.ok
      if (!ok) why = `HTTP ${r.status}`
    } catch (err) {
      why = err instanceof Error ? err.name : 'error'
    }
    if (mine !== seq) return ok ? 'sent' : 'failed' // a newer order took over; it owns the retry
    if (ok) {
      if (warned) console.log('[sidebar-order] homemini has the sidebar order again')
      warned = false
      delay = RETRY_FIRST_MS
      return 'sent'
    }
    if (!warned) warn(`[sidebar-order] homemini didn't take the sidebar order (${why}); trying again later`)
    warned = true
    cancelRetry()
    const wait = delay
    delay = Math.min(delay * 2, RETRY_MAX_MS)
    timer = setTimer(() => {
      timer = null
      if (latest) void send(latest, seq)
    }, wait)
    return 'failed'
  }

  return {
    publish(raw) {
      latest = parseSavedOrder(raw)
      cancelRetry()
      delay = RETRY_FIRST_MS
      seq += 1
      return send(latest, seq)
    },
    stop: cancelRetry,
  }
}
