/**
 * The converted copies a size limit may never take (Brief 265 Part 5; Jake, 2026-11-20: an
 * emptied cache made the punkPod convert 1,190 songs again and the music popped).
 *
 * For every iPod this Mac has synced, its last sync record (last-sync-manifest.json: the
 * Original's in the state dir, every other iPod's in ipod-pools/<id>/) names the songs on it
 * now. Each of those songs' masters can have a converted copy in the cache under any of the
 * recipes (AAC or MP3 at any bitrate, the iPod-safe ALAC); every such name is protected, so a
 * limit never takes a copy a song on an iPod was made from. Unknown or unreadable records
 * protect nothing extra; they never make anything deletable.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { aacMirrorCacheName, ipodAlacMirrorCacheName, mp3MirrorCacheName } from './aac-mirror-recipe.ts'

const KBPS = [128, 192, 256, 320]

/** Every cache name a song's master can have been converted under. */
export function mirrorNamesFor(masterAbs: string): string[] {
  return [
    ...KBPS.map((k) => aacMirrorCacheName(masterAbs, k)),
    ...KBPS.map((k) => mp3MirrorCacheName(masterAbs, k)),
    ipodAlacMirrorCacheName(masterAbs),
  ]
}

async function manifestIds(file: string): Promise<number[]> {
  try {
    const m = JSON.parse(await readFile(file, 'utf-8')) as { tracks?: Array<{ id?: unknown }> }
    return (m.tracks ?? []).map((t) => Number(t?.id)).filter((id) => Number.isInteger(id) && id >= 0)
  } catch { return [] }
}

/**
 * The protected names. `libraryRoot` is the folder holding iPod_Control/Music; `tracks` the
 * library (id → colon path).
 */
export async function protectedMirrorNames(opts: {
  stateDir: string
  libraryRoot: string
  tracks: ReadonlyArray<{ id?: unknown; path?: unknown }>
}): Promise<Set<string>> {
  const files = [join(opts.stateDir, 'last-sync-manifest.json')]
  const pools = await readdir(join(opts.stateDir, 'ipod-pools')).catch(() => [] as string[])
  for (const p of pools) files.push(join(opts.stateDir, 'ipod-pools', p, 'last-sync-manifest.json'))
  const pathById = new Map<number, string>()
  for (const t of opts.tracks) if (typeof t.path === 'string' && t.path) pathById.set(Number(t.id), t.path)
  const out = new Set<string>()
  for (const f of files) {
    for (const id of await manifestIds(f)) {
      const colon = pathById.get(id)
      if (!colon) continue
      const abs = join(opts.libraryRoot, ...colon.replace(/^:/, '').split(':'))
      for (const n of mirrorNamesFor(abs)) out.add(n)
    }
  }
  return out
}
