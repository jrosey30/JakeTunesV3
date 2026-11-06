/**
 * A show's poster in the artwork store: its own key, its own file, its source and
 * its matte. The rule itself is in src/common/concert-poster.ts.
 *
 * Electron-free (every path is passed in), so the app and the headless script
 * write the same files the same way.
 *
 * ⚠️ TWIN of the key convention: artwork-engine.ts artworkHash builds the md5 of
 * `artist|||album` the same way. A poster is an ordinary entry in that store:
 * `<hash>.jpg`, `<hash>.meta.json`, an index line `key → <hash>_<epoch>`, so the
 * rsync to homemini, the replica mirror and the self-heal all carry it unchanged.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isMatteColour, isPosterSource, mergedAlbumArtworkKey, posterArtworkKey, posterArtworkParts, POSTER_GROUND,
  builtPosterSpec, posterWords, type PosterFacts, type PosterSource,
} from '../common/concert-poster.ts'
import { imageToJpeg, readEdgeMatte, renderBuiltPoster, type RenderedPoster } from './concert-poster-render.ts'

export function md5Hex(s: string): string {
  return createHash('md5').update(s).digest('hex')
}

/** The poster file's name in the artwork store, and what concert.poster holds. */
export function posterArtworkHash(albumKey: string): string {
  return md5Hex(posterArtworkKey(albumKey))
}

/** The fields a show's `concert` block gets. */
export interface PosterFields {
  poster: string
  posterSource: PosterSource
  posterMatte: string
}

export interface InstalledPoster {
  /** The poster's index key. */
  key: string
  /** The bare hash: `<hash>.jpg` in the artwork store. */
  hash: string
  /** `<hash>_<epoch>`, what the index maps the key to, so a replacement busts caches. */
  versioned: string
  /** The merged recording's "(live set)" key, which also points at the poster. */
  aliasKey: string
  bytes: number
  fields: PosterFields
}

/**
 * Put an image into the store as this show's poster, and write the sidecar that
 * makes the store self-describing. A replica's load-artwork-map merges the key
 * from that sidecar, and the locked-backup copy means a lost poster comes back on
 * the next launch (selfHealUserLockedArtwork).
 *
 * The index is the caller's to save (withPosterKeys): the app serializes its
 * saves through saveArtworkIndex, and the script writes its own file.
 */
export async function installPosterImage(input: {
  artworkDir: string
  albumKey: string
  imagePath: string
  source: PosterSource
  now?: number
  /** Already measured: the migration reports the matte before it writes anything. */
  matte?: string
}): Promise<InstalledPoster> {
  const now = input.now ?? Date.now()
  const key = posterArtworkKey(input.albumKey)
  const hash = md5Hex(key)
  const dest = join(input.artworkDir, `${hash}.jpg`)
  await mkdir(input.artworkDir, { recursive: true })
  await imageToJpeg(input.imagePath, dest)
  const bytes = (await stat(dest)).size
  // A built poster's ground IS its edge: exact, so its matte can never drift from
  // what was drawn. Anything else is measured from the poster itself.
  // A poster with no measured matte still draws: on the plain ground, never not at all.
  const matte = input.matte ?? (input.source === 'built' ? POSTER_GROUND : await readEdgeMatte(dest).catch((err: unknown) => {
    console.warn('[concert-poster] no matte from this image (the plain ground stands in):', err instanceof Error ? err.message : err)
    return POSTER_GROUND
  }))
  const backupDir = join(input.artworkDir, 'locked-backup')
  try {
    await mkdir(backupDir, { recursive: true })
    await copyFile(dest, join(backupDir, `${hash}.jpg`))
  } catch (err) {
    console.warn('[concert-poster] backup copy failed (continuing):', err instanceof Error ? err.message : err)
  }
  const { artist, album } = posterArtworkParts(input.albumKey)
  const meta = {
    artist, album, key,
    source: 'concert-poster',
    posterSource: input.source,
    posterMatte: matte,
    albumKey: input.albumKey,
    bytes,
    importedAt: new Date(now).toISOString(),
  }
  await writeFile(join(input.artworkDir, `${hash}.meta.json`), JSON.stringify(meta, null, 2), 'utf-8')
  return {
    key, hash, versioned: `${hash}_${now}`, aliasKey: mergedAlbumArtworkKey(input.albumKey), bytes,
    fields: { poster: hash, posterSource: input.source, posterMatte: matte },
  }
}

/**
 * A poster already in the store for this show, read from its sidecar. Undeclaring a
 * show leaves its poster behind, and declaring it again must not build over Jake's
 * pick: the rule's first line is "Jake's pick, always".
 */
export async function posterInStore(artworkDir: string, albumKey: string, now: number = Date.now()): Promise<InstalledPoster | null> {
  const key = posterArtworkKey(albumKey)
  const hash = md5Hex(key)
  try {
    const bytes = (await stat(join(artworkDir, `${hash}.jpg`))).size
    const meta = JSON.parse(await readFile(join(artworkDir, `${hash}.meta.json`), 'utf-8')) as { posterSource?: unknown; posterMatte?: unknown }
    if (!bytes || !isPosterSource(meta.posterSource)) return null
    return {
      key, hash, versioned: `${hash}_${now}`, aliasKey: mergedAlbumArtworkKey(albumKey), bytes,
      fields: { poster: hash, posterSource: meta.posterSource, posterMatte: isMatteColour(meta.posterMatte) ? meta.posterMatte : POSTER_GROUND },
    }
  } catch { return null }
}

/** The artwork index with this show's poster under its key and the merged row's key. */
export function withPosterKeys(index: Record<string, string>, installed: Pick<InstalledPoster, 'key' | 'aliasKey' | 'versioned'>): Record<string, string> {
  return { ...index, [installed.key]: installed.versioned, [installed.aliasKey]: installed.versioned }
}

/** The file a cover key's index value names, or null. A version suffix is not part of the name. */
export function coverFileName(indexValue: string | undefined): string | null {
  if (!indexValue) return null
  return `${indexValue.replace(/_\d+$/, '')}.jpg`
}

/** Draw a built poster to `outPath`: the mock's drawing, from grounded words only. */
export async function renderPosterForShow(input: {
  facts: PosterFacts
  coverPath: string | null
  outPath: string
  fontPath: string | null
}): Promise<RenderedPoster> {
  return renderBuiltPoster({
    spec: builtPosterSpec(posterWords(input.facts)),
    coverPath: input.coverPath,
    outPath: input.outPath,
    fontPath: input.fontPath,
  })
}
