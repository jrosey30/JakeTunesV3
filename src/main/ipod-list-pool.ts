/**
 * A non-Original iPod's pool file, kept in step with homemini's list (2026-11-07).
 *
 * homemini is the only writer of every non-Original iPod's list
 * (common/ipod-list-doc.ts). The sync still reads the iPod's own pool file
 * (ipod-pools/<id>/activity-pool.json, { ids, names, updatedAt }, drop order:
 * oldest first), so before an Activity Sync — and when the pool page or the
 * sidebar asks — this copies homemini's list into that file.
 *
 * The file is the last good copy and nothing here may empty it by accident:
 *   • homemini's list, read clean → the file becomes it (atomic write)
 *   • 404 (homemini has no list yet) → the file stays as it is
 *   • no answer → the file stays, and the note says from when
 *   • junk (bad status, unreadable, the wrong iPod, over the cap) → the file stays, the note says so
 *   • an EMPTY list while the file has songs → the file stays (an empty list
 *     can't sync anyway, and a half-made list on homemini must not wipe 500)
 *
 * Electron-free so node --test loads it (__tests__/ipod-lists.test.ts).
 */
import { dirname } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { listOrderFromPool, poolOrderFromList } from '../common/ipod-list-doc.ts'
import type { IpodListAnswer } from './ipod-list-client.ts'

export interface PoolFileName { t: string; a: string }

export interface IpodPoolRefresh {
  /** The pool in drop order (oldest first): what the sync reads. */
  poolIds: number[]
  /** The same songs in list order (newest first): what the sidebar playlist shows. */
  listIds: number[]
  names: Record<string, PoolFileName>
  /** Where these ids came from this time. */
  source: 'homemini' | 'local'
  /** One plain line when the list is NOT homemini's fresh answer; null when it is. */
  note: string | null
  /** When the ids were last written (the file's updatedAt), ISO; null when never. */
  updatedAt: string | null
  /** homemini's grow cadence for this list (brain.everyDays), on a homemini answer that has one. */
  everyDays?: number
}

export interface RefreshIpodPoolInput {
  /** The iPod's pool file (poolFileFor(stateDir, device)). */
  poolFile: string
  ipodName: string
  /** homemini's answer for this iPod (ipod-list-client.ts). */
  ask: () => Promise<IpodListAnswer>
  /** A song's title and artist from the library, for the file's names memory. */
  nameOf?: (id: number) => PoolFileName | null
  now?: () => Date
  /** How a time is said in a note ("Nov 7, 3:04 PM"). */
  formatTime?: (iso: string) => string
}

interface PoolFile { ids: number[]; names: Record<string, PoolFileName>; updatedAt: string | null }

async function readPoolFile(path: string): Promise<PoolFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as { ids?: unknown; names?: unknown; updatedAt?: unknown }
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
    const names: Record<string, PoolFileName> = {}
    if (parsed?.names && typeof parsed.names === 'object') {
      for (const [k, v] of Object.entries(parsed.names as Record<string, { t?: unknown; a?: unknown }>)) {
        if (v && typeof v === 'object') names[k] = { t: String(v.t ?? ''), a: String(v.a ?? '') }
      }
    }
    return { ids, names, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null }
  } catch {
    return { ids: [], names: {}, updatedAt: null }
  }
}

async function writePoolFile(path: string, file: { ids: number[]; names: Record<string, PoolFileName>; updatedAt: string }): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(file, null, 2))
  await rename(tmp, path)
}

export function defaultFormatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export async function refreshIpodPool(input: RefreshIpodPoolInput): Promise<IpodPoolRefresh> {
  const now = input.now ?? (() => new Date())
  const fmt = input.formatTime ?? defaultFormatTime
  const local = await readPoolFile(input.poolFile)
  const keepLocal = (note: string | null): IpodPoolRefresh => ({
    poolIds: local.ids,
    listIds: listOrderFromPool(local.ids),
    names: local.names,
    source: 'local',
    note,
    updatedAt: local.updatedAt,
  })
  const fromWhen = local.updatedAt ? `the list from ${fmt(local.updatedAt)}` : 'the list on this Mac'

  let answer: IpodListAnswer
  try {
    answer = await input.ask()
  } catch (err) {
    answer = { kind: 'offline', error: (err as Error)?.message ?? String(err) }
  }

  if (answer.kind === 'none') {
    // Transition: the lists start on this Mac and are seeded to homemini after its deploy.
    return keepLocal(local.ids.length ? `homemini has no list for ${input.ipodName} yet — using ${fromWhen}.` : null)
  }
  if (answer.kind === 'offline') {
    return keepLocal(local.ids.length
      ? `homemini didn’t answer — using ${fromWhen}.`
      : `homemini didn’t answer, and this Mac has no copy of ${input.ipodName}’s list yet.`)
  }
  if (answer.kind === 'bad') {
    return keepLocal(`homemini’s list for ${input.ipodName} came back unreadable — using ${fromWhen}.`)
  }

  const list = answer.list
  if (list.ids.length === 0 && local.ids.length > 0) {
    return keepLocal(`homemini’s list for ${input.ipodName} is empty — using ${fromWhen}.`)
  }

  const poolIds = poolOrderFromList(list.ids)
  const names: Record<string, PoolFileName> = {}
  for (const id of poolIds) {
    const known = local.names[String(id)] ?? input.nameOf?.(id) ?? null
    if (known) names[String(id)] = known
  }
  const same = poolIds.length === local.ids.length && poolIds.every((id, i) => id === local.ids[i])
  let updatedAt = local.updatedAt
  if (!same || Object.keys(names).length !== Object.keys(local.names).length) {
    updatedAt = now().toISOString()
    try {
      await writePoolFile(input.poolFile, { ids: poolIds, names, updatedAt })
    } catch (err) {
      // The sync can still go from homemini's answer; the file catches up next time.
      console.warn(`[ipod-list] could not write ${input.ipodName}’s pool file:`, (err as Error)?.message ?? err)
    }
  }
  return {
    poolIds, listIds: [...list.ids], names, source: 'homemini', note: null, updatedAt,
    ...(list.brain.everyDays !== undefined ? { everyDays: list.brain.everyDays } : {}),
  }
}
