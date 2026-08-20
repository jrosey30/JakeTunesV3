/**
 * Decade / year constraints for retrieval + mix / playlist validation.
 *
 * Soft embedding similarity does NOT enforce era. A query like "1970s
 * classic rock" will happily rank Turnstile next to Bill Withers unless
 * something hard-gates on the library year field. brain-eval ret-006
 * ("classic rock from the 1970s") already measures this gap; the
 * 2026-08-14 P3 counterfactual quantified it further.
 *
 * ⚠️ TWIN: JakeTunesMobile backend mix builder + rag retrieve path
 *    (`backend/src/routes/mixes.ts`, `backend/src/util/rag.ts`). Decade-
 *    themed daily mixes ("1970s, Your Version") MUST apply the same
 *    hard year gate after retrieval — cosine alone is not enough.
 *    Keep the word-list + numeric parsing in lockstep with this file.
 */

export interface DecadeRange {
  /** Inclusive start year, e.g. 1970 */
  start: number
  /** Inclusive end year, e.g. 1979 */
  end: number
  /** Human label used in violation messages, e.g. "1970s" */
  label: string
}

/** Same shape as the dual-index router guard in main/index.ts — keep in sync. */
export const DECADE_QUERY_RE =
  /\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b/i

const WORD_DECADES: Array<{ re: RegExp; start: number; label: string }> = [
  { re: /\bfifties\b/i, start: 1950, label: '1950s' },
  { re: /\bsixties\b/i, start: 1960, label: '1960s' },
  { re: /\bseventies\b/i, start: 1970, label: '1970s' },
  { re: /\beighties\b/i, start: 1980, label: '1980s' },
  { re: /\bnineties\b/i, start: 1990, label: '1990s' },
  { re: /\b(noughties|aughts|2000s)\b/i, start: 2000, label: '2000s' },
]

/**
 * If the query/title/subtitle claims a specific decade or year, return
 * the inclusive year range. Otherwise null (no hard gate).
 *
 * Precedence: spelled-out decade words → `1970s` / `1970` → shorthand
 * `'70s` / `70s`. First match wins; multi-decade queries ("60s and 70s")
 * take the first span only — callers that need unions can compose.
 */
export function parseDecadeConstraint(text: string): DecadeRange | null {
  const q = String(text || '')
  if (!q.trim()) return null

  for (const w of WORD_DECADES) {
    if (w.re.test(q)) {
      return { start: w.start, end: w.start + 9, label: w.label }
    }
  }

  // Full year or decade: 1970, 1970s, 2010s
  const full = q.match(/\b((?:19|20)\d{2})(s)?\b/i)
  if (full) {
    const y = parseInt(full[1], 10)
    if (Number.isFinite(y)) {
      if (full[2]) {
        const start = Math.floor(y / 10) * 10
        return { start, end: start + 9, label: `${start}s` }
      }
      // Bare year ("1975 rock") — pin to that calendar year.
      return { start: y, end: y, label: String(y) }
    }
  }

  // Shorthand: '70s, 70s, ’80s (leading digit of decade)
  const short = q.match(/(^|[^\d])['’]?([1-9])0s\b/i)
  if (short) {
    const decadeDigit = parseInt(short[2], 10)
    // Ambiguous for 10s/20s without century — treat 1–9 as 1910–1990
    // (Jake's library peak is 20th-c / early 21st; "10s" alone is rare).
    const start = 1900 + decadeDigit * 10
    return { start, end: start + 9, label: `${start}s` }
  }

  return null
}

/** Parse a track's year field; returns null when missing / unparseable. */
export function parseTrackYear(year: string | number | null | undefined): number | null {
  if (year == null || year === '') return null
  const n = typeof year === 'number' ? year : parseInt(String(year).trim(), 10)
  if (!Number.isFinite(n) || n < 1000 || n > 2100) return null
  return n
}

export function yearInDecade(
  year: string | number | null | undefined,
  range: DecadeRange,
): boolean {
  const y = parseTrackYear(year)
  if (y == null) return false
  return y >= range.start && y <= range.end
}
