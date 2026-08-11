/**
 * Which edition of a record wins a search row.
 *
 * Jake, 2026-08-10, searching Migos and getting only CLEAN copies of Culture
 * and Culture II: "why am i only seeing the clean version?????"
 *
 * Apple lists the censored and uncensored editions of a record under the same
 * artist and title, so both collapse onto one key in the Download page. First
 * one seen used to keep the row — and with it the collectionId — so whenever
 * the clean edition happened to arrive first, expanding the album fetched the
 * CLEAN tracklist and every download taken from it was censored. The badge was
 * telling the truth the whole time; the row was simply bound to the wrong
 * record.
 *
 * The distinction that matters, and that is easy to get wrong:
 *
 *   'explicit'    — the uncensored release
 *   'cleaned'     — a censored substitute for one that exists uncensored
 *   'notExplicit' — a record with nothing to censor. NOT the same as cleaned,
 *                   and it must never lose its row to anything.
 */
export function explicitWins(current?: string, incoming?: string): boolean {
  return current === 'cleaned' && incoming === 'explicit'
}
