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
 * Ten bins laid out like a shop, not a grid (Jake: "it should all be
 * against the wall and in the middle"): a run of three along the left
 * wall, a run of three along the right wall, and a double-sided island of
 * four down the middle. Every rail faces an aisle.
 */

export type BinKind = 'arrivals' | 'genre' | 'mixed'

export interface BinDef {
  id: string
  /** Printed on the card taped to the front of the bin. */
  label: string
  kind: BinKind
  x: number
  z: number
  /** Yaw of the front rail, radians: 0 faces the door (+z), +π/2 faces
   *  +x (a left-wall bin faces the aisle), −π/2 faces −x. */
  facing: number
}

/** A divider card: stands in front of record `at`, printed `label`. */
export interface Section { at: number; label: string }

/** How many sleeves a bin holds per visit. The crate geometry is sized
 *  for this plus its cards (world.ts BIN / crateView.ts). */
export const CRATE_CAPACITY = 48

// Bins are 0.76 m across the rail and 0.91 m deep; in a run they touch.
const PITCH = 0.95
const WALL_X = 5.95           // bin centre for a wall run; the back sits on the wall racks
const ISLAND_X = 0.455        // back-to-back down the middle
const LEFT = Math.PI / 2      // rail faces +x
const RIGHT = -Math.PI / 2    // rail faces −x

export const BINS: BinDef[] = [
  // Left wall, front to back — what you meet first when you walk in.
  { id: 'arrivals',   label: 'NEW ARRIVALS',                  kind: 'arrivals', x: -WALL_X, z: -9.2,             facing: LEFT },
  { id: 'rock',       label: 'ROCK',                          kind: 'genre',    x: -WALL_X, z: -9.2 - PITCH,     facing: LEFT },
  { id: 'alt',        label: 'ALTERNATIVE / INDIE',           kind: 'genre',    x: -WALL_X, z: -9.2 - 2 * PITCH, facing: LEFT },
  // The island: dug from the left aisle …
  { id: 'punk',       label: 'PUNK',                          kind: 'genre',    x: -ISLAND_X, z: -11.0,          facing: RIGHT },
  { id: 'grunge',     label: 'GRUNGE',                        kind: 'genre',    x: -ISLAND_X, z: -11.0 - PITCH,  facing: RIGHT },
  // … and from the right aisle.
  { id: 'rap',        label: 'RAP / HIP-HOP',                 kind: 'genre',    x: ISLAND_X,  z: -11.0,          facing: LEFT },
  { id: 'electronic', label: 'ELECTRONIC / DANCE',            kind: 'genre',    x: ISLAND_X,  z: -11.0 - PITCH,  facing: LEFT },
  // Right wall, behind the listening deck, toward the counter.
  { id: 'soul',       label: 'SOUL / FUNK / R&B',             kind: 'genre',    x: WALL_X, z: -13.0,             facing: RIGHT },
  { id: 'pop',        label: 'POP / NEW WAVE',                kind: 'genre',    x: WALL_X, z: -13.0 - PITCH,     facing: RIGHT },
  { id: 'other',      label: 'JAZZ · WORLD · METAL · COUNTRY', kind: 'mixed',    x: WALL_X, z: -13.0 - 2 * PITCH, facing: RIGHT },
]

/** A point given in a bin's own frame (x across the rail, z out through
 *  the rail) in world space. */
export function binToWorld(def: BinDef, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(def.facing)
  const s = Math.sin(def.facing)
  return { x: def.x + lx * c + lz * s, z: def.z - lx * s + lz * c }
}

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
