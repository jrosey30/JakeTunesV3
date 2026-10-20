/**
 * A replica's stars into the shared star record (2026-10-20).
 *
 * The shared record is mobile-stars.json in homemini's state dir — the file
 * the phone reads and /api/phone-sidecars serves. The backend is its single
 * writer, so a replica does not copy its file there: it POSTs its whole star
 * state (format v2, every star and un-star with its time) to
 * /api/stars/merge, and the backend merges it last-writer-wins per song
 * (⚠️ TWIN: src/main/mobile-stars-merge.ts ↔ JakeTunesMobile
 * backend/src/util/starSidecar.ts). A merge can only add a newer event; a
 * stale or empty copy removes nothing. The way back is the phone-sidecar
 * mirror, which now merges into the local file instead of copying over it.
 *
 * Until 2026-10-20 nothing carried a workmini star anywhere, and the mirror
 * replaced workmini's file with homemini's whenever homemini's was newer —
 * the stars Jake set at work were wiped from it.
 *
 * Pushes after every star change (coalesced) and on every mirror tick until
 * one lands. Hub and 'off' Macs never push.
 *
 * Electron-free (injected fetch) — __tests__/star-hub-push.test.ts.
 */
import { withCompanionInit } from './hub-companion.ts'
import type { StarSidecarData } from './mobile-stars-merge.ts'

export const STARS_MERGE_PATH = '/api/stars/merge'

export interface StarHubPushOptions {
  baseUrl: string
  isReplica: () => Promise<boolean>
  state: () => Promise<StarSidecarData>
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>
  warn?: (key: string, msg: string) => void
  debounceMs?: number
  timeoutMs?: number
}

export interface StarHubPush {
  /** A star changed here — push soon. */
  changed(): void
  /** Push if something is owed (a change not yet landed, or nothing landed this session). */
  tick(): Promise<void>
  /** One push now; true when homemini took it. */
  pushNow(): Promise<boolean>
}

export function createStarHubPush(opts: StarHubPushOptions): StarHubPush {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as NonNullable<StarHubPushOptions['fetchImpl']>)
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${STARS_MERGE_PATH}`
  let owed = true          // nothing has landed this session yet
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<boolean> | null = null

  async function pushNow(): Promise<boolean> {
    if (!(await opts.isReplica())) return false
    if (inFlight) return inFlight
    inFlight = (async () => {
      owed = false
      try {
        const body = JSON.stringify(await opts.state())
        const res = await fetchImpl(url, withCompanionInit({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        }) as Record<string, unknown>)
        if (!res.ok) {
          owed = true
          warn('star-push-http', `[stars] homemini refused the star merge (${res.status}) — next tick retries`)
          return false
        }
        return true
      } catch (err) {
        owed = true
        warn('star-push-unreachable', `[stars] homemini unreachable for the star merge (${err instanceof Error ? err.message : String(err)}) — next tick retries`)
        return false
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    changed() {
      owed = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void pushNow() }, opts.debounceMs ?? 2000)
    },
    async tick() { if (owed) await pushNow() },
    pushNow,
  }
}
