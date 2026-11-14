/**
 * On-The-Go playlists, brought home (2026-11-13).
 *
 * Jake: "the on-the-go playlist feature, on the ipod needs to work on each
 * device." The click wheel builds a list on the iPod; the firmware keeps it in
 * `iPod_Control/iTunes/OTGPlaylistInfo` (and `_1`, `_2`… for saved ones) as
 * positions in the on-card catalog. The round trip (sync-engine/roundtrip.ts)
 * maps those to library ids; this file keeps them, per iPod, as real playlists:
 *
 *   <iPod state dir>/ipod-otg-playlists.json
 *
 * numbered up from the last one the way iTunes and gnupod did ("On-The-Go 1",
 * "On-The-Go 2" …). The next sync writes each back to the iPod as a normal
 * playlist and clears the firmware's files, so the iPod's own On-The-Go starts
 * empty again.
 *
 * ONE LIST IS SAVED ONCE. A list is known by what it is — this iPod, these
 * songs, in this order — never by the files it arrived in. The firmware's play
 * log changes every time a song is played, so a key that includes it saved the
 * same list again on every plug-in (review of PR 412: On-The-Go 1, 2 and 3 all
 * the same three songs).
 *
 * Order of safety, enforced by the callers: this file is written (temp file,
 * rename, read back) BEFORE the round-trip state records the snapshot, and the
 * pre-sync gate refuses to let a sync touch the card until that state shows it
 * (ipod-plays-archive.ts securePlaysBeforeSync). A raw copy of the firmware's
 * files is kept in the plays archive as well and is never deleted.
 *
 * A DAMAGED FILE never costs a list that can still be read, and never blocks
 * for good: the whole file as found is moved aside to
 * `ipod-otg-playlists.json.corrupt-<date>` (nothing in it is lost), the rows
 * that read are written back, and the log says what happened and where the
 * aside copy is. Only when the bad file can't be moved aside does this stop,
 * and the message says which file to move.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

export const OTG_PLAYLISTS_FILE = 'ipod-otg-playlists.json'

export interface OtgPlaylist {
  /** `otg-<hash of the iPod's key and the songs in order>`: the same list is the same id. */
  id: string
  /** 1, 2, 3 … per iPod, never reused. */
  n: number
  /** What the iPod shows: "On-The-Go 3". */
  deviceName: string
  /** What the library shows: "On-The-Go 3 — punkPod". */
  name: string
  createdAt: string
  /** The round-trip snapshot it was first seen in (for the record only; not its identity). */
  snapshot: string
  trackIds: number[]
  /** How many songs the list had on the iPod, when some couldn't be matched to the library. */
  onIpod?: number
}

interface OtgDoc { version: 1; playlists: OtgPlaylist[] }

/** The file system calls a save makes; injected only by tests. */
export interface OtgIo {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}
const realIo: OtgIo = {
  readFile: (p) => readFile(p, 'utf-8'),
  writeFile: (p, t) => writeFile(p, t, 'utf-8'),
  rename: (a, b) => rename(a, b),
}

const isPlaylist = (p: unknown): p is OtgPlaylist => {
  const o = p as OtgPlaylist | null
  return !!o && typeof o.id === 'string' && Number.isInteger(o.n) && o.n > 0 && typeof o.name === 'string' &&
    typeof o.deviceName === 'string' && Array.isArray(o.trackIds) && o.trackIds.every((x) => Number.isInteger(x))
}

/** A list's identity: the iPod it was made on and its songs in order. */
export function otgListId(deviceKey: string, trackIds: readonly number[]): string {
  return `otg-${createHash('sha1').update(`${deviceKey}\n${trackIds.join(',')}`).digest('hex').slice(0, 16)}`
}

async function writeDoc(io: OtgIo, path: string, playlists: OtgPlaylist[]): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await io.writeFile(tmp, JSON.stringify({ version: 1, playlists } satisfies OtgDoc, null, 1))
  await io.rename(tmp, path)
}

export interface OtgRead {
  playlists: OtgPlaylist[]
  /** Set when the file was damaged and repaired: plain words for the log and for Jake. */
  repaired: string | null
}

/**
 * The saved lists, oldest number first, repairing a damaged file on the way
 * (see the header). Throws only when a damaged file can't be moved aside.
 */
export async function readOtgPlaylistsRepairing(stateDir: string, opts: { now?: Date; io?: OtgIo; warn?: (m: string) => void } = {}): Promise<OtgRead> {
  const io = opts.io ?? realIo
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const path = join(stateDir, OTG_PLAYLISTS_FILE)
  let text: string
  try {
    text = await io.readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { playlists: [], repaired: null }
    throw new Error(`The saved On-The-Go lists (${path}) can’t be opened: ${(err as Error).message}. Nothing was changed. Fix the file’s permissions, or move it out of that folder, and sync again.`)
  }
  let rows: unknown[] | null = null
  try {
    const doc = JSON.parse(text) as { playlists?: unknown } | null
    if (doc && Array.isArray(doc.playlists)) rows = doc.playlists
  } catch { /* not JSON: rows stays null */ }
  const good = (rows ?? []).filter(isPlaylist).sort((a, b) => a.n - b.n)
  const bad = rows === null ? null : rows.length - good.length
  if (bad === 0) return { playlists: good, repaired: null }

  // Damaged. Keep every byte of it aside, then write back only what read.
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const aside = `${path}.corrupt-${stamp}`
  try {
    await io.rename(path, aside)
  } catch (err) {
    throw new Error(`The saved On-The-Go lists (${path}) are damaged and couldn’t be moved aside (${(err as Error).message}). Nothing was changed. Move that file out of the folder and sync again; lists already on the iPod or on homemini are not affected.`)
  }
  if (good.length > 0) await writeDoc(io, path, good)
  const repaired = bad === null
    ? `The saved On-The-Go lists file was unreadable. It was moved aside, whole, to ${aside} and a fresh one was started; nothing in it was deleted.`
    : `${bad} saved On-The-Go list(s) were unreadable. The file as found was moved aside, whole, to ${aside}; the ${good.length} list(s) that read were kept.`
  warn(`[otg] ${repaired}`)
  return { playlists: good, repaired }
}

/** The saved lists, oldest number first (a damaged file is repaired, see above). */
export async function readOtgPlaylists(stateDir: string): Promise<OtgPlaylist[]> {
  return (await readOtgPlaylistsRepairing(stateDir)).playlists
}

export interface OtgListIn {
  /** Library ids, in his order. */
  trackIds: number[]
  /** How many songs the list had on the iPod (≥ trackIds.length). */
  onIpod?: number
}

/** The lists a round trip adds to what is already saved. Pure. */
export function planOtgSave(
  existing: OtgPlaylist[],
  input: { snapshot: string; lists: OtgListIn[]; ipodName: string; deviceKey: string; now: Date },
): OtgPlaylist[] {
  const have = new Set(existing.map((p) => p.id))
  let n = existing.reduce((m, p) => Math.max(m, p.n), 0)
  const ipod = input.ipodName.trim() || 'iPod'
  const out: OtgPlaylist[] = []
  for (const list of input.lists) {
    const trackIds = list.trackIds.filter((x) => Number.isInteger(x))
    if (trackIds.length === 0) continue
    const id = otgListId(input.deviceKey, trackIds)
    if (have.has(id)) continue
    have.add(id)
    n += 1
    out.push({
      id, n,
      deviceName: `On-The-Go ${n}`,
      name: `On-The-Go ${n} — ${ipod}`,
      createdAt: input.now.toISOString(),
      snapshot: input.snapshot,
      trackIds,
      ...(list.onIpod && list.onIpod > trackIds.length ? { onIpod: list.onIpod } : {}),
    })
  }
  return out
}

/**
 * Save a round trip's On-The-Go lists. Resolves only once the file on disk has
 * been read back and holds every one of them; throws otherwise.
 */
export async function saveOtgLists(
  stateDir: string,
  input: { snapshot: string; lists: OtgListIn[]; ipodName: string; deviceKey: string; now?: Date },
  io: OtgIo = realIo,
): Promise<OtgPlaylist[]> {
  await mkdir(stateDir, { recursive: true })
  const now = input.now ?? new Date()
  const existing = (await readOtgPlaylistsRepairing(stateDir, { now, io })).playlists
  const added = planOtgSave(existing, { ...input, now })
  if (added.length === 0) return []
  const path = join(stateDir, OTG_PLAYLISTS_FILE)
  await writeDoc(io, path, [...existing, ...added])
  let back: OtgPlaylist[] = []
  try {
    const doc = JSON.parse(await io.readFile(path)) as { playlists?: unknown }
    back = Array.isArray(doc?.playlists) ? doc.playlists.filter(isPlaylist) : []
  } catch { /* back stays empty: the check below fails */ }
  for (const p of added) {
    const got = back.find((b) => b.id === p.id)
    if (!got || got.trackIds.join(',') !== p.trackIds.join(',')) {
      throw new Error(`${p.deviceName} did not read back from ${path} after it was saved`)
    }
  }
  return added
}
