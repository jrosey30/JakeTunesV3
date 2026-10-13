/**
 * Music Man credit guard (2026-10-13, Jake: "what happened with the made up
 * answer?? cant happen").
 *
 * The 10/13 nightly eval caught the model crediting two REAL library songs to
 * the wrong name: "No More Hangovers" (Mean Street) credited to the EP's own
 * title, and "Celebrity" by the band My First Time with the two names
 * swapped. Nothing was invented. The songs it was handed came as dash-joined
 * lines, and a band named like a song made the fields ambiguous.
 *
 * Two layers in the chat path:
 *   1. rag-retrieval.ts hands the songs over unambiguously ("Title" by Artist)
 *      and asks for that exact shape back.
 *   2. This guard fixes, in the reply, a song from that list whose credit
 *      shows one of those garble signatures. It never touches an attribution
 *      that could be a deliberate choice (a cover, another artist, a song
 *      outside the list); those are left alone, not "corrected".
 *
 * Electron-free and pure; node --test loads it.
 */

export interface CreditTrack { title?: string; artist?: string; album?: string }
export interface CreditFix { from: string; to: string; why: 'title-as-artist' | 'album-as-artist' | 'swapped' }

const fold = (s: string | undefined): string =>
  (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
/** "No More Hangovers - EP" → "No More Hangovers" (release-type suffixes aren't names). */
const albumName = (a: string | undefined): string => (a || '').replace(/\s*[-–—]\s*(EP|Single)\s*$/i, '').replace(/\s*\((EP|Single|Deluxe[^)]*)\)\s*$/i, '').trim()

// A quoted title, then "by" or a dash, then the credited name up to the end
// of the clause. Straight or curly quotes.
const MENTION = /(["“])([^"“”\n]{1,120})(["”])(\s*(?:by|—|–|-)\s+)([^\n,.;:!?()[\]"“”]{1,80})/g

/** Does the credited text begin with this name (word-boundary, folded)? */
function startsWithName(credited: string, name: string | undefined): boolean {
  const c = fold(credited), n = fold(name)
  return !!n && (c === n || c.startsWith(n + ' '))
}

/** Length in the ORIGINAL text of the prefix that folds to `name`. */
function prefixLength(credited: string, name: string): number {
  const target = fold(name)
  for (let i = 1; i <= credited.length; i++) {
    const f = fold(credited.slice(0, i))
    if (f === target && (i === credited.length || /[^A-Za-z0-9]/.test(credited[i]))) return i
    if (f.length > target.length) break
  }
  return 0
}

export function guardCredits(text: string, shown: readonly CreditTrack[]): { text: string; fixes: CreditFix[] } {
  if (!text || shown.length === 0) return { text, fixes: [] }
  const byTitle = new Map<string, CreditTrack[]>()
  const byArtist = new Map<string, CreditTrack[]>()
  for (const t of shown) {
    if (!t.title || !t.artist) continue
    byTitle.set(fold(t.title), [...(byTitle.get(fold(t.title)) ?? []), t])
    byArtist.set(fold(t.artist), [...(byArtist.get(fold(t.artist)) ?? []), t])
  }
  const fixes: CreditFix[] = []
  const out = text.replace(MENTION, (whole, q1: string, title: string, q2: string, sep: string, credited: string) => {
    const songs = byTitle.get(fold(title)) ?? []
    // Correct (or plausibly deliberate) already: leave it.
    if (songs.some((t) => startsWithName(credited, t.artist))) return whole
    if (songs.length === 1) {
      const t = songs[0]
      for (const [name, why] of [[t.title, 'title-as-artist'], [albumName(t.album), 'album-as-artist']] as const) {
        const n = name ? prefixLength(credited, name) : 0
        if (n > 0) {
          fixes.push({ from: `"${title}" by ${credited.slice(0, n)}`, to: `"${title}" by ${t.artist}`, why })
          return `${q1}${title}${q2}${sep}${t.artist}${credited.slice(n)}`
        }
      }
      return whole
    }
    // Swapped: the quoted "title" is a listed artist and the credit is that
    // artist's listed song — write it the right way round.
    if (songs.length === 0) {
      for (const t of byArtist.get(fold(title)) ?? []) {
        const n = t.title ? prefixLength(credited, t.title) : 0
        if (n > 0) {
          fixes.push({ from: `"${title}" by ${credited.slice(0, n)}`, to: `"${t.title}" by ${t.artist}`, why: 'swapped' })
          return `${q1}${t.title}${q2}${sep}${t.artist}${credited.slice(n)}`
        }
      }
    }
    return whole
  })
  return { text: out, fixes }
}
