/**
 * Sentence boundaries for prose the app shows or stores (the album page's
 * history and the Music Man's take, 2026-10-30: Perfecth's history ended on
 * `"Where` — the reply ran out of tokens and the cut-off text was cached and
 * shown; and the page's preview ended mid-sentence too).
 *
 *   wholeSentences(text)       keep only the finished sentences of a reply
 *                              that stopped early ('' when none finished)
 *   sentencePreview(text, max) the opening whole sentences that fit in about
 *                              `max` characters — always at least one, never
 *                              cut mid-sentence; the whole text when it fits
 *
 * An end is . ! ? or an ellipsis, optionally followed by a closing quote or
 * bracket, then whitespace or the end of the text. "In Times New Roman… (2023),
 * and" is NOT an end: an ellipsis or a period only ends a sentence when the
 * next word starts a new one (capital, digit or opening quote), which also
 * steps over "feat." / "Mr." / "J. Dilla".
 */

const END = /[.!?…]+["”’)\]]*(?=\s|$)/g
const ABBREVIATION = /(?:^|[\s("“‘'])(?:feat|ft|vs|mr|mrs|ms|dr|st|no|vol|pt|[A-Za-z])\.$/i
/** What may start the next sentence: a capital, a digit, a quote, a bracket … */
const NEXT_START = /^[\p{Lu}\p{N}"“‘'(\[]/u
/** … but after an ellipsis only a capital or a quote ("Roman… (2023), and" carries on). */
const NEXT_START_AFTER_ELLIPSIS = /^[\p{Lu}"“‘']/u

/** Index just past each sentence end, in order. */
export function sentenceEnds(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(END)) {
    const end = m.index! + m[0].length
    const punct = m[0].replace(/["”’)\]]+$/, '')
    if (ABBREVIATION.test(text.slice(0, m.index! + punct.length))) continue
    const rest = text.slice(end).replace(/^\s+/, '')
    const starts = /…|\.\.+/.test(punct) ? NEXT_START_AFTER_ELLIPSIS : NEXT_START
    // Mid-sentence "…" or "." (the next word carries on).
    if (rest && !starts.test(rest)) continue
    out.push(end)
  }
  return out
}

export function wholeSentences(text: string): string {
  const t = text.trim()
  const ends = sentenceEnds(t)
  if (!ends.length) return ''
  return t.slice(0, ends[ends.length - 1]!).trim()
}

export function sentencePreview(text: string, maxChars = 330): string {
  const t = text.trim()
  if (t.length <= maxChars) return t
  const ends = sentenceEnds(t)
  let cut = 0
  for (const end of ends) {
    if (end > maxChars && cut > 0) break
    cut = end
    if (end > maxChars) break
  }
  if (cut === 0 || cut >= t.length) return t
  return t.slice(0, cut).trim()
}
