// Music Man's Record Store — type contracts (Brief 037 §5)
//
// These are the shapes that cross the IPC boundary (main ↔ renderer)
// and the disk-cache boundary. Keep this file dependency-free so it
// can be imported from either side without dragging Electron-only or
// renderer-only deps.

export type Persona = 'music-man' | 'megan' | 'stephen-hands'

export type DayTheme = {
  /** YYYY-MM-DD in local time. The cache key. */
  date: string
  /** Human-readable, displayed under the shop sign. ≤ ~80 chars. */
  theme: string
  /** 1-2 sentences, why this theme today. Drives MM's banter. */
  rationale: string
  /** Where the theme came from — informs the renderer if we want to
   *  badge a shelf with "from the show this Friday" vs "rediscover". */
  source: 'era' | 'scene' | 'throughline' | 'mood' | 'personal' | 'cultural'
  /** Present iff source === 'cultural'. The real-world anchor that
   *  sparked the theme — e.g. "Big Thief at Brooklyn Steel, Friday". */
  externalAnchor?: {
    kind: 'show' | 'release' | 'feature'
    label: string
    url?: string
  }
}

/** A single browsable card on a shelf. Stable `id` is critical for
 *  blurb caching (blurbs are keyed by (itemId, persona) forever). */
export type ShelfItem = {
  /** Stable across runs. Convention:
   *   library-album   → `lib:album:<albumId>`
   *   library-track   → `lib:track:<trackId>`
   *   external        → `ext:bc:<urlhash>`
   *   crate           → `crate:<uuid>` */
  id: string
  kind: 'library-album' | 'library-track' | 'external-release' | 'crate'
  coverUrl: string | null
  /** Album/track title or crate name. */
  title: string
  /** Artist, or "N tracks · MMm" for crates. */
  subtitle: string
  /** Shelf-level reason this item is on the wall today. 1 line. */
  placement: string
  /** Type-specific action data. The renderer dispatches based on `kind`. */
  payload: {
    albumId?: string
    trackIds?: string[]
    /** For external releases — Bandcamp deep link. v1 opens the
     *  existing BandcampStore view. */
    externalUrl?: string
  }
}

export type ShelfId = 'mm-picks' | 'new-arrivals' | 'deep-cuts' | 'megan-picks' | 'stephen-crate'

export type Shelf = {
  id: ShelfId
  /** `'house'` = the shop itself (e.g. New Arrivals). All else = a persona. */
  curator: Persona | 'house'
  /** Display title — "Music Man's Picks". */
  title: string
  /** 1 sentence in the curator's voice. */
  tagline: string
  items: ShelfItem[]
}

export type ShelfBundle = {
  /** YYYY-MM-DD local; the cache key for first-open-of-day regen. */
  date: string
  generatedAt: number
  /** ms epoch. Renderer treats `Date.now() > validUntil` as stale. */
  validUntil: number
  theme: DayTheme
  shelves: Shelf[]
  /** For the "served from yesterday" subtle pill in the corner of the
   *  shop sign when LLM was unreachable and we fell back to cache. */
  source: 'llm' | 'heuristic' | 'cached'
}

/** Lazy + cached forever per (itemId, persona) tuple. */
export type Blurb = {
  itemId: string
  persona: Persona
  /** 1-3 sentences, persona voice, references the user's listening
   *  relationship with the item where possible. */
  text: string
  generatedAt: number
  source: 'llm' | 'cached'
}
