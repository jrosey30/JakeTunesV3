/**
 * The iPod list wire contract (2026-11-07) — what homemini serves for every
 * iPod but the Original:
 *
 *   GET /api/ipod-lists/:deviceId → IpodList   (404 = homemini has no list for it yet)
 *
 * Jake (2026-11-07), about the second iPod, "iPod EVIL": "the evil ipod gets a
 * playlist like the top 1000 ipod does. and the evil ipod list can add songs to
 * the fold but it cannot be more than 1000 songs...it doesnt need to hit 1000 at
 * once...it can be a slow build. i cannot manually add songs in there. if i want
 * a song in there, ill tell you, or if the ai brain is really working, the
 * song(s) will be there before i can even ask".
 *
 * homemini is the only writer of these lists (JakeTunesMobile backend). This
 * desktop only reads them: the sidebar playlist, the read-only pool page, and
 * the iPod's pool file refreshed before each Activity Sync
 * (main/ipod-list-pool.ts). Pure — node --test loads it.
 *
 * ⚠️ TWIN: JakeTunesMobile backend, the GET /api/ipod-lists/:deviceId route and
 * the list's writer — the shape, the 1000 ceiling and newest-first order must match.
 */

/** No iPod list is ever bigger than this, whatever homemini says its cap is. */
export const IPOD_LIST_MAX = 1000

export type IpodListAddedBy = 'seed' | 'claude' | 'brain'

export interface IpodListChange {
  id: number
  at: string
  by: IpodListAddedBy
  why?: string
}

export interface IpodList {
  /** The iPod's marker id (common/ipod-identity.ts). */
  id: string
  name: string
  purpose: string | null
  /** At most IPOD_LIST_MAX. */
  cap: number
  /** Song ids in list order, NEWEST FIRST. Never longer than `cap`, never a repeat. */
  ids: number[]
  adds: IpodListChange[]
  removed: IpodListChange[]
  updatedAt: string
  /**
   * The grower's settings. `everyDays` (1..60) and `perRun` (0..50) are the
   * list's cadence (Jake 2026-11-08: "only update punkpod once every other
   * week"): optional, absent on older lists (= every day, perDay a run).
   */
  brain: { enabled: boolean; perDay: number; everyDays?: number; perRun?: number }
}

/** homemini's bounds for the cadence fields; a value outside them is dropped, never the list. */
export const IPOD_LIST_EVERY_DAYS_MAX = 60
export const IPOD_LIST_PER_RUN_MAX = 50

const DEVICE_ID = /^[a-z0-9-]{6,64}$/
const BY = new Set<IpodListAddedBy>(['seed', 'claude', 'brain'])

function isSongId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function parseChanges(raw: unknown): IpodListChange[] {
  if (!Array.isArray(raw)) return []
  const out: IpodListChange[] = []
  for (const e of raw) {
    const r = e as Record<string, unknown> | null
    if (!r || typeof r !== 'object' || !isSongId(r.id) || typeof r.at !== 'string' || !BY.has(r.by as IpodListAddedBy)) continue
    out.push({ id: r.id, at: r.at, by: r.by as IpodListAddedBy, ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}) })
  }
  return out
}

/**
 * Read homemini's answer. null = junk, and junk never reaches a pool file:
 * the wrong iPod's list, a cap past IPOD_LIST_MAX, more songs than the cap,
 * a song id that isn't a whole positive number, a song twice, no updatedAt.
 * The history (`adds`, `removed`) is informational: a bad entry is dropped,
 * not a reason to refuse the list.
 */
export function parseIpodList(raw: unknown, expectedId?: string): IpodList | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !DEVICE_ID.test(r.id)) return null
  if (expectedId !== undefined && r.id !== expectedId) return null
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  const cap = r.cap
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > IPOD_LIST_MAX) return null
  if (!Array.isArray(r.ids) || r.ids.length > cap) return null
  const seen = new Set<number>()
  for (const id of r.ids) {
    if (!isSongId(id) || seen.has(id)) return null
    seen.add(id)
  }
  if (typeof r.updatedAt !== 'string' || !r.updatedAt.trim()) return null
  const b = r.brain as Record<string, unknown> | null | undefined
  const brain: IpodList['brain'] = b && typeof b === 'object'
    ? { enabled: b.enabled === true, perDay: typeof b.perDay === 'number' && Number.isFinite(b.perDay) && b.perDay >= 0 ? Math.floor(b.perDay) : 0 }
    : { enabled: false, perDay: 0 }
  // The cadence (optional): kept only when it is a whole number in homemini's
  // bounds. A bad or missing one is just absent: an older list never fails here.
  if (b && typeof b === 'object') {
    const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
    if (whole(b.everyDays, 1, IPOD_LIST_EVERY_DAYS_MAX)) brain.everyDays = b.everyDays
    if (whole(b.perRun, 0, IPOD_LIST_PER_RUN_MAX)) brain.perRun = b.perRun
  }
  return {
    id: r.id,
    name: r.name.trim(),
    purpose: typeof r.purpose === 'string' && r.purpose.trim() ? r.purpose.trim() : null,
    cap,
    ids: [...(r.ids as number[])],
    adds: parseChanges(r.adds),
    removed: parseChanges(r.removed),
    updatedAt: r.updatedAt,
    brain,
  }
}

/** The pool file keeps drop order (oldest first, the newest at the end: splitListOnly takes
 *  from the end). homemini's list is newest first. These two turn one into the other. */
export function poolOrderFromList(listIdsNewestFirst: readonly number[]): number[] {
  return [...listIdsNewestFirst].reverse()
}
export function listOrderFromPool(poolIdsOldestFirst: readonly number[]): number[] {
  return [...poolIdsOldestFirst].reverse()
}

/** The plain line that says no one adds to this list by hand. */
export function ipodListHowSongsArrive(ipodName: string): string {
  return `Songs are added to ${ipodName} by asking Claude, or by the brain. Nothing here can be added or removed by hand.`
}

/**
 * The pool-edit refusal (activity-pool-ipc.ts): the Original's pool is Jake's to
 * drop into; every other iPod's list is homemini's. null = the edit may go ahead.
 */
export function poolEditRefusal(owner: { name: string; primary: boolean } | null): string | null {
  if (!owner || owner.primary) return null
  return `${owner.name}’s list is kept on homemini. ${ipodListHowSongsArrive(owner.name)}`
}

/** The sidebar playlist of a non-Original iPod's list ('ipod-list-<marker id>'). Sidebar only,
 *  never synced to the Original. */
export const IPOD_LIST_PLAYLIST_PREFIX = 'ipod-list-'
export function ipodListPlaylistId(deviceId: string): `ipod-list-${string}` {
  return `${IPOD_LIST_PLAYLIST_PREFIX}${deviceId}`
}
export function parseIpodListPlaylistId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(IPOD_LIST_PLAYLIST_PREFIX)) return null
  const dev = id.slice(IPOD_LIST_PLAYLIST_PREFIX.length)
  return DEVICE_ID.test(dev) ? dev : null
}
