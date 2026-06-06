/** Pure iTunes reco matching — shared by suggest-verify and unit tests. */

export function recoNorm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
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
  const w = recoNorm(want)
  const g = recoNorm(got)
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

export function recoArtistMatches(want: string, got: string): boolean {
  const w = recoNorm(want)
  const g = recoNorm(got)
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
