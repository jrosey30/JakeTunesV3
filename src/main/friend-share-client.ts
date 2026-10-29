/**
 * Friend share client (2026-10-29) — the desktop's half of homemini's
 * GET /api/share/link (contract: common/friend-share-doc.ts). homemini
 * resolves and caches the cross-app links, so nothing is cached here.
 * Pure of electron — fetch is injected (__tests__/friend-share.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import { parseShareInfo, type ShareInfo, type ShareKind } from '../common/friend-share-doc.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export function createFriendShareClient(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  // The first share of a song asks three catalogs (iTunes is paced), so allow time.
  const timeoutMs = opts.timeoutMs ?? 25_000
  const base = opts.baseUrl.replace(/\/+$/, '').replace(/\/audio$/, '')
  return {
    async info(trackId: string | number, kind: ShareKind): Promise<Result<ShareInfo>> {
      const url = `${base}/api/share/link?id=${encodeURIComponent(String(trackId))}&kind=${kind}`
      try {
        const res = await fetchImpl(url, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status === 404) return { ok: false, error: 'homemini doesn’t have this song yet.' }
        const doc = res.status === 200 ? parseShareInfo(await res.json().catch(() => null)) : null
        return doc ? { ok: true, value: doc } : { ok: false, error: 'homemini sent back something unexpected.' }
      } catch {
        return { ok: false, error: 'homemini isn’t answering, so the links can’t be found right now.' }
      }
    },
  }
}
