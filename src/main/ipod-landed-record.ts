/**
 * What each converted song on an iPod is, recorded at the sync that put it there
 * (Brief 265 Part 5, Amendment 2).
 *
 * The swap planner keeps a song when the file this sync would copy is the size of the one on
 * the card. For a converted song that file is a mirror in the sync-convert cache, so an empty
 * cache meant every converted song was converted again just to learn its size (1,415 iPod-safe
 * ALAC rescues on iBANDCAMP, every AAC on the nano). The landed record answers instead: for
 * each converted song it holds the card path, the card file's size, the master's revision when
 * it was converted (size + mtime), the codec and bitrate it was converted to, and the recipe
 * version (the cache-key token). A song is kept from the record only when EVERY field still
 * matches: the card file is there at the recorded size, the master hasn't changed, the iPod's
 * profile wants the same codec and bitrate, and the recipe is the current one. Any mismatch
 * sends that one song down the normal path. A mirror is built only when a song really has to
 * be copied.
 *
 * Only converted songs are recorded: a master copied as it is already stays by its own size.
 * Written once per sealed sync, in the iPod's own state folder. Pure parts first; node --test.
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AAC_MIRROR_TOKEN, IPOD_ALAC_MIRROR_TOKEN, MP3_MIRROR_TOKEN } from './aac-mirror-recipe.ts'

export const LANDED_RECORD_FILE = 'ipod-landed-record.json'

export type LandedCodec = 'aac' | 'mp3' | 'alac-safe'

export interface LandedEntry {
  /** The library row's path (colon form) the card copy was made from. */
  rawColon: string
  /** Where it is on the card (colon form). */
  destPath: string
  /** The card file's size. */
  size: number
  /** The master when it was converted. */
  source: { size: number; mtimeMs: number }
  codec: LandedCodec
  /** Target kbps for AAC / MP3; null for the iPod-safe ALAC. */
  kbps: number | null
  /** The recipe version (cache-key token) that made it. */
  recipe: string
}

/** The current recipe token for a codec: a bump in aac-mirror-recipe.ts makes every older entry stale. */
export function recipeFor(codec: LandedCodec): string {
  return codec === 'aac' ? AAC_MIRROR_TOKEN : codec === 'mp3' ? MP3_MIRROR_TOKEN : IPOD_ALAC_MIRROR_TOKEN
}

export interface LandedNow {
  rawColon: string
  /** The master on this Mac now. */
  sourceSize: number
  sourceMtimeMs: number
  /** What this sync would convert the song to. */
  codec: LandedCodec
  kbps: number | null
  /** The card file at the recorded path, now (null = not there). */
  cardSize: number | null
}

/** 'keep', or the plain reason the song goes down the normal path. */
export function landedVerdict(e: LandedEntry | undefined, now: LandedNow): 'keep' | string {
  if (!e) return 'no record'
  if (e.rawColon !== now.rawColon) return 'another file'
  if (now.cardSize === null) return 'not on the card'
  if (now.cardSize !== e.size) return 'the card file changed'
  if (e.source.size !== now.sourceSize || Math.round(e.source.mtimeMs) !== Math.round(now.sourceMtimeMs)) return 'the master changed'
  if (e.codec !== now.codec) return 'another format'
  if ((e.kbps ?? null) !== (now.kbps ?? null)) return 'another bitrate'
  if (e.recipe !== recipeFor(now.codec)) return 'an older recipe'
  return 'keep'
}

function parseEntry(raw: unknown): LandedEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const src = r.source as Record<string, unknown> | undefined
  const codec = r.codec
  if (typeof r.rawColon !== 'string' || typeof r.destPath !== 'string' || typeof r.recipe !== 'string') return null
  if (codec !== 'aac' && codec !== 'mp3' && codec !== 'alac-safe') return null
  const size = Number(r.size), ss = Number(src?.size), sm = Number(src?.mtimeMs)
  if (!(size > 0) || !(ss > 0) || !Number.isFinite(sm)) return null
  const kbps = r.kbps === null || r.kbps === undefined ? null : Number(r.kbps)
  if (kbps !== null && !(kbps > 0)) return null
  return { rawColon: r.rawColon, destPath: r.destPath, size, source: { size: ss, mtimeMs: sm }, codec, kbps, recipe: r.recipe }
}

export function parseLandedRecord(raw: unknown): Map<number, LandedEntry> {
  const out = new Map<number, LandedEntry>()
  const entries = (raw as { entries?: unknown } | null)?.entries
  if (!entries || typeof entries !== 'object') return out
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    const id = Number(k)
    const e = parseEntry(v)
    if (Number.isInteger(id) && e) out.set(id, e)
  }
  return out
}

/** Why a song kept by the record can't be copied: converting it again gave nothing. */
export const NOT_CONVERTED_AGAIN = "it couldn't be converted again for this iPod (its master is never copied in place of the converted copy)"

/**
 * The record and the time of the seal it was written at. A missing or torn record is an empty
 * one: the songs go down the normal path, nothing is lost.
 */
export async function readLandedRecord(stateDir: string): Promise<{ at: string | null; entries: Map<number, LandedEntry> }> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, LANDED_RECORD_FILE), 'utf-8')) as { at?: unknown }
    return { at: typeof raw.at === 'string' ? raw.at : null, entries: parseLandedRecord(raw) }
  } catch {
    return { at: null, entries: new Map() }
  }
}

/** Gone before a sync writes to the card. Missing is fine; anything else is a failure the caller refuses on. */
export async function deleteLandedRecord(stateDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await unlink(join(stateDir, LANDED_RECORD_FILE))
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function writeLandedRecord(stateDir: string, entries: Map<number, LandedEntry>, at: string): Promise<void> {
  const path = join(stateDir, LANDED_RECORD_FILE)
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, at, entries: Object.fromEntries(entries) }), 'utf-8')
  await rename(tmp, path)
}
