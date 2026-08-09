/** Pure Qobuz search-result matching for streamrip — shared by download-by-query and tests. */
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'

export interface StreamripSearchHit { source: string; mediaType: string; id: string; desc: string }

/** streamrip result descs end with " by <artist>" — split on the LAST " by ". */
export function parseStreamripDesc(desc: string): { title: string; artist: string } {
  const i = desc.lastIndexOf(' by ')
  if (i > 0) return { title: desc.slice(0, i).trim(), artist: desc.slice(i + 4).trim() }
  return { title: desc.trim(), artist: '' }
}

/** Alternate-version markers. A candidate title carrying one of these words
 *  when the REQUESTED title doesn't is a different recording, not the song —
 *  Qobuz is flooded with rights-free re-records and live cuts, and its search
 *  routinely ranks them ABOVE the original (2026-08-07: "Something's Got a
 *  Hold on Me (Rerecorded)" was result #0; the 1962 take sat at #2, and the
 *  old first-tie-wins picker shipped Jake the re-record). Note "remaster" is
 *  deliberately absent: a remaster IS the original recording. */
const VERSION_MARKER = /^(live|unplugged|acoustic|rerecord|rerecorded|rerecording|rerecords|demo|karaoke|tribute|instrumental|remix|remixed|medley|sped|slowed|reverb|soundalike|cover|covers|bootleg|session|sessions|amended|amendedd|clean|cleaned|censored|edit|edited|radio)$/

/**
 * Decoration inside brackets that is EDITION metadata, not part of the song's
 * name: censorship labels, remaster stamps, and featured-artist credits.
 *
 * Jake, 2026-08-09: five tracks off Life After Death refused to download and
 * "Mo Money Mo Problems" kept fetching a radio clean version. Neither was a
 * Qobuz problem. iTunes only carries that album as "Life After Death [Amended
 * Version]" — the censored edit — so the app was asking Qobuz, by name, for
 *
 *     Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]
 *
 * against a catalogue that calls it "Mo Money Mo Problems (feat. Puff Daddy &
 * Mase)". Normalised, that is …featmaepuffdaddyamended vs …featpuffdaddymase:
 * it fails equality, containment, edit distance AND the prefix test, so the
 * track was rejected outright. Where Qobuz did happen to carry a clean cut
 * under a matching name, it matched — and shipped the radio edit.
 *
 * Feature credits are stripped because catalogues order and spell them
 * differently ("Ma$e & Puff Daddy" vs "Puff Daddy & Mase") and they are not
 * the song's title. The artist is matched separately and the duration guard
 * still runs, so dropping them widens the search without weakening any check.
 */
const EDITION_GROUP = /^(?:(?:amended|explicit|clean|cleaned|censored|edited)\w*(?:\s+(?:version|edit|mix))?|album version|single version|original version|bonus(?: track)?s?|deluxe|mono|stereo|(?:digital(?:ly)? )?remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*(?:digital )?remaster(?:ed)?|feat\.?\s.*|featuring\s.*|ft\.?\s.*|with\s.+)$/i

/**
 * The title to SEARCH a catalogue with — the song's name, without edition
 * metadata. Version markers are deliberately preserved: "(Live)" and "(Remix)"
 * name a different recording and the whole wrong-version guard depends on them
 * surviving.
 */
export function searchTitle(raw: string): string {
  let out = String(raw || '')
  // Bracketed groups, innermost-safe: only drop a group that is PURELY edition
  // metadata and carries no version marker.
  for (let pass = 0; pass < 3; pass++) {
    out = out.replace(/\s*[([{]([^()[\]{}]*)[)\]}]/g, (whole, inner: string) => {
      const body = inner.trim()
      if (!body) return ''
      if (titleTokens(body).some((w) => VERSION_MARKER.test(w) && !/^(amended|amendedd|clean|cleaned|censored|edit|edited|radio)$/.test(w))) return whole
      return EDITION_GROUP.test(body) ? '' : whole
    })
  }
  // Trailing " - Amended" / " - 2014 Remaster" style stamps.
  out = out.replace(/\s+[-–—]\s*(?:amended\w*|explicit|clean(?:ed)?|censored|edited|(?:digital(?:ly)? )?remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*(?:digital )?remaster(?:ed)?)\s*$/i, '')
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out || String(raw || '').trim()
}

const titleTokens = (s: string): string[] =>
  s.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean)

/** If `gotTitle` carries a version marker the request didn't ask for, return
 *  that marker; null = clean. COUNT-based token diff, so a song legitimately
 *  NAMED with a marker word never self-rejects ("Live and Let Die" is clean)
 *  while a decorated variant still trips ("Live and Let Die (Live)" has a
 *  second "live" beyond the requested title → rejected). */
export function unwantedVersionOf(wantTitle: string, gotTitle: string): string | null {
  const budget = new Map<string, number>()
  for (const w of titleTokens(wantTitle)) budget.set(w, (budget.get(w) ?? 0) + 1)
  for (const w of titleTokens(gotTitle)) {
    const left = budget.get(w) ?? 0
    if (left > 0) { budget.set(w, left - 1); continue }
    if (VERSION_MARKER.test(w)) return w
  }
  return null
}

/** Rank every eligible Qobuz hit for a reco title + artist, best first.
 *  `wantMediaType` gates which result rows are eligible — 'track' for a song
 *  query, 'album' for an album query. This MUST match what the caller searched
 *  for: an album search returns mediaType:'album' rows, and the old hard-coded
 *  `!== 'track'` skip rejected every one of them, so album downloads silently
 *  failed (the Charli XCX "Music, Fashion, Film" / "downloads only one song"
 *  bug, 2026-07-24).
 *
 *  Ordering rules (the wrong-version fix, 2026-08-07):
 *  - unwanted-version titles are EXCLUDED, reported in `rejectedVersions`
 *  - a known artist that doesn't match is EXCLUDED, never scored down — a
 *    high title score must not float a cover band above "not found"
 *  - exact title equality beats loose containment; fewer extra title tokens
 *    beats more (the undecorated original outranks "(Single Version)" etc.)
 *  - ties keep Qobuz's own order */
export function rankStreamripCandidates(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album' = 'track',
): { ranked: StreamripSearchHit[]; rejectedVersions: string[] } {
  const scored: Array<{ r: StreamripSearchHit; score: number; i: number }> = []
  const rejectedVersions: string[] = []
  const nWant = recoNorm(wantTitle)
  const wantToks = new Set(titleTokens(wantTitle))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.mediaType !== wantMediaType) continue
    const { title, artist } = parseStreamripDesc(r.desc)
    if (!recoTitleMatches(wantTitle, title)) continue
    if (unwantedVersionOf(wantTitle, title)) { rejectedVersions.push(title); continue }
    let score = 2
    if (wantArtist && artist) {
      if (!recoArtistMatches(wantArtist, artist)) continue
      score += 5
    } else if (artist) {
      score += 1
    }
    if (recoNorm(title) === nWant) score += 6
    const extras = titleTokens(title).filter((w) => !wantToks.has(w)).length
    score -= Math.min(4, extras)
    scored.push({ r, score, i })
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return { ranked: scored.map((s) => s.r), rejectedVersions }
}

/** Back-compat single-pick wrapper over rankStreamripCandidates. */
export function pickBestStreamripMatch(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album' = 'track',
): StreamripSearchHit | null {
  return rankStreamripCandidates(wantTitle, wantArtist, results, wantMediaType).ranked[0] ?? null
}

/**
 * Pick the best SoundCloud hit for a reco title + artist (2026-07-22:
 * Qobuz-first, SoundCloud-fallback for tracks Qobuz doesn't carry —
 * indie/underground singles like "Mr Vibe" by Villanova).
 *
 * SoundCloud descs don't split cleanly into title/artist the way Qobuz
 * does — the uploader is often a label ("… by Indie House Records") and
 * the real artist + title are packed into the track name
 * ("Villanova - Mr Vibe feat. Mike Dunn [Indie House Records]"). So we
 * match against the WHOLE desc: the wanted title must appear, and the
 * wanted artist must appear somewhere in it. Both present = the right
 * upload; artist-absent = reject (avoids grabbing a random cover/bootleg).
 */
export function pickBestSoundcloudMatch(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
): StreamripSearchHit | null {
  const nTitle = recoNorm(wantTitle)
  const nArtist = recoNorm(wantArtist)
  if (!nTitle) return null
  let best: StreamripSearchHit | null = null
  let bestScore = -1
  for (const r of results) {
    if (r.mediaType !== 'track') continue
    const hay = recoNorm(r.desc)
    if (!hay.includes(nTitle)) continue        // title must be present
    // Same version guard as Qobuz: an upload whose desc carries live/remix/
    // cover/etc. beyond the requested words is a different recording.
    if (unwantedVersionOf(`${wantTitle} ${wantArtist}`, r.desc)) continue
    let score = 1
    if (nArtist) {
      if (!hay.includes(nArtist)) continue     // artist required when we have one
      score += 5
    }
    // Prefer the shortest desc that still matches — usually the original
    // upload, not a "X (Y remix) [Z edit] (bootleg)" derivative.
    score += Math.max(0, 40 - r.desc.length / 4)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}
