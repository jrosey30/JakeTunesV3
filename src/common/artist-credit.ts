/**
 * Whether two artist credits are one act. In common because both bundles ask: the main process's
 * judge, and the Listen List, which has to know who a row's download is for.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts, the same functions.
 */
import { hasOtherScript, nameKey, withinEditDistance } from './fold-text.ts'

const fold = (name: string): string => nameKey(name, '')

/**
 * The same name: folded, or as written when it has no letters to fold. "!!!" folds to nothing, so
 * the band's own name never matched itself, and "Even When the Water's Cold" was refused as "by !!!,
 * not !!!" on both apps (2026-11-06). Compared as written, "???" is still somebody else, and an empty
 * name is no name. textNamesArtist (exact-recording.ts) looks for such a name in free text the same way.
 */
export function sameArtistName(want: string, got: string): boolean {
  const key = (name: string): string => fold(name) || (name || '').trim()
  return key(want) !== '' && key(want) === key(got)
}

export function recoArtistMatches(want: string, got: string): boolean {
  if (sameArtistName(want, got)) return true
  const w = fold(want)
  const g = fold(got)
  return w.length >= 4 && g.length >= 4 && (w.includes(g) || g.includes(w))
}

/**
 * Another way of writing the same credit, for when recoArtistMatches says no (JakeTunesMobile
 * Brief 225):
 *   'order': the same words in another order. Qobuz lists Richard F. as "F. Richard", and a
 *            joint credit comes in any order ("Mr. Kris & Eric Faria").
 *   'part':  one whole name of a joint credit, too short for recoArtistMatches' containment
 *            test. Qobuz lists "OMA & SitarNik" as "Oma".
 * Only "&" and "," join credits: "/" and "+" sit inside names (AC/DC, C+C Music Factory).
 * "Sly & the Family Stone" is one band, "Sammy Davis, Jr." one man, and a lone letter no name.
 * There is no spelling rule: 18 artist pairs in Jake's library are one letter apart, and all 18
 * are different acts (David Bowie, David Zowie).
 * A name alone does not make it the song: see creditHolds (streamrip-match.ts).
 */
export function otherCredit(want: string, got: string): 'order' | 'part' | null {
  const wordsOf = (name: string): string[] => name.split(/[\s,&]+/).map(fold).filter(Boolean)
  const w = wordsOf(want), g = wordsOf(got)
  if (w.join(' ') !== g.join(' ') && [...w].sort().join(' ') === [...g].sort().join(' ')) return 'order'
  const credits = want.split(/[,&]/).map((c) => c.trim()).filter(Boolean)
  const name = fold(got)
  if (credits.length < 2 || name.length < 2 || credits.some((c) => /^(?:the\s|[js]r\b)/i.test(c))) return null
  return credits.some((c) => fold(c) === name) ? 'part' : null
}

/** Who a match's own words credit: "(feat. Calvin Harris)", "(Mixed By Tiësto)". */
function creditedNames(title: string, album: string): string[] {
  const credits = [
    ...title.matchAll(/[([](?:feat\.?|ft\.?|featuring|with)\s+([^)\]]*)[)\]]|\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/gi),
    ...album.matchAll(/\bmixed by\s+([^)\]]+)/gi),
  ].map((m) => m[1] ?? m[2] ?? '')
  return credits.flatMap((c) => [c, ...c.split(/\s*(?:,|&|\band\b)\s*/i)])
}

const withoutFeaturedCredit = (title: string): string => title
  .replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi, '')
  .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
  .trim()

/**
 * Is Apple's match of a row still the artist the row names? Apple can only answer with what it lists,
 * so with no row by that name it offers someone else's song of that title, and a download asks for the
 * match. Bizarre Inc's "I'm Gonna Get You" landed as Eddy Raven's country song, Natek's "Bite the bullet"
 * as Jessica Baio's, and Pierce the Veil's "Floral & Fading" came back as a lullaby tribute. One artist
 * among Apple's rows only says who Apple happens to list. Of the 300 rows ever on the Listen List, 8 came
 * back under another name and 1 of those was right. So the match counts only with evidence:
 *   - the name itself or inside the match's credit (recoArtistMatches), or the same credit written
 *     another way (otherCredit, either way round)
 *   - the match credits it: "We Found Love (feat. Calvin Harris)" by Rihanna, "AFTR:HRS (Mixed By Tiësto)"
 *   - one letter off, on a name long enough for that to say something: "Chromio" for Chromeo
 *   - two alphabets, whose letters can't say: הדג נחש is Hadag Nahash
 *   - Apple lists the row the other way round (a pasted "Coach - Sex Week")
 * A row that names nobody has nothing to contradict, and neither does a row with no match.
 * Scored on Jake's library: of 2,428 same-title pairs by artists the artist test calls different, this
 * accepts none. It is for a row Jake named. A model's pick is another matter:
 * shouldRejectRecoArtistCorrection (reco-match.ts) corrects Music Man's credit by the title alone.
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts matchNamesRowArtist.
 */
export function matchNamesRowArtist(rec: { song?: string; artist?: string; matchedTitle?: string; matchedArtist?: string; matchedAlbum?: string }): boolean {
  const asked = String(rec.artist ?? '').trim(), matched = String(rec.matchedArtist ?? '').trim()
  if (!asked || !matched || recoArtistMatches(asked, matched)) return true
  if (hasOtherScript(asked) !== hasOtherScript(matched)) return true
  const title = String(rec.matchedTitle ?? '')
  if (creditedNames(title, String(rec.matchedAlbum ?? '')).some((name) => sameArtistName(asked, name))) return true
  if (otherCredit(asked, matched) || otherCredit(matched, asked)) return true
  const a = fold(asked), m = fold(matched)
  if (Math.max(a.length, m.length) >= 5 && withinEditDistance(a, m, 1)) return true
  return sameArtistName(String(rec.song ?? ''), matched) && sameArtistName(asked, withoutFeaturedCredit(title))
}
