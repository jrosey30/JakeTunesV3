import type { Track } from '../types'

/** Quick-add matcher for the playlist strip. Pure so src/main/__tests__ can
 *  exercise it (the test runner strips .ts, not .tsx). */
export const MAX_RESULTS = 8

function norm(s: unknown): string {
  return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function quickAddMatches(pool: Track[], exclude: Set<number>, query: string, cap = MAX_RESULTS): Track[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const scored: Array<{ t: Track; score: number }> = []
  for (const t of pool) {
    if (exclude.has(t.id)) continue
    const title = norm(t.title), artist = norm(t.artist), album = norm(t.album)
    const hay = `${title} ${artist} ${album}`
    if (!words.every(w => hay.includes(w))) continue
    // Title hits outrank artist hits outrank album-only hits; a title that
    // STARTS with the query outranks one that merely contains it.
    const q = words.join(' ')
    let score = 0
    if (title.startsWith(q)) score += 40
    else if (title.includes(q)) score += 30
    else if (words.every(w => title.includes(w))) score += 20
    if (artist.startsWith(q)) score += 12
    else if (words.some(w => artist.includes(w))) score += 8
    if (words.some(w => album.includes(w))) score += 2
    scored.push({ t, score })
  }
  scored.sort((a, b) => b.score - a.score || norm(a.t.title).localeCompare(norm(b.t.title)))
  return scored.slice(0, cap).map(s => s.t)
}

