/**
 * Friend standings — pure scoring core (2026-08-05, Jake: "i want the friends
 * area to look like standings... if friend sends album and i import. 5 points.
 * song and i import. 1 point. if i delete that album or song from library,
 * minus 1 point. if i delete a song from the album a friend sent me, but kept
 * the other songs... it counts as 1 song (so 1 point)").
 *
 * Points are NEVER stored — only credit RECORDS are. Points are recomputed
 * against the live library every time standings are read, which is what makes
 * deletion-awareness automatic: delete the album tomorrow and the same record
 * evaluates to −1 without any event needing to fire on delete.
 *
 * Scoring per credited reco:
 *   song   still in library                    → +1
 *   song   gone from library                   → −1
 *   album  every snapshot track still present  → +5
 *   album  some present, some deleted          → +1  (counts as one song)
 *   album  none present                        → −1
 *   legacy (pre-standings credit, no identity) → +1 flat, never negative —
 *          we can't honestly say a song we never fingerprinted was deleted.
 *
 * Renamed, not deleted (2026-10-21, Jake: "why did jack lose a point"): Jack
 * Orlan's credit is for "Above (Deluxe Edition)" by Mad Season. All 14 tracks
 * are still in the library, but a metadata override renamed the album "Above",
 * so the stored key `abovedeluxeedition|madseason` met nothing and the credit
 * read as deleted (−1 instead of +5). Any credited album or song that later
 * gains or loses an edition tag ("(Deluxe Edition)", "[2011 Remaster]",
 * "- Anniversary Edition", "(Remastered 2009)") lost its friend the same way.
 * So a credit is matched exactly FIRST, and only when nothing carries the
 * credited name does it match by the editionless name (editionlessTitle, the
 * radar's album compare) on BOTH sides — the artist never folds, so a match
 * never crosses artists. Stored keys are never rewritten.
 */

// recoIdNorm, not recoNorm (2026-10-11): these keys are STORED — in
// friend-credits.json (CreditRecord keys / albumKey) and inside attribution
// credit ids in reco-import-credit.json — so a Latin name must keep its
// recoNorm key byte for byte. recoNorm alone erased every Hebrew and
// Cyrillic letter, so a friend's Hebrew or Cyrillic send could never earn a
// credit or show on the standings. Live state on 10/11: 0 such entries in
// any of the four friend files, so nothing stored changes.
import { recoIdNorm } from './reco-match.ts'
import { editionlessTitle } from './radar-core.ts'

export type CreditKind = 'song' | 'album'

export interface CreditRecord {
  recoId: string
  friend: string
  kind: CreditKind
  /** Display label, e.g. "Pareidolia — Ken Pomeroy". */
  label: string
  /** Song: normalized `title|artist` pair keys (raw + iTunes-matched). */
  keys?: string[]
  /** Album: normalized `album|artist` key. */
  albumKey?: string
  /** Album: matching track count at credit time. */
  n0?: number
  creditedAt: string
  /** Migrated from the pre-standings counter — no identity attached. */
  legacy?: boolean
}

export interface StandingsTrackLite {
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
}

export type CreditStatus = 'kept' | 'partial' | 'deleted' | 'legacy'

export interface EvaluatedCredit {
  record: CreditRecord
  status: CreditStatus
  points: number
}

export interface LibraryIndex {
  pairKeys: Set<string>
  albumCounts: Map<string, number>
  /** The same keys with edition words dropped from the title side
   *  (editionlessTitle) — the fallback for a credited name that was renamed.
   *  Compared only, never stored. */
  editionlessPairKeys: Set<string>
  editionlessAlbumCounts: Map<string, number>
}

/** ⚠️ TWIN: src/renderer/views/ListenToTheListView.tsx recoType() — same
 *  precedence (explicit kind → song → album), change both or neither. */
export function creditKindOf(r: { kind?: string; song?: string; matchedTitle?: string; album?: string; matchedAlbum?: string }): CreditKind | null {
  const song = String(r.matchedTitle || r.song || '').trim()
  const album = String(r.matchedAlbum || r.album || '').trim()
  if (r.kind === 'album' || r.kind === 'concert') return 'album'
  if (song) return 'song'
  if (album) return 'album'
  return null   // artist recos aren't creditable — nothing concrete to import
}

export function albumKeyOfStrings(album: string, artist: string): string | null {
  const al = recoIdNorm(album)
  const ar = recoIdNorm(artist)
  return al && ar ? `${al}|${ar}` : null
}

/** `title|artist` (or `album|artist`) with edition words dropped from the
 *  title side. The artist side is the stored identity, unfolded. */
function editionlessKeyOfStrings(title: string, artist: string): string | null {
  return albumKeyOfStrings(editionlessTitle(title), artist)
}

/** `foldArtists`: the artist keys whose tracks need the editionless fold —
 *  computeStandings passes the credited artists, since a credit only ever
 *  looks up `…|<its own artist>` (the fold is ~3× the cost of the exact
 *  index over a whole library). Omitted = fold every track. */
export function buildLibraryIndex(tracks: StandingsTrackLite[], foldArtists?: ReadonlySet<string>): LibraryIndex {
  const pairKeys = new Set<string>()
  const albumCounts = new Map<string, number>()
  const editionlessPairKeys = new Set<string>()
  const editionlessAlbumCounts = new Map<string, number>()
  // An album's name repeats on every one of its tracks — fold it once.
  const folded = new Map<string, string>()
  const bare = (raw: string): string => {
    let k = folded.get(raw)
    if (k === undefined) { k = recoIdNorm(editionlessTitle(raw)); folded.set(raw, k) }
    return k
  }
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1) }
  for (const t of tracks) {
    const title = recoIdNorm(t.title || '')
    const album = recoIdNorm(t.album || '')
    // artist AND albumArtist both index the track, but a track counts ONCE
    // per album key. (This compared the raw strings, so a track whose
    // albumArtist is its artist — most of them — counted twice, and half an
    // album could be deleted while the credit still read intact. The sweep's
    // n0 snapshot counts each track once, so the live count must too.)
    const artists = new Set([recoIdNorm(t.artist || ''), recoIdNorm(t.albumArtist || '')])
    artists.delete('')
    const fold = !foldArtists || [...artists].some((a) => foldArtists.has(a))
    const bareTitle = fold && title ? bare(t.title || '') : ''
    const bareAlbum = fold && album ? bare(t.album || '') : ''
    for (const a of artists) {
      if (title) pairKeys.add(`${title}|${a}`)
      if (album) bump(albumCounts, `${album}|${a}`)
      if (foldArtists && !foldArtists.has(a)) continue
      if (bareTitle) editionlessPairKeys.add(`${bareTitle}|${a}`)
      if (bareAlbum) bump(editionlessAlbumCounts, `${bareAlbum}|${a}`)
    }
  }
  return { pairKeys, albumCounts, editionlessPairKeys, editionlessAlbumCounts }
}

/** The raw title and artist a stored key was made from, read back off the
 *  credit's label ("Above (Deluxe Edition) — Mad Season"). Trusted only when
 *  it reproduces the stored key exactly; every " — " is tried as the split,
 *  since a title can carry one ("Above — Expanded — Mad Season"). */
function labelPartsFor(label: string, key: string): { title: string; artist: string } | null {
  const SEP = ' — '
  for (let i = label.indexOf(SEP); i >= 0; i = label.indexOf(SEP, i + 1)) {
    const title = label.slice(0, i)
    const artist = label.slice(i + SEP.length)
    if (albumKeyOfStrings(title, artist) === key) return { title, artist }
  }
  return null
}

/** A stored key's editionless twin. The edition words are gone from the
 *  squashed key, so the fold needs the raw text — the label, when it
 *  reproduces the key. Otherwise the key stands for itself: a key whose raw
 *  name carried no edition words is its own fold, and one whose did simply
 *  gets no fallback (fail closed). */
function editionlessCreditKey(label: string, key: string): string {
  const parts = labelPartsFor(label || '', key)
  return (parts && editionlessKeyOfStrings(parts.title, parts.artist)) || key
}

export function evaluateCredit(record: CreditRecord, lib: LibraryIndex): EvaluatedCredit {
  if (record.legacy) return { record, status: 'legacy', points: 1 }
  if (record.kind === 'song') {
    const keys = record.keys || []
    // The exact song first; then the same song under a title that gained or
    // lost edition words ("(Remastered 2009)").
    const present = keys.some((k) => lib.pairKeys.has(k))
      || keys.some((k) => lib.editionlessPairKeys.has(editionlessCreditKey(record.label, k)))
    return present
      ? { record, status: 'kept', points: 1 }
      : { record, status: 'deleted', points: -1 }
  }
  // album — the credited name first. Only when NO track still carries it does
  // the editionless name count: exact-first, so a half-deleted deluxe can't
  // borrow tracks from a standard edition owned beside it.
  let cur = record.albumKey ? (lib.albumCounts.get(record.albumKey) ?? 0) : 0
  if (cur === 0 && record.albumKey) {
    cur = lib.editionlessAlbumCounts.get(editionlessCreditKey(record.label, record.albumKey)) ?? 0
  }
  const n0 = record.n0 ?? 1
  if (cur === 0) return { record, status: 'deleted', points: -1 }
  if (cur < n0) return { record, status: 'partial', points: 1 }
  return { record, status: 'kept', points: 5 }
}

export interface StandingRow {
  name: string
  points: number
  credits: EvaluatedCredit[]
  /** Ledger context for the detail view. */
  adds: number
  tossed: number
}

export function computeStandings(
  records: CreditRecord[],
  ledger: Record<string, { name: string; adds?: number; tossed?: number }>,
  tracks: StandingsTrackLite[],
): StandingRow[] {
  const creditedArtists = new Set<string>()
  for (const r of records) {
    for (const k of [...(r.keys || []), ...(r.albumKey ? [r.albumKey] : [])]) creditedArtists.add(k.slice(k.lastIndexOf('|') + 1))
  }
  const lib = buildLibraryIndex(tracks, creditedArtists)
  const byFriend = new Map<string, EvaluatedCredit[]>()
  for (const r of records) {
    const key = r.friend.trim().toLowerCase()
    if (!byFriend.has(key)) byFriend.set(key, [])
    byFriend.get(key)!.push(evaluateCredit(r, lib))
  }
  const rows: StandingRow[] = []
  const seen = new Set<string>()
  for (const [key, evs] of byFriend) {
    const led = ledger[key]
    rows.push({
      name: led?.name || evs[0].record.friend,
      points: evs.reduce((s, e) => s + e.points, 0),
      credits: evs.sort((a, b) => String(b.record.creditedAt).localeCompare(String(a.record.creditedAt))),
      adds: led?.adds ?? 0,
      tossed: led?.tossed ?? 0,
    })
    seen.add(key)
  }
  // Friends who've sent SONGS but have no credits yet still belong on the
  // board at 0 — a standings table that hides the winless is a podium.
  for (const [key, led] of Object.entries(ledger)) {
    if (seen.has(key)) continue
    rows.push({ name: led.name, points: 0, credits: [], adds: led.adds ?? 0, tossed: led.tossed ?? 0 })
  }
  // Jake's rule, tightened 2026-08-28 ("Joey should not be in standings" —
  // Joey had sent one legitimate song, never imported): SENDING no longer
  // seats you. A friend appears on the board only once a credit exists —
  // their first import (or the deletion penalty that follows one). The
  // ledger still remembers every sender; the first credit makes them show.
  // (Supersedes the 2026-08-07 adds>0 rule from the Dan Gottlieb case —
  // that rule kept podcast-only friends off the board, this one also keeps
  // the not-yet-imported off it.)
  const filtered = rows.filter((r) => r.credits.length > 0)
  // Rank: points desc, then most credits (activity), then name for stability.
  filtered.sort((a, b) => b.points - a.points || b.credits.length - a.credits.length || a.name.localeCompare(b.name))
  return filtered
}

/**
 * Album credits: an album-kind reco earns its credit when the library holds
 * matching album tracks that ARRIVED after the reco existed — the same
 * honesty rule as songs (owning it already proves nothing).
 */
export interface AlbumCreditableReco {
  id: string
  kind?: string
  song?: string
  matchedTitle?: string
  album?: string
  matchedAlbum?: string
  artist?: string
  matchedArtist?: string
  note?: string
  createdAt?: string
}

export interface AlbumCreditHit {
  recoId: string
  friend: string
  albumKey: string
  label: string
  n0: number
}

export function computeAlbumCredits(
  recos: AlbumCreditableReco[],
  tracks: Array<StandingsTrackLite & { dateAdded?: string }>,
  alreadyCredited: ReadonlySet<string>,
  friendOfNote: (note: string | undefined) => string | null,
): AlbumCreditHit[] {
  // album|artist key → { count, newestArrival }
  const albums = new Map<string, { count: number; newest: number }>()
  for (const t of tracks) {
    const album = recoIdNorm(t.album || '')
    if (!album) continue
    const when = Date.parse(t.dateAdded || '') || 0
    const artists = new Set([recoIdNorm(t.artist || ''), recoIdNorm(t.albumArtist || '')])
    for (const a of artists) {
      if (!a) continue
      const k = `${album}|${a}`
      const cur = albums.get(k) ?? { count: 0, newest: 0 }
      cur.count += 1
      if (when > cur.newest) cur.newest = when
      albums.set(k, cur)
    }
  }
  const hits: AlbumCreditHit[] = []
  for (const r of recos) {
    if (alreadyCredited.has(r.id)) continue
    if (creditKindOf(r) !== 'album') continue
    const friend = friendOfNote(r.note)
    if (!friend) continue
    const albumName = String(r.matchedAlbum || r.album || '').trim()
    const artistName = String(r.matchedArtist || r.artist || '').trim()
    const key = albumKeyOfStrings(albumName, artistName)
    if (!key) continue           // artist-less album jot: never text-credited
    const found = albums.get(key)
    if (!found) continue
    const recoAt = Date.parse(r.createdAt || '') || 0
    if (found.newest < recoAt) continue   // owned before the reco — no credit
    hits.push({ recoId: r.id, friend, albumKey: key, label: `${albumName} — ${artistName}`, n0: found.count })
  }
  return hits
}
