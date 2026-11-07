/**
 * The concert poster rule, for both apps (Jake, 2026-11-06, approved in the
 * Posters mock). The words, the frame and the matte live here so a tile, a page
 * and the poster maker cannot disagree. Pure: nothing here reads a file.
 *
 *  - One image per show, on every surface, in one frame of 961:1292.
 *  - Whole, never cropped. What the image leaves over gets a matte from the
 *    poster's own edge colour. Nothing is drawn on top of it.
 *  - What counts as a poster, in order: Jake's pick, always; a gig poster naming
 *    that venue and date; the film one-sheet if the recording is that film;
 *    otherwise a built poster.
 *  - A built poster is one flat JPEG, made once, from the cover whole plus the
 *    band, the show, the city and the year, and one orange rule. No AI art and
 *    no invented words.
 *  - A poster sits under its own artwork key, never the album's. A poster drop
 *    used to overwrite the album's cover, which is why Unplugged and Stop Making
 *    Sense showed a cropped poster on the Albums tab.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/liveSetMeta.ts carries poster,
 * posterSource and posterMatte to the phone. The phone draws the same frame.
 */
import { posterVenue, posterYear } from './artist-page.ts'

export const POSTER_FRAME_W = 961
export const POSTER_FRAME_H = 1292
/** For CSS: `aspect-ratio: 961 / 1292`. */
export const POSTER_ASPECT = `${POSTER_FRAME_W} / ${POSTER_FRAME_H}`

/** A built poster's ground, and the matte of a show with no poster yet. */
export const POSTER_GROUND = '#0B0B0A'
/** The logo orange: the built poster's one rule. */
export const POSTER_RULE = '#FD5601'

export const POSTER_SOURCES = ['jake-pick', 'gig-poster', 'film-one-sheet', 'built'] as const
export type PosterSource = (typeof POSTER_SOURCES)[number]
export function isPosterSource(v: unknown): v is PosterSource {
  return typeof v === 'string' && (POSTER_SOURCES as readonly string[]).includes(v)
}

/** The "artist" half of every poster key. No real artist has this name. */
export const POSTER_KEY_ARTIST = 'concert poster'

/**
 * A show's own artwork key: `concert poster|||<band> · <show>`. Every other
 * artwork key has exactly one `|||`, and code across the app splits on it, so
 * the album key's own separator is replaced rather than nested.
 */
export function posterArtworkParts(albumKey: string): { artist: string; album: string } {
  return { artist: POSTER_KEY_ARTIST, album: albumKey.toLowerCase().trim().replace('|||', ' · ') }
}
export function posterArtworkKey(albumKey: string): string {
  const { artist, album } = posterArtworkParts(albumKey)
  return `${artist}|||${album}`
}

/**
 * The artwork key of the merged recording's row: V3 files it under
 * "<show> (Live Set)". It points at the poster, so anything that draws the row
 * draws the show's one image.
 */
export function mergedAlbumArtworkKey(albumKey: string): string {
  return `${albumKey.toLowerCase().trim()} (live set)`
}
/** The other way: which show a "(live set)" key belongs to, or null. */
export function showKeyOfMergedAlbumKey(key: string): string | null {
  return key.endsWith(' (live set)') ? key.slice(0, -' (live set)'.length) : null
}

export function isMatteColour(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
}

/** The frame's background for a show: its poster's edge colour, else the ground. */
export function posterMatte(concert: { posterMatte?: string } | null | undefined): string {
  return isMatteColour(concert?.posterMatte) ? concert!.posterMatte! : POSTER_GROUND
}

/**
 * A poster's own edge colour: the per-channel median of the outermost `band`
 * pixels on all four sides. A median, so a signature or a white tack in a corner
 * cannot tint the whole matte; and all four sides, so the Geese poster's black
 * top strip loses to its yellow on the other three.
 *
 * `rgb` is packed 8-bit RGB, `width × height` pixels.
 */
export function edgeMatte(rgb: Uint8Array, width: number, height: number, band = 2): string {
  const expected = width * height * 3
  if (width <= 0 || height <= 0 || rgb.length < expected) throw new Error(`edgeMatte: ${rgb.length} bytes is not ${width}x${height} RGB`)
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(width, height) / 2) || 1))
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let count = 0
  const take = (x: number, y: number): void => {
    const i = (y * width + x) * 3
    bins[0]![rgb[i]!]!++
    bins[1]![rgb[i + 1]!]!++
    bins[2]![rgb[i + 2]!]!++
    count++
  }
  for (let y = 0; y < height; y++) {
    const edgeRow = y < b || y >= height - b
    for (let x = 0; x < width; x++) {
      if (edgeRow || x < b || x >= width - b) take(x, y)
    }
  }
  const median = (h: Uint32Array): number => {
    let seen = 0
    for (let v = 0; v < 256; v++) {
      seen += h[v]!
      if (seen * 2 >= count) return v
    }
    return 255
  }
  const hex = (v: number): string => v.toString(16).padStart(2, '0')
  return `#${hex(median(bins[0]!))}${hex(median(bins[1]!))}${hex(median(bins[2]!))}`
}

// ── The built poster's words ────────────────────────────────────────────

export interface PosterFacts {
  band: string
  /** The show's name: the source album's title. */
  show: string
  venue?: string
  city?: string
  /** The show's date as the concert page prints it. */
  date?: string
  /** Release year: used only when the date names no year. */
  year?: number | string
}

export interface PosterWords {
  band: string
  /** The show's title, with any "(Live …)" or "[Live]" tag taken off. */
  title: string
  /** What follows the title, in print order: venue (when the title lacks it), city, year. */
  details: string[]
}

/** "Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)" → "Getting Killed Again". */
export function posterTitle(show: string): string {
  const cleaned = show
    .replace(/\s*\(Live Set\)\s*$/i, '')
    .replace(/\s*[[(]Live\b[^\])]*[\])]\s*$/i, '')
    .trim()
  return cleaned || show.trim()
}

const NOT_THE_NAME = new Set(['the', 'of', 'at', 'in', 'a', 'an', 'and', 'on', 'hall', 'stadium', 'arena', 'theatre', 'theater', 'club', 'studio', 'studios', 'recording', 'center', 'centre', 'field', 'garden', 'coliseum'])

const nameWords = (s: string): string[] =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * Does the title already name the venue? "Live at Carnegie Hall" names Carnegie
 * Hall, and "Alive in the Catacombs" names The Catacombs of Paris once its city
 * is set aside. Generic words like "Hall" do not count as a name on their own.
 */
export function titleNamesVenue(title: string, venue?: string, city?: string): boolean {
  if (!venue) return false
  const inTitle = new Set(nameWords(title))
  const inCity = new Set(nameWords(city ?? ''))
  const distinctive = nameWords(venue).filter((w) => !NOT_THE_NAME.has(w) && !inCity.has(w))
  return distinctive.length > 0 && distinctive.every((w) => inTitle.has(w))
}

/** Only grounded words: nothing here is ever made up, so a missing fact just leaves the line shorter. */
export function posterWords(f: PosterFacts): PosterWords {
  const title = posterTitle(f.show)
  const venue = posterVenue(f.venue)
  const when = posterYear(f.date) || (Number(f.year) > 0 ? String(f.year) : '')
  const details = [titleNamesVenue(title, venue, f.city) ? '' : venue, f.city ?? '', when].filter(Boolean)
  return { band: f.band.trim(), title, details }
}

// ── The built poster's layout ───────────────────────────────────────────
// The Posters mock draws it at 170 wide. The JPEG is the same drawing at 961.

export interface BuiltPosterSpec {
  w: number
  h: number
  ground: string
  /** JPEG quality, 0–1. */
  quality: number
  pad: { top: number; right: number; bottom: number; left: number }
  band: { text: string; font: string; size: number; lineHeight: number; minSize: number; color: string }
  /** Between the band's name and the cover. */
  coverGap: number
  rule: { w: number; h: number; gap: number; color: string }
  lines: { title: string; details: string[]; size: number; lineHeight: number; tracking: number; color: string; gap: number }
}

const k = POSTER_FRAME_W / 170
const at = (mockPx: number): number => Math.round(mockPx * k)

export function builtPosterSpec(words: PosterWords): BuiltPosterSpec {
  const upper = (s: string): string => s.toLocaleUpperCase('en-US')
  return {
    w: POSTER_FRAME_W,
    h: POSTER_FRAME_H,
    ground: POSTER_GROUND,
    quality: 0.92,
    pad: { top: at(11), right: at(12), bottom: at(10), left: at(12) },
    band: { text: upper(words.band), font: 'pixChicago', size: at(16), lineHeight: at(19), minSize: at(8), color: '#FFFFFF' },
    coverGap: at(7),
    rule: { w: at(22), h: at(2), gap: at(8), color: POSTER_RULE },
    lines: {
      title: upper(words.title),
      details: words.details.map(upper),
      size: at(8),
      lineHeight: at(11),
      // The mock's 0.05em is on SF at 8 px, whose small-size cut is already loose. At 45 px
      // the system font is the tight display cut, so this much prints the same line width.
      tracking: Math.round(0.118 * at(8) * 100) / 100,
      color: '#E9E5DF',
      gap: at(5),
    },
  }
}
