/**
 * Jake's JUSTIFICATION playlists (2026-10-24): "17-20 songs that i either found
 * or rediscovered on jaketunes that i would never have found on spotify. it is
 * Justification for me having jaketunes". They stay regular playlists (edit,
 * drag, rename, Add to Playlist); the sidebar groups them in their own
 * section, in the order of their numerals: Justification, Justification II,
 * III, "JUSTIFICATION IV: A NEW STREAM", …
 */

export const isJustificationPlaylist = (name: string): boolean => /^\s*justification\b/i.test(name)

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 }

/** 1 for the bare "Justification", the numeral's value after it ("Justification IV" → 4). */
export function justificationOrder(name: string): number {
  const m = /^\s*justification\s+([ivxlc]+)(?![a-z])/i.exec(name)
  if (!m) return 1
  const s = m[1].toLowerCase()
  let total = 0
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]] ?? 0
    const next = ROMAN[s[i + 1] ?? ''] ?? 0
    total += v < next ? -v : v
  }
  return total || 1
}

export function sortJustifications<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => justificationOrder(a.name) - justificationOrder(b.name) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
