/**
 * iPod list client (2026-11-07) — the desktop's half of homemini's
 * GET /api/ipod-lists/:deviceId (contract: common/ipod-list-doc.ts). homemini is
 * the only writer; this only asks. Same shape as the Top 1000 client
 * (top1000-client.ts): the companion header, a timeout, fetch injected so it runs
 * under node:test (__tests__/ipod-lists.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import { parseIpodList, type IpodList } from '../common/ipod-list-doc.ts'
import { parseProposalSet, type IpodProposalSet } from '../common/ipod-list-proposals.ts'
import type { FetchLike } from './top1000-client.ts'

export type IpodListAnswer =
  /** homemini's list, checked. */
  | { kind: 'ok'; list: IpodList }
  /** 404: homemini has no list for this iPod yet. */
  | { kind: 'none' }
  /** No answer at all (down, timed out, off the tailnet). */
  | { kind: 'offline'; error: string }
  /** An answer that isn't a list: another status, or a body that fails the parser. */
  | { kind: 'bad'; error: string }

export interface IpodListClientOptions {
  baseUrl: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  warn?: (msg: string) => void
}

export function createIpodListClient(opts: IpodListClientOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 8_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/ipod-lists`

  return {
    async get(deviceId: string): Promise<IpodListAnswer> {
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await fetchImpl(`${base}/${encodeURIComponent(deviceId)}`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      } catch (err) {
        const error = (err as Error)?.message ?? String(err)
        warn(`[ipod-list] ${deviceId} failed: ${error}`)
        return { kind: 'offline', error }
      }
      if (res.status === 404) return { kind: 'none' }
      if (res.status !== 200) {
        warn(`[ipod-list] ${deviceId}: homemini answered ${res.status}`)
        return { kind: 'bad', error: `homemini answered ${res.status}` }
      }
      const list = parseIpodList(await res.json().catch(() => null), deviceId)
      if (!list) {
        warn(`[ipod-list] ${deviceId}: the list came back unreadable`)
        return { kind: 'bad', error: 'the list came back unreadable' }
      }
      return { kind: 'ok', list }
    },

    /** Every list homemini keeps, including lists for iPods not registered on any Mac yet
     *  (GET /api/ipod-lists). null = no clean answer (down, refused, or a body that isn't
     *  { lists: [...] }); a list that fails the parser is dropped, never guessed at. */
    async all(): Promise<IpodList[] | null> {
      try {
        const res = await fetchImpl(base, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) {
          warn(`[ipod-list] all lists: homemini answered ${res.status}`)
          return null
        }
        const body = await res.json().catch(() => null) as { lists?: unknown } | null
        if (!body || !Array.isArray(body.lists)) return null
        return body.lists.map((l) => parseIpodList(l)).filter((l): l is IpodList => l !== null)
      } catch (err) {
        warn(`[ipod-list] all lists failed: ${(err as Error)?.message ?? err}`)
        return null
      }
    },

    /** The brain's picks waiting for Jake (2026-11-09; common/ipod-list-proposals.ts). */
    async proposals(deviceId: string): Promise<
      | { kind: 'ok'; set: IpodProposalSet }
      | { kind: 'none' }
      | { kind: 'offline'; error: string }
      | { kind: 'bad'; error: string }> {
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await fetchImpl(`${base}/${encodeURIComponent(deviceId)}/proposals`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      } catch (err) {
        const error = (err as Error)?.message ?? String(err)
        warn(`[ipod-list] proposals ${deviceId} failed: ${error}`)
        return { kind: 'offline', error }
      }
      if (res.status === 404) return { kind: 'none' }
      if (res.status !== 200) return { kind: 'bad', error: `homemini answered ${res.status}` }
      const set = parseProposalSet(await res.json().catch(() => null), deviceId)
      return set ? { kind: 'ok', set } : { kind: 'bad', error: 'the picks came back unreadable' }
    },

    /** Jake's approvals and skips. 'done' = homemini has them; 'retry' = not now (away, 5xx,
     *  a refused token); 'drop' = homemini will never take this one (400, 404): keeping it
     *  would retry forever. */
    async decide(deviceId: string, d: { approve: number[]; reject: number[] }): Promise<'done' | 'retry' | 'drop'> {
      try {
        const res = await fetchImpl(`${base}/${encodeURIComponent(deviceId)}/proposals/decide`, withCompanionInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(d),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status === 200) return 'done'
        warn(`[ipod-list] decide ${deviceId}: homemini answered ${res.status}`)
        return res.status === 400 || res.status === 404 ? 'drop' : 'retry'
      } catch (err) {
        warn(`[ipod-list] decide ${deviceId} failed: ${(err as Error)?.message ?? err}`)
        return 'retry'
      }
    },

    /** "iPod color…" (2026-11-09): PATCH homemini's list { color }. true = homemini has it, or
     *  never will (404: no such list, keeping it would retry forever). A 400 stays false: a
     *  homemini older than the colour field answers 400, and the colour should land once it updates. */
    async setColor(deviceId: string, color: string): Promise<boolean> {
      try {
        const res = await fetchImpl(`${base}/${encodeURIComponent(deviceId)}`, withCompanionInit({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status === 200 || res.status === 404) return true
        warn(`[ipod-list] colour ${deviceId}: homemini answered ${res.status}`)
        return false
      } catch (err) {
        warn(`[ipod-list] colour ${deviceId} failed: ${(err as Error)?.message ?? err}`)
        return false
      }
    },

    /** One drawn iPod cover from homemini (GET /api/playlist-cover/ipod/:model/:color).
     *  exact = homemini drew this very colour (X-Ipod-Cover: exact); otherwise it is the
     *  nearest named colour while the custom one is being drawn. null = no answer. */
    async cover(path: string): Promise<{ bytes: Buffer; exact: boolean } | null> {
      try {
        const res = await fetchImpl(`${opts.baseUrl.replace(/\/+$/, '')}${path}`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) return null
        const r = res as unknown as { arrayBuffer: () => Promise<ArrayBuffer>; headers?: { get?: (k: string) => string | null } }
        const bytes = Buffer.from(await r.arrayBuffer())
        if (bytes.length < 1000) return null
        return { bytes, exact: r.headers?.get?.('x-ipod-cover') === 'exact' }
      } catch (err) {
        warn(`[ipod-list] cover ${path} failed: ${(err as Error)?.message ?? err}`)
        return null
      }
    },

    /** The iPod was renamed (2026-11-07): PATCH homemini's list name (Mobile PR #753).
     *  true = homemini took it; false = not now (down, 404, any refusal). */
    async rename(deviceId: string, name: string): Promise<boolean> {
      try {
        const res = await fetchImpl(`${base}/${encodeURIComponent(deviceId)}`, withCompanionInit({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status === 200) return true
        warn(`[ipod-list] rename ${deviceId}: homemini answered ${res.status}`)
        return false
      } catch (err) {
        warn(`[ipod-list] rename ${deviceId} failed: ${(err as Error)?.message ?? err}`)
        return false
      }
    },
  }
}
