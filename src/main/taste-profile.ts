/**
 * Jake's explicit taste profile (2026-10-10, Rocksurgence step 1).
 *
 * The Record Shop used to dig only from his all-time most-played artists
 * (Chili Peppers, Beatles, Daft Punk, Drake…) — the artists of Rocksurgence,
 * the rock playlist he is building right now, ranked #70 (Geese) to #1135.
 * And nothing could say "less of this genre": the only "no" was per artist.
 *
 * The profile (userData/taste-profile.json, hand-editable, written by Jake's
 * answers — never inferred) holds three things:
 *   - focusPlaylists: playlists whose artists also steer discovery
 *   - lowGenres: genres he is generally not into (left out of discovery)
 *   - exceptions: artists he loves DESPITE their genre. "I like Angine de
 *     Poitrine because they're exceptional, not because of math rock." An
 *     exception is never a template: it doesn't anchor digging, doesn't
 *     teach the brain what to look for, and doesn't open its genre's door.
 *
 * Electron-free and pure except loadTasteProfile (file read).
 */
import { readFile } from 'fs/promises'

export interface TasteException { artist: string; genre: string; note?: string; at?: string }
export interface TasteProfile {
  focusPlaylists: string[]
  lowGenres: string[]
  exceptions: TasteException[]
}

export const EMPTY_PROFILE: TasteProfile = { focusPlaylists: [], lowGenres: [], exceptions: [] }

/** Accent-fold BEFORE stripping (é → e, not a space), then keep letters and
 *  digits of EVERY script. Keeping only [a-z0-9] folded every Hebrew/Cyrillic
 *  name to '' — one shared key, so Молчат Дома inherited an Israeli band's
 *  origin (2026-10-11). */
export function normName(s: string | undefined): string {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])

export function normalizeProfile(raw: unknown): TasteProfile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PROFILE }
  const r = raw as Record<string, unknown>
  const exceptions = Array.isArray(r.exceptions)
    ? r.exceptions.flatMap((e): TasteException[] => {
      const x = e as Record<string, unknown>
      return typeof x?.artist === 'string' && x.artist.trim()
        ? [{ artist: x.artist.trim(), genre: typeof x.genre === 'string' ? x.genre.trim() : '', note: typeof x.note === 'string' ? x.note : undefined, at: typeof x.at === 'string' ? x.at : undefined }]
        : []
    })
    : []
  return { focusPlaylists: strings(r.focusPlaylists), lowGenres: strings(r.lowGenres), exceptions }
}

/** Missing or unreadable file = empty profile: discovery behaves exactly as before. */
export async function loadTasteProfile(file: string): Promise<TasteProfile> {
  try { return normalizeProfile(JSON.parse(await readFile(file, 'utf8'))) } catch { return { ...EMPTY_PROFILE } }
}

export function isException(p: TasteProfile, artist: string | undefined): boolean {
  const a = normName(artist)
  return a !== '' && p.exceptions.some((e) => normName(e.artist) === a)
}

/** Anchors without the exception artists — digging from Angine finds math rock. */
export function dropExceptionAnchors<T extends { artist: string }>(anchors: T[], p: TasteProfile): T[] {
  return p.exceptions.length ? anchors.filter((a) => !isException(p, a.artist)) : anchors
}

/** The tracks the brain learns "taste" from. An exception artist's songs are
 *  loved, not a pattern: left in, a few starred Angine tracks form their own
 *  corner and every math-rock candidate near it scores high. */
export function exemplarPool<T extends { artist?: string; albumArtist?: string }>(tracks: T[], p: TasteProfile): T[] {
  return p.exceptions.length ? tracks.filter((t) => !isException(p, t.albumArtist || t.artist) && !isException(p, t.artist)) : tracks
}

/**
 * Focus-playlist artists as extra discovery anchors: the most present
 * (songs on the playlist ×3 + plays, capped) always speak, the rest rotate
 * daily so every artist on the playlist gets turns. Exceptions never anchor.
 */
export function focusAnchors(
  p: TasteProfile,
  playlists: Array<{ id?: string; name?: string; trackIds?: unknown[] }>,
  tracks: Array<{ id?: number; artist?: string; albumArtist?: string; playCount?: number }>,
  dayNumber: number,
  max = 8,
): string[] {
  if (!p.focusPlaylists.length) return []
  const wanted = new Set(p.focusPlaylists.map(normName))
  const byId = new Map(tracks.filter((t) => typeof t.id === 'number').map((t) => [t.id as number, t]))
  const score = new Map<string, { name: string; s: number }>()
  for (const pl of playlists) {
    if (!wanted.has(normName(pl.id)) && !wanted.has(normName(pl.name))) continue
    for (const id of pl.trackIds ?? []) {
      const t = byId.get(Number(id))
      const name = (t?.albumArtist || t?.artist || '').trim()
      if (!t || !name || isException(p, name)) continue
      const k = normName(name)
      const cur = score.get(k) ?? { name, s: 0 }
      cur.s += 3 + Math.min(t.playCount ?? 0, 10)
      score.set(k, cur)
    }
  }
  const ranked = [...score.values()].sort((a, b) => b.s - a.s || a.name.localeCompare(b.name)).map((x) => x.name)
  if (ranked.length <= max) return ranked
  const fixed = ranked.slice(0, 2)
  const bench = ranked.slice(2)
  const n = max - fixed.length
  const start = ((dayNumber * n) % bench.length + bench.length) % bench.length
  return [...fixed, ...Array.from({ length: n }, (_, i) => bench[(start + i) % bench.length])]
}

/** The genre gate: true = leave this card out of discovery. An exception
 *  artist passes; otherwise any hint (the card's genre, the artist's
 *  MusicBrainz tags) naming a low genre blocks it. */
export function genreBlocked(p: TasteProfile, artist: string, hints: Array<string | undefined>): boolean {
  if (!p.lowGenres.length || isException(p, artist)) return false
  const low = p.lowGenres.map(normName).filter(Boolean)
  const squash = (s: string): string => s.replace(/ /g, '')
  // The exact genre only (spelling-tolerant: "math rock" = "math-rock" =
  // "mathrock"). Never containment: a low "pop" must not block "pop punk".
  return hints.some((h) => {
    const k = normName(h)
    return k !== '' && low.some((g) => squash(k) === squash(g))
  })
}
