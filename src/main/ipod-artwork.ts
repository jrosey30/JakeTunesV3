/**
 * Album covers on colour-screen iPods (2026-11-18). Until now no sync wrote
 * any: Jake's "iBANDCAMP" (an iPod Video, 2,089 songs) showed no covers.
 *
 * Two halves:
 *  - prepareArtworkArgs: before the catalog is built, each song is matched to
 *    the cover file the app itself shows for its album (artwork-engine.ts
 *    resolveArtworkFile — the desktop's own cache, never re-fetched). The
 *    map goes to db_reader as a file (--artwork-map), so the rows the sync
 *    writes are never changed.
 *  - installArtworkOnIpod: core/db_reader.py --artwork-out builds ArtworkDB +
 *    .ithmb files on the Mac (core/ipod_artwork.py); this copies them onto
 *    the iPod. Only the Python side knows which iPods take art; for a mini or
 *    an unknown model the folder stays empty and nothing here touches the card.
 *
 * Art never fails the music: every error is logged and the sync carries on.
 * The card is never left with a NEW ArtworkDB over OLD thumbnails (or the
 * other way round): every file goes on under a temporary name first, and only
 * when all of them are there are they renamed into place, thumbnails first,
 * ArtworkDB last. A rename that fails part-way removes ArtworkDB, so the iPod
 * shows no covers rather than wrong ones.
 */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { ARTWORK_FAMILIES_BY_HARDWARE, artworkFamilyFor, hardwareForUsb, parseSysInfo, type IpodUsbFacts } from '../common/ipod-onboarding.ts'

type Row = Record<string, unknown>

/** The cover to put on the iPod for each song, by song id: the album
 *  artist's album first (how the app's album grids key art), then the song's
 *  own artist. One look per album. */
export async function artworkPathsFor(
  tracks: Row[],
  resolve: (artist: string, album: string) => Promise<string | null>,
): Promise<{ paths: Record<string, string>; withArt: number }> {
  const memo = new Map<string, Promise<string | null>>()
  const look = (artist: string, album: string): Promise<string | null> => {
    const key = `${artist}\u0000${album}`
    let p = memo.get(key)
    if (!p) {
      p = resolve(artist, album).catch((err: unknown) => {
        console.warn(`ipod-artwork: no cover for "${artist} — ${album}" (${errText(err)})`)
        return null
      })
      memo.set(key, p)
    }
    return p
  }
  const paths: Record<string, string> = {}
  for (const t of tracks) {
    const album = String(t.album ?? '').trim()
    const artist = String(t.artist ?? '').trim()
    const albumArtist = String(t.albumArtist ?? '').trim()
    if (!album || t.id === undefined || t.id === null) continue
    let path: string | null = null
    if (albumArtist) path = await look(albumArtist, album)
    if (!path && artist && artist !== albumArtist) path = await look(artist, album)
    if (path) paths[String(t.id)] = path
  }
  return { paths, withArt: Object.keys(paths).length }
}

/** Look up every song's cover and write the map db_reader reads. Returns the
 *  extra db_reader arguments, or [] when anything went wrong (no art then). */
export async function prepareArtworkArgs(
  tracks: Row[],
  resolve: (artist: string, album: string) => Promise<string | null>,
  localDir: string,
  log: (line: string) => void,
  /** The plugged-in iPod's own state folder: its thumbnail cache, and the
   *  model Jake named for it when the iPod itself doesn't say (rememberArtworkFamily). */
  opts: {
    ipodStateDir?: string
    /** The family the plugged-in iPod's USB id names (artworkFamilyByUsb), asked only when
     *  nothing is remembered for it; the answer is then remembered. */
    usbFamily?: () => Promise<string | null>
  } = {},
): Promise<string[]> {
  try {
    await clearLocalArtwork(localDir)
    const { paths, withArt } = await artworkPathsFor(tracks, resolve)
    const mapFile = localDir + '.map.json'
    await writeFile(mapFile, JSON.stringify(paths))
    log(`${withArt}/${tracks.length} song(s) have a cover in the app`)
    const args = ['--artwork-out', localDir, '--artwork-map', mapFile]
    if (opts.ipodStateDir) {
      args.push('--artwork-cache', join(opts.ipodStateDir, ARTWORK_CACHE_DIR))
      let family = await rememberedArtworkFamily(opts.ipodStateDir)
      if (!family && opts.usbFamily) {
        // An iPod set up before set-up settled this (Indie Sleaze, 2026-11-23): its USB id.
        const byUsb = await opts.usbFamily().catch(() => null)
        if (byUsb && (await rememberArtworkFamily(opts.ipodStateDir, byUsb, ARTWORK_FAMILIES_BY_HARDWARE).catch(() => false))) {
          family = byUsb
          log(`this iPod is ${byUsb} by its USB id; remembered`)
        }
      }
      if (family) args.push('--artwork-family', family)
    }
    return args
  } catch (err) {
    log(`cover lookup failed (non-fatal, no covers this sync): ${errText(err)}`)
    return []
  }
}

/** Thumbnails kept between syncs, in the iPod's own state folder (core/ipod_artwork.py ThumbCache). */
export const ARTWORK_CACHE_DIR = 'artwork-thumbs'
/** The model Jake named for an iPod that doesn't say what it is. */
export const ARTWORK_MODEL_FILE = 'ipod-artwork-model.json'

/** The family Jake named for this iPod ('none' = no colour screen), or null. */
export async function rememberedArtworkFamily(ipodStateDir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(ipodStateDir, ARTWORK_MODEL_FILE), 'utf-8')) as { family?: unknown }
    return typeof raw.family === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.family) ? raw.family : null
  } catch {
    return null
  }
}

/** Remember Jake's answer for this iPod. Only a family the table knows, or 'none'. */
export async function rememberArtworkFamily(ipodStateDir: string, family: string, known: readonly string[]): Promise<boolean> {
  if (family !== 'none' && !known.includes(family)) return false
  await mkdir(ipodStateDir, { recursive: true })
  const tmp = join(ipodStateDir, `${ARTWORK_MODEL_FILE}.tmp-${process.pid}`)
  await writeFile(tmp, JSON.stringify({ family, at: new Date().toISOString() }))
  await rename(tmp, join(ipodStateDir, ARTWORK_MODEL_FILE))
  return true
}

/**
 * The cover family the plugged-in iPod's USB product id names (common artworkFamilyFor), or
 * null. Not asked when SysInfo names a model: core/ipod_artwork.py reads that first, and the
 * USB look (system_profiler) costs seconds. Never throws.
 */
export async function artworkFamilyByUsb(mount: string, usb: (mount: string) => Promise<IpodUsbFacts | null>): Promise<string | null> {
  try {
    const sys = parseSysInfo(await readFile(join(mount, 'iPod_Control', 'Device', 'SysInfo'), 'utf-8').catch(() => ''))
    if (sys.modelNumStr) return null
    const hw = hardwareForUsb((await usb(mount))?.productId)
    return hw ? artworkFamilyFor(hw) : null
  } catch (err) {
    console.warn(`ipod-artwork: no USB answer (${errText(err)})`)
    return null
  }
}

/** What the sync did about covers, from db_reader's JSON answer (its `artwork` key). */
export interface ArtworkOutcome {
  /** Covers written for this many songs (0 = none this sync). */
  images: number
  /** The table's family name for this iPod, if known. */
  model: string | null
  /** Nothing on the iPod says what it is: ask Jake once. */
  ask: boolean
  /** Why there are no covers, in plain words, or null. */
  skipped: string | null
}

export function artworkOutcome(stdout: string): ArtworkOutcome | null {
  let art: Record<string, unknown> | undefined
  try {
    art = (JSON.parse(stdout) as { artwork?: Record<string, unknown> }).artwork
  } catch {
    return null
  }
  if (!art || typeof art !== 'object') return null
  const images = typeof art.images === 'number' ? art.images : 0
  const model = typeof art.familyName === 'string' ? art.familyName : null
  const ask = art.ask === true
  let skipped: string | null = null
  if (ask) skipped = 'JakeTunes doesn’t know which iPod this is'
  else if (typeof art.error === 'string') skipped = 'the covers couldn’t be made'
  return { images, model, ask, skipped }
}

/** The colour iPods the table knows, for "Which iPod is this?" (core/ipod_artwork_models.json). */
export async function artworkFamilies(modelsFile: string): Promise<Array<{ family: string; name: string }>> {
  try {
    const doc = JSON.parse(await readFile(modelsFile, 'utf-8')) as { families?: Array<{ family?: unknown; name?: unknown; artwork?: unknown }> }
    return (doc.families ?? [])
      .filter((f) => f.artwork === true && typeof f.family === 'string' && typeof f.name === 'string')
      .map((f) => ({ family: f.family as string, name: f.name as string }))
  } catch {
    return []
  }
}

export interface ArtworkInstallResult {
  installed: boolean
  files: string[]
  summary: string
}

const TMP_SUFFIX = '.jt-new'

/**
 * Copy what db_reader left in `localDir` into <mount>/iPod_Control/Artwork.
 * An empty or missing `localDir` (a mini, an unknown model, art skipped) is
 * a no-op that never touches the card.
 */
export async function installArtworkOnIpod(localDir: string, mount: string): Promise<ArtworkInstallResult> {
  let names: string[]
  try {
    names = (await readdir(localDir)).filter((n) => n === 'ArtworkDB' || /^F\d+_\d+\.ithmb$/.test(n))
  } catch {
    return { installed: false, files: [], summary: 'artwork: none built for this iPod' }
  }
  if (!names.includes('ArtworkDB')) {
    return { installed: false, files: [], summary: 'artwork: none built for this iPod' }
  }
  const thumbs = names.filter((n) => n !== 'ArtworkDB').sort()
  const order = [...thumbs, 'ArtworkDB']
  const dest = join(mount, 'iPod_Control', 'Artwork')
  const staged: string[] = []
  try {
    await mkdir(dest, { recursive: true })
    // 1. Every file on the card under a temporary name, size-checked.
    for (const n of order) {
      const tmp = join(dest, n + TMP_SUFFIX)
      await copyFile(join(localDir, n), tmp)
      staged.push(tmp)
      const [a, b] = await Promise.all([stat(join(localDir, n)), stat(tmp)])
      if (a.size !== b.size) throw new Error(`${n} landed ${b.size} of ${a.size} bytes`)
    }
  } catch (err) {
    for (const tmp of staged) await removeQuietly(tmp)
    return { installed: false, files: [], summary: `artwork: not copied, the iPod keeps its old covers (${errText(err)})` }
  }
  // 2. Into place: thumbnails first, ArtworkDB last.
  try {
    for (const n of order) await rename(join(dest, n + TMP_SUFFIX), join(dest, n))
  } catch (err) {
    // Some thumbnails may already be the new ones: an old ArtworkDB would
    // point into them at the wrong pictures. No covers beats wrong covers.
    await removeQuietly(join(dest, 'ArtworkDB'))
    for (const n of order) await removeQuietly(join(dest, n + TMP_SUFFIX))
    return { installed: false, files: [], summary: `artwork: install interrupted, covers removed until the next sync (${errText(err)})` }
  }
  return { installed: true, files: order, summary: `artwork: ${order.join(', ')} on the iPod` }
}

/** Remove the local build folder and its map (best effort, logged). */
export async function clearLocalArtwork(localDir: string): Promise<void> {
  try {
    await rm(localDir, { recursive: true, force: true })
    await rm(localDir + '.map.json', { force: true })
  } catch (err) {
    console.warn(`ipod-artwork: could not clear ${localDir} (${errText(err)})`)
  }
}

/** Remove a file; a missing one is fine, anything else is logged. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn(`ipod-artwork: could not remove ${path} (${errText(err)})`)
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
