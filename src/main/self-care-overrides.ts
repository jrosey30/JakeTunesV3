/**
 * The nightly check's tag job: Jake's edits (title, artist, album, genre, year,
 * track and disc numbers) reach the song files.
 *
 * It was "File › Library › Apply Overrides to Files…" (Brief 020), which
 * rewrote every edited file, ~1,600 of them, each time it was clicked. Every
 * rewrite is a new file for the vault and homemini to copy, so a nightly copy
 * of that would churn the whole library every night. Here a file is written
 * only when a field on it isn't what Jake set, and never twice for the same
 * values (a ledger, `self-care-tags.json`): the second night writes nothing.
 *
 * Same guards as the old tool, kept from it:
 *   - the entry must still name this song (overrideNamesTrack): a corrected
 *     title or artist is fine, a different song is never written;
 *   - a song the player is using goes on the per-edit line, which writes it
 *     when the player is done (the 2026-11-14 splice).
 * The writer runs at background priority, one file at a time, and stops the
 * moment music or a sync starts.
 */
import { overrideNamesTrack } from './tag-writeback-queue.ts'
import { WRITABLE_FIELDS } from './tag-writer.ts'
import { overrideHash, overrideNeedsWrite, type WantedTags } from './self-care-core.ts'
import type { JobContext, JobOutcome } from './self-care.ts'

type Row = Record<string, unknown>
type OverrideEntry = { fp?: string; fields?: Record<string, string> }

export interface TagJobHost {
  tracks: () => Promise<Row[]>
  overrides: () => Promise<Record<string, OverrideEntry>>
  playerUsing: (colonPath: string, durationMs: number) => boolean
  /** The per-edit line (waits for the player). */
  queueEdit: (e: { trackId: number; field: string; value: string }) => Promise<unknown>
  toAbs: (colonPath: string) => string
  /** The file's current tags under WRITABLE_FIELDS names; null when it can't be read. */
  readTags: (abs: string) => Promise<Record<string, unknown> | null>
  /** Writes these fields at background priority. */
  writeTags: (abs: string, fields: WantedTags) => Promise<{ ok: boolean; written: number; error?: string }>
  /** Size + fingerprint of the files written, for the renderer to save. */
  remeasure: (paths: Set<string>) => Promise<void>
  readLedger: () => Promise<Record<string, string>>
  writeLedger: (ledger: Record<string, string>) => Promise<void>
}

/** One entry's writable values, with the N/M pairs kept whole (Brief 020's pair augmentation). */
export function wantedFor(entry: OverrideEntry, track: Row): WantedTags {
  const writable: WantedTags = {}
  for (const [fname, fval] of Object.entries(entry?.fields || {})) {
    if (WRITABLE_FIELDS.has(fname) && fval !== undefined && fval !== null && fval !== '') writable[fname] = fval
  }
  if (Object.keys(writable).length === 0) return writable
  if (writable.trackNumber && !writable.trackCount && track.trackCount) writable.trackCount = String(track.trackCount)
  if (writable.discNumber && !writable.discCount && track.discCount) writable.discCount = String(track.discCount)
  return writable
}

export async function runTagJob(host: TagJobHost, ctx: JobContext): Promise<JobOutcome> {
  const tracksById = new Map<number, Row>()
  for (const t of await host.tracks()) if (typeof t.id === 'number') tracksById.set(t.id, t)
  const overrides = await host.overrides()
  const ledger = await host.readLedger()
  let written = 0, current = 0, waiting = 0, failed = 0, notThisSong = 0
  const writtenPaths = new Set<string>()
  let ledgerChanged = false
  let interrupted = false

  for (const [keyStr, entry] of Object.entries(overrides)) {
    if (!ctx.stillQuiet()) { interrupted = true; break }
    const trackId = Number(keyStr)
    if (!Number.isFinite(trackId)) continue
    const track = tracksById.get(trackId)
    if (!track) continue
    const wanted = wantedFor(entry, track)
    if (Object.keys(wanted).length === 0) continue
    // Identity guard: the entry must still name this song.
    if (!overrideNamesTrack(entry, track)) { notThisSong++; continue }
    const colonPath = String(track.path || '')
    if (!colonPath) continue
    const hash = overrideHash(colonPath, wanted)
    if (ledger[keyStr] === hash) { current++; continue }
    const abs = host.toAbs(colonPath)
    const fields = overrideNeedsWrite({ ledgerHash: ledger[keyStr], hash, onFile: await host.readTags(abs), wanted })
    if (fields.length === 0) { ledger[keyStr] = hash; ledgerChanged = true; current++; continue }
    // A song the player is using waits on the per-edit line.
    if (host.playerUsing(colonPath, Number(track.duration) || 0)) {
      waiting++
      for (const f of fields) await host.queueEdit({ trackId, field: f, value: String(wanted[f]) })
      continue
    }
    const payload: WantedTags = {}
    for (const f of fields) payload[f] = wanted[f]
    const r = await host.writeTags(abs, payload)
    if (r.ok) {
      written++
      if (r.written > 0) writtenPaths.add(abs)
      ledger[keyStr] = hash
      ledgerChanged = true
    } else {
      failed++
    }
  }

  if (ledgerChanged) await host.writeLedger(ledger)
  if (writtenPaths.size) await host.remeasure(writtenPaths)
  const note = `${written} written, ${current} already right, ${waiting} waiting for the player, ${failed} failed, ${notThisSong} no longer that song`
  return { ok: failed === 0, note, interrupted }
}
