/**
 * Record Shop bins + album hook selection (2026-08-22, Jake: "start to
 * organize recos by genre in the record store. make it like a flip through
 * the bin experience… if recommending an album, have one song be the 30
 * second sample for the entire album that is going to hook me").
 *
 * Pure and node-tested. SHOP_BINS / binForGenre are the critic wall's coarse
 * reading of a sheet genre (critic-picks.ts criticGenre). The page files
 * into CRATES (below), Jake's own filing, since 2026-11-09.
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

// ── The crates (2026-11-09 reorganization) ──────────────────────────
// Jake's own filing, 2026-09-10, rescued from Step Inside's floor plan
// (renderer/views/RecordStore/stepinside/shopPlan.ts, removed with the room;
// tag archive/step-inside-2026-11-09): "classic rock and rock share.
// alternative/indie share. punk and grunge their own thing." Then: "no —
// punk is separate and grunge is separate. they're their own things." The
// small sections share one crate with a label on each card, the way a
// neighbourhood shop files what it only has a few of. There is no Misc.

/** The crates in their fixed order, the order the page shows them. */
export const CRATES = [
  { id: 'punk', label: 'Punk' },
  { id: 'grunge', label: 'Grunge' },
  { id: 'rock', label: 'Rock' },
  { id: 'alt', label: 'Alternative / Indie' },
  { id: 'rap', label: 'Rap / Hip-Hop' },
  { id: 'electronic', label: 'Electronic / Dance' },
  { id: 'soul', label: 'Soul / Funk / R&B' },
  { id: 'pop', label: 'Pop / New Wave' },
  { id: 'other', label: 'Jazz · World · Metal · Country' },
] as const
export type CrateId = typeof CRATES[number]['id']
export const isCrateId = (v: unknown): v is CrateId => CRATES.some((c) => c.id === v)

/** Order the small sections file in the mixed crate. */
export const OTHER_SECTIONS = ['JAZZ', 'BRAZIL & LATIN', 'WORLD', 'REGGAE', 'METAL', 'COUNTRY', 'ODDITIES'] as const
export type OtherSection = typeof OTHER_SECTIONS[number]

export interface Filing { bin: CrateId; section?: OtherSection }

/** Ordered rules: the first match wins, and the order is the point —
 *  "Funk Rock" is rock, "Alternative Hip-Hop" is rap, "Latin House" is
 *  electronic, "Garage Rock" is rock but "UK Garage" is not. The words are
 *  the ones in Jake's own library ("altnerative", "sleaze"). */
const RULES: Array<[RegExp, Filing]> = [
  [/grunge/i,                                                      { bin: 'grunge' }],
  [/punk|hardcore/i,                                               { bin: 'punk' }],
  [/metal/i,                                                       { bin: 'other', section: 'METAL' }],
  [/\brap\b|hip.?hop|trip hop|dub-hop/i,                            { bin: 'rap' }],
  [/r&b|\bsoul\b(?! rock)|boogie|\bfunk\b(?! rock)(?! metal)/i,     { bin: 'soul' }],
  [/alternative|altnerative|indie|shoegaze|college|chillwave|sleaze/i, { bin: 'alt' }],
  [/house|electro|dance|disco|uk garage|big beat|berlin|techno|mash up/i, { bin: 'electronic' }],
  [/rock|blues|americana/i,                                        { bin: 'rock' }],
  [/pop|wave|synth|easy listening|italo/i,                          { bin: 'pop' }],
  [/jazz/i,                                                        { bin: 'other', section: 'JAZZ' }],
  [/bossa|samba|mpb|brazil|latin/i,                                { bin: 'other', section: 'BRAZIL & LATIN' }],
  [/reggae|dancehall|\bdub\b/i,                                    { bin: 'other', section: 'REGGAE' }],
  [/country/i,                                                     { bin: 'other', section: 'COUNTRY' }],
  [/world|afro/i,                                                  { bin: 'other', section: 'WORLD' }],
]

/** Where a genre files when one of Jake's rules knows it; null otherwise. */
export function knownFiling(genre: string | undefined | null): Filing | null {
  const g = (genre || '').trim()
  if (!g) return null
  for (const [re, filing] of RULES) if (re.test(g)) return filing
  return null
}

/** Where a genre string files. Anything unrecognised goes to the oddities
 *  card in the mixed crate, never lost and never a crate called Misc. */
export function fileGenre(genre: string | undefined | null): Filing {
  return knownFiling(genre) ?? { bin: 'other', section: 'ODDITIES' }
}

/** Where the genre of a pick comes from, best first. */
export interface PickGenreSources {
  /** The genre Jake's library gives this artist (his own words), if he has any of them. */
  libraryGenre: (artist: string) => string | undefined
  /** MusicBrainz's community tags for the artist, most-voted first (main/artist-tags.ts). */
  tags: (artist: string) => string[] | undefined
}

/**
 * Every pick gets a genre before it is filed (Jake, 2026-11-09: the crates
 * were one crate called "Misc" because most lanes reach the page with no
 * genre). Best first: the card's own (iTunes, the critic sheet), the
 * artist's genre in the library, the artist's MusicBrainz tags, the genre
 * (then the tags) of the artist the pick came from ("because"), then the
 * card's sonic one-liner. The first one Jake's rules know wins; failing that the
 * first word anyone gave; null only when nobody said anything at all.
 */
export function genreForPick(
  card: { artist: string; genre?: string; because?: string; desc?: string },
  src: PickGenreSources,
): string | null {
  const said: string[] = []
  const add = (g: string | undefined | null): void => { const t = (g || '').trim(); if (t) said.push(t) }
  add(card.genre)
  add(src.libraryGenre(card.artist))
  for (const t of src.tags(card.artist) ?? []) add(t)
  if (card.because) {
    add(src.libraryGenre(card.because))
    for (const t of src.tags(card.because) ?? []) add(t)
  }
  add(card.desc)
  return said.find((g) => knownFiling(g)) ?? said[0] ?? null
}
