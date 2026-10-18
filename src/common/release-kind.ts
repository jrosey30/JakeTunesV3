/**
 * What a release IS inside an artist's discography: a studio album, an EP,
 * a single, a live recording or a compilation (Jake, 2026-10-18: "mobile
 * needs to do better at grouping what is a compilation, studio release,
 * live concert, single and EP within an artist's discography … on desktop
 * and mobile").
 *
 * One rulebook, both apps. Desktop resolves each album ONCE (MusicBrainz
 * first) and writes the answer to `release-kinds.json` in the shared state
 * dir; the phone backend reads that file. When an album has no stored
 * answer yet, both sides fall back to `classifyRelease` with no MusicBrainz
 * facts — the same title and shape rules — so they still agree.
 *
 * Precedence: manual > MusicBrainz > title markers > shape > default.
 *  - MusicBrainz: secondary type Live → live, Compilation → compilation;
 *    otherwise primary type Single / EP / Album.
 *  - Title: Apple's " - Single" / " - EP" suffixes, "(Live …)", "Live at /
 *    in / from", "(Live Set)" (JakeTunes concert rows), "Unplugged", "In
 *    Concert", "At the BBC"; "Greatest Hits", "Best Of", "Past Masters",
 *    "Collection", "Essential", "Singles", "Hits" … (the desktop page's
 *    pre-10/18 list, minus "mixtape" — an artist's own release), or album
 *    artist "Various Artists" → compilation. A bare "live" inside a title
 *    is NOT live ("Live Through This" is a studio album); MusicBrainz, which
 *    wins over the title, corrects the rare studio album titled "Singles".
 *  - Shape (only with a DECLARED track count — owning 2 songs of a 12-song
 *    album says nothing): ≤ 3 tracks and under 30 min → single; ≤ 6 and
 *    under 30 min → EP; else album.
 *
 * Pure, and imports nothing: the phone backend's twin must be a leaf module
 * (its node --test runner cannot resolve '.js' siblings).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/releaseKind.ts — keep the
 * rules, labels, order and key format byte-for-byte in step.
 */

export type ReleaseKind = 'album' | 'ep' | 'single' | 'live' | 'compilation'
export type ReleaseKindSource = 'manual' | 'musicbrainz' | 'title' | 'shape' | 'default'

/** Section order on an artist page. */
export const RELEASE_KIND_ORDER: readonly ReleaseKind[] = ['album', 'ep', 'single', 'live', 'compilation']

export const RELEASE_KIND_LABEL: Readonly<Record<ReleaseKind, string>> = {
  album: 'Albums',
  ep: 'EPs',
  single: 'Singles',
  live: 'Live',
  compilation: 'Compilations',
}

export interface MbReleaseType {
  primaryType?: string | null
  secondaryTypes?: readonly string[] | null
}

export interface ReleaseFacts {
  album: string
  albumArtist?: string | null
  /** The album's declared track count (library `trackCount`), 0 / missing if unknown. */
  declaredTrackCount?: number | null
  /** Durations (ms) of the songs owned — used only when all declared songs are owned. */
  ownedDurationsMs?: readonly number[] | null
  mb?: MbReleaseType | null
  manual?: ReleaseKind | null
}

export interface ReleaseKindResult { kind: ReleaseKind; source: ReleaseKindSource }

export function kindFromMusicBrainz(t: MbReleaseType | null | undefined): ReleaseKind | null {
  if (!t) return null
  const secondary = (t.secondaryTypes || []).map((s) => String(s).toLowerCase())
  if (secondary.includes('live')) return 'live'
  if (secondary.includes('compilation')) return 'compilation'
  const primary = String(t.primaryType || '').toLowerCase()
  if (primary === 'single') return 'single'
  if (primary === 'ep') return 'ep'
  if (primary === 'album') return 'album'
  return null // Broadcast / Other: let the title and shape decide
}

const SINGLE_MARK = /\s[-–—]\s*single\s*$/i
const EP_MARK = /(?:^|\s[-–—]\s*|\s|\()ep\)?\s*$/i
const LIVE_MARK = /[([]\s*live\b|\blive\s+(?:at|in|from|on)\b|\bunplugged\b|\blive\s*$|\blive!|\bin concert\b|\bat the bbc\b|\bbbc sessions\b/i
const COMPILATION_MARK = /\b(?:greatest hits|best of|the very best|anthology|collection|essentials?|retrospective|b-sides|b sides|rarities|past masters|singles|hits|love songs|ballads|compilation)\b/i

export function kindFromTitle(album: string, albumArtist?: string | null): ReleaseKind | null {
  const a = String(album || '').trim()
  if (!a) return null
  if (SINGLE_MARK.test(a)) return 'single'
  if (EP_MARK.test(a)) return 'ep'
  if (LIVE_MARK.test(a)) return 'live'
  if (COMPILATION_MARK.test(a)) return 'compilation'
  if (String(albumArtist || '').trim().toLowerCase() === 'various artists') return 'compilation'
  return null
}

const THIRTY_MIN_MS = 30 * 60 * 1000

export function kindFromShape(declaredTrackCount?: number | null, ownedDurationsMs?: readonly number[] | null): ReleaseKind | null {
  const n = Number(declaredTrackCount) || 0
  if (n <= 0) return null
  const owned = (ownedDurationsMs || []).filter((d) => Number(d) > 0)
  // Total running time is known only when every declared song is owned.
  const total = owned.length >= n ? owned.reduce((s, d) => s + Number(d), 0) : null
  const short = total === null || total < THIRTY_MIN_MS
  if (n <= 3 && short) return 'single'
  if (n <= 6 && short) return 'ep'
  return 'album'
}

export function classifyRelease(f: ReleaseFacts): ReleaseKindResult {
  if (f.manual && RELEASE_KIND_ORDER.includes(f.manual)) return { kind: f.manual, source: 'manual' }
  const mb = kindFromMusicBrainz(f.mb)
  if (mb) return { kind: mb, source: 'musicbrainz' }
  const title = kindFromTitle(f.album, f.albumArtist)
  if (title) return { kind: title, source: 'title' }
  const shape = kindFromShape(f.declaredTrackCount, f.ownedDurationsMs)
  if (shape) return { kind: shape, source: 'shape' }
  return { kind: 'album', source: 'default' }
}

/**
 * The album title to look up on MusicBrainz: Apple's " - Single" / " - EP"
 * suffixes and edition tags ("(Deluxe Edition)", "[Remastered 2011]",
 * "(Expanded)") removed. Live/concert wording is kept — it IS the title.
 */
export function releaseTitleForLookup(album: string): string {
  let s = String(album || '').trim()
  s = s.replace(/\s[-–—]\s*(?:single|ep)\s*$/i, '')
  s = s.replace(/\s*[([](?:[^)\]]*\b(?:deluxe|remaster(?:ed)?|expanded|anniversary|bonus track|special edition|edition)\b[^)\]]*)[)\]]\s*$/i, '')
  return s.trim() || String(album || '').trim()
}

/**
 * The key an album is stored under in release-kinds.json:
 * `${fold(albumArtist || artist)}|${fold(album)}`. `fold` is each repo's
 * nameKey (fold-text.ts / nameKey.ts — themselves twins), injected so this
 * module stays import-free.
 */
export function releaseKey(fold: (s: string) => string, artist: string, album: string): string {
  return `${fold(artist || '')}|${fold(album || '')}`
}

/** release-kinds.json — written by desktop, read by both apps. */
export interface ReleaseKindsFile {
  version: 1
  updatedAt: string
  albums: Record<string, {
    kind: ReleaseKind
    source: ReleaseKindSource
    /** MusicBrainz release-group id when source is 'musicbrainz'. */
    mbid?: string
    /** When MusicBrainz was last asked (a miss is retried after 30 days). */
    checkedAt?: string
  }>
}

export const RELEASE_KINDS_FILE = 'release-kinds.json'
