/**
 * Every iPod list for the sidebar's iPODS section and the list's playlist page
 * ('ipod-lists:get', 2026-11-09). Jake: "i dont see punkpod on workmini for some
 * reason." The handler used to walk THIS Mac's ipod-devices.json, so a Mac that
 * never had punkPod plugged in (workmini) never asked for its list, and the
 * lists homemini keeps for iPods not set up yet never showed anywhere.
 *
 * Now homemini's whole set (GET /api/ipod-lists) is the source on every Mac,
 * kept in a local copy (ipod-lists-cache.json) that answers when homemini can't.
 * And, Jake: "they shouldnt have to be plugged into homemini and workmini....
 * macbook is the only one that actually syncs and works directly with each ipod":
 *   - replica (homemini's and workmini's apps): homemini's lists as plain
 *     playlists. The registry is never read, no pool file is written, nothing
 *     feeds the "ready to sync" check.
 *   - hub (the MacBook): each registered iPod's list goes through its pool
 *     refresh as before (the pool file its Sync reads, the ready-to-sync check),
 *     then every list homemini keeps for an iPod not registered here
 *     (`registered: false`, the sidebar's "planned").
 * Kept out of index.ts, which is ratcheted.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import type { IpodDeviceMarker } from '../common/ipod-identity.ts'
import { parseIpodList, type IpodList } from '../common/ipod-list-doc.ts'
import type { IpodPoolRefresh } from './ipod-list-pool.ts'
import { ipodLook, type IpodModel } from '../common/ipod-covers.ts'

export const IPOD_LISTS_CACHE_FILE = 'ipod-lists-cache.json'

export interface IpodListWire {
  id: string
  name: string
  /**
   * The iPod the list wears on its cover (2026-11-09, common/ipod-covers.ts): a named iPod
   * colour or '#rrggbb', never null. On the hub: Jake's choice on this Mac, then a registered
   * iPod's registry colour, then homemini's, then the model's default. On a replica: homemini's.
   */
  color: string | null
  model: IpodModel
  purpose: string | null
  /** Song ids, newest first. */
  ids: number[]
  /** homemini = a fresh answer; local = the iPod's pool file (hub); cache = homemini's last answer kept on this Mac. */
  source: 'homemini' | 'local' | 'cache'
  note: string | null
  updatedAt: string | null
  /** An iPod in this Mac's registry carries this list (always false on a replica). */
  registered: boolean
}

export interface IpodListsAnswer {
  ok: true
  role: 'hub' | 'replica'
  lists: IpodListWire[]
}

export interface GatherIpodListsDeps {
  /** True on homemini's and workmini's apps. A failed check counts as a replica: it never writes a pool file. */
  isReplica: () => Promise<boolean>
  /** This Mac's registry (hub only). */
  registry: () => Promise<IpodDeviceMarker[]>
  /** One registered iPod's list through its pool file (hub only). */
  refresh: (device: IpodDeviceMarker) => Promise<IpodPoolRefresh>
  /** Every list homemini keeps; null = no clean answer. */
  all: () => Promise<IpodList[] | null>
  /** Where homemini's last clean answer is kept (this Mac's state dir). */
  cacheFile: string
  /** Colours Jake picked on this Mac (main/ipod-colors.ts), by iPod id. They win on the hub. */
  chosen?: () => Promise<Record<string, string>>
  /** Names homemini hasn't heard yet (main/ipod-rename.ts readPendingNames), by iPod id. They win
   *  everywhere, so a rename shows at once, homemini there or not (2026-11-09). */
  pendingNames?: () => Promise<Record<string, string>>
  warn?: (msg: string) => void
}

export function ipodListsCachePath(stateDir: string): string {
  return join(stateDir, IPOD_LISTS_CACHE_FILE)
}

export async function readListsCache(file: string): Promise<IpodList[] | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as { lists?: unknown }
    if (!raw || !Array.isArray(raw.lists)) return null
    return raw.lists.map((l) => parseIpodList(l)).filter((l): l is IpodList => l !== null)
  } catch {
    return null
  }
}

async function writeListsCache(file: string, lists: IpodList[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), lists }), 'utf-8')
  await rename(tmp, file)
}

/** homemini's lists now, else the copy kept from its last answer, else none. */
async function homeminiLists(deps: GatherIpodListsDeps): Promise<{ lists: IpodList[]; fresh: boolean }> {
  let fresh: IpodList[] | null = null
  try { fresh = await deps.all() } catch (err) { deps.warn?.(`[ipod-lists] all lists: ${(err as Error)?.message ?? err}`) }
  if (fresh) {
    await writeListsCache(deps.cacheFile, fresh).catch((err) => deps.warn?.(`[ipod-lists] cache write: ${(err as Error)?.message ?? err}`))
    return { lists: fresh, fresh: true }
  }
  return { lists: (await readListsCache(deps.cacheFile)) ?? [], fresh: false }
}

function wire(l: IpodList, fresh: boolean, registered: boolean, chosen?: string, pendingName?: string): IpodListWire {
  const look = ipodLook({ model: l.model, listColor: l.color, chosen })
  return {
    id: l.id, name: pendingName ?? l.name, color: look.color, model: look.model, purpose: l.purpose, ids: [...l.ids],
    source: fresh ? 'homemini' : 'cache', note: null, updatedAt: l.updatedAt, registered,
  }
}

export async function gatherIpodLists(deps: GatherIpodListsDeps): Promise<IpodListsAnswer> {
  let replica = true
  try { replica = await deps.isReplica() } catch (err) { deps.warn?.(`[ipod-lists] role check: ${(err as Error)?.message ?? err}`) }

  const names = await (deps.pendingNames?.() ?? Promise.resolve({} as Record<string, string>)).catch(() => ({} as Record<string, string>))

  if (replica) {
    const remote = await homeminiLists(deps)
    return { ok: true, role: 'replica', lists: remote.lists.map((l) => wire(l, remote.fresh, false, undefined, names[l.id])) }
  }

  const devices = await deps.registry().catch(() => [] as IpodDeviceMarker[])
  const chosen = await (deps.chosen?.() ?? Promise.resolve({} as Record<string, string>)).catch(() => ({} as Record<string, string>))
  const lists: IpodListWire[] = []
  const known = new Set<string>()
  const pending: Array<{ d: IpodDeviceMarker; r: IpodPoolRefresh }> = []
  for (const d of devices) {
    known.add(d.id)
    if (d.primary) continue
    pending.push({ d, r: await deps.refresh(d) })
  }
  // homemini's lists carry each iPod's model and colour; a registered iPod's list goes
  // through its pool file, so its look comes from here.
  const remote = await homeminiLists(deps)
  const remoteById = new Map(remote.lists.map((l) => [l.id, l]))
  for (const { d, r } of pending) {
    const h = remoteById.get(d.id)
    const look = ipodLook({ model: h?.model, listColor: h?.color, registryColor: d.color, registered: true, chosen: chosen[d.id] })
    // The list's name (2026-11-09: a list is renamed on its own, the iPod keeps its name): a rename
    // homemini hasn't heard yet, else homemini's, else the iPod's own.
    const name = names[d.id] ?? h?.name ?? d.name
    lists.push({ id: d.id, name, color: look.color, model: look.model, purpose: d.purpose, ids: r.listIds, source: r.source, note: r.note, updatedAt: r.updatedAt, registered: true })
  }
  for (const l of remote.lists) if (!known.has(l.id)) lists.push(wire(l, remote.fresh, false, chosen[l.id], names[l.id]))
  return { ok: true, role: 'hub', lists }
}
