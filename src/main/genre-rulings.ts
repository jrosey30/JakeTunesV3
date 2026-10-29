/**
 * Jake's genre rulings (2026-10-29) — a genre HE decided, applied once on the
 * hub as his own edit, so it travels exactly like a Get Info change:
 *
 *   - written through the filer's persist path (the app's override writer, then
 *     a publish), so the hub catalog — what workmini adopts and the phone
 *     reads — carries it;
 *   - journaled in user-edits.json as his edit (recordEdit = the same
 *     UserEditsSync.record a Get Info save calls), so a replica's overlay and
 *     live journal updates (src/common/user-edits.ts replicaJournalValue)
 *     take it over any older value of its own, and genreOwner() reads it as
 *     'jake' — the filer and any corrections pass never move it again;
 *   - recorded in genre-provenance.json as by 'jake', how 'ruling';
 *   - any check-list question about the album is closed.
 *
 * Only songs not already wearing the ruled genre are written, the overrides
 * file is backed up first (no backup, no pass), and a marker
 * (genre-rulings-applied.json) makes a second launch a no-op. A ruling made
 * after this table runs is simply a Get Info edit; a later Get Info edit of
 * his beats a ruling (the journal is newest-wins).
 *
 * Electron-free (tests: __tests__/genre-replica.test.ts).
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normName } from './taste-profile.ts'
import { GENRE_NAMES } from '../common/genre-vocab.ts'
import type { CheckEntry, FilerDeps, FilerTrack } from './genre-filer.ts'

export interface GenreRuling {
  artist: string
  album: string
  /** the songs he ruled on (a song at another id is matched by album) */
  ids: number[]
  genre: string
  /** what grounded it — shown in the log */
  why: string
}

// 'b' (10/29, later the same day): his first ruling (Mashup) was overruled
// before it ever ran on any Mac. A new id, so a Mac that somehow applied the
// Mashup table still runs this one (its marker holds the old id) and the songs
// wearing Mashup are written to Plunderphonics.
export const RULINGS_ID = 'genre-rulings-2026-10-29b-plunderphonics'

export const RULINGS: GenreRuling[] = [
  {
    // Jake 10/29: neither "Electronic" nor "Nu Disco" — and not Mashup either
    // (Mashup is Girl Talk stacking whole songs). He added a shelf for it:
    // Plunderphonics. RYM: Sound Collage first (then Nu-Disco, Plunderphonics);
    // Wikipedia: the band is plunderphonics' exponent; Far Out: "sampledelia"
    // built from old ads. Supersedes the corrections pass's restore of his
    // 10/20 "Electronic".
    artist: 'The Avalanches', album: 'No Bad Memories',
    ids: [12774, 12775, 12776, ...Array.from({ length: 28 }, (_, i) => 12882 + i)],
    genre: 'Plunderphonics',
    why: 'Jake 10/29 ruling: a collage of samples — plunderphonics (RYM, Wikipedia, Far Out); his new shelf',
  },
]

export const RULINGS_MARKER = 'genre-rulings-applied.json'

export interface RulingsDeps extends Pick<FilerDeps, 'tracks' | 'persist' | 'applied' | 'loadCheck' | 'saveCheck' | 'log' | 'now'> {
  userData: string
  flushOverrides?(): Promise<void>
  /** his edit into user-edits.json — UserEditsSync.record, the Get Info path */
  recordEdit(trackId: number, field: string, value: string, at: number): Promise<void>
  /** test seam */
  table?: { id: string; rulings: GenreRuling[] }
}

export interface RulingsResult { ran: boolean; applied: Array<{ artist: string; album: string; genre: string; songs: number }>; skipped: string[] }

const albumKey = (artist: string, album: string): string => `album:${normName(artist)}|${normName(album)}`
const keyOf = (t: FilerTrack): string => albumKey((t.albumArtist || t.artist || '').trim(), t.album || '')

export async function runGenreRulings(deps: RulingsDeps): Promise<RulingsResult> {
  const table = deps.table ?? { id: RULINGS_ID, rulings: RULINGS }
  const result: RulingsResult = { ran: false, applied: [], skipped: [] }
  const markerPath = join(deps.userData, RULINGS_MARKER)
  try {
    const m = JSON.parse(await readFile(markerPath, 'utf8')) as { id?: string }
    if (m.id === table.id) return result
  } catch { /* never ran */ }
  const log = (s: string): void => deps.log?.(`[genre-rulings] ${s}`)
  const now = (deps.now ?? (() => new Date()))()

  await deps.flushOverrides?.()
  const src = join(deps.userData, 'metadata-overrides.json')
  const backup = `${src}.bak-genre-rulings-${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`
  try { await copyFile(src, backup) } catch (err) {
    log(`no backup of metadata-overrides.json (${err instanceof Error ? err.message : String(err)}) — rulings not applied`)
    return result
  }
  result.ran = true

  const tracks = await deps.tracks()
  const at = now.getTime()
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  const closed = new Set<string>()
  for (const r of table.rulings) {
    if (!GENRE_NAMES.has(r.genre)) { result.skipped.push(`${r.artist} — ${r.album}: ${r.genre} is not on the list`); continue }
    const key = albumKey(r.artist, r.album)
    const ids = new Set(r.ids)
    const songs = tracks.filter((t) => keyOf(t) === key || (ids.has(t.id) && normName(t.album || '') === normName(r.album)))
    if (!songs.length) { result.skipped.push(`${r.artist} — ${r.album}: not in the library`); continue }
    let n = 0
    for (const t of songs) {
      // Journal even a song already wearing the genre: the journal is what
      // makes it his on every device (and keeps the filer off it).
      await deps.recordEdit(t.id, 'genre', r.genre, at)
      if ((t.genre || '').trim() === r.genre) continue
      await deps.persist(t, { genre: r.genre }, { by: 'jake', how: 'ruling' })
      updates.push({ trackId: t.id, field: 'genre', newValue: r.genre })
      n++
    }
    closed.add(key); closed.add(`review:${key}`)
    result.applied.push({ artist: r.artist, album: r.album, genre: r.genre, songs: n })
    log(`${r.artist} — ${r.album} → ${r.genre} (his ruling; ${n} song${n === 1 ? '' : 's'} written, ${songs.length} journaled): ${r.why}`)
  }
  if (updates.length) deps.applied(updates)
  if (closed.size) {
    const check = await deps.loadCheck()
    const open = check.filter((c: CheckEntry) => !closed.has(c.key))
    if (open.length !== check.length) await deps.saveCheck(open)
  }
  await writeFile(markerPath, JSON.stringify({ id: table.id, at: now.toISOString(), backup, applied: result.applied, skipped: result.skipped }, null, 2))
  return result
}
