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

/**
 * Is `a` within `max` edits of `b`? Bounded Levenshtein with an early exit.
 *
 * Needed because iTunes ALREADY corrects a typo — "radiohed" returns Radiohead,
 * "beyonce" returns Beyoncé — and then our own scorer threw the right answer
 * away, because "radiohed" is not a substring of "radiohead" and nothing else
 * matched. Apple did the hard part and we deleted the result.
 */
export function withinEditDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > max) return false
  const m = a.length, n = b.length
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    let best = cur[0]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return false          // whole row already too far
    const t = prev; prev = cur; cur = t
  }
  return prev[n] <= max
}

/** Edits allowed for a word of this length — 1 for short, 2 from 7 chars up.
 *  Anything looser starts matching genuinely different words. */
export function typoBudget(len: number): number {
  if (len <= 3) return 0
  if (len <= 6) return 1
  return 2
}
