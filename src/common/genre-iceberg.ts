/**
 * The Genre Iceberg (2026-10-11, v3). Jake: "this ice berg was supposed to be
 * genre led, and artist secondary" — and "the tip should group the rock
 * together… grunge should be under rock". So: seven umbrellas on the tip,
 * each one's subgenres sinking beneath it by how known they are; click a
 * genre for his artists in it. Which artists are in a genre is each song's
 * CURRENT tag; how deep a genre sits is the table below.
 *
 * DEPTH (approved by Jake 10/11, "that is better"): a genre's score =
 *   0.50 × how known its biggest artists are (ListenBrainz listeners, top 3
 *          of his artists in it — the music itself)
 *   0.25 × how much music carries the label (MusicBrainz release groups)
 *   0.25 × how often people look it up (English Wikipedia, monthly views)
 * Coined names (Midwest Rap…) use the first part only — the label measures
 * can't see them. Ranked, then cut into four bands under the tip. No single
 * measure worked alone: Deezer fans buried Television; MusicBrainz raised
 * Experimental; Wikipedia put Shoegaze level with Rock.
 * Pure; the view feeds it library tracks.
 */
import { GENRES } from './genre-vocab.ts'

export const DEPTHS = ['The tip', 'Just below', 'Below', 'Deep water', 'Abyss'] as const

/** The seven umbrellas on the tip, and the genre-vocab families under each. */
export const UMBRELLAS: ReadonlyArray<{ name: string; families: string[]; shelf?: string }> = [
  { name: 'Rock', families: ['Rock', 'Punk', 'Metal'], shelf: 'Rock' },
  { name: 'Pop', families: ['Pop', 'New Wave & Synth'], shelf: 'Pop' },
  { name: 'Hip-Hop', families: ['Hip-Hop'] },
  { name: 'Electronic', families: ['Electronic & Dance'] },
  { name: 'R&B & Soul', families: ['R&B, Soul & Funk'], shelf: 'R&B' },
  { name: 'Country & Folk', families: ['Country, Folk & Blues'] },
  { name: 'Jazz & Global', families: ['Jazz, Brazil, Latin & Global'] },
]
// Soundtrack, Comedy, Children's, Video Game Music ("Other") stay off the berg.

/** How far under the tip each genre sits (1 = just below … 4 = abyss). */
export const GENRE_DEPTH: Readonly<Record<string, 1 | 2 | 3 | 4>> = {
  // Just below
  "Alternative": 1, "Blues Rock": 1, "Classic Rock": 1, "Country": 1, "East Coast Rap": 1, "Funk": 1,
  "Garage Rock": 1, "Grunge": 1, "Hard Rock": 1, "Heavy Metal": 1, "House": 1, "Indie Pop": 1, "Indie Rock": 1,
  "Jazz": 1, "Midwest Rap": 1, "New Wave": 1, "Nu-Metal": 1, "Pop-Punk": 1, "Post-Punk": 1, "Prog Rock": 1,
  "Psychedelic Rock": 1, "Punk": 1, "Southern Rap": 1, "Synth-Pop": 1, "Trip Hop": 1, "West Coast Rap": 1,
  // Below
  "Alternative Hip-Hop": 2, "Ambient": 2, "Art Pop": 2, "Big Beat": 2, "Blues": 2, "Classic Soul": 2,
  "Club Rap": 2, "College Rock": 2, "Conscious Rap": 2, "Dance-Pop": 2, "Disco": 2, "Downtempo": 2,
  "Dream Pop": 2, "EDM": 2, "Easy Listening": 2, "Electroclash": 2, "Folk": 2, "French Electro": 2,
  "Funk Rock": 2, "Glam Rock": 2, "Hardcore Punk": 2, "Melodic Rap": 2, "Modern Soul": 2, "Motown": 2,
  "Power Pop": 2, "Reggae": 2, "Shoegaze": 2, "Singer-Songwriter": 2, "Southern Rock": 2, "Stoner Rock": 2,
  "Techno": 2, "Thrash Metal": 2, "Trance": 2, "Trap": 2,
  // Deep water
  "Acid House": 3, "Alternative Dance": 3, "Alternative R&B": 3, "Americana Rock": 3, "Bossa Nova": 3,
  "Breakbeat": 3, "Chillwave": 3, "Cloud Rap": 3, "Dance-Punk": 3, "Dancehall": 3, "Deep House": 3,
  "Drum & Bass": 3, "Electro House": 3, "Eurodance": 3, "Experimental": 3, "French House": 3,
  "Groove Metal": 3, "Hyperpop": 3, "Indie Sleaze": 3, "Indietronica": 3, "Instrumental Hip-Hop": 3,
  "Jazz Fusion": 3, "Jazz Rap": 3, "Latin": 3, "Latin Pop": 3, "Math Rock": 3, "Neo-Soul": 3,
  "Psychedelic Pop": 3, "Rap Rock": 3, "Ska-Punk": 3, "Space Rock": 3, "Traditional Pop": 3, "UK Garage": 3,
  "Yacht Rock": 3,
  // Abyss
  "Geordie Jazz": 4,   // one Newcastle scene: no tag, no article, no listeners to speak of — the abyss
  "Afrobeat": 4, "Ambient House": 4, "Bedroom Pop": 4, "Brazilian Boogie": 4, "Chicago House": 4,
  "Darkwave": 4, "Disco House": 4, "Dub-Hop": 4, "Electro Swing": 4, "Future Funk": 4, "Garage Punk": 4,
  "Global Psych": 4, "Indie Groove": 4, "Israeli Hip-Hop": 4, "Italo Disco": 4, "Jangle Pop": 4, "Jazz Pop": 4,
  "Latin House": 4, "Latin Jazz": 4, "Latin Rock": 4, "MPB": 4, "Nu Disco": 4, "Nu Funk": 4, "Nu Jazz": 4,
  "Old School Hip-Hop": 4, "Plunderphonics": 4, "Tech House": 4,
}

const FAMILY = new Map(GENRES.map((g) => [g.name, g.area]))
const umbrellaOf = (genre: string): typeof UMBRELLAS[number] | undefined => {
  const fam = FAMILY.get(genre)
  return UMBRELLAS.find((u) => u.families.includes(fam ?? ''))
}

export interface BergUmbrella { name: string; shelf?: string; layers: Record<1 | 2 | 3 | 4, string[]> }

/** The berg for the genres he actually has songs in. A genre the table
 *  doesn't know yet (a new one on his list) sits in "Below" until placed. */
export function bergLayout(present: Map<string, number>): BergUmbrella[] {
  return UMBRELLAS.map((u) => {
    const layers: BergUmbrella['layers'] = { 1: [], 2: [], 3: [], 4: [] }
    for (const [g, songs] of present) {
      if (!songs || g === u.shelf || umbrellaOf(g)?.name !== u.name) continue
      layers[GENRE_DEPTH[g] ?? 2].push(g)
    }
    for (const k of [1, 2, 3, 4] as const) layers[k].sort((a, b) => (present.get(b) ?? 0) - (present.get(a) ?? 0) || a.localeCompare(b))
    return { name: u.name, shelf: u.shelf && present.get(u.shelf) ? u.shelf : undefined, layers }
  })
}

/** A genre's layer on the berg, 0 (the tip) to 4 (the abyss); null when it
 *  isn't on the berg at all (Soundtrack, Comedy — no umbrella). Year in
 *  Review counts plays by this, so the two always agree. */
export function layerOf(genre: string | undefined): 0 | 1 | 2 | 3 | 4 | null {
  if (!genre) return null
  const u = umbrellaOf(genre)
  if (!u) return null
  return u.shelf === genre ? 0 : (GENRE_DEPTH[genre] ?? 2)
}

export function depthOf(genre: string): string {
  if (UMBRELLAS.some((u) => u.shelf === genre)) return DEPTHS[0]
  return DEPTHS[GENRE_DEPTH[genre] ?? 2]
}
export function umbrellaName(genre: string): string | undefined { return umbrellaOf(genre)?.name }

export interface IceTrack { artist?: string; contributingArtists?: string[]; genre?: string }

/** Songs per genre right now (current tags). */
export function genreCounts(tracks: IceTrack[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tracks) if (t.genre) m.set(t.genre, (m.get(t.genre) ?? 0) + 1)
  return m
}

/** His artists in a genre (or a whole umbrella) — one per artist identity
 *  (`canon`: aliases + feat. folded), best-known first when listener counts
 *  are known, then by how many songs of theirs are here. */
export function artistsIn(
  tracks: IceTrack[], genres: Set<string>, canon: (n: string) => string, listeners: Record<string, number | undefined>,
): Array<{ name: string; songs: number; listeners?: number }> {
  const m = new Map<string, number>()
  for (const t of tracks) {
    if (!t.genre || !genres.has(t.genre)) continue
    for (const a of new Set((t.contributingArtists?.length ? t.contributingArtists : [t.artist || '']).map((x) => canon(x || '')).filter(Boolean))) m.set(a, (m.get(a) ?? 0) + 1)
  }
  return [...m.entries()].map(([name, songs]) => ({ name, songs, listeners: listeners[name] }))
    .sort((a, b) => (b.listeners ?? -1) - (a.listeners ?? -1) || b.songs - a.songs || a.name.localeCompare(b.name))
}

/** Every genre under an umbrella (its own shelf included) — for clicking a peak. */
export function umbrellaGenres(name: string): Set<string> {
  const u = UMBRELLAS.find((x) => x.name === name)
  return new Set(GENRES.filter((g) => u?.families.includes(g.area)).map((g) => g.name))
}
