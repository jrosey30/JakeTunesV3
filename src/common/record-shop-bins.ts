/**
 * Record Shop bins + album hook selection (2026-08-22, Jake: "start to
 * organize recos by genre in the record store. make it like a flip through
 * the bin experience… if recommending an album, have one song be the 30
 * second sample for the entire album that is going to hook me").
 *
 * Pure and node-tested. The shop's genre DIVIDERS are deliberately coarse —
 * a real store has PUNK and HIP-HOP cards in the crates, not a taxonomy.
 * Order is display order; Punk leads (this is Jake's store).
 */

export const SHOP_BINS = [
  'Punk', 'Rock', 'Hip-Hop', 'Electronic', 'Pop',
  'Soul & Funk', 'Jazz & Blues', 'Country & Folk', 'World', 'Misc',
] as const
export type ShopBin = typeof SHOP_BINS[number]

const BIN_RULES: Array<[RegExp, ShopBin]> = [
  [/punk|hardcore|emo|ska\b|oi!/i, 'Punk'],
  [/hip.?hop|rap\b|trap\b|grime|drill/i, 'Hip-Hop'],
  [/electronic|dance|house|techno|edm|dubstep|drum.?(&|and).?bass|idm|ambient|synth|electro/i, 'Electronic'],
  [/soul|funk|r&b|rnb|r\/b|motown|disco/i, 'Soul & Funk'],
  [/jazz|blues\b/i, 'Jazz & Blues'],
  [/country|folk|americana|bluegrass|singer.?songwriter/i, 'Country & Folk'],
  [/latin|world|afro|reggae|brazil|salsa|k-?pop\b.*world|african/i, 'World'],
  // Pop BEFORE Rock so "Pop" doesn't fall through, but AFTER the specific
  // families above so "Dance Pop"→Electronic, "Country Pop"→Country.
  [/\bpop\b|k-?pop/i, 'Pop'],
  [/rock|metal|grunge|alternative|indie|shoegaze|psychedelic|garage/i, 'Rock'],
]

export function binForGenre(genre: string | undefined | null): ShopBin {
  const g = String(genre || '').trim()
  if (!g) return 'Misc'
  for (const [re, bin] of BIN_RULES) if (re.test(g)) return bin
  return 'Misc'
}

/**
 * Choose the album's HOOK track — the one 30-second sample doing the
 * selling. Inputs are the album's tracks with (optionally) a brain pct per
 * track; the winner is the highest-scored track THAT HAS A PREVIEW. With
 * no scores (brain unavailable) the first previewable track wins — track
 * order is the artist's own opening argument.
 */
export function pickHookIndex(tracks: Array<{ previewUrl?: string; pct?: number }>): number {
  let best = -1
  let bestPct = -Infinity
  for (let i = 0; i < tracks.length; i++) {
    if (!tracks[i].previewUrl) continue
    const p = tracks[i].pct ?? -1
    if (p > bestPct) { bestPct = p; best = i }
  }
  return best
}

/**
 * Shelf quotas (2026-08-23, Jake: "some genre's shouldnt have 7 picks and
 * others 2 and 1"). Presentation policy, applied at render time so cached
 * feeds behave identically:
 *  - a bin shows at most `cap` cards — its BEST by brain %, ties keep
 *    original order;
 *  - a bin with fewer than `minShelf` cards can't stand as a shelf — its
 *    cards fold into the 'More Finds' shelf at the end, so nothing is lost
 *    but no shelf looks abandoned.
 */
export const MORE_BIN = 'More Finds'

export function applyBinQuotas<T extends { bin?: string; brainPct?: number }>(
  cards: T[],
  opts: { cap?: number; minShelf?: number } = {},
): Array<{ bin: string; cards: T[] }> {
  const cap = opts.cap ?? 6
  const minShelf = opts.minShelf ?? 3
  const byBin = new Map<string, T[]>()
  for (const c of cards) {
    const b = c.bin || 'Misc'
    const arr = byBin.get(b) || []
    arr.push(c)
    byBin.set(b, arr)
  }
  const shelves: Array<{ bin: string; cards: T[] }> = []
  const overflow: T[] = []
  for (const bin of SHOP_BINS) {
    const arr = byBin.get(bin)
    if (!arr) continue
    if (arr.length < minShelf) { overflow.push(...arr); continue }
    const kept = [...arr]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => ((b.c.brainPct ?? 0) - (a.c.brainPct ?? 0)) || (a.i - b.i))
      .slice(0, cap)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.c)
    shelves.push({ bin, cards: kept })
  }
  // Unknown bins (future-proofing) fold into More too.
  for (const [bin, arr] of byBin) if (!(SHOP_BINS as readonly string[]).includes(bin)) overflow.push(...arr)
  if (overflow.length) {
    const kept = [...overflow]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => ((b.c.brainPct ?? 0) - (a.c.brainPct ?? 0)) || (a.i - b.i))
      .slice(0, cap + 2)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.c)
    shelves.push({ bin: MORE_BIN, cards: kept })
  }
  return shelves
}
