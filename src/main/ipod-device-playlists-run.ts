/**
 * The playlists one iPod gets at sync (2026-11-13) — the I/O around
 * common/ipod-device-playlists.ts (the rule) for the sync engine.
 *
 * Gathers, for the plugged-in iPod:
 *   - verified BPMs from homemini (GET /api/bpm-key?ids=), for the BPM lists
 *   - the playlists assigned to it on homemini (GET /api/ipod-playlists?device=):
 *     AI ones Jake approved and the ones he made himself
 *   - its On-The-Go read-backs (this Mac's ipod-otg-playlists.json)
 * and hands them, with what the renderer passed, to devicePlaylistSet.
 *
 * homemini away: the last good answer, kept beside the iPod's other state, is
 * used, so a sync on the road writes the same playlists as the last one at
 * home. Never asked and nothing kept: those lists are left off this sync and
 * the log says so. An On-The-Go file that can't be read STOPS the sync: writing
 * a database without lists Jake made would look like they were lost.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'
import { readOtgPlaylists, type OtgPlaylist } from './ipod-otg-playlists.ts'
// The app's one name-sort rule, main-side twin of renderer/utils/artistSort.ts compareNames
// (pinned equal on one fixture by __tests__/ipod-device-playlists.test.ts).
import { compareIpodArtistNames } from './ipod-artist-sort.ts'
import {
  devicePlaylistSet,
  verifiedBpmFrom,
  type DevicePlaylist,
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

  /** Verified BPM per id for these songs: homemini's answer merged over the kept copy. */
  async function verifiedBpm(stateDir: string, ids: number[]): Promise<Map<number, number>> {
    const cachePath = join(stateDir, BPM_CACHE_FILE)
    const kept = verifiedBpmFromCache(await readJson<{ bpm?: Record<string, number> }>(cachePath))
    const fresh = new Map<number, number>()
    let complete = true
    for (let i = 0; i < ids.length; i += IDS_PER_ASK) {
      const r = await get(`/api/bpm-key?ids=${ids.slice(i, i + IDS_PER_ASK).join(',')}`)
      const tracks = (r?.body as { tracks?: unknown } | null)?.tracks
      if (!r || r.status !== 200 || !tracks) { complete = false; break }
      for (const [id, bpm] of verifiedBpmFrom(tracks)) fresh.set(id, bpm)
    }
    if (!complete) {
      warn(`[ipod-playlists] homemini didn't give the BPM record; using the copy kept from last time (${kept.size} songs)`)
      return kept
    }
    await writeJson(cachePath, { savedAt: (deps.now?.() ?? new Date()).toISOString(), bpm: Object.fromEntries(fresh) })
      .catch((err) => warn(`[ipod-playlists] could not keep the BPM copy: ${(err as Error)?.message ?? err}`))
    return fresh
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

  /** The playlists homemini holds for this iPod, or the copy kept from the last answer. */
  async function assigned(stateDir: string, deviceKey: string, otg: OtgPlaylist[]): Promise<DevicePlaylist[]> {
    const cachePath = join(stateDir, ASSIGNED_CACHE_FILE)
    const r = await get(`/api/ipod-playlists?device=${encodeURIComponent(deviceKey)}`)
    const parsed = r && r.status === 200 ? parseAssigned(r.body) : null
    if (parsed) {
      await sendOtg(deviceKey, otg, parsed)
      await writeJson(cachePath, { savedAt: (deps.now?.() ?? new Date()).toISOString(), playlists: parsed })
        .catch((err) => warn(`[ipod-playlists] could not keep the playlists copy: ${(err as Error)?.message ?? err}`))
      return parsed
    }
    const kept = parseAssigned(await readJson(cachePath)) ?? []
    warn(`[ipod-playlists] homemini didn't give ${deviceKey}'s playlists${r ? ` (answered ${r.status})` : ''}; using the copy kept from last time (${kept.length})`)
    return kept
  }

  return {
    /**
     * The exact playlist set to write to this iPod. Throws only when the
     * On-The-Go file exists and can't be read.
     */
    async forSync(input: {
      passed: ReadonlyArray<Record<string, unknown>>
      tracks: ReadonlyArray<Record<string, unknown>>
      stateDir: string
      deviceKey: string
    }): Promise<{ playlists: DevicePlaylist[]; dropped: string[] }> {
      await mkdir(input.stateDir, { recursive: true }).catch((err) => warn(`[ipod-playlists] could not make ${input.stateDir}: ${(err as Error)?.message ?? err}`))
      const tracks: DeviceTrack[] = input.tracks.map((t) => ({ id: Number(t.id), year: t.year as number | string | null }))
      const otg = await readOtgPlaylists(input.stateDir)
      const [bpm, mine] = await Promise.all([
        verifiedBpm(input.stateDir, tracks.map((t) => t.id)),
        assigned(input.stateDir, input.deviceKey, otg),
      ])
      return devicePlaylistSet({
        passed: input.passed,
        tracks,
        year: (deps.now?.() ?? new Date()).getFullYear(),
        verifiedBpm: bpm,
        onTheGo: otg.map((p) => ({ id: p.id, name: p.deviceName, trackIds: p.trackIds })),
        // A read-back On-The-Go list homemini also holds is written once, in the On-The-Go block.
        assigned: mine.filter((p) => !otg.some((o) => o.id === p.id)),
        compareNames: (a, b) => compareIpodArtistNames(a, b),
      })
    },
  }
}

function verifiedBpmFromCache(doc: { bpm?: Record<string, number> } | null): Map<number, number> {
  const out = new Map<number, number>()
  for (const [k, v] of Object.entries(doc?.bpm ?? {})) {
    if (Number.isInteger(Number(k)) && typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(Number(k), v)
  }
  return out
}
