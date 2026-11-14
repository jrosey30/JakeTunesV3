/**
 * homemini's event-cover proposals (2026-11-13, common/event-covers.ts).
 * Read, decide, and "this month's cover is…". Nothing is queued on this Mac:
 * a decision changes what every device shows, so it is made with homemini
 * there, or not at all.
 */
import { withCompanionInit } from './hub-companion.ts'
import { parseEventCoverList, type EventCoverDecision, type EventCoverProposal } from '../common/event-covers.ts'
import type { FetchLike } from './top1000-client.ts'

const isYm = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)

export function createEventCoverClient(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; warn?: (m: string) => void }) {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 20_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/event-covers`
  const post = async (path: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string; away: boolean }> => {
    try {
      const res = await fetchImpl(`${base}${path}`, withCompanionInit({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      if (res.status === 200) return { ok: true }
      const said = await res.json().catch(() => null) as { error?: unknown } | null
      return { ok: false, away: false, error: typeof said?.error === 'string' ? said.error : `homemini answered ${res.status}` }
    } catch (err) {
      warn(`[event-covers] ${path} failed: ${(err as Error)?.message ?? err}`)
      return { ok: false, away: true, error: 'homemini is away' }
    }
  }
  return {
    /** Every proposal; null = no clean answer (away, refused, or not the expected body). */
    async list(): Promise<EventCoverProposal[] | null> {
      try {
        const res = await fetchImpl(base, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) return null
        return parseEventCoverList(await res.json().catch(() => null))
      } catch (err) {
        warn(`[event-covers] list failed: ${(err as Error)?.message ?? err}`)
        return null
      }
    },
    /** The proposed cover, drawn; null when there is none or homemini is away. */
    async preview(ym: unknown): Promise<Buffer | null> {
      if (!isYm(ym)) return null
      try {
        const res = await fetchImpl(`${base}/${ym}/preview`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) return null
        const bytes = Buffer.from(await (res as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer())
        return bytes.length >= 1000 ? bytes : null
      } catch { return null }
    },
    async decide(ym: unknown, decision: unknown) {
      if (!isYm(ym) || (decision !== 'approve' && decision !== 'skip' && decision !== 'restore')) return { ok: false as const, away: false, error: 'a month, and approve, skip or restore' }
      return post(`/${ym}/decide`, { decision: decision as EventCoverDecision })
    },
    async wish(ym: unknown, text: unknown) {
      const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
      if (!isYm(ym) || !t) return { ok: false as const, away: false, error: 'say what happened' }
      return post(`/${ym}/wish`, { text: t })
    },
  }
}
