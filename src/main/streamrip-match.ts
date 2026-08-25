/** Pure Qobuz search-result matching for streamrip — shared by download-by-query and tests. */
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'
import { foldAccents } from '../common/fold-text.ts'

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
 * Apple MASKS profanity inside track names — "N****s Bleed", "F!*@ You
 * Tonight". Jake, 2026-08-09, still failing after the Amended fix: those rows
 * sat on Retry. Normalised, "N****s Bleed" is "nsbleed" and Qobuz's title is
 * "niggasbleed", so every match test fails and the track can never resolve.
 *
 * A masked token is matched as a PATTERN rather than a literal: the visible
 * characters must line up and the mask stands in for the hidden ones. Apple
 * usually preserves length, but not always, so the run is allowed some slack.
 */
const MASK_CHARS = /[*!@#$%]/

export function isMaskedToken(tok: string): boolean {
  return MASK_CHARS.test(tok) && /[a-z0-9]/i.test(tok)
}

function maskedTokenPattern(tok: string): RegExp {
  let out = ''
  let run = 0
  const flush = (): void => {
    if (run) { out += `.{0,${run + 3}}`; run = 0 }
  }
  for (const ch of tok) {
    if (MASK_CHARS.test(ch)) { run++; continue }
    flush()
    out += foldAccents(ch).replace(/[^a-z0-9]/g, '')
  }
  flush()
  return new RegExp(`^${out}$`, 'i')
}

/** Does a masked want-title match a real candidate title, token for token? */
export function maskedTitleMatches(want: string, got: string): boolean {
  const w = want.toLowerCase().split(/\s+/).filter(Boolean)
  const g = got.toLowerCase().split(/\s+/).filter(Boolean)
  if (!w.length || g.length < w.length) return false
  // Slide the want tokens over the candidate: the candidate may carry extra
  // trailing decoration ("(Remaster)") that the want does not.
  outer: for (let off = 0; off + w.length <= g.length; off++) {
    for (let i = 0; i < w.length; i++) {
      const wt = w[i]
      const gt = g[off + i].replace(/[^a-z0-9]/gi, '')
      if (isMaskedToken(wt)) {
        if (!maskedTokenPattern(wt).test(gt)) continue outer
      } else if (wt.replace(/[^a-z0-9]/gi, '') !== gt) {
        continue outer
      }
    }
    return true
  }
  return false
}

/**
 * Did we knowingly ask for a DIFFERENT EDITION than the row the user clicked?
 *
 * True when the title carried a censorship stamp, a remaster stamp, or masked
 * profanity — all cases where we deliberately search for the song rather than
 * that exact pressing, so its runtime is no longer a fingerprint. Feature
 * credits do NOT count: stripping "(feat. X)" still points at the same
 * recording, and the tight duration guard should keep protecting those.
 */
export function editionSubstituted(raw: string): boolean {
  const t = String(raw || '')
  if (t.split(/\s+/).some(isMaskedToken)) return true
  return /\b(amended|explicit|clean(?:ed)?|censored|edited|remaster(?:ed)?)\b/i.test(t)
}

/**
 * The query string to SEND a catalogue. Same as searchTitle, minus any masked
 * token — a catalogue cannot be searched for "N****s", and the remaining words
 * plus the artist are enough to surface the track. Matching still uses the
 * full masked title, so the right row is recognised when it comes back.
 */
export function searchQueryTitle(raw: string): string {
  const kept = searchTitle(raw).split(/\s+/).filter((t) => t && !isMaskedToken(t))
  return kept.join(' ').trim() || searchTitle(raw)
}

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
  // Trailing " - Amended" / " - 2014 Remaster" / Apple's " - Single" / " - EP".
  // ⚠️ TWIN: src/renderer/views/DownloadStore/DownloadView.tsx displayAlbumTitle
  // (display-only strip of the same Apple suffix). 2026-08-14: Get on Love
  // Fiend's "It's Nearly Over - Single" searched Qobuz for that exact name and
  // returned nothing; Qobuz catalogs it as "It's Nearly Over". Asking for the
  // Apple suffix is why the album tile stacked failed downloads on a track
  // that was sitting on Qobuz the whole time.
  out = out.replace(/\s+[-–—]\s*(?:amended\w*|explicit|clean(?:ed)?|censored|edited|(?:digital(?:ly)? )?remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*(?:digital )?remaster(?:ed)?|EP|Single)\s*$/i, '')
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out || String(raw || '').trim()
}

const titleTokens = (s: string): string[] =>
  foldAccents(s).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean)

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

/**
 * A parenthetical SUBTITLE that one catalogue carries and another drops.
 *
 * Jake, 2026-08-09: "i cannot download the real version of lady hear me
 * tonight by modjo!!! only the remix which i dont like."
 *
 * iTunes calls it "Lady (Hear Me Tonight)". Qobuz calls it, simply, "Lady".
 * Normalised that is ladyhearmetonight vs lady — four characters — which
 * fails every arm of recoTitleMatches: containment needs 8, edit distance
 * needs 10, the prefix test needs 6. So the ONE correct row on Qobuz was
 * invisible, the only thing that could match was "Lady (Hear Me Tonight) -
 * Remix", and the download had nowhere to land.
 *
 * Deliberately narrow: it matches only when one side carries a bracketed
 * subtitle and the other is exactly the bare title. Two DECORATED titles are
 * not compared this way — "Lady (Radio Edit)" vs "Lady (Live)" both reduce to
 * "lady", and that is where wrong matches live. Everything else still applies
 * on top: the artist must match, unwantedVersionOf still throws out remixes
 * and live cuts, and the duration guard still pins the exact recording.
 */
function bareTitle(s: string): string {
  return s.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

export function subtitleVariantMatches(want: string, got: string): boolean {
  const w = recoNorm(want), g = recoNorm(got)
  if (!w || !g || w === g) return false
  const wb = recoNorm(bareTitle(want)), gb = recoNorm(bareTitle(got))
  // Exactly one side decorated, and dropping its subtitle makes them equal.
  if (wb && wb !== w && wb === g) return true
  if (gb && gb !== g && gb === w) return true
  return false
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
    const subtitleOnly = !recoTitleMatches(wantTitle, title) && !maskedTitleMatches(wantTitle, title)
      && subtitleVariantMatches(wantTitle, title)
    if (!recoTitleMatches(wantTitle, title) && !maskedTitleMatches(wantTitle, title) && !subtitleOnly) continue
    if (unwantedVersionOf(wantTitle, title)) { rejectedVersions.push(title); continue }
    // Show-brand live recordings hide the tell in the album part of the
    // desc while the title reads clean — same rejection lane as markers.
    const brand = liveBrandMarker(wantTitle, r.desc)
    if (brand) { rejectedVersions.push(`${title} [${brand}]`); continue }
    let score = 2
    // A subtitle-dropped match is real but weaker evidence than a title that
    // actually reads the same, so it never outranks one that does.
    if (subtitleOnly) score -= 3
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

/**
 * TV/venue-brand LIVE recordings that never say "live" (2026-08-22, Jake:
 * "the wrong version of these boots were made for walking downloaded.
 * thats a consistent issue"). The Ed Sullivan cut of a song carries a
 * CLEAN title, an album named after the SHOW, and a runtime within
 * seconds of the studio take — so every existing gate (marker words,
 * duration, title match) passes and the wrong RECORDING lands. These
 * phrases are recording-identity tells, checked wherever version markers
 * are checked. Want-side exemption: a request that names the brand
 * (someone deliberately fetching an Ed Sullivan album) is honored.
 *
 * Lexicon discipline: multi-word phrases and unambiguous single tokens
 * only — zero false positives beats coverage ("letterman" is OUT because
 * The Lettermen are a real band; late-night host surnames are OUT).
 * Phrases are written in titleTokens-normal form (folded, alphanumeric).
 */
const LIVE_BRAND_PHRASES = [
  'ed sullivan', 'top of the pops', 'austin city limits', 'grand ole opry',
  'old grey whistle', 'midnight special', 'beat club', 'soul train',
  'american bandstand', 'ready steady go', 'smothers brothers',
  'jools holland', 'howard stern', 'tiny desk', 'kexp', 'live lounge',
  'peel session', 'hollywood a go',
] as const

/** The brand phrase present in `gotText` but absent from `wantText`, or
 *  null. Same budget semantics as unwantedVersionOf: a song legitimately
 *  NAMED "The Midnight Special" (CCR) never self-rejects, because the
 *  want side carries the phrase too. */
export function liveBrandMarker(wantText: string, gotText: string): string | null {
  const want = ` ${titleTokens(wantText).join(' ')} `
  const got = ` ${titleTokens(gotText).join(' ')} `
  for (const b of LIVE_BRAND_PHRASES) {
    const needle = ` ${b} `
    if (got.includes(needle) && !want.includes(needle)) return b
  }
  return null
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
    if (liveBrandMarker(`${wantTitle} ${wantArtist}`, r.desc)) continue
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

// ── The explicitness witness (2026-08-16) ───────────────────────────────
//
// Jake: "i cannot stand downloading what ends up being the clean versions
// of rap songs... it is fucking brutal." Fourth eruption of the class, and
// the first three fixes were all on the SEARCH side — badges, rescues,
// collection ids, all verified working. The hole was fulfillment: Qobuz
// resolves a TEXT query, Qobuz has its own clean editions, and its clean
// editions routinely ship the same title, the same length, and no marker —
// invisible to all three staging witnesses (duration, title-marker,
// album-marker). Measured on "Mask Off": five byte-identical search descs,
// among them a 204s album cut and two 258s remixes, distinguishable ONLY
// by the metadata endpoint's parental_warning / duration / version fields.
//
// So explicitness becomes a HARD identity axis, resolved before a single
// byte downloads. The gate never guesses: candidates whose metadata is
// missing pass through unjudged (an API hiccup must not brick downloads),
// but a candidate Qobuz itself flags as clean when the user asked for the
// explicit record is REFUSED — and if every candidate is flagged clean,
// the download fails LOUDLY instead of silently importing censorship.

export interface QobuzTrackMeta {
  parentalWarning?: boolean
  durationSec?: number
  album?: string
  version?: string | null
}

export interface ExplicitGateResult<T> {
  kept: T[]
  /** Candidates refused because Qobuz flags them clean. */
  refusedClean: T[]
}

export function applyExplicitGate<T extends { id: string }>(
  ranked: T[],
  meta: Map<string, QobuzTrackMeta>,
  wantExplicit: boolean,
): ExplicitGateResult<T> {
  if (!wantExplicit) return { kept: ranked, refusedClean: [] }
  const kept: T[] = []
  const refusedClean: T[] = []
  for (const c of ranked) {
    const m = meta.get(c.id)
    if (m?.parentalWarning === false) refusedClean.push(c)
    else kept.push(c)
  }
  return { kept, refusedClean }
}
