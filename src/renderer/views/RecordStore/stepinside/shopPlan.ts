/**
 * The floor plan of WJLR Records — pure data and pure functions, no
 * three.js, no React, so the filing can be tested.
 *
 * Jake, 2026-09-10, on how the records should be organised: "classic rock
 * and rock share. alternative/indie share. punk and grunge their own
 * thing. dollar bin doesn't make sense in this world." Then: "no — punk
 * is separate and grunge is separate. they're their own things." So:
 *
 *   • Genre bins, alphabetical inside with letter cards — where you go
 *     when you know what you want.
 *   • NEW ARRIVALS by the door, in the order things came in, no cards —
 *     what a digger checks first.
 *   • One bin for the small sections (jazz, Latin, world, reggae, metal,
 *     country, oddities) with a genre card at each boundary, the way a
 *     neighbourhood shop files what it only has a few of.
 *   • No dollar bin.
 *
 * Ten bins in three rows (3 / 4 / 3), front rails facing the door (+z).
 */

export type BinKind = 'arrivals' | 'genre' | 'mixed'

export interface BinDef {
  id: string
  /** Printed on the card taped to the front of the bin. */
  label: string
  kind: BinKind
  x: number
  z: number
}

/** A divider card: stands in front of record `at`, printed `label`. */
export interface Section { at: number; label: string }

/** How many sleeves a bin holds per visit. The crate geometry is sized
 *  for this plus its cards (world.ts BIN / crateView.ts). */
export const CRATE_CAPACITY = 48

const ROW = [-9.4, -12.4, -15.4]

export const BINS: BinDef[] = [
  { id: 'arrivals',   label: 'NEW ARRIVALS',                  kind: 'arrivals', x: -3,   z: ROW[0] },
  { id: 'rock',       label: 'ROCK',                          kind: 'genre',    x: 0,    z: ROW[0] },
  { id: 'alt',        label: 'ALTERNATIVE / INDIE',           kind: 'genre',    x: 3,    z: ROW[0] },
  { id: 'punk',       label: 'PUNK',                          kind: 'genre',    x: -4.5, z: ROW[1] },
  { id: 'grunge',     label: 'GRUNGE',                        kind: 'genre',    x: -1.5, z: ROW[1] },
  { id: 'rap',        label: 'RAP / HIP-HOP',                 kind: 'genre',    x: 1.5,  z: ROW[1] },
  { id: 'electronic', label: 'ELECTRONIC / DANCE',            kind: 'genre',    x: 4.5,  z: ROW[1] },
  { id: 'soul',       label: 'SOUL / FUNK / R&B',             kind: 'genre',    x: -3,   z: ROW[2] },
  { id: 'pop',        label: 'POP / NEW WAVE',                kind: 'genre',    x: 0,    z: ROW[2] },
  { id: 'other',      label: 'JAZZ · WORLD · METAL · COUNTRY', kind: 'mixed',    x: 3,    z: ROW[2] },
]

/** Order the small sections file in the mixed bin. */
export const OTHER_SECTIONS = ['JAZZ', 'BRAZIL & LATIN', 'WORLD', 'REGGAE', 'METAL', 'COUNTRY', 'ODDITIES'] as const
export type OtherSection = typeof OTHER_SECTIONS[number]

export interface Filing { bin: string; section?: OtherSection }

/** Where a genre string files. Ordered rules: the first match wins, and
 *  the order is the point — "Funk Rock" is rock, "Alternative Hip-Hop" is
 *  rap, "Latin House" is electronic, "Garage Rock" is rock but "UK Garage"
 *  is not. Anything unrecognised goes to the oddities card, never lost. */
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

export function fileGenre(genre: string | undefined | null): Filing {
  const g = (genre || '').trim()
  for (const [re, filing] of RULES) if (re.test(g)) return filing
  return { bin: 'other', section: 'ODDITIES' }
}

/** Key a shop files an artist under: leading "The" dropped, accents
 *  folded, so Édith is with the Es and The Beatles with the Bs. */
export function filingKey(artist: string): string {
  return artist.replace(/^the\s+/i, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Filing letter for a divider tab. Any script's letter counts — Hebrew
 *  and Cyrillic acts file after Z and the tab says so in their own
 *  alphabet. Digits and symbols are "#". */
export function filingLetter(artist: string): string {
  const c = [...artist.replace(/^the\s+/i, '').trim()][0] ?? ''
  const folded = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
  return /\p{L}/u.test(folded) ? folded : '#'
}

/** Letter-range cards for an artist-sorted run: one every `every`
 *  records, reading the first and last filing letters of its section. */
export function letterSections(artists: string[], every = 12): Section[] {
  const out: Section[] = []
  for (let i = 0; i < artists.length; i += every) {
    const last = Math.min(i + every - 1, artists.length - 1)
    const from = filingLetter(artists[i])
    const to = filingLetter(artists[last])
    out.push({ at: i, label: from === to ? from : `${from}–${to}` })
  }
  return out
}

/** Cards at each change of section label in an already-grouped run. */
export function groupSections(labels: string[]): Section[] {
  const out: Section[] = []
  labels.forEach((label, i) => { if (i === 0 || labels[i - 1] !== label) out.push({ at: i, label }) })
  return out
}
