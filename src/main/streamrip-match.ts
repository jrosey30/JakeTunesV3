/** Pure Qobuz search-result matching for streamrip — shared by download-by-query and tests. */
import { artistOrAlias, recoArtistMatches, recoFold, recoTitleMatches, sameArtistName } from './reco-match.ts'
import { otherCredit } from '../common/artist-credit.ts'
import { foldAccents, nameKey } from '../common/fold-text.ts'
import type { RealAlbum } from '../common/real-album.ts'

export { otherCredit }

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
// 6.0 Phase 1 (2026-09-04, the identity contract): the lexicon grows to
// every alternate-version family Jake named — mixes and DJ/club/extended
// mixes, mashups, rehearsals and alternate takes, a cappellas, nightcore /
// chopped-and-screwed / 8D variants, concert cuts, dubs. Still count-based,
// so a song NAMED with one of these words ("Live and Let Die", "Dub Be Good
// to Me") never self-rejects.
// 2026-11-03: club, megamix and the hyphen forms "(Re-Edit)" and "(Sped-Up)",
// which the phone's list already had: "We Found Love (Cahill Club)" read as the
// song here whenever no runtime was known.
// ⚠️ TWIN: JakeTunesMobile/backend/src/util/itunesCanonical.ts VERSION_MARKER.
// It also lists remaster / mono / deluxe / version for its own edition logic.
const VERSION_MARKER = /^(live|unplugged|acoustic|rerecord|rerecorded|rerecording|rerecordings|rerecords|demo|demos|karaoke|tribute|instrumental|instrumentals|remix|remixed|remixes|reedit|mix|mixes|megamix|extended|mashup|mashups|medley|sped|spedup|slowed|reverb|nightcore|chopped|screwed|8d|soundalike|cover|covers|bootleg|session|sessions|rehearsal|rehearsals|alternate|alt|acapella|acappella|concert|dub|club|amended|amendedd|clean|cleaned|censored|edit|edited|radio)$/

/**
 * Acts that are not the artist: cover bands, karaoke and tribute acts, "in the
 * style of" catalogues. "Rihanna" is inside "Rihanna Cover Band", the artist test
 * is a containment test, and the store's order broke the tie, so the cover band
 * ranked first here and the judge called its file exact. The phone learned this
 * on 2026-11-02 ("why did we found love (the karaoke version) get downloaded").
 * Out of the running unless the request itself asks for one.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts COVER_ACT_RE, verbatim.
 */
const COVER_ACT_RE = /\b(cover band|cover version|covers?|karaoke|tribute|in the style of|made famous by|originally performed by|as made popular by|sound-?alike|backing track|instrumental version)\b/i

export function isCoverAct(title: string, artist: string): boolean {
  return COVER_ACT_RE.test(`${artist} ${title}`)
}

/**
 * Is this album a cover or tribute release? "Covers" on its own says whose songs they are, not who
 * is playing them: T-Pain's "On Top of The Covers (Live from The Sun Rose)" and Ozzy Osbourne's
 * "Under Cover" are their own records, and every song on them was refused as a tribute (2026-11-06).
 * So on an album credited to the artist Jake asked for, that one word doesn't count. `asked` is who
 * Jake asked for, never Apple's match of it: a row for "Floral & Fading" by Pierce the Veil matched
 * Sparrow Sleeps, on "Lullaby covers of Pierce the Veil songs", and then named the act on the album.
 * The credit must be the whole name: "The Beatles Revival Band" contains "The Beatles". Every other
 * word still counts: Lynyrd Skynyrd's "… Tribute Tour 1987" is theirs too, a live record, and a plain
 * request is not asking for it. With no credit to read, nothing has changed.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts isCoverRelease, verbatim.
 */
const COVERS_WORD = /\bcovers?\b(?!\s+(?:band|version)\b)/gi

export function isCoverRelease(album: string, albumArtist: string | undefined, asked: string): boolean {
  return isCoverAct(sameArtistName(asked, albumArtist ?? '') ? album.replace(COVERS_WORD, ' ') : album, '')
}

/** The version markers a request itself carries — what Jake asked for by
 *  name ("Hallelujah (Live)"). Used by the identity contract to record that
 *  an alternate version was DELIBERATELY requested. */
export function requestedVersionMarkers(title: string): string[] {
  return titleTokens(title).filter((w) => VERSION_MARKER.test(w))
}

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
// 2026-08-25 — the list was CLOSED, so any reissue label outside it survived
// into the Qobuz query and returned nothing. Jake: Get on Simple Plan's
// "No Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)" searched
// Qobuz for that literal string; Qobuz catalogs the album as "No Pads, No
// Helmets...Just Balls". Same failure shape as the Love Fiend "- Single" bug
// below, one layer up. "deluxe" alone was listed but "Deluxe Edition" was not,
// so even the commonest reissue label missed. Now anything containing
// "edition"/"anniversary", plus reissue/expanded, is treated as PACKAGING.
// The VERSION_MARKER guard still runs first, so "(Live Edition)" survives —
// that names a different recording.
const EDITION_GROUP = /^(?:(?:amended|explicit|clean|cleaned|censored|edited)\w*(?:\s+(?:version|edit|mix))?|album version|single version|original version|bonus(?: tracks?)?(?:\s+(?:version|edition))?|deluxe|mono|stereo|(?:digital(?:ly)? )?remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*(?:digital )?remaster(?:ed)?|feat\.?\s.*|featuring\s.*|ft\.?\s.*|with\s.+|.*\bedition\b.*|.*\banniversar(?:y|ies)\b.*|reissue[ds]?|expanded|remastered\s+version)$/i

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
  // The punctuation that ends a word is not a mask (2026-11-03): "Oh! Darling"
  // asked Qobuz for "Darling". ⚠️ TWIN: the phone's streamripMatch.ts, same rule.
  const t = tok.replace(/^[#([]+/, '').replace(/[!?%.,;:)\]]+$/, '')
  return MASK_CHARS.test(t) && /[a-z0-9]/i.test(t)
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

/** Does a masked want-title match a real candidate title, token for token?
 *  Tokens fold in any script: stripped to [a-z0-9], every Hebrew or Cyrillic
 *  word was '' and equal to every other, so any Hebrew title "read as" the
 *  one asked for and the wrong song passed the recording guard. */
export function maskedTitleMatches(want: string, got: string): boolean {
  const w = want.toLowerCase().split(/\s+/).filter(Boolean)
  const g = got.toLowerCase().split(/\s+/).filter(Boolean)
  // A title with no mask is not a masked match (2026-11-03): without this, any
  // title holding the request's words passed, and the judge called "Love Song"
  // the exact recording of "Love".
  if (!w.some(isMaskedToken) || g.length < w.length) return false
  // Slide the want tokens over the candidate: the candidate may carry extra
  // trailing decoration ("(Remaster)") that the want does not.
  outer: for (let off = 0; off + w.length <= g.length; off++) {
    for (let i = 0; i < w.length; i++) {
      const wt = w[i]
      const gt = nameKey(g[off + i], '')
      if (isMaskedToken(wt)) {
        if (!maskedTokenPattern(wt).test(gt)) continue outer
      } else if (nameKey(wt, '') !== gt) {
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
 * recording, and the tight duration guard should keep protecting those. A
 * censorship stamp takes the length away altogether (exact-recording.ts
 * requestedLength); this widens the guard for what is left.
 */
export function editionSubstituted(raw: string): boolean {
  const t = String(raw || '')
  if (t.split(/\s+/).some(isMaskedToken)) return true
  return /\b(amended|explicit|clean(?:ed)?|censored|edited|remaster(?:ed)?)\b/i.test(t)
}

/**
 * A censorship label on a title or an album: "[Amended]", "(Clean Version)",
 * " - Edited". How Apple marks a clean row when its flag does not, and never
 * something Jake asked for by name. The album's words count too, because a
 * track on "Life After Death [Amended Version]" is off the censored edition
 * whatever its own title says.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts CENSOR_LABEL,
 * withoutCensorStamp, carriesCensorStamp.
 */
const CENSOR_LABEL = /^(?:amended|clean|cleaned|censored|edited)\w*(?:\s+(?:version|edit|mix))?$/i

export function withoutCensorStamp(title: string): string {
  return title
    .replace(/\s*[([]([^()[\]]*)[)\]]/g, (m, inner: string) => (CENSOR_LABEL.test(inner.trim()) ? '' : m))
    .replace(/\s+[-–—]\s*(?:amended\w*|clean(?:ed)?|censored|edited)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function carriesCensorStamp(text: string): boolean {
  return withoutCensorStamp(text) !== text.replace(/\s{2,}/g, ' ').trim()
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

/**
 * Version markers in Hebrew and Russian, read as the English marker they
 * mean (2026-10-11). Taken from the decorations on iTunes IL/RU for 15
 * Israeli and 12 Russian artists: הופעה חיה / בהופעה / לייב (live),
 * אינסטרומנטלי (16×), אקוסטי, מתוך מחרוזת (medley), מתוך חזרות (rehearsals);
 * Инструментальная версия, Акустика, Трибьют.
 *
 * An ALIAS, not a marker of its own: the same Israeli recording is titled
 * "(Live)", "(הופעה חיה)" or "(Live - הופעה חיה)" depending on the store, so
 * asking for one must accept the others. Hebrew attaches ב/ה/מ to the word,
 * so those forms are listed. Neutral words (מהדורת ויניל, רימאסטרינג,
 * Приглашение на концерт) are deliberately absent.
 */
const MARKER_ALIASES: Record<string, string> = {
  הופעה: 'live', בהופעה: 'live', ההופעה: 'live', מהופעה: 'live', לייב: 'live', בלייב: 'live',
  אקוסטי: 'acoustic', אקוסטית: 'acoustic', אקוסטיות: 'acoustic',
  אינסטרומנטלי: 'instrumental', אינסטרומנטלית: 'instrumental', אינסטרומנטל: 'instrumental',
  רמיקס: 'remix', רמיקסים: 'remixes', מיקס: 'mix', דמו: 'demo',
  מחרוזת: 'medley', במחרוזת: 'medley', חזרות: 'rehearsals',
  קריוקי: 'karaoke', קאריוקי: 'karaoke', קאבר: 'cover', מחווה: 'tribute',
  акустика: 'acoustic', инструментал: 'instrumental', ремикс: 'remix', ремиксы: 'remixes',
  демо: 'demo', трибьют: 'tribute', кавер: 'cover', караоке: 'karaoke', попурри: 'medley',
}
/** Russian adjectives inflect (Инструментальная версия, концертная запись). */
const MARKER_STEMS: Array<[RegExp, string]> = [
  [/^акустическ\p{L}*$/u, 'acoustic'],
  [/^инструментальн\p{L}*$/u, 'instrumental'],
  [/^концертн\p{L}*$/u, 'live'],
]
function markerAlias(w: string): string | undefined {
  return MARKER_ALIASES[w] ?? MARKER_STEMS.find(([re]) => re.test(w))?.[1]
}

// Any script: [a-z0-9] dropped every Hebrew word, so a decorated Hebrew title
// counted no extra words and tied the undecorated original. A Hebrew or
// Russian marker word becomes its English marker, and only when the title
// doesn't already say it: "(Live - הופעה חיה)" is ONE label, not two live
// markers that a plain "(Live)" request would count as an extra one.
const titleTokens = (s: string): string[] => {
  const words = foldAccents(s).replace(/\ba[ -]?capp?ella\b/gi, 'acapella').split(/\s+/).map((w) => nameKey(w, '')).filter(Boolean)
  const said = new Set(words)
  const out: string[] = []
  for (const w of words) {
    const m = markerAlias(w)
    if (!m) { out.push(w); continue }
    if (said.has(m)) continue
    said.add(m)
    out.push(m)
  }
  return out
}

const OWNED_VERSION = /[([{][^)\]}]*\p{L}['’]s\s+version[^)\]}]*[)\]}]/iu

/** If `gotTitle` carries a version marker the request didn't ask for, return
 *  that marker; null = clean. COUNT-based token diff, so a song legitimately
 *  NAMED with a marker word never self-rejects ("Live and Let Die" is clean)
 *  while a decorated variant still trips ("Live and Let Die (Live)" has a
 *  second "live" beyond the requested title → rejected). */
export function unwantedVersionOf(wantTitle: string, gotTitle: string): string | null {
  // "(Taylor's Version)" is a re-record whose words are all innocent, and it can
  // run within a second of the original (2026-11-03; the phone refuses it too).
  if (OWNED_VERSION.test(gotTitle) && !OWNED_VERSION.test(wantTitle)) return 'rerecord'
  const budget = new Map<string, number>()
  for (const w of titleTokens(wantTitle)) budget.set(w, (budget.get(w) ?? 0) + 1)
  // "(Original Mix)" is how dance catalogues label THE recording, not a
  // derivative — with "mix" now a marker it must not self-reject.
  for (const w of titleTokens(gotTitle.replace(/\boriginal\s+mix\b/gi, ''))) {
    const left = budget.get(w) ?? 0
    if (left > 0) { budget.set(w, left - 1); continue }
    if (VERSION_MARKER.test(w)) return w
  }
  return null
}

/**
 * Remaster stamps, in any language (2026-10-12). NOT version markers: a
 * remaster IS the original recording, so the download guard, the ranker and
 * titleTokens never see these. Read only by itunesVerify's canonical-edition
 * PREFERENCE (discover-feed.ts), which prefers "Who Are You" over "Who Are You
 * (Remastered 2015)" when both are listed, and keeps the remaster when that is
 * all Apple has. A title carries one stamp at most, so "(Remastered -
 * רימאסטרינג)" is one label.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/itunesCanonical.ts addsVersionMarker
 *    (VERSION_MARKER remaster + PHONE_MARKER_ALIASES רימאסטרינג).
 */
const REMASTER_WORD = /^(?:remaster(?:ed)?|רימאסטרינג)$/u
const remasterTokens = (s: string): string[] => {
  let stamped = false
  const out: string[] = []
  for (const w of titleTokens(s)) {
    if (!REMASTER_WORD.test(w)) { out.push(w); continue }
    if (!stamped) out.push('remastered')
    stamped = true
  }
  return out
}
export function addsRemasterStamp(wantTitle: string, gotTitle: string): boolean {
  const budget = new Map<string, number>()
  for (const w of remasterTokens(wantTitle)) budget.set(w, (budget.get(w) ?? 0) + 1)
  for (const w of remasterTokens(gotTitle)) {
    const left = budget.get(w) ?? 0
    if (left > 0) { budget.set(w, left - 1); continue }
    if (w === 'remastered') return true
  }
  return false
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
export function bareTitle(s: string): string {
  // A dash tail is the same decoration as a bracket: "Stars - Mono" (2026-11-03).
  // ⚠️ TWIN: the phone's streamripMatch.ts bareTitle.
  return s.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').replace(/\s+[-–—]\s+[^-–—()[\]{}]+$/u, '').replace(/\s{2,}/g, ' ').trim()
}

export function subtitleVariantMatches(want: string, got: string): boolean {
  const w = recoFold(want), g = recoFold(got)
  if (!w || !g || w === g) return false
  const wb = recoFold(bareTitle(want)), gb = recoFold(bareTitle(got))
  // Exactly one side decorated, and dropping its subtitle makes them equal.
  if (wb && wb !== w && wb === g) return true
  if (gb && gb !== g && gb === w) return true
  return false
}

/**
 * "Girls & Boys" and "Girls and Boys" are one title, and the fold can't see it: "&" folds to
 * nothing. Parklife's track list says "&", every compilation of it says "and", so the album door
 * walked straight past the album's own copy (JakeTunesMobile Brief 231). Only for comparing
 * titles: names stay as they are written.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts spelledOutAnd.
 */
export function spelledOutAnd(title: string): string {
  return title.replace(/\s*&\s*/g, ' and ').replace(/\s+['’]?n['’]?\s+/gi, ' and ')
}
export const titleKey = (title: string): string => recoFold(spelledOutAnd(title))
/** recoTitleMatches, with "&" and "and" as one word. */
export function titleMatches(want: string, got: string): boolean {
  return recoTitleMatches(want, got) || recoTitleMatches(spelledOutAnd(want), spelledOutAnd(got))
}

/** The same text. Outkast's "?", The Garden's ":(" and MOULD's "///" fold to nothing,
 *  and no fuzzy arm compares nothing. ⚠️ TWIN: the phone's streamripMatch.ts. */
function sameTitle(want: string, got: string): boolean {
  const w = want.trim().toLowerCase()
  return w !== '' && w === got.trim().toLowerCase()
}

/** Does a tag read as the song? The fuzzy arms, the masked pattern and a subtitle
 *  one catalogue dropped, on the titles as written and without their edition
 *  labels: "Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]" reads as
 *  "Mo Money Mo Problems (feat. Puff Daddy & Mase)", and "Hello" as "Hello - 2009
 *  Remaster". Until 2026-11-03 the short ones only passed because
 *  maskedTitleMatches let any title holding the words through, which also let
 *  "Love Song" pass for "Love". */
export function titleReads(want: string, got: string): boolean {
  const w = searchTitle(want) || want, g = searchTitle(got) || got
  return sameTitle(want, got) || titleMatches(w, g) || maskedTitleMatches(w, g) || subtitleVariantMatches(w, g)
    || titleMatches(want, got) || maskedTitleMatches(want, got) || subtitleVariantMatches(want, got)
}

/**
 * Whether another way of writing the credit is this song. The title has to be the request's
 * exactly, without its edition labels. A search summary hides the version ("Feels Alright" for
 * the Vocal Mix), so there the name without its brackets will do (`summary`), and the file's
 * tags are held to the whole title. A part of a joint credit also needs a clock: "Oma" alone
 * says little, so the row Jake clicked has to say how long the song runs.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts creditHolds.
 */
export function creditHolds(
  want: { title: string; artist: string },
  clocked: boolean,
  found: { title: string; artist: string },
  summary = false,
): boolean {
  const kind = otherCredit(want.artist, found.artist)
  if (!kind || (kind === 'part' && !clocked)) return false
  const key = (t: string): string => titleKey(summary ? bareTitle(searchTitle(t)) : searchTitle(t))
  return key(want.title) !== '' && key(want.title) === key(found.title)
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
 *  - ties keep Qobuz's own order
 *
 *  `credit` lets another way of writing the artist's name count (creditHolds), and says
 *  whether the row has a length to hold a file to. Left out, it does not count: a whole
 *  album goes to verifyAlbumCandidate, which holds to the name.
 *  Such a hit is a last resort, unlike on the phone: this scoring puts a stranger's "Daylight"
 *  by Kim above Matt & Kim's own "Daylight (Album Version)", and a stranger whose length happens
 *  to fit could then be imported, or vouch for an explicit master (judgeHitsByMeta). So it ranks
 *  only when nothing else does. */
export function rankStreamripCandidates(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album' = 'track',
  aliases: string[] = [],
  credit?: { clocked: boolean },
): { ranked: StreamripSearchHit[]; rejectedVersions: string[] } {
  const scored: Array<{ r: StreamripSearchHit; score: number; i: number; otherName: boolean }> = []
  const rejectedVersions: string[] = []
  const wantsCover = isCoverAct(wantTitle, wantArtist)
  const nWant = titleKey(wantTitle)   // compared only. recoNorm made every Hebrew title '' and gave each the exact-title bonus
  const wantToks = new Set(titleTokens(spelledOutAnd(wantTitle)))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.mediaType !== wantMediaType) continue
    const { title, artist } = parseStreamripDesc(r.desc)
    // The request is the title without its labels: "Hello" reads as "Hello - 2009
    // Remaster", five letters being too short for any fuzzy arm with the stamp on.
    const reads = titleMatches(wantTitle, title) || maskedTitleMatches(wantTitle, title) || sameTitle(wantTitle, title)
      || (nWant !== '' && titleKey(searchTitle(title)) === nWant)
    const subtitleOnly = !reads && (subtitleVariantMatches(wantTitle, title) || subtitleVariantMatches(searchTitle(wantTitle) || wantTitle, searchTitle(title) || title))
    if (!reads && !subtitleOnly) continue
    if (unwantedVersionOf(wantTitle, title)) { rejectedVersions.push(title); continue }
    // Show-brand live recordings hide the tell in the album part of the
    // desc while the title reads clean — same rejection lane as markers.
    const brand = liveBrandMarker(wantTitle, r.desc)
    if (brand) { rejectedVersions.push(`${title} [${brand}]`); continue }
    let score = 2
    let otherName = false
    // A subtitle-dropped match is real but weaker evidence than a title that
    // actually reads the same, so it never outranks one that does.
    if (subtitleOnly) score -= 3
    if (wantArtist && artist) {
      // The artist's own name, or one of the names MusicBrainz knows them by
      // (compared whole), outranks a name that merely contains it: "Rihanna"
      // before "Rihanna & Friends".
      if (sameArtistName(wantArtist, artist)) score += 6
      else if (recoArtistMatches(wantArtist, artist)) score += 5
      else if (artistOrAlias(wantArtist, artist, aliases)) score += 6
      else if (credit && creditHolds({ title: wantTitle, artist: wantArtist }, credit.clocked, { title, artist }, true)) otherName = true
      else continue
    } else if (artist) {
      score += 1
    }
    if (!wantsCover && isCoverAct(title, artist)) { rejectedVersions.push(title); continue }
    if (titleKey(title) === nWant) score += 6
    const extras = titleTokens(spelledOutAnd(title)).filter((w) => !wantToks.has(w)).length
    score -= Math.min(4, extras)
    scored.push({ r, score, i, otherName })
  }
  const underTheName = scored.filter((s) => !s.otherName)
  const pool = underTheName.length ? underTheName : scored
  pool.sort((a, b) => b.score - a.score || a.i - b.i)
  return { ranked: pool.map((s) => s.r), rejectedVersions }
}

/** True when the store has the song under a name for the artist that the request
 *  does not use: a hit that would have ranked if only its artist had matched
 *  ("Save It for Later by The Beat" for The English Beat, 2026-11-03).
 *  ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts hitsByAnotherName. */
export function hitsByAnotherName(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album' = 'track',
): boolean {
  if (!wantArtist) return false
  return results.some((r) => {
    if (r.mediaType !== wantMediaType) return false
    const { title, artist } = parseStreamripDesc(r.desc)
    if (!artist || recoArtistMatches(wantArtist, artist) || isCoverAct(title, artist)) return false
    if (!titleReads(wantTitle, title)) return false
    return !unwantedVersionOf(wantTitle, title) && !liveBrandMarker(wantTitle, r.desc)
  })
}

/**
 * Rank, and when nothing is left only because the store files the artist under
 * another name, ask for that artist's other names once and rank again. `lookup`
 * is artist-spellings-store.artistAliases: it waits on MusicBrainz at most once
 * per artist per TTL, and a busy MusicBrainz answers the stale entry or nothing.
 */
export async function rankWithArtistAliases(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album',
  lookup: (artist: string) => Promise<string[]>,
  credit?: { clocked: boolean },
): Promise<{ ranked: StreamripSearchHit[]; rejectedVersions: string[]; aliases: string[] }> {
  const first = rankStreamripCandidates(wantTitle, wantArtist, results, wantMediaType, [], credit)
  if (first.ranked.length > 0 || !hitsByAnotherName(wantTitle, wantArtist, results, wantMediaType)) return { ...first, aliases: [] }
  const aliases = await lookup(wantArtist)
  if (aliases.length === 0) return { ...first, aliases: [] }
  return { ...rankStreamripCandidates(wantTitle, wantArtist, results, wantMediaType, aliases), aliases }
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

/** Album names that are themselves a recording's name, wherever the words sit.
 *  Not "sessions": The Sun Sessions IS the original recordings. */
const RECORDING_ALBUM = /\b(?:live\s+(?:at|in|from|on)\b|(?:in\s+)?concert\b|unplugged\b|acoustic\b|remix(?:es|ed)\b|re-?record(?:ed|ings?)\b|rehearsals?\b|instrumental\w*|demos\b|bootlegs?\b|karaoke\b)|^live\W*$/i
/** One family of recordings, however an album words it: "(Don Carlos Ambient Mix)"
 *  on "Don Carlos Remixes", "(Live)" on "In Concert". */
const markerFamily = (s: string): string => s
  .replace(/\b(?:remix(?:es|ed)?|mix(?:es)?|megamix)\b/gi, 'mix')
  .replace(/\b(?:concert|unplugged|acoustic)\b/gi, 'live')

/**
 * The version an album's NAME says its tracks are (2026-11-03). A live album's
 * cut often has a clean title, so the album is a witness; but run over the whole
 * name, the marker test refused "Doll Parts" on Live Through This. On Jake's
 * library half of what it flagged was a false alarm: "Turn The Radio Off", "Come
 * Clean", "LONG.LIVE.A$AP", "Beyond The Mix". So a marker counts only where an
 * album says what it is: in its brackets, after a " - " or ": ", or as one of the
 * phrases above. A bracket of more than five words is a blurb, not a label.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/itunesCanonical.ts albumAddsRecording.
 */
export function albumVersionOf(wantWords: string, album: string): string | null {
  const labels = [...album.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)].map((m) => m[1])
  const tail = /(?:\s[-–—]\s|:\s)([^-–—:()[\]{}]+)$/u.exec(album)?.[1] ?? ''
  const phrase = (RECORDING_ALBUM.exec(album)?.[0] ?? '').replace(/instrumental\w*/i, 'instrumental')
  const said = markerFamily([...[...labels, tail].filter((l) => l.trim().split(/\s+/).length <= 5), phrase].join(' '))
  // Each word once: "Good Evening New York City (Live At Citi Field)" says live one
  // time, however many of the places above saw it, and a "(Live)" request covers it.
  return unwantedVersionOf(markerFamily(wantWords), [...new Set(said.toLowerCase().split(/\s+/))].join(' '))
}

/**
 * Every SoundCloud hit that could be the song, best first (6.0 Phase 1):
 * the lane used to trust ONE top score; now it walks the top few and each
 * must prove itself in staging through the identity contract.
 */
export function rankSoundcloudCandidates(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
): StreamripSearchHit[] {
  const nTitle = recoFold(wantTitle)
  const nArtist = recoFold(wantArtist)   // any script: recoNorm made a Hebrew artist '', which skipped the artist gate
  if (!nTitle) return []
  const scored: Array<{ r: StreamripSearchHit; score: number; i: number }> = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.mediaType !== 'track') continue
    const hay = recoFold(r.desc)
    if (!hay.includes(nTitle)) continue
    if (unwantedVersionOf(`${wantTitle} ${wantArtist}`, r.desc)) continue
    if (liveBrandMarker(`${wantTitle} ${wantArtist}`, r.desc)) continue
    const tail = r.desc.slice(r.desc.lastIndexOf('('))
    if (r.desc.includes('(') && !tail.includes(')')) continue
    let score = 1
    if (nArtist) {
      if (!hay.includes(nArtist)) continue
      score += 5
    }
    score += Math.max(0, 40 - r.desc.length / 4)
    scored.push({ r, score, i })
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.map((s) => s.r)
}

/**
 * streamrip reports an EMPTY search as an error line ("No search results
 * found for query …") and writes no results file. That is a catalogue
 * answer — "nothing here" — not a provider failure (2026-09-04, XTC "Drums
 * and Wires (Bonus Track Version)": the verdict read "Found … but the
 * download failed" for a search that had simply returned nothing).
 */
export function isNoResultsMessage(msg: string): boolean {
  return /no (search )?results? found/i.test(msg || '')
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
  const nTitle = recoFold(wantTitle)
  const nArtist = recoFold(wantArtist)   // any script: recoNorm made a Hebrew artist '', which skipped the artist gate
  if (!nTitle) return null
  let best: StreamripSearchHit | null = null
  let bestScore = -1
  for (const r of results) {
    if (r.mediaType !== 'track') continue
    const hay = recoFold(r.desc)
    if (!hay.includes(nTitle)) continue        // title must be present
    // Same version guard as Qobuz: an upload whose desc carries live/remix/
    // cover/etc. beyond the requested words is a different recording.
    if (unwantedVersionOf(`${wantTitle} ${wantArtist}`, r.desc)) continue
    if (liveBrandMarker(`${wantTitle} ${wantArtist}`, r.desc)) continue
    // TRUNCATION SUSPICION (2026-08-29, the TopKnot case): SoundCloud cuts
    // descs at ~50 chars — "(TopKnot 5 Years L" hid the word Remix from the
    // guard above and a 5:57 remix imported as the 3:07 song. A desc whose
    // final "(" never closes is hiding its version marker: refuse it. An
    // original upload rarely needs a parenthetical; a derivative always has
    // one. Over-refusal is the safe direction.
    const tail = r.desc.slice(r.desc.lastIndexOf('('))
    if (r.desc.includes('(') && !tail.includes(')')) continue
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
  /** The whole title: a search summary's is cut at 50 characters (streamrip's clean()). */
  title?: string
  /** Qobuz's parental_warning. False means no warning on this release, not censored:
   *  exact-recording.ts flagToJudge. */
  parentalWarning?: boolean
  /** The flag on the album the track sits on: see judgeHitsByMeta. */
  albumParentalWarning?: boolean
  durationSec?: number
  album?: string
  /** Who the album is by: "Various Artists" on a compilation (isCompilationCopy). */
  albumArtist?: string
  version?: string | null
}

/** A track/get answer, field by field: what is absent or the wrong type stays unknown. */
export function qobuzTrackMetaOf(d: { title?: unknown; parental_warning?: unknown; duration?: unknown; version?: unknown; album?: { title?: unknown; parental_warning?: unknown; artist?: { name?: unknown } } }): QobuzTrackMeta {
  return {
    title: typeof d.title === 'string' ? d.title.trim() : undefined,
    parentalWarning: typeof d.parental_warning === 'boolean' ? d.parental_warning : undefined,
    albumParentalWarning: typeof d.album?.parental_warning === 'boolean' ? d.album.parental_warning : undefined,
    durationSec: typeof d.duration === 'number' ? d.duration : undefined,
    album: typeof d.album?.title === 'string' ? d.album.title : undefined,
    albumArtist: typeof d.album?.artist?.name === 'string' ? d.album.artist.name : undefined,
    version: typeof d.version === 'string' ? d.version : null,
  }
}

const albumName = (album: string): string => (searchTitle(album) || album).replace(/\s+[-–—]\s*(?:ep|single)\s*$/i, '').trim()

/**
 * What to ask Qobuz's album search for: the album's name, then with every bracket gone. It answers
 * nothing for "Underworld Second Toughest in the Infants (Super Deluxe)", and the album is there.
 * Whatever comes back is still ranked against the row's whole name.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts albumSearchNames.
 */
export function albumSearchNames(album: string): string[] {
  const name = albumName(album)
  return [...new Set([name, bareTitle(name)].filter(Boolean))]
}

/** Is this the album the request names? No album on either side is never a mismatch. */
export function onWantedAlbum(wanted: string, album: string | undefined): boolean {
  if (!wanted || !album) return true
  return titleReads(albumName(wanted), albumName(album))
}

/**
 * A copy on an album that isn't the artist's own: a compilation, a label sampler, someone
 * else's DJ mix. The same recording, usually, on the wrong album for the library. So it goes
 * last in the walk, and with no album to look for it is still off the album. Nothing is known
 * without an answer from Qobuz, so an unanswered hit is not one of these.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts isCompilationCopy.
 */
export function isCompilationCopy(want: { artist: string; artistAliases?: string[] }, meta: QobuzTrackMeta | undefined): boolean {
  const by = meta?.albumArtist?.trim()
  if (!by || !want.artist) return false
  if (/^(?:various(?: artists)?|va|v\.a\.)$/i.test(by)) return true
  if ([want.artist, ...(want.artistAliases ?? [])].some((name) => recoArtistMatches(name, by))) return false
  return otherCredit(want.artist, by) === null
}

/**
 * The order to fetch hits in: the album asked for, then another album of the artist's, then a
 * compilation. `offAlbum`: the hits Qobuz says are on another album, or on a compilation when
 * no album is named. A compilation only counts as the album when the request names that album.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts judgeHitsByMeta.
 */
export function albumFirst<H extends { id: string }>(
  want: { artist: string; album: string; artistAliases?: string[] },
  hits: H[],
  meta: Map<string, QobuzTrackMeta>,
): { walk: H[]; offAlbum: Set<string> } {
  const compilation = new Set(hits.filter((h) => isCompilationCopy(want, meta.get(h.id))).map((h) => h.id))
  const offAlbum = new Set(hits.filter((h) => !onWantedAlbum(want.album, meta.get(h.id)?.album) || (compilation.has(h.id) && !want.album)).map((h) => h.id))
  return {
    walk: [
      ...hits.filter((h) => !offAlbum.has(h.id)),
      ...hits.filter((h) => offAlbum.has(h.id) && !compilation.has(h.id)),
      ...hits.filter((h) => offAlbum.has(h.id) && compilation.has(h.id)),
    ],
    offAlbum,
  }
}

/** What the library's row says instead of the file's tags, when the copy in hand is from the
 *  wrong album. The file's cover is that album's too, so the album's own comes from `coverUrls`. */
export interface RealAlbumTags {
  album: string
  albumArtist: string
  year?: number
  trackNumber?: number
  trackCount?: number
  discNumber?: number
  /** The song's title as the album prints it, when that only differs in how it is written. */
  title?: string
  coverUrls: string[]
}

/** How far a file may stray from the album's cut when that is the only clock there is. */
const ALBUM_CUT_TOLERANCE_SEC = 5

/**
 * The album a copy from the wrong album is filed on. Only when that is certain, or the file's
 * own tags stand: a row that names a compilation beats a row that names the wrong record.
 *   - MusicBrainz says which album this is, and the file is the song by the clock: the row's
 *     length, or the album's own cut.
 *   - Nothing from MusicBrainz: the row names the album, its length fits, and the copy is on a
 *     compilation. Never over a copy on the artist's own album: Turnover's "Humming" on
 *     Peripheral Vision is better than a row's "Humming - Single".
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts realAlbumTags.
 */
export function realAlbumTags(
  want: { title: string; artist: string; album: string; durationSec: number; durationTolSec: number; artistAliases?: string[] },
  real: RealAlbum | null,
  copy: { durationSec?: number; meta?: QobuzTrackMeta },
): RealAlbumTags | null {
  const sec = copy.durationSec
  if (!want.album || !sec || sec <= 0) return null
  const clocked = want.durationSec > 0 && Math.abs(sec - want.durationSec) <= want.durationTolSec
  const mb = real && titleKey(albumName(real.album)) === titleKey(albumName(want.album)) ? real : null
  const nearTheCut = mb?.durationSec !== undefined && Math.abs(sec - mb.durationSec) <= ALBUM_CUT_TOLERANCE_SEC
  if (mb && !mb.lateAlbum && (clocked || nearTheCut)) {
    return {
      album: mb.album,
      albumArtist: want.artist,
      ...(mb.year ? { year: mb.year } : {}),
      ...(mb.trackNumber ? { trackNumber: mb.trackNumber } : {}),
      ...(mb.trackCount ? { trackCount: mb.trackCount } : {}),
      ...(mb.discNumber ? { discNumber: mb.discNumber } : {}),
      ...(titleKey(searchTitle(mb.title) || mb.title) === titleKey(searchTitle(want.title) || want.title) ? { title: mb.title } : {}),
      coverUrls: [`https://coverartarchive.org/release-group/${mb.releaseGroupId}/front-500`],
    }
  }
  if (!clocked || !isCompilationCopy(want, copy.meta)) return null
  return { album: want.album, albumArtist: want.artist, coverUrls: [] }
}

/** Qobuz saying it has no such item: "No result matching given argument", the search
 *  index outliving the catalog. A gateway's 404 or a moved API path looks the same by
 *  status, and would skip every hit of every song. */
export function isQobuzNoSuchItem(body: unknown): boolean {
  const message = (body as { message?: unknown } | null)?.message
  return typeof message === 'string' && /no result/i.test(message)
}

/** The title a file from this hit would carry: streamrip writes "title (version)"
 *  unless the title already says it. */
export function titleWithVersion(title: string, version?: string | null): string {
  const v = (version ?? '').trim()
  return v && !title.includes(v) ? `${title} (${v})` : title
}

/** Why a copy is refused for its flag. What Qobuz says, not a claim about the audio:
 *  exact-recording.ts flagToJudge. */
export const NO_EXPLICIT_WARNING = 'has no explicit warning on Qobuz; the explicit record was asked for'

/** Does this copy say it is the explicit cut? Its version field can, or a bracket in its
 *  title. "Non-Explicit" does not, and a song named "Explicit Content" has said nothing.
 *  Qobuz's flag can be wrong about a copy that says so: "Paris, Tokyo (Explicit Album
 *  Version)" on Lupe Fiasco's The Cool is flagged clean, and it sits beside the album's
 *  clean edit, flagged the same (the phone's live check, 2026-11-04, Brief 223 §6).
 *  ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts saysExplicit. */
export function saysExplicit(title?: string | null, version?: string | null): boolean {
  const label = `${version ?? ''} ${/[([].*[)\]]/.exec(title ?? '')?.[0] ?? ''}`
  return /(?<!\b(?:non|not)[- ])\bexplicit\b/i.test(label)
}

// ── Whose Bandcamp page is this? ─────────────────────────────────────────
//
// Anyone can upload anything to Bandcamp under any band's name, and a row with no length
// has only tags to hold a file to. "Sky's the Limit" by The Notorious B.I.G. on
// bstep.bandcamp.com, on "Life After Death (Bstep Edition)", has the right tags and runs
// 247.1 s; the song runs 329.4 s. Of 64 rap rows with no length, Bandcamp would have
// imported 27 files and 21 ran more than 5 s from Jake's copy (2026-11-04): a 37 s sample,
// a slowed mixtape, a DJ's edit.
// Two things on the search's own answer tell them from a real release, before any fetch.
// ⚠️ TWIN: JakeTunesMobile/backend/src/util/bandcampLane.ts bandcampPages, stricter: the
//    phone has no search, so it only ever asks the band's own address.

const bandcampAddress = (name: string): string => foldAccents(name).toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The address names the band: warmduscher, pulpmusic, sapbandatx, officialjackwhite. It
 *  has to start with the name: xrayrecordsdmx is a label's "Greatest Hits" of DMX re-cuts.
 *  A short name gets no such room, or "Nas" would own nastyboyrecords. Only "," and "&" join
 *  credits (otherCredit). */
export function isBandsOwnAddress(artist: string, url: string): boolean {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  const page = bandcampAddress(host.replace(/^www\./, '').split('.')[0] ?? '')
  return [artist, ...artist.split(/[,&]/)].some((credit) => {
    const name = bandcampAddress(credit), bare = bandcampAddress(credit.trim().replace(/^the\s+/i, ''))
    if (!bare) return false
    if (page === `the${bare}` || page === `official${bare}`) return true
    return bare.length >= 4 ? page.startsWith(bare) || page.startsWith(name) : new RegExp(`^${bare}(?:band|music|official)?$`).test(page)
  })
}

/** "(Deluxe Edition)" is the record in other packaging. "(Bstep Edition)" and "(The Samples
 *  Edition)" are somebody's own: searchTitle drops every "edition", which is right for a
 *  search and wrong for saying two albums are one. */
const PACKAGING_EDITION = /\b(?:deluxe|special|expanded|anniversar\w*|remaster\w*|reissue\w*|limited|collector\w*|bonus|standard|super|tour|digital|complete|definitive|legacy|platinum|gold|international|explicit|original|extended)\b/i
function albumKey(album: string): string {
  const own = [...album.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)].some((m) => /\bedition\b/i.test(m[1]) && !PACKAGING_EDITION.test(m[1]))
  return recoFold(own ? album : (searchTitle(album) || album).replace(/\s+(?:e\.?p\.?|l\.?p\.?|single)$/i, ''))
}

/**
 * Why a Bandcamp hit can't be trusted for a row with no length, or null when it can. On the
 * band's own address, under the band's own name, it can, whatever album it sits on: r/MGMT at
 * mgmtcoveralbum and future2 at futuretalk start with the name and are not the band. On
 * anyone else's it has to name the row's album: a label's page does (Passin' Me By on Craft
 * Recordings, Bizarre Ride II The Pharcyde), a fan's mixtape does not. A page with no album
 * can stand only for a single, a row whose album is named after the song. A row that names
 * no album has nothing to hold a page to, and it is the scene band Apple has never heard
 * of, which this lane is for.
 */
export function bandcampHitDoubt(
  req: { artist: string; title: string; album: string },
  hit: { url: string; band: string; album?: string | null },
): string | null {
  if (!req.album) return null
  const credits = (name: string): string[] => [name, ...name.split(/[,&]/)].map(recoFold).filter(Boolean)
  const names = credits(req.artist)
  if (credits(hit.band).some((c) => names.includes(c)) && isBandsOwnAddress(req.artist, hit.url)) return null
  const wanted = albumKey(req.album)
  if (hit.album ? albumKey(hit.album) === wanted : wanted === albumKey(req.title)) return null
  return `is on someone else’s page${hit.album ? `, on “${hit.album}”` : ''}, and there’s no length to check it against`
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
