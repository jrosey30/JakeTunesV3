/**
 * Download search — P1C3 of the structural renovation (2026-08-16).
 *
 * The iTunes/Deezer search surface the Download page and the List omnibox
 * stand on: suggestion search with the artist-catalogue upgrade path, the
 * explicit-edition rescue (fetchExplicitAlbumMap + resolveExplicitEdition,
 * the Migos fix and its title-search extension), the Deezer rate-limit
 * failover, the junk-artist filter, and the album tracklist expansion.
 *
 * Moved OUT of main/index.ts by dependency map. Unlike P1C1 this cluster
 * needed NO injected dependencies — it is fetch + pure logic end to end,
 * so the module is import-only and node --test reaches everything. The two
 * IPC registrations stay in index.ts as one-line shims over
 * searchItunesSuggestions / itunesAlbumTracks; bodies here are the shipped
 * bytes with exactly two mechanical changes: handler arrows became named
 * exported functions, and their `, { refuse: ... })` closers became `}`.
 *
 * ItunesSuggestion is deliberately NARROWER than the rows some paths build
 * (collectionId / trackNumber / durationSecs ride along via assignability,
 * and the renderer's mirror type declares them) — preserved as-is because
 * widening it is a type change, not a move.
 */

import { foldAccents } from '../common/fold-text.ts'
import { explicitWins } from '../common/explicit.ts'

/**
 * A catalogue row that is really a 30-second PREVIEW, not the song.
 *
 * 2026-08-26, Jake with a screenshot of a search result reading 0:29 —
 * "WHAT THE FUCK IS THIS????". Matt and Kim's "Let's Go" was being offered at
 * twenty-nine seconds. There was NO minimum-duration guard anywhere in search,
 * so a snippet release ranked like a real track and would have downloaded as
 * one.
 *
 * Deliberately narrow, because Jake's library legitimately contains 3-15s
 * pieces (Eminem "Paul (Skit)", Modest Mouse "Horn Intro", The Who "Miracle
 * Cure" — 122 tracks under 45s). Those announce themselves in the title. A
 * short row that does NOT is a snippet.
 */
const DELIBERATELY_SHORT = /\b(interlude|skit|intro|outro|prelude|reprise|segue|prologue|epilogue|bonus beat|a cappella)\b|^untitled/i
export const PREVIEW_MAX_SECS = 45

export function isPreviewLengthResult(durationSecs: number | undefined, title: string): boolean {
  if (typeof durationSecs !== 'number' || !Number.isFinite(durationSecs) || durationSecs <= 0) return false
  if (durationSecs > PREVIEW_MAX_SECS) return false
  return !DELIBERATELY_SHORT.test(String(title || ''))
}

export interface ItunesSuggestion {
  song: string
  artist: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  appleMusicUrl?: string
  /** Release year, and the collection's REAL track count.
   *  Jake, 2026-08-09: "albums and EP's need the release year next to them."
   *  The Download list had neither, so every release rendered as a hardcoded
   *  "ALBUM" badge with no date — a 3-track EP and a 1994 LP looked identical,
   *  and there was no way to tell an original from a reissue. trackCount rides
   *  along because it is what makes the badge honest; the row's own song count
   *  is only how many of that album happened to appear in the search results. */
  releaseYear?: number
  trackCount?: number
  /** iTunes' primaryGenreName. Real metadata, not a guess — it gives a release
   *  card a third fact to stand on beside year and size. */
  genre?: string
  /** 'explicit' | 'cleaned' | 'notExplicit'. Jake, 2026-08-09, on Life After
   *  Death: it "kept downloading a separate radio clean version". iTunes only
   *  carries that album as the Amended edition and nothing in the UI said so,
   *  so the clean cut was invisible until it was already in the library. */
  explicitness?: string
}
/**
 * Year out of an iTunes releaseDate ("1994-09-13T07:00:00Z").
 *
 * Parsed off the string rather than through Date: releaseDate is UTC, and a
 * release dated Jan 1 lands on Dec 31 of the PREVIOUS year once a Date is read
 * back in a western timezone. An album's year is not a timestamp, so it should
 * not survive a timezone conversion. Anything that isn't a plain 4-digit year
 * in a sane range returns undefined and the UI shows nothing — a blank is
 * honest, a wrong year is not.
 */
export function itunesYear(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^(\d{4})/.exec(raw)
  if (!m) return undefined
  const y = Number(m[1])
  return y >= 1900 && y <= 2100 ? y : undefined
}

// Obvious non-original acts — karaoke, tribute/cover factories, lullaby
// renditions, kids covers. iTunes Search has NO popularity score, so it
// dumps these in with the real thing. Filter them out entirely.
export const ITUNES_JUNK_ARTIST = /karaoke|tribute|cover band|made famous|made popular|in the style of|originally performed|8.?bit|chiptune|lullaby|rockabye|little rock star|music foundation|piano (tribute|version|renditions?)|string quartet|meditation|sleep baby|nursery/i
// Deezer public search — the INSTANT fallback when Apple rate-limits
// (403s under heavy use; Jake typed "when you die MGMT" into a silent
// blank, 2026-07-16). Keyless, ~200ms, artwork + 30s previews, and it
// maps 1:1 onto the ItunesSuggestion shape so every consumer (Download
// search, List omnibox) inherits the failover for free.
export async function fetchDeezerSuggestions(q: string): Promise<ItunesSuggestion[] | null> {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=25`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = await res.json() as { data?: Array<{ title?: string; preview?: string; artist?: { name?: string }; album?: { title?: string; cover_medium?: string } }> }
    const out: ItunesSuggestion[] = (data.data || []).map((r) => ({
      song: String(r.title ?? ''),
      artist: String(r.artist?.name ?? ''),
      album: r.album?.title ? String(r.album.title) : undefined,
      artworkUrl: r.album?.cover_medium || undefined,
      previewUrl: r.preview || undefined,
    })).filter((s) => s.song && s.artist)
    return out.length ? out : null
  } catch { return null }
}

// The uncensored editions of every album a set of artists has, keyed by
// folded album name. This is the heart of the Migos fix (3968c84): the song
// SEARCH endpoint prefers cleaned editions, the artist LOOKUP endpoint has
// both, so any row built from search results has to be repointed here before
// its collectionId is worth expanding. Shared by BOTH search paths —
// title-shaped queries harvest artistIds from their own results, artist-shaped
// queries pass the resolved artist — so the two can never drift apart again
// the way the original inline version did.
export async function fetchExplicitAlbumMap(artistIds: number[]): Promise<Map<string, { id: number; trackCount?: number }>> {
  const map = new Map<string, { id: number; trackCount?: number }>()
  if (artistIds.length === 0) return map
  await Promise.all(artistIds.map(async (artistId) => {
    try {
      const abRes = await fetch(
        // 200 is the lookup endpoint's max, and it matters: Nicki Minaj's
        // catalog holds 200+ collections, and at limit=100 the explicit
        // "Roman Reloaded the Re-Up" simply wasn't in the page — so the
        // rescue coin-flipped on big-catalog artists (measured 2026-08-15:
        // limit=100 → 0 explicit Re-Up editions, limit=200 → 1).
        `https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200`,
        { signal: AbortSignal.timeout(6000) })
      if (!abRes.ok) return
      const abData = await abRes.json() as { results?: Array<Record<string, unknown>> }
      for (const c of abData.results || []) {
        if (c.wrapperType !== 'collection') continue
        if (c.collectionExplicitness !== 'explicit') continue
        const name = foldAccents(String(c.collectionName ?? '')).replace(/[^a-z0-9]/g, '')
        if (!name || !c.collectionId) continue
        // First explicit wins: Apple lists deluxe/extended variants under
        // their own names, so a same-name hit is the album.
        if (!map.has(name)) {
          map.set(name, {
            id: Number(c.collectionId),
            trackCount: typeof c.trackCount === 'number' ? c.trackCount : undefined,
          })
        }
      }
    } catch { /* one artist's lookup failing must not sink the others */ }
  }))
  return map
}

/**
 * The lookup an individual row does against the explicit map. Exact folded
 * name first; failing that, the PARENTHETICAL BRIDGE: Apple frequently
 * censors "Album (Bonus Track Version)" while listing the explicit edition
 * as plain "Album" — same record, differently subtitled. Stripping the
 * trailing parenthetical is only trusted when the TRACK COUNTS MATCH:
 * identical counts = the same record wearing two names; different counts
 * (a real deluxe vs the standard album) = genuinely different editions, and
 * repointing would silently change what Jake downloads — so the honest
 * cleaned badge stays. Measured refusal that proves the gate's worth
 * (2026-08-15): cleaned "…the Re-Up (Booklet Version)" is EIGHT tracks;
 * explicit "…the Re-Up" is TWENTY-EIGHT. Same base name, different record —
 * a name-only bridge would have silently swapped one for the other.
 */
export function resolveExplicitEdition(
  albumName: string,
  rowTrackCount: number | undefined,
  map: Map<string, { id: number; trackCount?: number }>,
): { id: number } | undefined {
  const folded = foldAccents(albumName).replace(/[^a-z0-9]/g, '')
  if (!folded) return undefined
  const exact = map.get(folded)
  if (exact) return exact
  const base = albumName.replace(/\s*[([][^)\]]*[)\]]\s*$/, '')
  if (base === albumName) return undefined
  const baseFolded = foldAccents(base).replace(/[^a-z0-9]/g, '')
  const bridged = baseFolded ? map.get(baseFolded) : undefined
  if (!bridged) return undefined
  if (rowTrackCount === undefined || bridged.trackCount === undefined) return undefined
  return rowTrackCount === bridged.trackCount ? bridged : undefined
}

export async function searchItunesSuggestions(query: string): Promise<{ ok: boolean; results: ItunesSuggestion[] }> {
  const q = (query || '').trim()
  if (q.length < 2) return { ok: true, results: [] }
  try {
    // Pull a WIDER pool (25) than we show, so the re-rank below has enough
    // signal to float the recognizable artist up and bury one-off covers.
    let raw: ItunesSuggestion[] | null = null
    try {
      // Apple THROTTLES bursts, and this search fires on every typing pause.
      // Measured: three back-to-back queries return empty, the same three
      // with a 2s gap all return 200 with results. A throttled response used
      // to fall straight through to the failover and render a thin page — the
      // search looked broken when it had simply been asked too fast. One
      // short retry costs 400ms and recovers most of them.
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=60`
      let res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok || res.status === 403) {
        await new Promise((r) => setTimeout(r, 400))
        res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      }
      if (res.ok) {
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
        // Jake, 2026-08-15, searching the song title "Shawty Is Da Sh*!" and
        // getting CLEAN-only releases: "WHY IS THE CLEAN VERSION ONLY
        // SHOWING????????"
        //
        // The Migos fix only rescued queries that RESOLVE AS AN ARTIST — the
        // rescue lived inside the musicArtist branch below. A song-title
        // query never enters it, so its rows shipped whatever editions the
        // search endpoint returned, and that endpoint prefers cleaned. The
        // key was in our hands the whole time: every song result carries its
        // artistId. Harvest the ids that own CLEANED rows (only they need
        // rescuing — zero extra requests when nothing is censored) and
        // repoint those rows at the uncensored editions of the same albums.
        const results = data.results || []
        const cleanedArtistIds = [...new Set(results
          .filter((r) => r.trackExplicitness === 'cleaned' || r.collectionExplicitness === 'cleaned')
          .map((r) => Number(r.artistId))
          .filter((id) => Number.isFinite(id) && id > 0))].slice(0, 4)
        const explicitByAlbum = await fetchExplicitAlbumMap(cleanedArtistIds)
        raw = results
          .map((r) => {
            const uncensored = resolveExplicitEdition(
              String(r.collectionName ?? ''),
              typeof r.trackCount === 'number' ? r.trackCount : undefined,
              explicitByAlbum)
            const rescued = uncensored !== undefined &&
              (r.trackExplicitness === 'cleaned' || r.collectionExplicitness === 'cleaned')
            return {
              song: String(r.trackName ?? ''),
              artist: String(r.artistName ?? ''),
              album: r.collectionName ? String(r.collectionName) : undefined,
              // Bump the 100px thumb to 200px for a crisper suggestion row.
              artworkUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : undefined,
              previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
              appleMusicUrl: r.trackViewUrl ? String(r.trackViewUrl) : undefined,
              // A rescued row points at the UNCENSORED edition — the
              // collectionId is what the album expands by, so this is the
              // difference between downloading the record and downloading
              // the radio edit of it.
              collectionId: rescued ? uncensored.id : (r.collectionId ? Number(r.collectionId) : undefined),
              // Length of the EXACT version this row represents — the download
              // path verifies the Qobuz file against it (wrong-version guard).
              durationSecs: typeof r.trackTimeMillis === 'number' ? Math.round(r.trackTimeMillis / 1000) : undefined,
              releaseYear: itunesYear(r.releaseDate),
              trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
              genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
              explicitness: rescued ? 'explicit'
                : (typeof r.trackExplicitness === 'string' ? r.trackExplicitness : undefined),
            }
          })
          .filter((s) => s.song && s.artist && !ITUNES_JUNK_ARTIST.test(s.artist) && !ITUNES_JUNK_ARTIST.test(s.album || '')
            && !isPreviewLengthResult(s.durationSecs, s.song))
      }
    } catch { raw = null }
    if (raw === null) raw = await fetchDeezerSuggestions(q)
    if (raw === null) return { ok: false, results: [] }

    // ── the artist's OWN catalogue ────────────────────────────────────────
    // Jake, 2026-08-09, searching "Jay z": every result was a Beyoncé or
    // Rihanna track that FEATURES him, and not one of his own records. That is
    // (fetchExplicitAlbumMap — the explicit-edition rescue shared with the
    // title-search path above — is defined just before this handler.)
    // Apple's ranking, not a bug we introduced — a song search sorts by
    // popularity, and a superstar's guest verses out-rank his own catalogue.
    //
    // Resolving the ARTIST first fixes it, and fixes the spelling at the same
    // time: "jay z" resolves to JAŸ-Z (U+0178) and "husker du" to Hüsker Dü,
    // which is the canonical name Apple files their records under.
    //
    // Only fires when the query really does look like an artist NAME — the
    // resolved artist must fold to the query itself. So "husker du" and
    // "snoop dogg" trigger it and "when you die mgmt" does not, which matters
    // because that phrase resolves to MGMT and would otherwise bury the song
    // the user actually typed under MGMT's back catalogue.
    const foldedQ = foldAccents(q).replace(/[^a-z0-9]/g, '')
    if (foldedQ.length >= 3) {
      try {
        const aRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=musicArtist&limit=3`,
          { signal: AbortSignal.timeout(3500) })
        if (aRes.ok) {
          const aData = await aRes.json() as { results?: Array<{ artistId?: number; artistName?: string }> }
          const hit = (aData.results || []).find((a) =>
            foldAccents(a.artistName || '').replace(/[^a-z0-9]/g, '') === foldedQ)
          if (hit?.artistId) {
            const lRes = await fetch(`https://itunes.apple.com/lookup?id=${hit.artistId}&entity=song&limit=120`,
              { signal: AbortSignal.timeout(6000) })
            if (lRes.ok) {
              const lData = await lRes.json() as { results?: Array<Record<string, unknown>> }
              const canonical = foldAccents(hit.artistName || '').replace(/[^a-z0-9]/g, '')

              // ── Find the UNCENSORED edition of each album ──────────────
              // Jake, 2026-08-10, searching Migos and getting CLEAN copies of
              // Culture and Culture II: "this is a disaster."
              //
              // Apple's two endpoints disagree, and the one we were using is
              // the worse of the pair. Measured on the live API:
              //
              //   lookup?id=<artist>&entity=album  ->  Culture II explicit
              //                                        1440907256 AND cleaned
              //                                        1440914594
              //   search?term=Migos Culture II     ->  cleaned 1440914594 ONLY
              //
              // Album rows here are derived from a SONG search, and those
              // results carry the collectionId of whatever the search endpoint
              // returned - the censored one. So the row pointed at the clean
              // album, expanding it fetched the clean tracklist, and every
              // download taken from it was censored. Preferring 'explicit'
              // among the results could never help: no explicit result was
              // ever in the set to prefer.
              //
              // So ask the endpoint that has both, and rewrite each track's
              // collection to the uncensored edition of the same album.
              // One implementation for both paths — see fetchExplicitAlbumMap
              // above the handler. This used to be inline here, which is how
              // the title-search path shipped without it.
              const explicitByAlbum = await fetchExplicitAlbumMap([Number(hit.artistId)])
              const own = (lData.results || [])
                .filter((r) => (r.wrapperType === 'track' || r.kind === 'song') && r.trackName && r.artistName)
                // PRIMARY artist only. The lookup also returns the guest spots
                // the plain search already gave us; keeping them would just
                // deepen the pile we are trying to get out from under.
                .filter((r) => foldAccents(String(r.artistName)).replace(/[^a-z0-9]/g, '').startsWith(canonical))
                .map((r) => ({
                  song: String(r.trackName ?? ''),
                  artist: String(r.artistName ?? ''),
                  album: r.collectionName ? String(r.collectionName) : undefined,
                  artworkUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : undefined,
                  previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
                  appleMusicUrl: r.trackViewUrl ? String(r.trackViewUrl) : undefined,
                  collectionId: (() => {
                    const ex = resolveExplicitEdition(String(r.collectionName ?? ''),
                      typeof r.trackCount === 'number' ? r.trackCount : undefined, explicitByAlbum)
                    return ex ? ex.id : (r.collectionId ? Number(r.collectionId) : undefined)
                  })(),
                  durationSecs: typeof r.trackTimeMillis === 'number' ? Math.round(r.trackTimeMillis / 1000) : undefined,
                  releaseYear: itunesYear(r.releaseDate),
                  trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
                  genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
                  explicitness: (() => {
                    // If an uncensored edition of this album exists, the row now
                    // points at it, so the badge must say so too.
                    if (resolveExplicitEdition(String(r.collectionName ?? ''),
                      typeof r.trackCount === 'number' ? r.trackCount : undefined, explicitByAlbum)) return 'explicit'
                    return typeof r.trackExplicitness === 'string' ? r.trackExplicitness : undefined
                  })(),
                }))
                .filter((s2) => !ITUNES_JUNK_ARTIST.test(s2.artist))
              // Dedupe on song+artist WITHOUT the album: an artist's catalogue
              // carries the same track on the album, the greatest-hits and the
              // single, and adding all three put "Empire State Of Mind" in the
              // list twice before this line existed.
              // ⚠️ The plain search and the artist lookup do NOT return the same
              // editions. Measured on the live API, 2026-08-10:
              //
              //   search?term=Migos Culture II  ->  cleaned  1440914594 only
              //   lookup?id=<artist>&entity=song ->  explicit 1440907256
              //
              // `raw` is the search (censored), `own` is the lookup (real). This
              // loop used to append only songs the search had NOT returned, so
              // every uncensored version of a song the search already had was
              // thrown away — and the censored one kept the row, and with it the
              // collectionId the album expands by. That is why Jake searched
              // Migos and got CLEAN copies of Culture and Culture II, and why
              // downloads off those rows were censored.
              //
              // So a lookup result now UPGRADES a censored one in place instead
              // of being discarded. Still deduped on song+artist without the
              // album, which is what stops the same track appearing three times
              // off the album, the compilation and the single.
              const byKey = new Map<string, number>()
              raw.forEach((r, i) => {
                const k = `${foldAccents(r.song)}|${foldAccents(r.artist)}`
                if (!byKey.has(k)) byKey.set(k, i)
              })
              for (const o of own) {
                const k = `${foldAccents(o.song)}|${foldAccents(o.artist)}`
                const at = byKey.get(k)
                if (at === undefined) { byKey.set(k, raw.length); raw.push(o); continue }
                // explicitWins is the TESTED doctrine (common/explicit.ts):
                  // explicit takes over a cleaned row, notExplicit never loses
                  // its seat. This line was an inline twin of it for months —
                  // identical today, one refactor away from drifting.
                  if (explicitWins(raw[at].explicitness, o.explicitness)) raw[at] = o
              }
            }
          }
        }
      } catch { /* the plain search already stands on its own */ }
    }

    // Re-rank toward the recognizable version. iTunes gives no popularity
    // score, so use a free proxy: a famous artist shows up MULTIPLE times
    // for one song (studio + live + comps), while a one-off cover appears
    // once. Boost by that frequency, prefer studio over live, and demote
    // the "<TrackTitle> - Single" one-offs that covers ship as.
    const artistFreq = new Map<string, number>()
    for (const s of raw) {
      const k = s.artist.toLowerCase()
      artistFreq.set(k, (artistFreq.get(k) || 0) + 1)
    }
    // Fold accents BEFORE stripping, or an accented artist scores against a
    // mangled string — "JAŸ-Z" becomes "ja z" and never matches "jay z".
    const qNorm = foldAccents(q).replace(/[^a-z0-9]+/g, ' ').trim()
    const scoreOf = (s: ItunesSuggestion): number => {
      let score = (artistFreq.get(s.artist.toLowerCase()) || 1) * 10
      const album = (s.album || '').toLowerCase()
      const song = s.song.toLowerCase()
      // The song the user actually TYPED wins: if the track title appears
      // verbatim inside the query, nothing popularity-ranked beats it
      // ("when you die mgmt" must put When You Die above Little Dark Age).
      const songNorm = foldAccents(song).replace(/[^a-z0-9]+/g, ' ').trim()
      if (songNorm.length > 3 && qNorm.includes(songNorm)) score += 25
      const isLive = /\blive\b|\(live/.test(song) || /\blive\b/.test(album)
      const isRemix = /remix|rework|edit\)/.test(song) || /remix/.test(album)
      if (!isLive && !isRemix && !/ - single$/.test(album)) score += 4   // prefer the studio cut
      if (isLive) score -= 3                                          // demote live versions a touch
      if (isRemix) score -= 3                                         // and remixes — the original leads
      if (/ - single$/.test(album) && album.startsWith(song)) score -= 6 // one-off cover single
      return score
    }
    const ranked = raw
      .map((s, i) => ({ s, i, score: scoreOf(s) }))
      .sort((a, b) => (b.score - a.score) || (a.i - b.i))   // score desc, iTunes order as stable tiebreak
      .slice(0, 10)
      .map((x) => x.s)
    return { ok: true, results: ranked }
  } catch {
    return { ok: false, results: [] }
  }
}

// Full tracklist for an album, by iTunes collection id. Powers the Download
// view's "expand the album → see every track" (2026-07-23): the search only
// returns the handful of songs that matched, so an album's real contents were
// invisible. lookup?entity=song returns the collection record first, then every
// track in order.
export async function itunesAlbumTracks(collectionId: number): Promise<{ ok: boolean; tracks: ItunesSuggestion[]; album?: string; artist?: string; artworkUrl?: string; releaseYear?: number; trackCount?: number; genre?: string; explicitness?: string }> {
  const id = Number(collectionId)
  if (!id || !Number.isFinite(id)) return { ok: false, tracks: [] }
  try {
    const url = `https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200`
    // Two tries, 8 s each: the lookup answers 403/timeout under a burst
    // (2026-09-03, Sister Nancy "One Two": "Couldn't load the tracklist"
    // while the same lookup returned 11 rows from a shell moments later).
    let res: Response | null = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (res.ok) break
      } catch { res = null }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200))
    }
    if (!res || !res.ok) return { ok: false, tracks: [] }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
    const rows = data.results || []
    const collection = rows.find((r) => r.wrapperType === 'collection' || r.collectionType)
    const tracks: ItunesSuggestion[] = rows
      .filter((r) => (r.wrapperType === 'track' || r.kind === 'song') && r.trackName && r.artistName)
      .map((r) => ({
        song: String(r.trackName ?? ''),
        artist: String(r.artistName ?? ''),
        album: r.collectionName ? String(r.collectionName) : undefined,
        artworkUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : undefined,
        previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
        appleMusicUrl: r.trackViewUrl ? String(r.trackViewUrl) : undefined,
        collectionId: id,
        trackNumber: r.trackNumber ? Number(r.trackNumber) : undefined,
        durationSecs: r.trackTimeMillis ? Math.round(Number(r.trackTimeMillis) / 1000) : undefined,
        releaseYear: itunesYear(r.releaseDate),
        genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
        explicitness: typeof r.trackExplicitness === 'string' ? r.trackExplicitness : undefined,
      }))
      // A 30s snippet is not the song — see isPreviewLengthResult.
      .filter((t) => !isPreviewLengthResult(t.durationSecs, t.song))
      .sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
    return {
      ok: true,
      tracks,
      album: collection?.collectionName ? String(collection.collectionName) : undefined,
      artist: collection?.artistName ? String(collection.artistName) : undefined,
      artworkUrl: collection?.artworkUrl100 ? String(collection.artworkUrl100).replace('100x100', '400x400') : undefined,
      // The COLLECTION record is authoritative for both. The search-results
      // path has to infer an album's year and size from whichever of its
      // tracks happened to match the query; this is the album itself saying so.
      releaseYear: itunesYear(collection?.releaseDate),
      trackCount: typeof collection?.trackCount === 'number' ? collection.trackCount : undefined,
      genre: typeof collection?.primaryGenreName === 'string' ? collection.primaryGenreName : undefined,
      explicitness: typeof collection?.collectionExplicitness === 'string' ? collection.collectionExplicitness : undefined,
    }
  } catch {
    return { ok: false, tracks: [] }
  }
}
