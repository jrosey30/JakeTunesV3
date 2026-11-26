/**
 * The converted copies a size limit or Empty may never take (Brief 265 Part 5; Jake, 2026-11-20:
 * an emptied cache made the punkPod convert 1,190 songs again and the music popped).
 *
 * For every iPod this Mac has synced, its last sync record (last-sync-manifest.json: the
 * Original's in the state dir, every other iPod's in ipod-pools/<id>/) names the songs on it
 * now. Each of those songs' masters can have a converted copy in the cache under any of the
 * recipes (AAC or MP3 at any bitrate, the iPod-safe ALAC); every such name is protected.
 *
 * It fails CLOSED: anything that keeps the set from being complete THROWS, and the caller then
 * takes nothing. An empty library (library.json unreadable or missing reads as no songs), a sync
 * record that exists but can't be read, a state folder that can't be listed, a song on an iPod
 * that the library doesn't have, or the library folder not known yet: each throws.
 *
 * Not protected, and can't be: a song staged from homemini for a sync (its master is only on
 * homemini) is converted from a temporary file, so its copy's name hashes that temp path. Those
 * copies are made again when such a song has to be copied.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { aacMirrorCacheName, ipodAlacMirrorCacheName, mp3MirrorCacheName } from './aac-mirror-recipe.ts'

const KBPS = [128, 192, 256, 320]

/**
 * The protected copies couldn't be worked out. `message` is for the log (it may name a file or
 * a song id); `plain` is what the Device page shows: plain words, never an id or a path.
 */
export class ProtectionUnknownError extends Error {
  readonly plain: string
  constructor(message: string, plain: string) { super(message); this.name = 'ProtectionUnknownError'; this.plain = plain }
}

const RECORD_UNREADABLE = 'The record of what’s on one of your iPods couldn’t be read. Sync that iPod, then try again.'
/** A song deleted from the library that an iPod still holds (Brief 265 review of #506). */
export const DELETED_SONG_ON_IPOD = 'A song deleted from the library is still on an iPod. Sync that iPod, then try again.'
export const LIBRARY_LOADING = 'The library is still loading. Try again in a minute.'

/** What the page says about a failed protection: the error's plain words, else a generic line. */
export function plainProtectionWhy(err: unknown): string {
  return err instanceof ProtectionUnknownError ? err.plain : 'Couldn’t tell which converted copies the songs on your iPods use. Try again in a minute.'
}

/** Every cache name a song's master can have been converted under. */
export function mirrorNamesFor(masterAbs: string): string[] {
  return [
    ...KBPS.map((k) => aacMirrorCacheName(masterAbs, k)),
    ...KBPS.map((k) => mp3MirrorCacheName(masterAbs, k)),
    ipodAlacMirrorCacheName(masterAbs),
  ]
}

/** The song ids in one sync record. A missing record is no songs; one that can't be read throws. */
async function manifestIds(file: string): Promise<number[]> {
  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new ProtectionUnknownError(`a sync record can't be read (${file}): ${err instanceof Error ? err.message : String(err)}`, RECORD_UNREADABLE)
  }
  let m: { tracks?: unknown }
  try { m = JSON.parse(text) as { tracks?: unknown } } catch {
    throw new ProtectionUnknownError(`a sync record is damaged (${file})`, RECORD_UNREADABLE)
  }
  if (!Array.isArray(m.tracks)) throw new ProtectionUnknownError(`a sync record has no song list (${file})`, RECORD_UNREADABLE)
  return (m.tracks as Array<{ id?: unknown }>).map((t) => {
    const id = Number(t?.id)
    if (!Number.isInteger(id) || id < 0) throw new ProtectionUnknownError(`a sync record names a song it can't (${file})`, RECORD_UNREADABLE)
    return id
  })
}

/**
 * The protected names. `libraryRoot` is the folder holding iPod_Control/Music (null = not known
 * yet: throws); `tracks` the library (id → colon path).
 */
export async function protectedMirrorNames(opts: {
  stateDir: string
  libraryRoot: string | null
  tracks: ReadonlyArray<{ id?: unknown; path?: unknown }>
}): Promise<Set<string>> {
  if (!opts.libraryRoot) throw new ProtectionUnknownError('the library folder isn’t known yet', LIBRARY_LOADING)
  if (opts.tracks.length === 0) throw new ProtectionUnknownError('the library can’t be read (no songs)', 'The library couldn’t be read. Try again in a minute.')
  const files = [join(opts.stateDir, 'last-sync-manifest.json')]
  let pools: string[] = []
  try {
    pools = await readdir(join(opts.stateDir, 'ipod-pools'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProtectionUnknownError(`the iPods' sync records can't be listed: ${err instanceof Error ? err.message : String(err)}`, 'The record of what’s on your iPods couldn’t be read. Try again in a minute.')
  }
  for (const p of pools) files.push(join(opts.stateDir, 'ipod-pools', p, 'last-sync-manifest.json'))
  const pathById = new Map<number, string>()
  for (const t of opts.tracks) if (typeof t.path === 'string' && t.path) pathById.set(Number(t.id), t.path)
  const out = new Set<string>()
  for (const f of files) {
    for (const id of await manifestIds(f)) {
      const colon = pathById.get(id)
      if (!colon) throw new ProtectionUnknownError(`song ${id} is on an iPod (${f}) but not in the library`, DELETED_SONG_ON_IPOD)
      const abs = join(opts.libraryRoot, ...colon.replace(/^:/, '').split(':'))
      for (const n of mirrorNamesFor(abs)) out.add(n)
    }
  }
  return out
}
