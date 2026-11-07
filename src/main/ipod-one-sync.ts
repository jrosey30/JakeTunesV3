/**
 * One button per iPod (Jake, 2026-11-07: "activity sync is kind of obsolete.
 * can we just make the sync process for specific ipods easy and pretty
 * straight forward").
 *
 * What one Sync puts on the plugged-in iPod, decided here and nowhere else:
 *
 *   • the Original ("my top 1000 songs"): its Top 1000, homemini's ranked list,
 *     best first. Exactly 1,000: when some of the list can't go on, the most-loved
 *     songs in the library fill the seats (pickReplacementTracks), and the engine
 *     keeps its own copy-time fill for the Original as before.
 *   • every other registered iPod: its whole list from homemini, refreshed first
 *     (ipod-list-pool.ts), at most 1,000, never filler. A song that can't go on is
 *     left off and named.
 *   • an unknown iPod, or none: refused. The set-up strip above the page handles
 *     an unknown one.
 *
 * No size picker, no profile, no Music Man, no review step. The plan only names
 * songs; the copy, seal, verify and plays round trip are the activity engine's
 * (runActivitySync through sync-to-ipod with origin 'activity-click').
 *
 * Pure apart from the injected deps — node --test loads it.
 */
import { activityTrackCanBoard, leftOffSong, pickReplacementTracks, planListOnlyBoarding, type LeftOffSong } from './activity-fill.ts'
import { pickFromTop1000 } from '../common/top1000-sync.ts'
import type { OneSyncPlan } from '../common/ipod-one-sync-plan.ts'

/** Every iPod carries at most this many songs (and the Original exactly this many). */
export const ONE_SYNC_SIZE = 1000

export type OneSyncIpod =
  | { status: 'none' }
  | { status: 'unknown' }
  | { status: 'known'; id: string; name: string; color: string | null; primary: boolean }

export interface OneSyncDeps {
  /** Which iPod is plugged in. */
  ipod: () => Promise<OneSyncIpod>
  /** homemini's Top 1000, ranked best first; null when homemini isn't answering. */
  top1000: () => Promise<number[] | null>
  /** The plugged-in list-only iPod's list, refreshed from homemini first; null = none. */
  list: () => Promise<{ ids: number[]; note: string | null } | null>
  /** Songs that can never go on an iPod (full-concert-owned). */
  ineligible: () => Promise<Set<number>>
}

export interface OneSyncTrack {
  id: number
  title?: unknown
  artist?: unknown
  path?: unknown
  codec?: unknown
  audioMissing?: unknown
  duration?: unknown
  genre?: unknown
  rating?: unknown
  playCount?: unknown
  lastPlayedAt?: unknown
  dateAdded?: unknown
}

export type { OneSyncPlan, OneSyncKind } from '../common/ipod-one-sync-plan.ts'

export async function planOneSync(deps: OneSyncDeps, tracks: OneSyncTrack[]): Promise<OneSyncPlan> {
  const ipod = await deps.ipod().catch((): OneSyncIpod => ({ status: 'none' }))
  if (ipod.status === 'none') {
    return { ok: false, kind: 'none', ipodName: null, color: null, error: 'No iPod is plugged in.' }
  }
  if (ipod.status === 'unknown') {
    return { ok: false, kind: 'unknown', ipodName: null, color: null, error: 'JakeTunes doesn’t know this iPod yet. Set it up first, then sync it.' }
  }
  const ineligible = await deps.ineligible().catch(() => new Set<number>())
  const byId = new Map<number, OneSyncTrack>()
  for (const t of tracks) {
    const id = Number(t?.id)
    if (Number.isFinite(id)) byId.set(id, t)
  }
  return ipod.primary
    ? planOriginal(deps, ipod, byId, tracks, ineligible)
    : planList(deps, ipod, byId, ineligible)
}

async function planOriginal(
  deps: OneSyncDeps,
  ipod: Extract<OneSyncIpod, { status: 'known' }>,
  byId: Map<number, OneSyncTrack>,
  tracks: OneSyncTrack[],
  ineligible: Set<number>,
): Promise<OneSyncPlan> {
  const base = { kind: 'original' as const, ipodName: ipod.name, color: ipod.color }
  const ranked = await deps.top1000().catch(() => null)
  if (!ranked || ranked.length === 0) {
    return { ok: false, ...base, error: `homemini didn’t answer, so ${ipod.name}’s Top 1000 can’t be read right now. Nothing on the iPod was changed. Try again when homemini is back.` }
  }
  const picked = pickFromTop1000(ranked, {
    gap: ONE_SYNC_SIZE,
    exclude: ineligible,
    syncable: (id) => { const t = byId.get(id); return !!t && activityTrackCanBoard(t) },
  }).picked
  let note: string | null = null
  const trackIds = [...picked]
  if (trackIds.length < ONE_SYNC_SIZE) {
    const fill = pickReplacementTracks(tracks, new Set(trackIds), ONE_SYNC_SIZE - trackIds.length, ineligible)
    for (const t of fill) trackIds.push(Number(t.id))
    if (fill.length > 0) {
      note = `${picked.length.toLocaleString('en-US')} from your Top 1000 can go on; your most-loved songs fill the other ${fill.length.toLocaleString('en-US')}.`
    }
  }
  if (trackIds.length === 0) {
    return { ok: false, ...base, error: `None of the Top 1000 can go on ${ipod.name}. Nothing on the iPod was changed.` }
  }
  return { ok: true, ...base, setName: 'Top 1000', trackIds, leftOff: [], note }
}

async function planList(
  deps: OneSyncDeps,
  ipod: Extract<OneSyncIpod, { status: 'known' }>,
  byId: Map<number, OneSyncTrack>,
  ineligible: Set<number>,
): Promise<OneSyncPlan> {
  const base = { kind: 'list' as const, ipodName: ipod.name, color: ipod.color }
  const list = await deps.list().catch(() => null)
  if (!list) {
    return { ok: false, ...base, error: `${ipod.name}’s list couldn’t be read. Nothing on the iPod was changed.` }
  }
  if (list.ids.length === 0) {
    return { ok: false, ...base, error: `${ipod.name}’s list is empty. Songs are added by asking Claude, or by the brain.${list.note ? ` ${list.note}` : ''}` }
  }
  // Songs not in this library, or owned by a full concert, are left off and named
  // here; the board check names the rest (planListOnlyBoarding, the engine's own).
  const leftOff: LeftOffSong[] = []
  const rows: OneSyncTrack[] = []
  const seen = new Set<number>()
  for (const raw of list.ids) {
    const id = Number(raw)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    if (!t) { leftOff.push(leftOffSong({ id, title: `Song ${id}`, artist: '' }, 'it isn’t in this library')); continue }
    if (ineligible.has(id)) { leftOff.push(leftOffSong(t, 'it belongs to a full concert, which stays off iPods')); continue }
    rows.push(t)
  }
  const plan = planListOnlyBoarding(rows, ONE_SYNC_SIZE, (t) => Number(t.id))
  leftOff.push(...plan.leftOff)
  if (plan.pool.length === 0) {
    return { ok: false, ...base, error: `None of the ${list.ids.length.toLocaleString('en-US')} songs on ${ipod.name}’s list can go on it. Nothing on the iPod was changed.` }
  }
  return {
    ok: true,
    ...base,
    setName: ipod.name,
    trackIds: plan.pool.map((t) => Number(t.id)),
    leftOff,
    note: list.note,
  }
}
