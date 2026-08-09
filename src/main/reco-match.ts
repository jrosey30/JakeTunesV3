/** Pure iTunes reco matching — shared by suggest-verify and unit tests. */
import { foldAccents } from '../common/fold-text.ts'

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
 * The same shape, but accent-folded — for COMPARING two names, never for
 * storing one. iTunes writes JAŸ-Z and Qobuz writes Jay-Z; recoNorm turns
 * those into "jaz" and "jayz" and they never meet.
 * See src/common/fold-text.ts for why NFD alone is not enough.
 */
export function recoFold(s: string): string {
  return foldAccents(s).replace(/[^a-z0-9]/g, '')
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
  const s = recoNorm(song || '')
  const a = recoNorm(artist || '')
  return s && a ? `${s}|${a}` : null
}

export function recordIdentityKeys(r: RecoIdentityInput): string[] {
  const keys = new Set<string>()
  const ext = recoNorm(r.externalId || '')
  if (ext) keys.add(`ext:${ext}`)
  const raw = recoIdentityPairKey(r.song, r.artist)
  if (raw) keys.add(raw)
  const matched = recoIdentityPairKey(r.matchedTitle, r.matchedArtist)
  if (matched) keys.add(matched)
  if (!recoNorm(r.artist || '') && !recoNorm(r.matchedArtist || '') && recoNorm(r.song || '')) {
    keys.add(`solo:${recoNorm(r.song || '')}~${recoNorm(r.album || '')}~${recoNorm(r.note || '')}`)
  }
  // Artist-anchored key for SONGLESS rows — a band or album link with no
  // title. Symmetric to solo:. Without it these get ZERO identity keys, so
  // a delete tombstones only the UUID and the next morning's re-sync
  // re-adds them under a fresh UUID → immortal (Jake: Die Spitz &
  // Victoryland "always show up even if deleted"). Keyed on the artist
  // ALONE so any songless entry for that artist stays dead. ⚠️ TWIN:
  // ~/JakeTunesMobile/backend/src/util/reco-identity.ts — keep identical.
  const anyArtist = recoNorm(r.artist || '') || recoNorm(r.matchedArtist || '')
  if (!raw && !matched && anyArtist) {
    keys.add(`artist:${anyArtist}`)
  }
  // Absolute catch-all: a non-empty row must never be keyless (album-only
  // or note-only jots), else it too becomes un-deletable.
  if (keys.size === 0) {
    const parts = [recoNorm(r.album || ''), recoNorm(r.note || '')].filter(Boolean)
    if (parts.length) keys.add(`partial:${parts.join('~')}`)
  }
  return [...keys]
}

/** Grouping key for mirror/serve dedupe. First identity key, else a strict
 *  full-text key, else the id (nothing-rows never merge). */
export function recoDedupeKey(r: RecoIdentityInput): string {
  const keys = recordIdentityKeys(r)
  if (keys.length > 0) return keys[0]
  const full = [r.song, r.artist, r.album, r.note].map((s) => recoNorm(s || '')).join('|')
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

// ⚠️ TWIN: src/renderer/listen-to-the-list/store.ts artistLooselyMatches —
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
    const key = recoNorm(r.artist)
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
