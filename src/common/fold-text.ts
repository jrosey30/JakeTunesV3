/**
 * Fold a name to plain ASCII letters before comparing it to another name.
 *
 * Jake, 2026-08-09, typing "JAY-Z" into Download and getting "Nothing matched
 * that": iTunes spells him JAŸ-Z, with U+0178, and every normaliser in the
 * download path stripped anything outside [a-z0-9]. So "JAŸ-Z" became "ja z",
 * the query "jay z" never matched it, every result scored zero, and a search
 * that returned ten correct rows rendered an empty page.
 *
 * It was never about JAY-Z. Measured on the same normalisers:
 *
 *     Beyoncé      -> "beyonc"        Björk      -> "bj rk"
 *     Sigur Rós    -> "sigur r s"     Motörhead  -> "mot rhead"
 *     Céline Dion  -> "c line dion"   JAŸ-Z      -> "ja z"
 *
 * Every one of those is unfindable and unmatchable. Two steps are needed and
 * the second is the one people forget:
 *
 *  1. NFD decomposition splits a letter from its accent, so the combining mark
 *     can be dropped and "é" becomes "e".
 *  2. Some letters have NO decomposition — ø, æ, ß, ł, đ, þ are single
 *     codepoints, not letter-plus-mark — so NFD alone leaves them to be
 *     stripped to nothing. They need an explicit map.
 *
 * ⚠️ TWIN: src/renderer/utils/searchIndex.ts (normalize) does step 1 only.
 * That is why universal search finds Beyoncé but Download did not.
 */

/** Letters with no NFD decomposition. Without these, step 1 silently misses. */
const SINGLETONS: Record<string, string> = {
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ß: 'ss', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ı: 'i', İ: 'i', ŋ: 'n', ħ: 'h',
}

/**
 * Diacritics folded, case dropped, everything else left exactly as it was —
 * callers still apply their own punctuation rules on top. Folding must happen
 * BEFORE any [a-z0-9] strip, or the accented letter is already gone.
 */
export function foldAccents(s: string | null | undefined): string {
  if (!s) return ''
  let out = ''
  for (const ch of String(s)) {
    out += SINGLETONS[ch] ?? ch
  }
  return out
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}
