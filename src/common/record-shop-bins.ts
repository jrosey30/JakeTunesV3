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
