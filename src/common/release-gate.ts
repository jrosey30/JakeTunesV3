// Release-admission gate: the one check every artist discography list in
// JakeTunes passes before Jake sees a release.
//
// ⚠️ TWIN of JakeTunesMobile backend/src/util/releaseGate.ts. Everything
// below this header is byte-identical, and both repos run the same
// fixtures (release-gate fixtures: real MusicBrainz / Deezer / iTunes
// responses captured 2026-10-20). Change both or neither.
//
// Why it exists (Jake, 2026-10-20). Every complaint was junk on an
// artist page, and each one had been patched where it surfaced:
//   - "does geese have albums that ive never heard of??!!! what is duck
//     and pop songs???": a namesake's catalogue (identity).
//   - "take bottomless pink lagoon out from geese it isnt anywhere": a
//     real EP no store carries (availability, plus his hidden list).
//   - "More from Daft Punk" listed "Leftovers" and "Extra Credit": fan
//     bootlegs MusicBrainz files as plain albums (status).
//   - "you need a safety check but for making sure no junk enters the
//     fucking picture here!!!"
// So the checks live in one place and every surface calls them: the
// desktop discography, the phone's "More from", and the phone's artist
// profile builder.
//
// A release group is ADMITTED only when all of these hold:
//   1. identity: the artist is confirmed (the owned-album overlap rule).
//      An unconfirmed identity admits nothing.
//   2. not on Jake's hidden list (HIDDEN_RELEASES).
//   3. type: Album / EP / Single for the section asked for; Live only in
//      a live list; Compilation, DJ-mix, Mixtape/Street, Demo,
//      Interview, Spokenword, Audiobook, Audio drama, Field recording
//      and Remix never. Soundtrack is allowed.
//   4. credited: this artist is a principal artist credit, not Various
//      Artists and not a "feat." guest.
//   5. no bootleg vocabulary in the title (the old phone regex, kept as
//      a backstop).
//   6. at least one Official release on MusicBrainz.
//   7. available somewhere real: Deezer has it, or the iTunes Store does.
// Owned releases pass checks 4 to 7 even when they fail them: a record
// in Jake's library is real to him. Identity, the hidden list and the
// type/section rule still apply, because those decide which list a
// record belongs in, not whether it exists.
//
// FAIL CLOSED: a check that can't run (MusicBrainz or both stores
// unreachable) rejects, and the verdict is marked `transient` so callers
// never cache it as fact.
//
// LEAF MODULE: no imports. The name fold, the title matchers and every
// network call are injected, so the whole gate runs in unit tests on
// captured data.

export type ReleaseSection = 'album' | 'ep' | 'single' | 'live'

export type GateIdentity = 'confirmed' | 'single' | 'ambiguous' | 'weak'

export type GateCredit = { artistId: string | null; name: string; joinphrase: string }

export type GateReleaseGroup = {
  id: string
  title: string
  primaryType: string | null
  secondaryTypes: string[]
  firstReleaseDate?: string | null
  /// The release group's artist credit. Null when MusicBrainz didn't send
  /// one, which fails the credit check (fail closed).
  credit: GateCredit[] | null
}

/// Every reason a release can be turned away, in reporting order: the
/// first one that applies is the "primary" reason in audits.
export const REJECT_REASONS = [
  'identity',               // the artist isn't confirmed; nothing is admitted
  'hidden',                 // on Jake's hidden list
  'excluded-type',          // Compilation, DJ-mix, Remix, Demo, ...
  'wrong-type',             // primary type isn't Album / EP / Single
  'live-outside-live-list', // a live record offered to a studio list
  'other-section',          // a real section, just not one this list shows
  'various-artists',        // credited to Various Artists
  'not-credited',           // this artist isn't a principal credit (guest, absent)
  'bootleg-title',          // "Beta Version", "Demos", "Bootleg", ...
  'no-official-release',    // MusicBrainz has no Official release of it
  'official-unknown',       // MusicBrainz couldn't be asked (transient)
  'not-in-catalogue',       // neither Deezer nor iTunes has it
  'catalogue-unreachable',  // a store couldn't be asked (transient)
  'duplicate',              // an owned-excused group whose title a clean group already carries
] as const
export type RejectReason = typeof REJECT_REASONS[number]

/// Reasons caused by a source being down. A rejection made only of these
/// is not a fact about the release, so it must never be cached long.
export const TRANSIENT_REASONS: readonly RejectReason[] = ['official-unknown', 'catalogue-unreachable']

/// The reality checks an owned release is allowed to fail.
export const OWNED_MAY_FAIL: readonly RejectReason[] = [
  'various-artists', 'not-credited', 'bootleg-title', 'no-official-release', 'official-unknown',
  'not-in-catalogue', 'catalogue-unreachable',
]

export type GateVerdict = {
  id: string
  title: string
  section: ReleaseSection | null
  admitted: boolean
  owned: boolean
  /// Every check that failed, in REJECT_REASONS order. An admitted owned
  /// release can still carry reasons (the checks it was excused from).
  reasons: RejectReason[]
  /// Human-readable notes for audits: which store had it, which type
  /// excluded it, why ownership excused it.
  notes: string[]
  /// Where availability was proven ('deezer' | 'itunes'), when it was checked.
  catalogue: 'deezer' | 'itunes' | null
  /// The rejection rests only on a source being down: don't cache it.
  transient: boolean
}

export type GateResult = {
  verdicts: GateVerdict[]
  identity: { ok: boolean; why: string }
  /// False when any verdict is transient (or the identity check itself was
  /// incomplete). Callers cache an incomplete result briefly, never long.
  complete: boolean
}

type Fold = (s: string | null | undefined, sep?: string) => string
type AlbumMatch = (libraryTitle: string, candidateTitle: string) => boolean

export type CatalogueHit = { title: string; artist: string }
export type CatalogueSearch = (query: string) => Promise<{ ok: true; albums: CatalogueHit[] } | { ok: false }>
export type OfficialPage = { ok: true; releaseGroupIds: string[]; releaseCount: number; total: number } | { ok: false }
export type OfficialCount = { ok: true; count: number } | { ok: false }

export type GateDeps = {
  /// The repo's identity fold (fold-text / nameKey).
  fold: Fold
  /// The twin album-title normalizer and matcher (artist-identity /
  /// albumMatch): normAlbumTitle and albumTitlesMatch.
  normTitle: (s: string) => string
  albumMatch: AlbumMatch
  /// One page of `release?artist=<mbid>&status=official&type=...&inc=release-groups`
  /// starting at `offset`: the release-group id of every release on it.
  browseOfficial: (mbid: string, offset: number) => Promise<OfficialPage>
  /// How many Official releases one release group has
  /// (`release?release-group=<id>&status=official&limit=1`, its release-count).
  officialInGroup: (releaseGroupId: string) => Promise<OfficialCount>
  /// Deezer album search (`api.deezer.com/search/album?q=<query>`).
  deezerAlbums: CatalogueSearch
  /// iTunes Search (`itunes.apple.com/search?entity=album&term=<query>`).
  itunesAlbums: CatalogueSearch
  /// Pages of the artist-wide official scan before the rest are asked one
  /// group at a time (a cost bound, never a correctness one).
  maxOfficialPages?: number
}

export type GateInput = {
  /// The library's name for the artist.
  artist: string
  /// Other names this artist goes by in catalogues (MusicBrainz's
  /// canonical spelling, aliases). Used only to recognize store hits.
  artistNames?: string[]
  mbid: string
  identity: GateIdentity | null
  /// The identity check had a MusicBrainz failure; don't cache a refusal.
  identityIncomplete?: boolean
  /// Which lists the caller is building ('album', 'ep', ...).
  sections: readonly ReleaseSection[]
  releaseGroups: GateReleaseGroup[]
  /// Album titles in Jake's library under this artist.
  ownedAlbums: readonly string[]
  /// Jake's hidden list (defaults to HIDDEN_RELEASES; tests pass {} to
  /// prove the other checks catch a release on their own).
  hiddenReleases?: Record<string, { titles: string[]; why: string }>
}

// ── Jake's hidden releases ────────────────────────────────────────────

/// Releases Jake ruled out, keyed by the artist's MusicBrainz id, each
/// with his reason. Exact title, case-folded.
export const HIDDEN_RELEASES: Record<string, { titles: string[]; why: string }> = {
  // Geese (Brooklyn)
  'e0c97a4d-c392-41a9-a374-57af3e3eeab3': {
    titles: ['Bottomless Pink Lagoon'],
    why: 'Jake 2026-10-20: "take bottomless pink lagoon out from geese it isnt anywhere"',
  },
}

export function isHiddenRelease(mbid: string, title: string, hidden: Record<string, { titles: string[]; why: string }> = HIDDEN_RELEASES): boolean {
  const entry = hidden[mbid]
  if (!entry) return false
  const t = title.trim().toLowerCase()
  return entry.titles.some((h) => h.trim().toLowerCase() === t)
}

/// The hidden titles for one artist (empty for most).
export function hiddenReleaseTitles(mbid: string | null | undefined): string[] {
  return mbid ? [...(HIDDEN_RELEASES[mbid]?.titles ?? [])] : []
}

// ── Type ──────────────────────────────────────────────────────────────

/// MusicBrainz secondary types that never belong in a discography list.
export const EXCLUDED_SECONDARY_TYPES: readonly string[] = [
  'compilation', 'dj-mix', 'mixtape/street', 'demo', 'interview', 'spokenword',
  'audiobook', 'audio drama', 'field recording', 'remix',
]

/// Which list a release group belongs in, or why it belongs in none.
/// Unknown secondary types are excluded (fail closed); Soundtrack is the
/// one secondary type a studio list accepts.
export function sectionOf(
  primaryType: string | null | undefined,
  secondaryTypes: readonly string[] | null | undefined,
): { section: ReleaseSection | null; excluded: string | null } {
  const secondary = (secondaryTypes ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  const banned = secondary.find((s) => EXCLUDED_SECONDARY_TYPES.includes(s))
  if (banned) return { section: null, excluded: banned }
  const unknown = secondary.find((s) => s !== 'live' && s !== 'soundtrack')
  if (unknown) return { section: null, excluded: unknown }
  const primary = String(primaryType ?? '').trim().toLowerCase()
  const base: ReleaseSection | null = primary === 'album' ? 'album' : primary === 'ep' ? 'ep' : primary === 'single' ? 'single' : null
  if (!base) return { section: null, excluded: null }
  if (secondary.includes('live')) return { section: 'live', excluded: null }
  return { section: base, excluded: null }
}

// ── Credit ────────────────────────────────────────────────────────────

export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377'

/// A join phrase that turns everyone after it into a guest.
const GUEST_JOIN = /(^|[\s(\[,])(feat\.?|ft\.?|featuring)(?=[\s.]|$)/i

/// How this artist is credited on a release group.
///   principal: a lead credit ("Daft Punk", "JAY-Z & Kanye West")
///   guest:     after a "feat." join phrase
///   absent:    not in the credit at all (or no credit was sent)
///   various:   credited to Various Artists
export function creditRole(credit: readonly GateCredit[] | null | undefined, mbid: string): 'principal' | 'guest' | 'absent' | 'various' {
  if (!credit || credit.length === 0) return 'absent'
  if (credit.some((c) => c.artistId === VARIOUS_ARTISTS_MBID)) return 'various'
  const at = credit.findIndex((c) => c.artistId === mbid)
  if (at < 0) return 'absent'
  for (let i = 0; i < at; i++) {
    if (GUEST_JOIN.test(credit[i]!.joinphrase || '')) return 'guest'
  }
  return 'principal'
}

/// The principal artist names on a credit (everyone before a "feat.").
export function principalNames(credit: readonly GateCredit[] | null | undefined): string[] {
  const out: string[] = []
  for (const c of credit ?? []) {
    if (c.name) out.push(c.name)
    if (GUEST_JOIN.test(c.joinphrase || '')) break
  }
  return out
}

// ── Bootleg vocabulary (backstop) ─────────────────────────────────────

/// The phone's original bootleg-title regex (Daft Punk "Discovery (Beta
/// Version)", 2026). Kept as a backstop behind the Official-status check.
export const BOOTLEG_TITLE = /\b(beta version|beta|demos?|bootleg|unreleased|leaked?|outtakes)\b/i

// ── Titles ────────────────────────────────────────────────────────────

/// The words a release title adds in brackets or after a subtitle mark:
/// "(Beta Version)", "[Live]", ": Remixes".
export function decorationWords(title: string, fold: Fold): string[] {
  const parts: string[] = []
  for (const m of title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)) parts.push(m[1] ?? m[2] ?? '')
  const bare = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  const sub = bare.split(/\s*[:–—]\s*|\s+-\s+/)
  if (sub.length > 1) parts.push(sub.slice(1).join(' '))
  return parts.flatMap((p) => fold(p, ' ').split(' ')).filter(Boolean)
}

/// Is `other` (a library or store title) the same release as the
/// MusicBrainz title `rgTitle`? Equal under the twin title normalizer
/// (normAlbumTitle: case, accents, punctuation, a leading "The", brackets
/// and subtitles dropped), and the words the release adds in brackets or
/// after a subtitle mark must be in the other title too.
/// Deliberately stricter than albumTitlesMatch, whose prefix and word-subset
/// rules suit owned-vs-catalogue counting but here admit junk: "The
/// Alternate A Hard Day's Night" (a bootleg) would pass as owned because
/// Jake owns "A Hard Day's Night", and "The Beatles' Hits" would be proven
/// by the store's "The Beatles (The White Album)". The bracket rule is why
/// "Discovery (Beta Version)", a leak, is not Jake's "Discovery".
export function sameRelease(other: string, rgTitle: string, deps: Pick<GateDeps, 'fold' | 'normTitle'>): boolean {
  // The same characters are the same title, even with no letters to fold:
  // Bowie's "★" normalizes to nothing.
  const plain = (t: string) => t.normalize('NFKC').trim().toLowerCase()
  if (plain(other) && plain(other) === plain(rgTitle)) return true
  const a = deps.normTitle(other)
  if (!a || a !== deps.normTitle(rgTitle)) return false
  const extra = decorationWords(rgTitle, deps.fold)
  if (extra.length === 0) return true
  const have = new Set(deps.fold(other, ' ').split(' ').filter(Boolean))
  return extra.every((w) => have.has(w))
}

/// Words that make a store title a different recording, not an edition of
/// the same one: "Human After All (Remixes)" is not proof that "Human After
/// All" is in the store.
const OTHER_RECORDING = /\b(remix(es)?|remixed|live|demos?|karaoke|tribute|instrumentals?|acoustic|covers?|commentary|interview|takes?|alternate|sessions?|rehearsals?|outtakes?|mixdowns?)\b/i

/// A store's album is this release: the same release by sameRelease, and
/// it adds no other-recording marker the MusicBrainz title lacks.
export function storeTitleMatches(storeTitle: string, rgTitle: string, deps: Pick<GateDeps, 'fold' | 'normTitle'>): boolean {
  if (!sameRelease(storeTitle, rgTitle, deps)) return false
  const added = decorationWords(storeTitle, deps.fold).join(' ')
  return !OTHER_RECORDING.test(added) || OTHER_RECORDING.test(rgTitle)
}

/// Does Jake own this release group? (The bypass for the reality checks.)
export function ownsRelease(rgTitle: string, ownedAlbums: readonly string[], deps: Pick<GateDeps, 'fold' | 'normTitle'>): boolean {
  return ownedAlbums.some((owned) => sameRelease(owned, rgTitle, deps))
}

// ── Identity ──────────────────────────────────────────────────────────

/// Is this catalogue really the library's artist? The resolver's verdict
/// must be confirmed (or the only claimant), and when the library holds
/// album titles that can testify, at least one must be in the catalogue.
/// The second half catches a resolver that hands over the wrong MBID: the
/// shoegaze Geese's catalogue has none of Jake's Geese records.
export function identityVerdict(
  identity: GateIdentity | null | undefined,
  catalogueTitles: readonly string[],
  ownedAlbums: readonly string[],
  deps: Pick<GateDeps, 'normTitle' | 'albumMatch'>,
): { ok: boolean; why: string } {
  if (identity === 'ambiguous') return { ok: false, why: "several artists share this name and the library's albums can't tell them apart" }
  if (identity !== 'confirmed' && identity !== 'single') return { ok: false, why: 'no MusicBrainz artist claims this exact name' }
  const witnesses = ownedAlbums.filter((t) => deps.normTitle(t))
  if (witnesses.length > 0 && !catalogueTitles.some((t) => witnesses.some((o) => deps.albumMatch(o, t)))) {
    return { ok: false, why: `none of the ${witnesses.length} library albums are in this catalogue` }
  }
  return { ok: true, why: identity === 'confirmed' ? 'confirmed by owned albums' : 'the only artist with this name' }
}

// ── Official status ───────────────────────────────────────────────────

/// Which of `want` have at least one Official release, for the fewest
/// requests and with no cut-off that guesses. It pages through the artist's
/// official releases (100 a page, to the end: MusicBrainz's release-count),
/// and as soon as the groups still unresolved are no more than the pages
/// left, it asks about each of those directly
/// (`release?release-group=<id>&status=official&limit=1`). A scan that just
/// stops early calls a prolific artist's real albums unofficial: Bowie has
/// 1,135 official album/EP releases, and "★" and "The Next Day" sit past
/// release 400. A failed request leaves its groups `unknown` (transient),
/// never "no".
export async function officialStatus(
  mbid: string,
  want: Iterable<string>,
  deps: Pick<GateDeps, 'browseOfficial' | 'officialInGroup' | 'maxOfficialPages'>,
): Promise<{ official: Set<string>; unknown: Set<string> }> {
  const pending = new Set(want)
  const official = new Set<string>()
  const unknown = new Set<string>()
  const maxPages = deps.maxOfficialPages ?? 50
  let offset = 0
  let total = 0
  let exhausted = false
  for (let page = 0; pending.size > 0; page++) {
    if (page > 0 && (pending.size <= Math.ceil((total - offset) / 100) || page >= maxPages)) break
    const r = await deps.browseOfficial(mbid, offset)
    if (!r.ok) {
      for (const id of pending) unknown.add(id)
      return { official, unknown }
    }
    for (const id of r.releaseGroupIds) { official.add(id); pending.delete(id) }
    total = r.total
    if (r.releaseCount === 0) break  // short page before the end: ask directly
    offset += r.releaseCount
    if (offset >= total) { exhausted = true; break }
  }
  if (pending.size === 0 || exhausted) return { official, unknown }
  const left = [...pending]
  for (let i = 0; i < left.length; i++) {
    const r = await deps.officialInGroup(left[i]!)
    if (!r.ok) {
      // MusicBrainz is failing: stop asking, and leave the rest unknown.
      for (const id of left.slice(i)) unknown.add(id)
      return { official, unknown }
    }
    if (r.count > 0) official.add(left[i]!)
  }
  return { official, unknown }
}

// ── Availability ──────────────────────────────────────────────────────

/// Does a store's artist name name this artist? Whole-name fold match,
/// "The" optional, and a collaboration ("JAY-Z & Kanye West") counts for
/// each of its members.
export function storeArtistMatches(storeArtist: string, names: readonly string[], fold: Fold): boolean {
  const key = (s: string) => fold(s, ' ').replace(/^the /, '')
  const want = new Set(names.map(key).filter(Boolean))
  if (want.size === 0) return false
  if (want.has(key(storeArtist))) return true
  const parts = storeArtist.split(/\s*(?:,|&|\+|\/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i)
  return parts.length > 1 && parts.some((p) => want.has(key(p)))
}

const quoteSafe = (s: string) => s.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()

/// The Deezer queries, strictest first: the advanced artist:/album:
/// search, then plain words.
export function deezerQueries(artist: string, title: string): string[] {
  return [`artist:"${quoteSafe(artist)}" album:"${quoteSafe(title)}"`, `${quoteSafe(artist)} ${quoteSafe(title)}`]
}

export function itunesTerm(artist: string, title: string): string {
  return `${quoteSafe(artist)} ${quoteSafe(title)}`
}

/// Is the release in a mainstream catalogue? Deezer first, iTunes when
/// Deezer has no match or can't be reached. 'missing' only when both
/// stores answered and neither had it; any store failure without a match
/// is 'unreachable' (the caller rejects it, and doesn't cache that).
export async function findInCatalogue(
  names: readonly string[],
  rgTitle: string,
  deps: Pick<GateDeps, 'fold' | 'normTitle' | 'deezerAlbums' | 'itunesAlbums'>,
): Promise<{ status: 'found' | 'missing' | 'unreachable'; source: 'deezer' | 'itunes' | null; matched: string | null }> {
  const lead = names[0] ?? ''
  const hitOf = (albums: CatalogueHit[]) =>
    albums.find((a) => storeArtistMatches(a.artist, names, deps.fold) && storeTitleMatches(a.title, rgTitle, deps))
  let allAnswered = true
  for (const q of deezerQueries(lead, rgTitle)) {
    const r = await deps.deezerAlbums(q)
    if (!r.ok) { allAnswered = false; break }
    const hit = hitOf(r.albums)
    if (hit) return { status: 'found', source: 'deezer', matched: hit.title }
  }
  const r = await deps.itunesAlbums(itunesTerm(lead, rgTitle))
  if (r.ok) {
    const hit = hitOf(r.albums)
    if (hit) return { status: 'found', source: 'itunes', matched: hit.title }
  } else {
    allAnswered = false
  }
  return { status: allAnswered ? 'missing' : 'unreachable', source: null, matched: null }
}

// ── Requests and responses (shared so both repos ask the same way) ────

export const MB_WS = 'https://musicbrainz.org/ws/2'

/// MusicBrainz primary types to browse for these sections (live records
/// are Albums with a Live secondary type).
export function mbTypesFor(sections: readonly ReleaseSection[]): string {
  const want = new Set(sections.map((s) => (s === 'live' ? 'album' : s)))
  return (['album', 'ep', 'single'] as const).filter((t) => want.has(t)).join('|')
}

export function releaseGroupBrowseUrl(mbid: string, types: string, offset: number): string {
  return `${MB_WS}/release-group?artist=${encodeURIComponent(mbid)}&type=${types}&inc=artist-credits&fmt=json&limit=100&offset=${Math.max(0, Math.trunc(offset))}`
}

export function officialGroupUrl(releaseGroupId: string): string {
  return `${MB_WS}/release?release-group=${encodeURIComponent(releaseGroupId)}&status=official&fmt=json&limit=1`
}

export function officialBrowseUrl(mbid: string, types: string, offset: number): string {
  return `${MB_WS}/release?artist=${encodeURIComponent(mbid)}&status=official&type=${types}&inc=release-groups&fmt=json&limit=100&offset=${Math.max(0, Math.trunc(offset))}`
}

export function deezerSearchUrl(query: string): string {
  return `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=25`
}

export function itunesSearchUrl(term: string): string {
  return `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=album&limit=25`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/// One page of a release-group browse (with inc=artist-credits).
export function parseReleaseGroupPage(json: unknown): { groups: GateReleaseGroup[]; count: number; total: number } {
  const j = (json ?? {}) as Record<string, unknown>
  const raw = Array.isArray(j['release-groups']) ? (j['release-groups'] as Array<Record<string, unknown>>) : []
  const groups: GateReleaseGroup[] = []
  for (const g of raw) {
    const id = str(g?.id)
    const title = str(g?.title).trim()
    if (!id || !title) continue
    const ac = Array.isArray(g['artist-credit']) ? (g['artist-credit'] as Array<Record<string, unknown>>) : null
    groups.push({
      id,
      title,
      primaryType: str(g['primary-type']) || null,
      secondaryTypes: Array.isArray(g['secondary-types']) ? (g['secondary-types'] as unknown[]).map(str).filter(Boolean) : [],
      firstReleaseDate: str(g['first-release-date']) || null,
      credit: ac
        ? ac.map((c) => ({
            artistId: str((c?.artist as Record<string, unknown> | undefined)?.id) || null,
            name: str(c?.name) || str((c?.artist as Record<string, unknown> | undefined)?.name),
            joinphrase: str(c?.joinphrase),
          }))
        : null,
    })
  }
  const total = typeof j['release-group-count'] === 'number' ? (j['release-group-count'] as number) : groups.length
  return { groups, count: raw.length, total }
}

/// One page of `release?...&status=official&inc=release-groups`.
export function parseOfficialPage(json: unknown): OfficialPage {
  const j = (json ?? {}) as Record<string, unknown>
  if (!Array.isArray(j.releases)) return { ok: false }
  const releases = j.releases as Array<Record<string, unknown>>
  const ids: string[] = []
  for (const r of releases) {
    // The browse already filters on status; check it anyway (fail closed).
    if (str(r?.status) && str(r.status).toLowerCase() !== 'official') continue
    const id = str((r?.['release-group'] as Record<string, unknown> | undefined)?.id)
    if (id) ids.push(id)
  }
  const total = typeof j['release-count'] === 'number' ? (j['release-count'] as number) : releases.length
  return { ok: true, releaseGroupIds: ids, releaseCount: releases.length, total }
}

/// Deezer answers errors (quota, bad query) with HTTP 200 and `{ error }`.
export function parseDeezerAlbums(json: unknown): { ok: true; albums: CatalogueHit[] } | { ok: false } {
  const j = (json ?? {}) as Record<string, unknown>
  if (j.error || !Array.isArray(j.data)) return { ok: false }
  const albums = (j.data as Array<Record<string, unknown>>)
    .map((a) => ({ title: str(a?.title), artist: str((a?.artist as Record<string, unknown> | undefined)?.name) }))
    .filter((a) => a.title && a.artist)
  return { ok: true, albums }
}

export function parseItunesAlbums(json: unknown): { ok: true; albums: CatalogueHit[] } | { ok: false } {
  const j = (json ?? {}) as Record<string, unknown>
  if (!Array.isArray(j.results)) return { ok: false }
  const albums = (j.results as Array<Record<string, unknown>>)
    .map((a) => ({ title: str(a?.collectionName), artist: str(a?.artistName) }))
    .filter((a) => a.title && a.artist)
  return { ok: true, albums }
}

/// The one network door the gate needs: GET a URL as JSON. Callers own
/// pacing (MusicBrainz 1 req/s, the stores politely) and the User-Agent.
/// `ok: false` on any HTTP failure, timeout or unparseable body.
export type GetJson = (url: string, source: 'musicbrainz' | 'deezer' | 'itunes') => Promise<{ ok: true; json: unknown } | { ok: false; status: number | null }>

/// Gate dependencies over plain HTTP, for these sections.
export function httpGateSources(getJson: GetJson, sections: readonly ReleaseSection[]): Pick<GateDeps, 'browseOfficial' | 'officialInGroup' | 'deezerAlbums' | 'itunesAlbums'> {
  const types = mbTypesFor(sections)
  return {
    browseOfficial: async (mbid, offset) => {
      const r = await getJson(officialBrowseUrl(mbid, types, offset), 'musicbrainz')
      return r.ok ? parseOfficialPage(r.json) : { ok: false }
    },
    officialInGroup: async (releaseGroupId) => {
      const r = await getJson(officialGroupUrl(releaseGroupId), 'musicbrainz')
      const count = r.ok ? (r.json as Record<string, unknown> | null)?.['release-count'] : undefined
      return typeof count === 'number' ? { ok: true, count } : { ok: false }
    },
    deezerAlbums: async (q) => {
      const r = await getJson(deezerSearchUrl(q), 'deezer')
      return r.ok ? parseDeezerAlbums(r.json) : { ok: false }
    },
    itunesAlbums: async (term) => {
      const r = await getJson(itunesSearchUrl(term), 'itunes')
      return r.ok ? parseItunesAlbums(r.json) : { ok: false }
    },
  }
}

/// Every release group of these sections' types for an artist, paged.
/// `complete` is false when a page failed or the cap was hit.
export async function fetchReleaseGroupsForGate(
  mbid: string,
  sections: readonly ReleaseSection[],
  getJson: GetJson,
  maxPages = 10,
): Promise<{ groups: GateReleaseGroup[]; complete: boolean }> {
  const types = mbTypesFor(sections)
  const groups: GateReleaseGroup[] = []
  let offset = 0
  for (let page = 0; page < maxPages; page++) {
    const r = await getJson(releaseGroupBrowseUrl(mbid, types, offset), 'musicbrainz')
    if (!r.ok) return { groups, complete: false }
    const p = parseReleaseGroupPage(r.json)
    groups.push(...p.groups)
    offset += p.count
    if (p.count === 0 || offset >= p.total) return { groups, complete: true }
  }
  return { groups, complete: false }
}

// ── The gate ──────────────────────────────────────────────────────────

function ordered(reasons: Iterable<RejectReason>): RejectReason[] {
  const set = new Set(reasons)
  return REJECT_REASONS.filter((r) => set.has(r))
}

/// Judge every release group for one artist. Network work runs only
/// where it can change the answer: the official scan covers groups the
/// cheap checks left standing, and stores are asked only about groups
/// that passed everything else and that Jake doesn't own.
export async function gateReleaseGroups(input: GateInput, deps: GateDeps): Promise<GateResult> {
  const groups = input.releaseGroups
  const identity = identityVerdict(input.identity, groups.map((g) => g.title), input.ownedAlbums, deps)
  if (!identity.ok) {
    return {
      identity,
      complete: !input.identityIncomplete,
      verdicts: groups.map((g) => ({
        id: g.id, title: g.title, section: sectionOf(g.primaryType, g.secondaryTypes).section,
        admitted: false, owned: false, reasons: ['identity'], notes: [identity.why], catalogue: null,
        transient: !!input.identityIncomplete,
      })),
    }
  }

  type Draft = { g: GateReleaseGroup; section: ReleaseSection | null; owned: boolean; reasons: Set<RejectReason>; notes: string[]; catalogue: 'deezer' | 'itunes' | null }
  const drafts: Draft[] = groups.map((g) => {
    const reasons = new Set<RejectReason>()
    const notes: string[] = []
    const { section, excluded } = sectionOf(g.primaryType, g.secondaryTypes)
    const hidden = input.hiddenReleases ?? HIDDEN_RELEASES
    if (isHiddenRelease(input.mbid, g.title, hidden)) { reasons.add('hidden'); notes.push(hidden[input.mbid]?.why ?? 'hidden by Jake') }
    if (excluded) { reasons.add('excluded-type'); notes.push(`secondary type ${excluded}`) }
    else if (!section) { reasons.add('wrong-type'); notes.push(`primary type ${g.primaryType ?? 'none'}`) }
    else if (!input.sections.includes(section)) reasons.add(section === 'live' ? 'live-outside-live-list' : 'other-section')
    const role = creditRole(g.credit, input.mbid)
    if (role === 'various') reasons.add('various-artists')
    else if (role !== 'principal') { reasons.add('not-credited'); notes.push(role === 'guest' ? 'credited as a guest (feat.)' : 'not in the artist credit') }
    if (BOOTLEG_TITLE.test(g.title)) reasons.add('bootleg-title')
    return { g, section, owned: ownsRelease(g.title, input.ownedAlbums, deps), reasons, notes, catalogue: null }
  })

  // A group is still in play when nothing but a reality check has failed
  // (owned groups always are: they pass reality checks regardless).
  const hardFail = (d: Draft) => [...d.reasons].some((r) => !OWNED_MAY_FAIL.includes(r))
  const inPlay = drafts.filter((d) => !hardFail(d))

  const status = await officialStatus(input.mbid, inPlay.map((d) => d.g.id), deps)
  for (const d of inPlay) {
    if (status.official.has(d.g.id)) continue
    d.reasons.add(status.unknown.has(d.g.id) ? 'official-unknown' : 'no-official-release')
  }

  const names = [input.artist, ...(input.artistNames ?? [])]
  for (const d of inPlay) {
    if (d.owned || d.reasons.size > 0) continue
    const found = await findInCatalogue([...names, ...principalNames(d.g.credit)], d.g.title, deps)
    if (found.status === 'found') { d.catalogue = found.source; d.notes.push(`${found.source}: ${found.matched}`) }
    else d.reasons.add(found.status === 'missing' ? 'not-in-catalogue' : 'catalogue-unreachable')
  }

  const verdicts: GateVerdict[] = drafts.map((d) => {
    const reasons = ordered(d.reasons)
    const excused = d.owned && !hardFail(d)
    const admitted = reasons.length === 0 || excused
    if (excused && reasons.length > 0) d.notes.push(`owned: admitted despite ${reasons.join(', ')}`)
    else if (d.owned && admitted) d.notes.push('owned')
    const transient = !admitted && reasons.length > 0 && reasons.every((r) => TRANSIENT_REASONS.includes(r))
    return { id: d.g.id, title: d.g.title, section: d.section, admitted, owned: d.owned, reasons, notes: d.notes, catalogue: d.catalogue, transient }
  })
  // Ownership excuses a release for being real to Jake, not for being the
  // copy he owns: when a group with the same title passed every check on its
  // own, an excused namesake group (a bootleg called "The Beatles") goes.
  for (const v of verdicts) {
    if (!v.admitted || v.reasons.length === 0) continue
    const clean = verdicts.find((o) => o !== v && o.admitted && o.reasons.length === 0 && o.section === v.section && sameRelease(o.title, v.title, deps))
    if (!clean) continue
    v.admitted = false
    v.reasons = ordered([...v.reasons, 'duplicate'])
    v.notes.push(`duplicate of the clean "${clean.title}" (${clean.id})`)
  }
  return { identity, verdicts, complete: !verdicts.some((v) => v.transient) }
}

/// The primary (first-applying) reason for a rejected verdict.
export function primaryReason(v: GateVerdict): RejectReason | null {
  return v.admitted ? null : (v.reasons[0] ?? null)
}

/// One log line: "kept 9, rejected 4 (Leftovers: no-official-release, ...)".
export function describeGate(result: GateResult, max = 8): string {
  const kept = result.verdicts.filter((v) => v.admitted)
  const out = result.verdicts.filter((v) => !v.admitted)
  if (!result.identity.ok) return `identity refused (${result.identity.why}); rejected all ${out.length}`
  const shown = out.slice(0, max).map((v) => `${v.title}: ${v.reasons.join('+')}`)
  return `kept ${kept.length}, rejected ${out.length}${shown.length ? ` (${shown.join('; ')}${out.length > max ? '; ...' : ''})` : ''}${result.complete ? '' : ' [incomplete]'}`
}
