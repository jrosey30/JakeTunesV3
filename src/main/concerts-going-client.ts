/**
 * Going / I went + "What they've been playing" against homemini (2026-10-29).
 * The shapes and rules are src/common/concerts-going.ts; this is the HTTP.
 * The answers live on homemini only (rsvps.json) — the desktop keeps no copy
 * of its own beyond what it last read, so the phone and both Macs agree.
 *
 * Pure of electron: fetch is injected (tests: __tests__/concerts-going.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import {
  parseLately, parseRsvps,
  type AttendedAnswer, type Lately, type RsvpEntry, type RsvpShow, type RsvpStatus,
} from '../common/concerts-going.ts'

export interface GoingReply { ok: boolean; status: number; json(): Promise<unknown> }
export type GoingFetch = (url: string, init?: Record<string, unknown>) => Promise<GoingReply>

export interface ConcertsGoingClient {
  rsvps(): Promise<RsvpEntry[] | null>
  setGoing(eventId: string, status: RsvpStatus | null, show?: RsvpShow | null): Promise<boolean>
  setAttended(eventId: string, answer: AttendedAnswer | null): Promise<boolean>
  lately(artist: string): Promise<Lately | null>
}

export function createConcertsGoingClient(opts: { baseUrl: string; fetchImpl?: GoingFetch; now?: () => number; timeoutMs?: number }): ConcertsGoingClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const f: GoingFetch = opts.fetchImpl ?? (fetch as unknown as GoingFetch)
  const now = opts.now ?? Date.now
  const timeout = opts.timeoutMs ?? 8000
  const init = (extra: Record<string, unknown> = {}) =>
    withCompanionInit({ ...extra, signal: AbortSignal.timeout(timeout) } as RequestInit) as Record<string, unknown>
  const put = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const res = await f(`${base}${path}`, init({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      return res.ok
    } catch {
      return false
    }
  }
  const at = () => new Date(now()).toISOString()
  const enc = encodeURIComponent
  return {
    async rsvps() {
      try {
        const res = await f(`${base}/api/rsvps`, init())
        return res.ok ? parseRsvps(await res.json()) : null
      } catch {
        return null
      }
    },
    setGoing: (eventId, status, show) => put(`/api/rsvps/${enc(eventId)}`, { status: status ?? 'clear', at: at(), ...(show ? { show } : {}) }),
    setAttended: (eventId, answer) => put(`/api/rsvps/${enc(eventId)}/attended`, { answer: answer ?? 'clear', at: at() }),
    async lately(artist) {
      try {
        const res = await f(`${base}/api/concerts/lately?artist=${enc(artist)}`, init())
        return res.ok ? parseLately(await res.json()) : null
      } catch {
        return null
      }
    },
  }
}
