// Artist identity — which MusicBrainz entity IS this library artist?
//
// ⚠️ TWIN of JakeTunesMobile backend/src/util/artistIdentity.ts
// (qualifiesAsArtist, pickDiscographyArtist, MB_SCORE_FLOOR) and
// backend/src/util/albumMatch.ts (normAlbumTitle, albumTitlesMatch).
// Change the rule in both or neither.
//
// The rule, learned twice (phone Brief 202, desktop 2026-10-20): A NAME
// ALONE IS NOT IDENTITY. MusicBrainz holds several bands called Geese.
// The desktop resolver ranked candidates by genre-tag overlap, and
// because every Geese is tagged some flavour of "rock", a shoegaze Geese
// out-tagged the Brooklyn band by four points — Jake's artist page
// offered him "Pop Songs" and "Duck", records by strangers. Identity has
// to be earned with the library's own albums, and when the evidence
// can't separate the candidates the answer is "unknown", not a guess.
//
// Pure and dependency-free: the name fold and the release-group fetch
// are injected, so the Geese case runs in a unit test.

export type MbArtistCandidate = {
  id?: string
  name?: string
  score?: number
  aliases?: string[]
  releaseGroups?: string[]
}

type Fold = (s: string | null | undefined, sep?: string) => string
type AlbumMatch = (libraryTitle: string, candidateTitle: string) => boolean

/// The MusicBrainz score floor for an identity claim. Below it, a name
/// match is a rumor.
export const MB_SCORE_FLOOR = 80

/// Normalize album titles for owned-vs-catalogue matching. MusicBrainz
/// release groups carry subtitles and different article/case/punctuation
/// than the library ("The Shape Of Punk To Come").
export function normAlbumTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s*[:–—-]\s+/)[0]!
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/// True when two album titles refer to the same release for one artist.
export function albumTitlesMatch(libraryTitle: string, discographyTitle: string): boolean {
  const a = normAlbumTitle(libraryTitle)
  const b = normAlbumTitle(discographyTitle)
  if (!a || !b) return false
  if (a === b) return true
  if (a.startsWith(b) || b.startsWith(a)) return true
  const wordsA = a.split(' ').filter((w) => w.length > 2)
  const wordsB = b.split(' ').filter((w) => w.length > 2)
  if (wordsA.length === 0 || wordsB.length === 0) return false
  const [shorter, longer] =
    wordsA.length <= wordsB.length ? [wordsA, new Set(wordsB)] : [wordsB, new Set(wordsA)]
  return shorter.every((w) => longer.has(w))
}

/// Does this candidate claim the library name — as its name or as an
/// alias — strongly enough to be considered at all?
export function qualifiesAsArtist(candidate: MbArtistCandidate, name: string, fold: Fold): boolean {
  if (typeof candidate?.id !== 'string' || candidate.id.length === 0) return false
  if ((candidate.score ?? 0) < MB_SCORE_FLOOR) return false
  const want = fold(name, '')
  if (!want) return false
  const names = [candidate.name, ...(candidate.aliases ?? [])]
  return names.some((n) => typeof n === 'string' && fold(n, '') === want)
}

/// How many of a candidate's release groups the library owns.
export function albumOverlap(
  releaseGroups: readonly string[] | undefined,
  ownedAlbums: readonly string[],
  matchAlbum: AlbumMatch = albumTitlesMatch,
): number {
  if (!releaseGroups) return 0
  let n = 0
  for (const title of releaseGroups) {
    if (ownedAlbums.some((owned) => matchAlbum(owned, title))) n++
  }
  return n
}

/// Pick which MusicBrainz artist IS this library artist, or refuse.
/// One qualifier → it. Several → the one whose release groups overlap
/// the owned albums; MusicBrainz's score breaks an overlap tie; a tie on
/// both → null.
export function pickDiscographyArtist(
  candidates: MbArtistCandidate[],
  name: string,
  ownedAlbums: readonly string[],
  fold: Fold,
  matchAlbum: AlbumMatch = albumTitlesMatch,
): MbArtistCandidate | null {
  const qualifiers = (Array.isArray(candidates) ? candidates : []).filter((c) =>
    qualifiesAsArtist(c, name, fold),
  )
  if (qualifiers.length === 0) return null
  if (qualifiers.length === 1) return qualifiers[0]!
  const scored = qualifiers.map((c) => ({
    c,
    overlap: albumOverlap(c.releaseGroups, ownedAlbums, matchAlbum),
    score: c.score ?? 0,
  }))
  scored.sort((a, b) => b.overlap - a.overlap || b.score - a.score)
  const [top, second] = scored as [typeof scored[number], typeof scored[number] | undefined]
  if (second && second.overlap === top.overlap && second.score === top.score) return null
  return top.c
}

/// How sure we are about a resolved identity.
///   confirmed — several namesakes, and this one owns the library's albums
///   single    — the only candidate that claims the name above the floor
///   ambiguous — several namesakes and the library's albums can't tell
///               them apart (or the library holds no albums to ask)
///   weak      — nobody claims the exact name above the floor; best guess
export type IdentityConfidence = 'confirmed' | 'single' | 'ambiguous' | 'weak'

/// Desktop resolver step: `ranked` is the caller's existing ranking
/// (MB score + genre context), best first. Duplicate namesakes are
/// settled by owned-album overlap — the genre ranking never decides
/// between two bands with the same name, because genres don't
/// distinguish them (every Geese is "rock"). `fetchReleaseGroups`
/// returns album/EP titles for an MBID and THROWS when MusicBrainz
/// fails — a 503 is missing evidence, not evidence of a stranger, so
/// the result says `incomplete` and callers must not cache it.
export async function chooseArtistIdentity<C extends MbArtistCandidate>(input: {
  name: string
  ranked: C[]
  ownedAlbums: readonly string[]
  fold: Fold
  fetchReleaseGroups: (mbid: string) => Promise<string[]>
  maxEvidenceFetches?: number
}): Promise<{ candidate: C; identity: IdentityConfidence; incomplete?: boolean } | null> {
  const { name, ranked, ownedAlbums, fold, fetchReleaseGroups } = input
  if (ranked.length === 0) return null
  const qualifiers = ranked.filter((c) => qualifiesAsArtist(c, name, fold))
  if (qualifiers.length === 0) return { candidate: ranked[0]!, identity: 'weak' }
  if (qualifiers.length === 1) return { candidate: qualifiers[0]!, identity: 'single' }
  const owned = ownedAlbums.filter((t) => normAlbumTitle(t))
  if (owned.length === 0) return { candidate: qualifiers[0]!, identity: 'ambiguous' }
  const cap = input.maxEvidenceFetches ?? 5
  const evidence = qualifiers.slice(0, cap)
  let incomplete = false
  for (const c of evidence) {
    try { c.releaseGroups = await fetchReleaseGroups(c.id!) } catch { c.releaseGroups = []; incomplete = true }
  }
  const picked = pickDiscographyArtist(evidence, name, owned, fold)
  if (picked && albumOverlap(picked.releaseGroups, owned) > 0) {
    return { candidate: picked as C, identity: 'confirmed', ...(incomplete ? { incomplete } : {}) }
  }
  return { candidate: qualifiers[0]!, identity: 'ambiguous', ...(incomplete ? { incomplete } : {}) }
}

/// Wrong-entity guard for a fetched catalogue: when the library holds
/// comparable albums by this artist and NONE of them appear in the
/// catalogue, the catalogue belongs to somebody else. Owned titles that
/// normalize to nothing (non-Latin scripts) can't testify either way, so
/// a library made only of those skips the guard.
export function catalogueIsSomeoneElses(
  releaseGroupTitles: readonly string[],
  ownedAlbums: readonly string[],
): boolean {
  const owned = ownedAlbums.filter((t) => normAlbumTitle(t))
  if (owned.length === 0) return false
  return albumOverlap(releaseGroupTitles, owned) === 0
}
