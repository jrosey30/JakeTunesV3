/** Pure iTunes reco matching — shared by suggest-verify and unit tests. */
import { nameKey, storedNameKey } from '../common/fold-text.ts'

/**
 * ⚠️ IDENTITY, NOT MATCHING. recoNorm feeds recoMatchKey, and those keys are
 * PERSISTED — dedupe, tombstones, "already recommended" state. Folding
 * diacritics here would change the key for every accented artist, orphaning
 * their tombstones and resurrecting recommendations Jake had deleted. It stays
 * exactly as it is. Use recoFold for comparisons.
 */
export function recoNorm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * recoNorm for the identity keys below. A Latin name keeps its recoNorm key
 * byte for byte, so no tombstone is orphaned. A name with Hebrew, Cyrillic or
 * any other script's letters gets nameKey: recoNorm erased those, so an
 * all-Hebrew jot had NO identity key (a delete never stuck, and desktop's
 * add treated every such jot as a dupe of the first), and a Hebrew song by a
 * Latin-named artist keyed as `artist:<artist>` alone, so deleting it hid
 * every other one. Live state on 2026-10-11: 0 rows, 0 tombstones with
 * other-script letters, so nothing stored changes.
 * ⚠️ TWIN: ~/JakeTunesMobile/backend/src/util/reco-identity.ts idNorm.
 * Also the friend-credit keys (friend-imports-core, friend-standings-core),
 * which are stored the same way.
 */
export function recoIdNorm(s: string): string {
  return storedNameKey(s, recoNorm)
}

/**
 * The same shape, but accent-folded and in any script — for COMPARING two
 * names, never for storing one. iTunes writes JAŸ-Z and Qobuz writes Jay-Z;
 * recoNorm turns those into "jaz" and "jayz" and they never meet.
 *
 * Any script (2026-10-11): this was foldAccents + [a-z0-9], which erased
 * every Hebrew and Cyrillic name to '', and every matcher below returns
 * false on ''. So a Hebrew or Cyrillic artist never verified anywhere: Get
 * refused it on "artist", the Record Shop never saw it as owned, discovery
 * dropped its cards, and Music Man never confirmed a pick. It is fold-text
 * nameKey squashed. On Jake's library, 2 of 14,583 Latin-only names fold
 * differently, both better (ª → a, ᴹᴰ → md).
 * See src/common/fold-text.ts.
 */
export function recoFold(s: string): string {
  return nameKey(s, '')
}

// ── Recommendation identity (sync protocol v2, Brief 126) ──────────────────
// The ONE definition of "same song" for tombstones, dedupe, and deletes.
// ⚠️ TWIN: ~/JakeTunesMobile/backend/src/util/reco-identity.ts — byte-identical
// logic; the parity fixture table in __tests__ is copy-shared verbatim with
// the backend suite so drift fails both. Display-only cousins (looser, never
// write tombstones): renderer store.ts artistLooselyMatches; iOS matchKey.
//
// Key kinds, strongest first (a record emits every kind that applies; ANY
// overlap between two records = same song):
//   ext:<norm(externalId)>                       stable catalog id (archive.org)
//   <norm(song)>|<norm(artist)>                  raw pair
//   <norm(matchedTitle)>|<norm(matchedArtist)>   iTunes-canonical pair
//   solo:<norm(song)>~<norm(album)>~<norm(note)> ONLY when no artist anywhere —
//     the artist-less-jot fix; the prefix + both-artists-empty gate guarantee
//     a title-only jot can never collide with a real pair key.
//   album:<norm(artist)>~<norm(album)>            a SONGLESS row that names a
//     record: the record (with its edition words) is the identity, so two
//     records by one artist — or two editions of one record — never collapse
//     (2026-09-06: "Little Creatures (Deluxe Version)" came back as the
//     "Remain in Light (Deluxe Version)" row).
//   artist:<norm(artist)>                         songless AND albumless only.

export interface RecoIdentityInput {
  id?: string
  song?: string
  artist?: string
  album?: string
  note?: string
  matchedTitle?: string
  matchedArtist?: string
  externalId?: string
  createdAt?: string
  resolvedAt?: string
}

export const RECO_IDENTITY_PREFIX = 'identity:'

export function recoIdentityPairKey(song: string | undefined, artist: string | undefined): string | null {
  const s = recoIdNorm(song || '')
  const a = recoIdNorm(artist || '')
  return s && a ? `${s}|${a}` : null
}

export function recordIdentityKeys(r: RecoIdentityInput): string[] {
  const keys = new Set<string>()
  const ext = recoIdNorm(r.externalId || '')
  if (ext) keys.add(`ext:${ext}`)
  const raw = recoIdentityPairKey(r.song, r.artist)
  if (raw) keys.add(raw)
  const matched = recoIdentityPairKey(r.matchedTitle, r.matchedArtist)
  if (matched) keys.add(matched)
  if (!recoIdNorm(r.artist || '') && !recoIdNorm(r.matchedArtist || '') && recoIdNorm(r.song || '')) {
    keys.add(`solo:${recoIdNorm(r.song || '')}~${recoIdNorm(r.album || '')}~${recoIdNorm(r.note || '')}`)
  }
  // Artist-anchored key for SONGLESS rows — a band or album link with no
  // title. Symmetric to solo:. Without it these get ZERO identity keys, so
  // a delete tombstones only the UUID and the next morning's re-sync
  // re-adds them under a fresh UUID → immortal (Jake: Die Spitz &
  // Victoryland "always show up even if deleted"). Keyed on the artist
  // ALONE so any songless entry for that artist stays dead. ⚠️ TWIN:
  // ~/JakeTunesMobile/backend/src/util/reco-identity.ts — keep identical.
  const anyArtist = recoIdNorm(r.artist || '') || recoIdNorm(r.matchedArtist || '')
  const album = recoIdNorm(r.album || '')
  const songless = !recoIdNorm(r.song || '') && !recoIdNorm(r.matchedTitle || '')
  if (!raw && !matched && songless && album) {
    // The record is the identity — never the artist alone.
    keys.add(`album:${anyArtist}~${album}`)
  } else if (!raw && !matched && anyArtist) {
    keys.add(`artist:${anyArtist}`)
  }
  // Absolute catch-all: a non-empty row must never be keyless (album-only
  // or note-only jots), else it too becomes un-deletable.
  if (keys.size === 0) {
    const parts = [recoIdNorm(r.album || ''), recoIdNorm(r.note || '')].filter(Boolean)
    if (parts.length) keys.add(`partial:${parts.join('~')}`)
  }
  return [...keys]
}

/** Grouping key for mirror/serve dedupe. First identity key, else a strict
 *  full-text key, else the id (nothing-rows never merge). */
export function recoDedupeKey(r: RecoIdentityInput): string {
  const keys = recordIdentityKeys(r)
  if (keys.length > 0) return keys[0]
  const full = [r.song, r.artist, r.album, r.note].map((s) => recoIdNorm(s || '')).join('|')
  return full !== '|||' ? `full:${full}` : `id:${r.id ?? ''}`
}

/** Which of two same-identity rows survives a dedupe: the resolved one, else
 *  the newest. */
export function pickBetterReco<T extends RecoIdentityInput>(a: T, b: T): T {
  const aResolved = Boolean(a.resolvedAt || a.matchedTitle)
  const bResolved = Boolean(b.resolvedAt || b.matchedTitle)
  if (aResolved !== bResolved) return aResolved ? a : b
  return (a.createdAt || '') >= (b.createdAt || '') ? a : b
}

/** Tombstone entries: bare ids, plus `identity:<key>` for every key kind. */
export function isTombstonedRecord(tombs: ReadonlySet<string>, r: RecoIdentityInput): boolean {
  if (r.id && tombs.has(String(r.id))) return true
  return recordIdentityKeys(r).some((k) => tombs.has(RECO_IDENTITY_PREFIX + k))
}

function recoEditDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i++) dp[i][0] = i
  for (let j = 0; j < cols; j++) dp[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
    if (Math.min(...dp[i]) > max) return max + 1
  }
  return dp[a.length][b.length]
}

/** Fuzzy title match — catches Bonafide/Bonafied-style drift. */
export function recoTitleMatches(want: string, got: string): boolean {
  const w = recoFold(want)
  const g = recoFold(got)
  if (!w || !g) return false
  if (w === g) return true
  if (Math.min(w.length, g.length) >= 8 && (w.includes(g) || g.includes(w))) return true
  const minLen = Math.min(w.length, g.length)
  if (minLen >= 10 && recoEditDistance(w, g, 2) <= 2) return true
  if (minLen >= 6) {
    const shared = Math.floor(minLen * 0.75)
    return w.slice(0, shared) === g.slice(0, shared)
  }
  return false
}

// ⚠️ TWIN: src/renderer/listen-to-the-list/store.ts artistLooselyMatches (same fold: nameKey squashed) —
// renderer-side copy of this rule (no cross-bundle import); keep in sync.
export function recoArtistMatches(want: string, got: string): boolean {
  const w = recoFold(want)
  const g = recoFold(got)
  if (!w || !g) return false
  if (w === g) return true
  if (w.length >= 4 && g.length >= 4 && (w.includes(g) || g.includes(w))) return true
  return false
}

/** Distinct credited artists on iTunes rows whose track title matches `wantTitle`. */
export function distinctArtistsForRecoTitle(
  wantTitle: string,
  rows: Array<{ song: string; artist: string }>,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (!recoTitleMatches(wantTitle, r.song)) continue
    const key = recoFold(r.artist)   // compared, never stored: a Hebrew artist counts (was '', skipped, so a title looked unambiguous)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(r.artist)
  }
  return out
}

/**
 * MM credited the wrong artist. Reject when the title maps to multiple real artists
 * on iTunes (e.g. "Around the World" → Daft Punk vs Kings of Leon). Allow a single
 * canonical correction when the title is unambiguous (e.g. Bonafied Lovin' → Chromeo).
 */
export function shouldRejectRecoArtistCorrection(
  wantTitle: string,
  mmArtist: string,
  canonicalArtist: string,
  titleOnlyRows: Array<{ song: string; artist: string }>,
): boolean {
  if (recoArtistMatches(mmArtist, canonicalArtist)) return false
  const artists = distinctArtistsForRecoTitle(wantTitle, titleOnlyRows)
  if (artists.length !== 1) return true
  return !recoArtistMatches(canonicalArtist, artists[0])
}

export type RecoLookupHit = { matchedTitle?: string; matchedArtist?: string }

export type EvaluateMusicManVerificationInput = {
  mm: { song: string; artist: string }
  strictCredit: RecoLookupHit
  canonical: RecoLookupHit
  titleOnlyRows: Array<{ song: string; artist: string }>
}

export type EvaluateMusicManVerificationResult =
  | { ok: true; song: string; artist: string; mode: 'strict' | 'canonical' | 'corrected' }
  | { ok: false; reason: 'no_match' | 'title_mismatch' | 'artist_hallucination' }

/** Pure decision for Music Man suggest verification (no network). */
export function evaluateMusicManVerification(
  input: EvaluateMusicManVerificationInput,
): EvaluateMusicManVerificationResult {
  const { mm, strictCredit, canonical, titleOnlyRows } = input
  if (
    strictCredit.matchedTitle &&
    strictCredit.matchedArtist &&
    recoTitleMatches(mm.song, strictCredit.matchedTitle) &&
    recoArtistMatches(mm.artist, strictCredit.matchedArtist)
  ) {
    return {
      ok: true,
      song: strictCredit.matchedTitle,
      artist: strictCredit.matchedArtist,
      mode: 'strict',
    }
  }
  if (!canonical.matchedTitle || !canonical.matchedArtist) {
    return { ok: false, reason: 'no_match' }
  }
  if (!recoTitleMatches(mm.song, canonical.matchedTitle)) {
    return { ok: false, reason: 'title_mismatch' }
  }
  if (recoArtistMatches(mm.artist, canonical.matchedArtist)) {
    return {
      ok: true,
      song: canonical.matchedTitle,
      artist: canonical.matchedArtist,
      mode: 'canonical',
    }
  }
  if (shouldRejectRecoArtistCorrection(mm.song, mm.artist, canonical.matchedArtist, titleOnlyRows)) {
    return { ok: false, reason: 'artist_hallucination' }
  }
  return {
    ok: true,
    song: canonical.matchedTitle,
    artist: canonical.matchedArtist,
    mode: 'corrected',
  }
}
