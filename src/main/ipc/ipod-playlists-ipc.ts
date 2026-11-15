/**
 * The playlists on one iPod (2026-11-14) — the renderer's door to them
 * (renderer/ipodPlaylists.ts). Registered by ipod-lists-ipc.ts, beside the
 * iPod lists, so index.ts (ratcheted) doesn't grow.
 *
 *   'ipod-playlists:get' (device, { fresh?, ipodName? })
 *       → { ok, device, playlists: [...rows in the one order], from: 'homemini' | 'kept' | 'none' }
 *       fresh: what this Mac is waiting to tell homemini goes first, then homemini is
 *       asked; otherwise this Mac's disk only (the first paint).
 *   'ipod-playlists:save' ({ device, id?, name?, trackIds?, defaults, ipodName, alsoOnIpod? })
 *       → { ok, id, view } | { ok: false, error }   (no id = a new playlist)
 *   'ipod-playlists:delete' ({ device, id }) → { ok, id, view } | { ok: false, error }
 *   'ipod-playlists:answer' ({ device, id, choice: 'add' | 'drop' | 'rename', name? })
 *       a playlist homemini held: put its songs on the iPod too, take them out, or rename it.
 *   'ipod-playlists:bpm' (ids) → { ok, bpm: { id: bpm }, known }
 *       verified foot-tap BPMs from homemini (GET /api/bpm-key?ids=), for the BPM
 *       defaults; the copy kept from last time when homemini doesn't answer.
 *
 * Every write is on this Mac's disk before homemini is asked
 * (main/ipod-playlists-outbox.ts); what homemini hasn't heard goes on the next
 * read or the 5-minute retry.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { IpcRegistrar } from '../ipc-register.ts'
import type { FetchLike } from '../top1000-client.ts'
import { withCompanionInit } from '../hub-companion.ts'
import { writeJsonAtomic } from '../atomic-write.ts'
import { withLocalLock } from '../hub-local-state.ts'
import { compareIpodArtistNames } from '../ipod-artist-sort.ts'
import { verifiedBpmFrom } from '../../common/ipod-device-playlists.ts'
import { createIpodPlaylistsDesk, createIpodPlaylistsRemote } from '../ipod-playlists-outbox.ts'

export const BPM_KEEP_FILE = 'ipod-playlists-bpm-cache.json'
const IDS_PER_ASK = 400
/** How often what homemini hasn't heard is tried again. */
export const IPOD_PLAYLISTS_RETRY_MS = 5 * 60_000

export interface IpodPlaylistsHost {
  stateDir: string
  baseUrl: string
  fetchImpl?: FetchLike
  libraryTracks?: () => Promise<unknown[]>
  warn?: (msg: string) => void
}

/** Verified BPMs for these songs: homemini's answer (kept for next time), else what was kept. */
export async function verifiedBpmFor(host: IpodPlaylistsHost, rawIds: unknown): Promise<{ ok: true; bpm: Record<string, number>; known: boolean }> {
  const ids = (Array.isArray(rawIds) ? rawIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  const path = join(host.stateDir, BPM_KEEP_FILE)
  const fetchImpl: FetchLike = host.fetchImpl ?? (fetch as unknown as FetchLike)
  const base = host.baseUrl.replace(/\/+$/, '')
  const fresh: Record<string, number> = {}
  let complete = true
  for (let i = 0; i < ids.length; i += IDS_PER_ASK) {
    try {
      const res = await fetchImpl(`${base}/api/bpm-key?ids=${ids.slice(i, i + IDS_PER_ASK).join(',')}`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(8_000) }) as Record<string, unknown>)
      const body = res.status === 200 ? await res.json().catch(() => null) as { tracks?: unknown } | null : null
      if (!body?.tracks) { complete = false; break }
      for (const [id, bpm] of verifiedBpmFrom(body.tracks)) fresh[String(id)] = bpm
    } catch (err) {
      host.warn?.(`[ipod-playlists] BPM record not read (${(err as Error)?.message ?? err})`)
      complete = false
      break
    }
  }
  return withLocalLock(`ipod-playlists-bpm:${host.stateDir}`, async () => {
    let kept: Record<string, number> = {}
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as { bpm?: Record<string, unknown> }
      for (const [k, v] of Object.entries(raw?.bpm ?? {})) if (typeof v === 'number' && Number.isFinite(v) && v > 0) kept[k] = v
    } catch {
      // Nothing kept yet.
      kept = {}
    }
    if (complete) {
      // homemini's answer for these songs replaces what was kept for them (a song can lose its verification).
      for (const id of ids) delete kept[String(id)]
      Object.assign(kept, fresh)
      await writeJsonAtomic(path, { savedAt: new Date().toISOString(), bpm: kept }, false)
        .catch((err) => host.warn?.(`[ipod-playlists] could not keep the BPM record: ${(err as Error)?.message ?? err}`))
      return { ok: true as const, bpm: fresh, known: true }
    }
    const out: Record<string, number> = {}
    for (const id of ids) if (kept[String(id)] !== undefined) out[String(id)] = kept[String(id)]
    return { ok: true as const, bpm: out, known: Object.keys(kept).length > 0 }
  })
}

export function registerIpodPlaylistsIpc(ipc: IpcRegistrar, host: IpodPlaylistsHost): void {
  let titles: Map<number, string> | null = null
  let titlesAt = 0
  const refreshTitles = async (): Promise<void> => {
    if (titles && Date.now() - titlesAt < 60_000) return
    try {
      const rows = (await host.libraryTracks?.()) ?? []
      titles = new Map(rows.map((t) => {
        const r = t as { id?: unknown; title?: unknown }
        return [Number(r?.id), String(r?.title ?? '')] as [number, string]
      }))
      titlesAt = Date.now()
    } catch (err) {
      host.warn?.(`[ipod-playlists] library read for titles failed: ${(err as Error)?.message ?? err}`)
    }
  }
  const desk = createIpodPlaylistsDesk({
    stateDir: host.stateDir,
    remote: createIpodPlaylistsRemote({ baseUrl: host.baseUrl, fetchImpl: host.fetchImpl, warn: host.warn }),
    compareNames: (a, b) => compareIpodArtistNames(a, b),
    titleOf: (id) => titles?.get(id) || `song ${id}`,
    warn: host.warn,
  })
  ipc.handle('ipod-playlists:get', async (_e, device: unknown, opts?: unknown) => {
    const o = (opts ?? {}) as { fresh?: unknown; ipodName?: unknown }
    if (o.fresh === true) await refreshTitles()
    return desk.view(String(device), { fresh: o.fresh === true, ipodName: typeof o.ipodName === 'string' ? o.ipodName : undefined })
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t read the playlists' }))
  }, { public: true })
  // Writes: the main window only.
  ipc.handle('ipod-playlists:save', async (_e, input: unknown) => {
    return desk.save((input ?? {}) as Parameters<typeof desk.save>[0])
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t save the playlist' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('ipod-playlists:delete', async (_e, input: unknown) => {
    const i = (input ?? {}) as { device?: unknown; id?: unknown }
    return desk.remove({ device: i.device, id: i.id })
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t delete the playlist' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('ipod-playlists:answer', async (_e, input: unknown) => {
    return desk.answer((input ?? {}) as Parameters<typeof desk.answer>[0])
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t save the answer' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('ipod-playlists:bpm', async (_e, ids: unknown) => verifiedBpmFor(host, ids), { public: true })
  setInterval(() => {
    void refreshTitles().then(() => desk.flushAll()).catch(() => undefined)
  }, IPOD_PLAYLISTS_RETRY_MS).unref?.()
}
