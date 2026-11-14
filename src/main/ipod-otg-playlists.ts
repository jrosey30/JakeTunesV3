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
 * Order of safety, enforced by the callers: this file is written (temp file,
 * rename, read back) BEFORE the round-trip state records the snapshot, and the
 * pre-sync gate refuses to let a sync touch the card until that state shows it
 * (ipod-plays-archive.ts securePlaysBeforeSync). A raw copy of the firmware's
 * files is kept in the plays archive as well and is never deleted.
 *
 * Saving the same snapshot twice saves nothing new (plug-in and the pre-sync
 * gate both see the same files).
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'

export const OTG_PLAYLISTS_FILE = 'ipod-otg-playlists.json'

export interface OtgPlaylist {
  /** `otg-<snapshot, 12 chars>-<position in that snapshot>`: the same list is the same id. */
  id: string
  /** 1, 2, 3 … per iPod, never reused. */
  n: number
  /** What the iPod shows: "On-The-Go 3". */
  deviceName: string
  /** What the library shows: "On-The-Go 3 — punkPod". */
  name: string
  createdAt: string
  snapshot: string
  trackIds: number[]
}

interface OtgDoc { version: 1; playlists: OtgPlaylist[] }

const isPlaylist = (p: unknown): p is OtgPlaylist => {
  const o = p as OtgPlaylist | null
  return !!o && typeof o.id === 'string' && Number.isInteger(o.n) && o.n > 0 && typeof o.name === 'string' &&
    typeof o.deviceName === 'string' && Array.isArray(o.trackIds) && o.trackIds.every((x) => Number.isInteger(x))
}

/** The saved lists, oldest number first. A missing file is no lists; an unreadable one throws
 *  (a save must never start a new numbering over a file it could not read). */
export async function readOtgPlaylists(stateDir: string): Promise<OtgPlaylist[]> {
  let text: string
  try {
    text = await readFile(join(stateDir, OTG_PLAYLISTS_FILE), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const doc = JSON.parse(text) as OtgDoc
  if (!doc || !Array.isArray(doc.playlists)) throw new Error(`${OTG_PLAYLISTS_FILE} is not a playlist file`)
  return doc.playlists.filter(isPlaylist).sort((a, b) => a.n - b.n)
}

/** The lists a snapshot adds to what is already saved. Pure. */
export function planOtgSave(
  existing: OtgPlaylist[],
  input: { snapshot: string; lists: number[][]; ipodName: string; now: Date },
): OtgPlaylist[] {
  const have = new Set(existing.map((p) => p.id))
  let n = existing.reduce((m, p) => Math.max(m, p.n), 0)
  const ipod = input.ipodName.trim() || 'iPod'
  const out: OtgPlaylist[] = []
  input.lists.forEach((ids, i) => {
    const trackIds = ids.filter((x) => Number.isInteger(x))
    const id = `otg-${input.snapshot.slice(0, 12)}-${i + 1}`
    if (trackIds.length === 0 || have.has(id)) return
    n += 1
    out.push({
      id, n,
      deviceName: `On-The-Go ${n}`,
      name: `On-The-Go ${n} — ${ipod}`,
      createdAt: input.now.toISOString(),
      snapshot: input.snapshot,
      trackIds,
    })
  })
  return out
}

/**
 * Save a snapshot's On-The-Go lists. Resolves only once the file on disk has
 * been read back and holds every one of them; throws otherwise.
 */
export async function saveOtgLists(
  stateDir: string,
  input: { snapshot: string; lists: number[][]; ipodName: string; now?: Date },
): Promise<OtgPlaylist[]> {
  const existing = await readOtgPlaylists(stateDir)
  const added = planOtgSave(existing, { ...input, now: input.now ?? new Date() })
  if (added.length === 0) return []
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, OTG_PLAYLISTS_FILE)
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const doc: OtgDoc = { version: 1, playlists: [...existing, ...added] }
  await writeFile(tmp, JSON.stringify(doc, null, 1), 'utf-8')
  await rename(tmp, path)
  const back = await readOtgPlaylists(stateDir)
  for (const p of added) {
    const got = back.find((b) => b.id === p.id)
    if (!got || got.trackIds.join(',') !== p.trackIds.join(',')) {
      throw new Error(`On-The-Go list ${p.deviceName} did not read back from ${path}`)
    }
  }
  return added
}
