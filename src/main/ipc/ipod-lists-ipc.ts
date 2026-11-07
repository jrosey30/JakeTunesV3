/**
 * iPod lists IPC (2026-11-07) — every iPod but the Original carries a list that
 * homemini writes (contract: common/ipod-list-doc.ts; Jake: "i cannot manually
 * add songs in there"). This module is the desktop's one door to those lists:
 *
 *   'ipod-lists:get' → { ok, lists: [{ id, name, color, purpose, ids, source, note, updatedAt }] }
 *       one per registered non-Original iPod, ids in LIST order (newest first) —
 *       the sidebar's playlist per iPod (renderer/ipodLists.ts). homemini's list,
 *       else that iPod's pool file.
 *
 * And for main: `refresh(device)` (the pool page, activity-pool-ipc.ts) and
 * `refreshPlugged(mount)` (the Activity Sync build, workout-sync-ipc.ts) — both
 * copy homemini's list into the iPod's pool file first (ipod-list-pool.ts).
 * Kept out of index.ts, which is ratcheted.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import type { IpodDeviceMarker } from '../../common/ipod-identity.ts'
import { identifyIpod, loadIpodRegistry, poolFileFor } from '../ipod-identity.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { refreshIpodPool, type IpodPoolRefresh, type PoolFileName } from '../ipod-list-pool.ts'
import type { FetchLike } from '../top1000-client.ts'
import { flushHomeminiName } from '../ipod-rename.ts'

export interface IpodListsHost {
  stateDir: string
  /** homemini's base URL (no /audio). */
  baseUrl: string
  /** The library, for the pool file's names memory. Best-effort. */
  libraryTracks?: () => Promise<unknown[]>
  fetchImpl?: FetchLike
  warn?: (msg: string) => void
}

export interface IpodListSource {
  refresh(device: IpodDeviceMarker): Promise<IpodPoolRefresh>
  /** The plugged-in iPod's list when it is a known non-Original iPod; null otherwise. */
  refreshPlugged(mount: string | null): Promise<{ ids: number[]; note: string | null } | null>
  /** Tell homemini an iPod's new name (PATCH); false = not now. */
  rename(deviceId: string, name: string): Promise<boolean>
}

export function createIpodListSource(host: IpodListsHost): IpodListSource {
  const client = createIpodListClient({ baseUrl: host.baseUrl, fetchImpl: host.fetchImpl, warn: host.warn })

  async function namesFromLibrary(): Promise<(id: number) => PoolFileName | null> {
    let tracks: unknown[] = []
    try { tracks = (await host.libraryTracks?.()) ?? [] } catch (err) {
      host.warn?.(`[ipod-list] library read for names failed: ${(err as Error)?.message ?? err}`)
    }
    const byId = new Map<number, PoolFileName>()
    for (const t of tracks) {
      const r = t as { id?: unknown; title?: unknown; artist?: unknown } | null
      const id = Number(r?.id)
      if (Number.isInteger(id)) byId.set(id, { t: String(r?.title ?? ''), a: String(r?.artist ?? '') })
    }
    return (id) => byId.get(id) ?? null
  }

  async function refresh(device: IpodDeviceMarker): Promise<IpodPoolRefresh> {
    // A rename homemini missed (it was away) goes first — every sync reads the list here.
    await flushHomeminiName(host.stateDir, device.id, (id, name) => client.rename(id, name))
      .catch((err) => host.warn?.(`[ipod-list] pending rename for ${device.name}: ${(err as Error)?.message ?? err}`))
    return refreshIpodPool({
      poolFile: poolFileFor(host.stateDir, device),
      ipodName: device.name,
      ask: () => client.get(device.id),
      nameOf: await namesFromLibrary(),
    })
  }

  return {
    refresh,
    rename: (deviceId, name) => client.rename(deviceId, name),
    async refreshPlugged(mount) {
      if (!mount) return null
      const id = await identifyIpod(mount, host.stateDir)
      if (id.status !== 'known' || id.device.primary) return null
      const r = await refresh(id.device)
      return { ids: r.poolIds, note: r.note }
    },
  }
}

export function registerIpodListsIpc(ipc: IpcRegistrar, host: IpodListsHost): IpodListSource {
  const source = createIpodListSource(host)
  ipc.handle('ipod-lists:get', async () => {
    const reg = await loadIpodRegistry(host.stateDir)
    const lists = []
    for (const d of reg.devices) {
      if (d.primary) continue
      const r = await source.refresh(d)
      lists.push({ id: d.id, name: d.name, color: d.color, purpose: d.purpose, ids: r.listIds, source: r.source, note: r.note, updatedAt: r.updatedAt })
    }
    return { ok: true, lists }
  }, { public: true })
  return source
}
