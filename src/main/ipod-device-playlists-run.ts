/**
 * The playlists one iPod gets at sync (2026-11-13) — the I/O around
 * common/ipod-device-playlists.ts (the rule) for the sync engine.
 *
 * Gathers, for the plugged-in iPod:
 *   - verified BPMs from homemini (GET /api/bpm-key?ids=), for the BPM lists
 *   - the playlists assigned to it on homemini (GET /api/ipod-playlists?device=):
 *     AI ones Jake approved and the ones he made himself
 *   - its On-The-Go read-backs (this Mac's ipod-otg-playlists.json)
 * and hands them, with what the renderer passed, to devicePlaylistSet. The
 * rule holds on every iPod (2026-11-14): there is no per-iPod switch.
 *
 * `preview` is the same set, worked out for the Device page's plan before
 * anything is plugged in or synced: it writes nothing (no plan file, no kept
 * copies, nothing sent to homemini, a damaged On-The-Go file left where it is).
 *
 * UNKNOWN IS NOT EMPTY. When homemini can't be asked, the answer kept from
 * last time is used. When there is no kept answer either, the playlists the
 * LAST FINISHED SYNC wrote (ipod-playlists-last-sync.json) are written again: a
 * playlist is never taken off an iPod because a list couldn't be read. Only an
 * iPod that has never had them goes without, and every such case is a line in
 * `notes`, in the log and in the last-sync file.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'
import { readOtgPlaylistsRepairing, type OtgIo, type OtgPlaylist } from './ipod-otg-playlists.ts'
import {
  describePlaylistPlan, readLastSyncPlaylists, writePlannedPlaylists, type LastSyncPlaylists,
} from './ipod-playlist-rule.ts'
// The app's one name-sort rule, main-side twin of renderer/utils/artistSort.ts compareNames
// (pinned equal on one fixture by __tests__/ipod-device-playlists.test.ts).
import { compareIpodArtistNames } from './ipod-artist-sort.ts'
import {
  devicePlaylistSet,
  verifiedBpmFrom,
  NEARLY_ALL,
  type DevicePlaylist,
  type DevicePlaylistResult,
  type DeviceTrack,
} from '../common/ipod-device-playlists.ts'

export const BPM_CACHE_FILE = 'ipod-bpm-verified-cache.json'
export const ASSIGNED_CACHE_FILE = 'ipod-assigned-playlists-cache.json'
const IDS_PER_ASK = 400

export interface DevicePlaylistsDeps {
  baseUrl: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => Date
  warn?: (msg: string) => void
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf-8')) as T } catch { return null }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf-8')
  await rename(tmp, path)
}

/** homemini's assigned playlists for one iPod, parsed. Anything that isn't a playlist is dropped. */
export function parseAssigned(body: unknown): DevicePlaylist[] | null {
  const rows = (body as { playlists?: unknown } | null)?.playlists
  if (!Array.isArray(rows)) return null
  const out: DevicePlaylist[] = []
  for (const r of rows as Array<{ id?: unknown; name?: unknown; trackIds?: unknown }>) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.trackIds)) continue
    out.push({ id: r.id, name: r.name, trackIds: r.trackIds.map((x) => Number(x)).filter((n) => Number.isInteger(n)) })
  }
  return out
}

function verifiedBpmFromCache(doc: { bpm?: Record<string, number> } | null): Map<number, number> | null {
  if (!doc || !doc.bpm || typeof doc.bpm !== 'object') return null
  const out = new Map<number, number>()
  for (const [k, v] of Object.entries(doc.bpm)) {
    if (Number.isInteger(Number(k)) && typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(Number(k), v)
  }
  return out
}

export interface ForSyncInput {
  passed: ReadonlyArray<Record<string, unknown>>
  tracks: ReadonlyArray<Record<string, unknown>>
  stateDir: string
  deviceKey: string
  ipodName: string
  /** The Original: keeps "Top 1000" as a playlist, in rank order. */
  original: boolean
}
export type ForSyncResult = DevicePlaylistResult & { notes: string[] }

export function createDevicePlaylists(deps: DevicePlaylistsDeps) {
  const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = deps.timeoutMs ?? 8_000
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const base = deps.baseUrl.replace(/\/+$/, '')
  const get = async (path: string): Promise<{ status: number; body: unknown } | null> => {
    try {
      const res = await fetchImpl(`${base}${path}`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      return { status: res.status, body: res.status === 200 ? await res.json().catch(() => null) : null }
    } catch (err) {
      warn(`[ipod-playlists] ${path.split('?')[0]} failed: ${(err as Error)?.message ?? err}`)
      return null
    }
  }

  /** Verified BPM per id: homemini's answer, else the kept copy, else null = unknown. */
  async function verifiedBpm(stateDir: string, ids: number[], preview: boolean): Promise<{ bpm: Map<number, number> | null; note: string | null }> {
    const cachePath = join(stateDir, BPM_CACHE_FILE)
    const fresh = new Map<number, number>()
    let complete = true
    for (let i = 0; i < ids.length; i += IDS_PER_ASK) {
      const r = await get(`/api/bpm-key?ids=${ids.slice(i, i + IDS_PER_ASK).join(',')}`)
      const tracks = (r?.body as { tracks?: unknown } | null)?.tracks
      if (!r || r.status !== 200 || !tracks) { complete = false; break }
      for (const [id, bpm] of verifiedBpmFrom(tracks)) fresh.set(id, bpm)
    }
    if (complete) {
      if (preview) return { bpm: fresh, note: null }
      await writeJson(cachePath, { savedAt: (deps.now?.() ?? new Date()).toISOString(), bpm: Object.fromEntries(fresh) })
        .catch((err) => warn(`[ipod-playlists] could not keep the BPM copy: ${(err as Error)?.message ?? err}`))
      return { bpm: fresh, note: null }
    }
    const kept = verifiedBpmFromCache(await readJson<{ bpm?: Record<string, number> }>(cachePath))
    if (kept) return { bpm: kept, note: `homemini didn’t give the BPM record; the copy kept from last time was used (${kept.size} songs).` }
    return { bpm: null, note: null }
  }

  /** Tell homemini about On-The-Go lists it doesn't hold yet, so the other Macs and the
   *  phone show them under this iPod. The id is the list's own, so a re-send can't make
   *  two. Not reaching homemini changes nothing here: the list is on this Mac's disk and
   *  is sent again at the next sync. */
  async function sendOtg(deviceKey: string, otg: OtgPlaylist[], held: DevicePlaylist[]): Promise<void> {
    for (const p of otg) {
      if (held.some((h) => h.id === p.id)) continue
      try {
        const res = await fetchImpl(`${base}/api/ipod-playlists/${encodeURIComponent(deviceKey)}/${encodeURIComponent(p.id)}`, withCompanionInit({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: p.name, source: 'on-the-go', trackIds: p.trackIds, createdAt: p.createdAt }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status !== 200) warn(`[ipod-playlists] ${p.deviceName}: homemini answered ${res.status}; it is kept on this Mac and sent again next sync`)
      } catch (err) {
        warn(`[ipod-playlists] ${p.deviceName} not sent to homemini (${(err as Error)?.message ?? err}); it is kept on this Mac and sent again next sync`)
        return
      }
    }
  }

  /** The playlists homemini holds for this iPod, else the kept copy, else null = unknown. */
  async function assigned(stateDir: string, deviceKey: string, otg: OtgPlaylist[], preview: boolean): Promise<{ playlists: DevicePlaylist[] | null; note: string | null }> {
    const cachePath = join(stateDir, ASSIGNED_CACHE_FILE)
    const r = await get(`/api/ipod-playlists?device=${encodeURIComponent(deviceKey)}`)
    const parsed = r && r.status === 200 ? parseAssigned(r.body) : null
    if (parsed) {
      if (preview) return { playlists: parsed, note: null }
      await sendOtg(deviceKey, otg, parsed)
      await writeJson(cachePath, { savedAt: (deps.now?.() ?? new Date()).toISOString(), playlists: parsed })
        .catch((err) => warn(`[ipod-playlists] could not keep the playlists copy: ${(err as Error)?.message ?? err}`))
      return { playlists: parsed, note: null }
    }
    const kept = parseAssigned(await readJson(cachePath))
    const why = r ? `answered ${r.status}` : 'didn’t answer'
    if (kept) return { playlists: kept, note: `homemini ${why} for this iPod’s playlists; the copy kept from last time was used (${kept.length}).` }
    return { playlists: null, note: why }
  }

  /** The set, worked out. `preview`: write nothing anywhere (see the top of this file). */
  async function build(input: ForSyncInput, preview: boolean): Promise<ForSyncResult & { record: LastSyncPlaylists }> {
    if (!preview) await mkdir(input.stateDir, { recursive: true }).catch((err) => warn(`[ipod-playlists] could not make ${input.stateDir}: ${(err as Error)?.message ?? err}`))
    const now = deps.now?.() ?? new Date()
    const tracks: DeviceTrack[] = input.tracks.map((t) => ({ id: Number(t.id), year: t.year as number | string | null }))
    const notes: string[] = []
    let otg: OtgPlaylist[]
    if (preview) {
      // Read only: a damaged file is left for the sync to repair, and the preview shows none.
      const readOnly: OtgIo = {
        readFile: (p) => readFile(p, 'utf-8'),
        writeFile: async () => { throw new Error('preview writes nothing') },
        rename: async () => { throw new Error('preview writes nothing') },
      }
      otg = (await readOtgPlaylistsRepairing(input.stateDir, { io: readOnly, warn: () => {} }).catch(() => ({ playlists: [] as OtgPlaylist[] }))).playlists
    } else {
      const otgRead = await readOtgPlaylistsRepairing(input.stateDir, { now, warn })
      if (otgRead.repaired) notes.push(otgRead.repaired)
      otg = otgRead.playlists
    }
    const [bpm, mine, last] = await Promise.all([
      verifiedBpm(input.stateDir, tracks.map((t) => t.id), preview),
      assigned(input.stateDir, input.deviceKey, otg, preview),
      readLastSyncPlaylists(input.stateDir),
    ])
    if (bpm.note) notes.push(bpm.note)
    if (mine.note && mine.playlists) notes.push(mine.note)

    // Unknown is not empty: what the last sync wrote stands in for what couldn't be asked.
    // Only its assigned and BPM lists are ever taken, so a record older than the rule
    // (library playlists, another iPod's own list) can't bring those back.
    const lastOf = (pick: (p: DevicePlaylist) => boolean): DevicePlaylist[] => (last?.playlists ?? []).filter(pick)
    let assignedNow = mine.playlists
    if (!assignedNow) {
      assignedNow = lastOf((p) => p.kind === 'assigned')
      notes.push(last
        ? `homemini ${mine.note} for this iPod’s playlists and no copy was kept, so the ${assignedNow.length} assigned playlist(s) the last sync wrote are written again.`
        : `homemini ${mine.note} for this iPod’s playlists, and this Mac has no record of any from an earlier sync, so none are written this time.`)
    }
    const lastBpm = bpm.bpm ? [] : lastOf((p) => p.kind === 'default' && p.id.startsWith('default-bpm-'))
    if (!bpm.bpm) {
      notes.push(last
        ? `homemini didn’t give the BPM record and no copy was kept, so the ${lastBpm.length} BPM playlist(s) the last sync wrote are written again.`
        : 'homemini didn’t give the BPM record, and this Mac has no record of BPM playlists from an earlier sync, so none are written this time.')
    }

    const set = devicePlaylistSet({
      passed: input.passed,
      tracks,
      year: now.getFullYear(),
      original: input.original,
      verifiedBpm: bpm.bpm ?? new Map(),
      onTheGo: otg.map((p) => ({ id: p.id, name: p.deviceName, trackIds: p.trackIds })),
      // A read-back On-The-Go list homemini also holds is written once, in the On-The-Go block.
      assigned: assignedNow.filter((p) => !otg.some((o) => o.id === p.id)),
      compareNames: (a, b) => compareIpodArtistNames(a, b),
    })
    if (lastBpm.length) {
      // Put the last sync's BPM lists back where BPM lists go: after the last default.
      // Held to the same line as every default: empty or nearly the whole iPod is not written.
      const onIpod = new Set(tracks.map((t) => t.id))
      const keep = lastBpm
        .map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => onIpod.has(id)) }))
        .filter((p) => p.trackIds.length > 0 && p.trackIds.length / Math.max(1, tracks.length) < NEARLY_ALL && !set.playlists.some((q) => q.name === p.name))
      const at = set.playlists.findIndex((p) => p.kind === 'on-the-go' || p.kind === 'assigned')
      set.playlists.splice(at === -1 ? set.playlists.length : at, 0, ...keep)
    }
    const record: LastSyncPlaylists = { version: 1, at: now.toISOString(), ipod: input.ipodName, ...set, notes }
    return { ...set, notes, record }
  }

  /**
   * The exact playlist set to write to this iPod, and what is left off. Throws only
   * when the saved On-The-Go lists are damaged AND can't be moved aside.
   * Leaves ipod-playlists-planned.json behind (never the last-sync record).
   */
  async function forSync(input: ForSyncInput): Promise<ForSyncResult> {
    const { record, ...result } = await build(input, false)
    // The PLAN, not the record: it becomes ipod-playlists-last-sync.json only when the
    // sync it belongs to has verified and sealed (sync-engine → promotePlannedPlaylists).
    await writePlannedPlaylists(input.stateDir, record)
      .catch((err) => warn(`[ipod-playlists] could not keep this sync’s playlist plan: ${(err as Error)?.message ?? err}`))
    return result
  }

  /** What the next sync would write, for the Device page's plan. Writes nothing. */
  async function preview(input: ForSyncInput): Promise<ForSyncResult> {
    const { record: _record, ...result } = await build(input, true)
    return result
  }

  return { forSync, preview }
}

export type ApplyResult =
  | { ok: true; playlists: Array<Record<string, unknown>> }
  | { ok: false; error: string }

/**
 * The sync engine's one call, for EVERY sync that writes an iPod's database (the
 * one Sync button and the whole-library sync alike). Runs after the plays gate
 * (On-The-Go is read back and saved first) and before anything is written to
 * the card. ANY failure putting the set together is ok:false: the caller must
 * stop, the card is untouched. There is no path that hands the library's
 * playlists through: an unknown iPod never gets this far (resolveIpodState
 * refuses it), and a sync with no iPod identified is refused here too.
 */
export async function applyDevicePlaylists(input: {
  device: { id: string; name: string; primary: boolean } | null
  passed: Array<Record<string, unknown>>
  tracks: ReadonlyArray<Record<string, unknown>>
  stateDir: string
  deviceKey: string
  forSync: (i: ForSyncInput) => Promise<ForSyncResult>
  log?: (line: string) => void
}): Promise<ApplyResult> {
  if (!input.device) return { ok: false, error: 'JakeTunes couldn’t tell which iPod this is, so its playlists can’t be worked out. Nothing on the iPod was changed.' }
  try {
    const set = await input.forSync({
      passed: input.passed, tracks: input.tracks, stateDir: input.stateDir, deviceKey: input.deviceKey,
      ipodName: input.device.name, original: input.device.primary,
    })
    ;(input.log ?? ((l: string) => console.warn(l)))(`sync-to-ipod: playlists — ${describePlaylistPlan(input.device.name, set)}`)
    return { ok: true, playlists: set.playlists as unknown as Array<Record<string, unknown>> }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `This iPod’s playlists couldn’t be put together (${why}). Nothing on the iPod was changed.` }
  }
}
