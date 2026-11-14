/**
 * iPod lists IPC (2026-11-07) — every iPod but the Original carries a list that
 * homemini writes (contract: common/ipod-list-doc.ts; Jake: "i cannot manually
 * add songs in there"). This module is the desktop's one door to those lists:
 *
 *   'ipod-lists:get' → { ok, role, lists: [{ id, name, color, purpose, ids, source, note, updatedAt, registered }] }
 *       every list homemini keeps, ids in LIST order (newest first) — the
 *       sidebar's iPODS section and each list's playlist (renderer/ipodLists.ts).
 *       On the hub a registered iPod's list goes through its pool file; a replica
 *       never touches the registry or a pool file (main/ipod-lists-gather.ts).
 *
 *   'ipod-lists:proposals' (deviceId) → { ok, proposals, proposedAt, queued, offline }
 *       the brain's picks waiting for Jake (2026-11-09), for the panel at the top
 *       of an iPod list's playlist (renderer/components/IpodProposalsPanel.tsx).
 *   'ipod-lists:wanted-shelf' (force?) → { ok, shelves: [{ listId, listName, title, cards }] }
 *       the Record Shop's "For your iPods" rows: what each list is missing
 *       (main/ipod-wanted-shelf-source.ts).
 *   'ipod-lists:decide' ({ deviceId, approve, reject }) → { ok, sent }
 *       Approve / Skip: on disk first, then homemini (main/ipod-list-proposals.ts);
 *       what homemini doesn't hear now goes on the next read, refresh or the
 *       5-minute retry.
 *   'ipod-lists:set-color' ({ deviceId, color }) → { ok, color, homemini: 'saved' | 'later' }
 *       "iPod color…" (2026-11-09): the cover's colour. Kept on this Mac (the hub's
 *       choice wins over the registry) and sent to homemini, or waits on disk for it
 *       (main/ipod-colors.ts); flushed before each list read and on the 5-minute retry.
 *   'ipod-lists:rename' ({ deviceId, name }) → { ok, name, homemini: 'saved' | 'later' } | { ok: false, error }
 *       Rename… (2026-11-09) on any Mac: the list's name, never the iPod's (main/ipod-list-rename.ts).
 *       Waits on disk when homemini is away; flushed before each list read and on the 5-minute retry.
 *   'top1000-name:get' → { ok, name, custom, pending }  /  'top1000-name:set' (name) → { ok, name, custom, homemini }
 *       The Top 1000's display name, kept on homemini (main/top1000-name.ts).
 *   'ipod-cover:get' (key) → { ok, url } — a custom-colour cover homemini drew, kept on
 *       this Mac for good (main/ipod-cover-cache.ts); url null = show the bundled nearest.
 *
 * And for main: `refresh(device)` (the pool page, activity-pool-ipc.ts) and
 * `refreshPlugged(mount)` (the Activity Sync build, workout-sync-ipc.ts) — both
 * copy homemini's list into the iPod's pool file first (ipod-list-pool.ts).
 * Kept out of index.ts, which is ratcheted.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import type { IpodDeviceMarker } from '../../common/ipod-identity.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'
import { identifyIpod, loadIpodRegistry, poolFileFor } from '../ipod-identity.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { refreshIpodPool, type IpodPoolRefresh, type PoolFileName } from '../ipod-list-pool.ts'
import type { FetchLike } from '../top1000-client.ts'
import { flushAllHomeminiNames, readPendingNames } from '../ipod-rename.ts'
import { renameIpodList } from '../ipod-list-rename.ts'
import { createTop1000NameRemote, flushTop1000Name, localTop1000Name, readTop1000Name, setTop1000Name, type Top1000NameDeps } from '../top1000-name.ts'
import { createProposalsDesk } from '../ipod-list-proposals.ts'
import { gatherIpodLists, ipodListsCachePath, readListsCache } from '../ipod-lists-gather.ts'
import { createWantedShelfSource } from '../ipod-wanted-shelf-source.ts'
import { chooseIpodColor, flushPendingColors, readChosenColors } from '../ipod-colors.ts'
import { ipodCoverDataUrl } from '../ipod-cover-cache.ts'
import { periodCoverDataUrl } from '../period-cover-cache.ts'
import { createPhotoCoverClient, createPhotoCovers } from '../ipod-photo-covers.ts'
import { withCompanionInit } from '../hub-companion.ts'
import { MAX_PHOTO_BYTES } from '../../common/ipod-photo-covers.ts'
import { open as openFile } from 'fs/promises'

/** How often a decision homemini hasn't heard yet is tried again. */
export const DECISION_RETRY_MS = 5 * 60_000

export interface IpodListsHost {
  stateDir: string
  /** homemini's base URL (no /audio). */
  baseUrl: string
  /** The library, for the pool file's names memory. Best-effort. */
  libraryTracks?: () => Promise<unknown[]>
  fetchImpl?: FetchLike
  warn?: (msg: string) => void
  /** homemini's and workmini's apps: the lists are plain playlists there (main/ipod-lists-gather.ts). Absent = hub. */
  isReplica?: () => Promise<boolean>
  /** "Use a photo…": the file Jake picks (a dialog in main/index.ts); null = cancelled. */
  pickPhoto?: () => Promise<string | null>
  /** A list was just read clean from homemini (ids newest first, and its grow cadence when it has one): the "ready to sync" check (ipod-sync-ready.ts). */
  onListRead?: (device: IpodDeviceMarker, listIds: number[], everyDays?: number) => void
}

export interface IpodListSource {
  refresh(device: IpodDeviceMarker): Promise<IpodPoolRefresh>
  /** The plugged-in iPod's list when it is a known non-Original iPod; null otherwise. */
  refreshPlugged(mount: string | null): Promise<{ ids: number[]; note: string | null } | null>
  /** Tell homemini an iPod's new name (PATCH); false = not now. */
  rename(deviceId: string, name: string): Promise<boolean>
}

export function createIpodListSource(host: IpodListsHost): IpodListSource & {
  desk: ReturnType<typeof createProposalsDesk>
  all: () => Promise<IpodList[] | null>
  sendColor: (deviceId: string, color: string) => Promise<boolean>
  flushColors: () => Promise<'none' | 'sent' | 'still-waiting'>
  flushNames: () => Promise<'none' | 'sent' | 'still-waiting'>
  renameList: (deviceId: string, name: string) => Promise<'done' | 'retry' | 'drop'>
  cover: (path: string) => Promise<{ bytes: Buffer; exact: boolean } | null>
} {
  const client = createIpodListClient({ baseUrl: host.baseUrl, fetchImpl: host.fetchImpl, warn: host.warn })
  const desk = createProposalsDesk({ stateDir: host.stateDir, get: (id) => client.proposals(id), send: (id, d) => client.decide(id, d), log: host.warn })

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

  const sendColor = (id: string, color: string) => client.setColor(id, color)
  const flushColors = () => flushPendingColors(host.stateDir, sendColor)
    .catch((err) => { host.warn?.(`[ipod-list] pending colours: ${(err as Error)?.message ?? err}`); return 'still-waiting' as const })

  const flushNames = () => flushAllHomeminiNames(host.stateDir, client.renameList, undefined, host.warn)
    .catch((err) => { host.warn?.(`[ipod-list] pending names: ${(err as Error)?.message ?? err}`); return 'still-waiting' as const })

  async function refresh(device: IpodDeviceMarker): Promise<IpodPoolRefresh> {
    // A rename homemini missed (it was away) goes first — every sync reads the list here.
    await flushAllHomeminiNames(host.stateDir, client.renameList, device.id, host.warn)
      .catch((err) => host.warn?.(`[ipod-list] pending rename for ${device.name}: ${(err as Error)?.message ?? err}`))
    // Approvals homemini missed go before the list is read, so the read has them.
    await desk.flush().catch((err) => host.warn?.(`[ipod-list] pending decisions: ${(err as Error)?.message ?? err}`))
    return refreshIpodPool({
      poolFile: poolFileFor(host.stateDir, device),
      ipodName: device.name,
      ask: () => client.get(device.id),
      nameOf: await namesFromLibrary(),
    }).then((r) => {
      // A clean read from homemini: the "ready to sync" check takes these ids (ipod-sync-ready.ts).
      if (r.source === 'homemini') {
        try { host.onListRead?.(device, r.listIds, r.everyDays) } catch (err) { host.warn?.(`[ipod-list] onListRead: ${(err as Error)?.message ?? err}`) }
      }
      return r
    })
  }

  return {
    desk,
    sendColor,
    flushColors,
    flushNames,
    renameList: client.renameList,
    cover: (path: string) => client.cover(path),
    refresh,
    all: () => client.all(),
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
  const isReplica = host.isReplica ?? (async () => false)
  const top1000: Top1000NameDeps = {
    stateDir: host.stateDir,
    ...createTop1000NameRemote({ baseUrl: host.baseUrl, fetchImpl: host.fetchImpl, warn: host.warn }),
    warn: host.warn,
  }
  ipc.handle('ipod-lists:get', async () => {
    // A colour or a name homemini missed goes first, so the read has it.
    await source.flushColors()
    await source.flushNames()
    return gatherIpodLists({
      isReplica,
      registry: async () => (await loadIpodRegistry(host.stateDir)).devices,
      refresh: (d) => source.refresh(d),
      all: () => source.all(),
      cacheFile: ipodListsCachePath(host.stateDir),
      chosen: () => readChosenColors(host.stateDir),
      pendingNames: () => readPendingNames(host.stateDir),
      warn: host.warn,
    })
  }, { public: true })
  // Every list's name as this Mac shows it: homemini's last answer with the renames still waiting on top.
  async function listNames(): Promise<Array<{ id: string; name: string }>> {
    const kept = (await readListsCache(ipodListsCachePath(host.stateDir))) ?? []
    const waiting = await readPendingNames(host.stateDir)
    return kept.map((l) => ({ id: l.id, name: waiting[l.id] ?? l.name }))
  }
  // Rename… (2026-11-09). A write: the main window only. Any Mac, hub or replica.
  ipc.handle('ipod-lists:rename', async (_e, input: unknown) => {
    const i = input as { deviceId?: unknown; name?: unknown } | null
    return renameIpodList({
      stateDir: host.stateDir,
      send: source.renameList,
      others: async (id) => [
        ...(await listNames()).filter((l) => l.id !== id).map((l) => l.name),
        await localTop1000Name(host.stateDir),
      ],
      warn: host.warn,
    }, i?.deviceId, i?.name).catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t rename the list' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('top1000-name:get', async () => ({ ok: true as const, ...(await readTop1000Name(top1000)) }), { public: true })
  // A write: the main window only.
  ipc.handle('top1000-name:set', async (_e, name: unknown) => {
    const others = (await listNames()).map((l) => l.name)
    return setTop1000Name(top1000, name, others)
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t rename the Top 1000' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  // A write: the main window only.
  ipc.handle('ipod-lists:set-color', async (_e, input: unknown) => {
    const i = input as { deviceId?: unknown; color?: unknown } | null
    const hub = !(await isReplica().catch(() => true))
    return chooseIpodColor({ stateDir: host.stateDir, send: source.sendColor, hub }, i?.deviceId, i?.color)
      .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t save the colour' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('ipod-cover:get', async (_e, key: unknown) => {
    const url = await ipodCoverDataUrl({ stateDir: host.stateDir, fetchCover: source.cover }, key).catch(() => null)
    return { ok: true, url }
  }, { public: true })
  // A month's or the year's cover, drawn by homemini (2026-11-13, main/period-cover-cache.ts).
  ipc.handle('period-cover:get', async (_e, remoteId: unknown) => {
    const url = await periodCoverDataUrl({ stateDir: host.stateDir, fetchCover: source.cover }, remoteId).catch(() => null)
    return { ok: true, url }
  }, { public: true })
  ipc.handle('ipod-lists:proposals', async (_e, deviceId: unknown) => {
    if (typeof deviceId !== 'string') return { ok: false, error: 'no iPod' }
    return source.desk.view(deviceId)
  }, { public: true })
  // A write: the main window only.
  ipc.handle('ipod-lists:decide', async (_e, input: unknown) => {
    const i = input as { deviceId?: unknown; approve?: unknown; reject?: unknown } | null
    if (!i || typeof i.deviceId !== 'string') return { ok: false, error: 'no iPod' }
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [])
    return source.desk.decide(i.deviceId, { approve: ids(i.approve), reject: ids(i.reject) })
  }, { refuse: { ok: false, error: 'refused-sender' } })
  // Photo covers (2026-11-09; main/ipod-photo-covers.ts): "Use a photo…" / "Use the drawing"
  // for the Top 1000 and each iPod list, kept here first and sent when homemini answers.
  const photos = createPhotoCovers({
    stateDir: host.stateDir,
    client: createPhotoCoverClient({
      baseUrl: host.baseUrl,
      fetchImpl: host.fetchImpl as never,
      withAuth: (init) => withCompanionInit(init as RequestInit) as Record<string, unknown>,
      warn: host.warn,
    }),
    log: host.warn,
  })
  ipc.handle('ipod-photo:get', async (_e, key: unknown) => {
    const v = await photos.view(key).catch(() => ({ shown: 'drawing' as const, url: null }))
    return { ok: true, ...v }
  }, { public: true })
  ipc.handle('ipod-photo:sync', async () => {
    await photos.sync().catch((err) => host.warn?.(`[photo-covers] sync: ${(err as Error)?.message ?? err}`))
    return { ok: true }
  }, { public: true })
  // Writes: the main window only.
  ipc.handle('ipod-photo:choose', async (_e, key: unknown) => {
    const path = await (host.pickPhoto?.() ?? Promise.resolve(null)).catch(() => null)
    if (!path) return { ok: false, cancelled: true }
    const bytes = await readCapped(path, MAX_PHOTO_BYTES).catch(() => null)
    if (!bytes) return { ok: false, error: 'That photo couldn’t be read, or it is bigger than 25 MB.' }
    return photos.choose(key, bytes).catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t keep the photo' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  ipc.handle('ipod-photo:drawing', async (_e, key: unknown) => {
    return photos.useDrawing(key).catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? 'couldn’t go back to the drawing' }))
  }, { refuse: { ok: false, error: 'refused-sender' } })
  // The Record Shop's "For your iPods" section (2026-11-09; main/ipod-wanted-shelf.ts).
  // homemini away: the copy of its lists this Mac kept from its last answer
  // (ipod-lists-cache.json, `wanted` included), so the rows still show.
  const wanted = createWantedShelfSource({
    stateDir: host.stateDir,
    lists: async () => (await source.all().catch(() => null)) ?? readListsCache(ipodListsCachePath(host.stateDir)),
    libraryTracks: host.libraryTracks,
    warn: host.warn,
  })
  ipc.handle('ipod-lists:wanted-shelf', async (_e, force?: unknown) => wanted.get(force === true), { public: true })
  setInterval(() => {
    void source.desk.flush().catch(() => undefined)
    void source.flushColors()
    void source.flushNames()
    void flushTop1000Name(top1000).catch(() => undefined)
    void photos.sync().catch(() => undefined)
  }, DECISION_RETRY_MS).unref?.()
  return source
}

/** A picked file's bytes, never more than `cap` + 1 read (null when it is bigger: refused before it is kept). */
async function readCapped(path: string, cap: number): Promise<Uint8Array | null> {
  const fh = await openFile(path, 'r')
  try {
    const { size } = await fh.stat()
    if (!size || size > cap) return null
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, 0)
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
  } finally {
    await fh.close()
  }
}
