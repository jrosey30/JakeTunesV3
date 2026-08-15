/**
 * Turning Exa results into prompt text the personas can actually use.
 *
 * Split out of exa.ts (which imports electron and can't run under
 * `node --test`) when the 2026-08-15 audit of the live exa-cache showed what
 * the Music Man had really been reading: `highlights: true` on review pages
 * returns navigation crumbs — "Release Date:", a bare "2017", the page title
 * repeated, "..." separators — at ~34KB of prompt per artist. He was being
 * "grounded" in boilerplate, and paying dearly per call for it.
 *
 * The fix upstream is directed per-result summaries (contents.summary.query),
 * which return dense critical prose. This module's job is everything after
 * the response arrives: prefer the summary, fall back to highlights only
 * after filtering the junk lines, and hold every block to a hard size so a
 * fact block can never again dwarf the persona it's feeding.
 */

export interface ExaResultLike {
  title?: string
  url?: string
  publishedDate?: string
  summary?: string
  highlights?: string[]
}

/** Per-result and whole-block caps. Four dense summaries land ~4-5KB total —
 *  a tenth of what the junk highlights cost, and all of it usable. */
export const MAX_CHARS_PER_RESULT = 1400
export const MAX_CHARS_PER_BLOCK = 6000

/** Lines that carry no meaning for a persona: bare years, dates,
 *  "Release Date:"-style field labels, ellipsis separators, and other
 *  metadata crumbs Exa's highlighter picks off review-page chrome. */
const JUNK_LINE = /^(?:[\s•\-–—.…]*|(?:19|20)\d{2}|(?:reviewed\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*(?:19|20)?\d{0,4}|(?:genre|label|release date|reviewed|by [a-z .'-]+)\s*:?[\s.…]*)$/i

function cleanHighlights(highlights: string[] | undefined, title: string): string {
  if (!highlights || highlights.length === 0) return ''
  const titleNorm = title.trim().toLowerCase()
  const kept: string[] = []
  for (const h of highlights) {
    for (const line of h.split('\n')) {
      const t = line.trim()
      if (!t || JUNK_LINE.test(t)) continue
      // The highlighter loves re-serving the page's own <h1>.
      if (t.toLowerCase() === titleNorm) continue
      kept.push(t)
    }
  }
  return kept.join(' … ')
}

/**
 * One block per result: title, date, url, then the best text available for
 * that result. The URL is included so the model can attribute without
 * inventing a source — but never told to read it aloud (personas.ts owns
 * that instruction).
 */
export function formatExaResults(results: ExaResultLike[], header: string): string {
  const parts: string[] = []
  let budget = MAX_CHARS_PER_BLOCK
  for (const r of results) {
    if (budget <= 0) break
    const title = r.title?.trim() || 'Untitled'
    const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : ''
    const summary = r.summary?.trim() || ''
    const text = (summary || cleanHighlights(r.highlights, title)).slice(0, MAX_CHARS_PER_RESULT)
    // A result that survived filtering with nothing to say is not a result.
    if (!text) continue
    const block = `• ${title}${date}\n  ${r.url || ''}\n  ${text}`
    parts.push(block.slice(0, budget))
    budget -= block.length
  }
  if (parts.length === 0) return ''
  return `${header}\n${parts.join('\n\n')}`
}
