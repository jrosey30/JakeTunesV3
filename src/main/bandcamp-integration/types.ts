// ════════════════════════════════════════════════════════════════════════
//  Bandcamp Store integration — shared data contracts (Brief 036 v2.2)
//  Main-process only. The renderer receives plain-serialized copies of
//  these over IPC; keep every field JSON-serializable (no Set/Map on the
//  wire — see UnifiedProfile note).
// ════════════════════════════════════════════════════════════════════════

/** A single track row as parsed from a Bandcamp `data-tralbum` blob. */
export interface StoreTrack {
  num: number
  title: string
  durationSec: number
  /** 30s preview stream URL (mp3-128), when Bandcamp exposes one. */
  previewUrl?: string
  /** Canonical track page URL, when present. */
  trackUrl?: string
}

/** An album/release as presented in the Store UI. */
export interface StoreAlbum {
  /** Bandcamp tralbum id (stable per release). */
  id: number
  url: string
  title: string
  artist: string
  artistUrl?: string
  tags: string[]
  label?: string
  /** Free-text artist location ("Cardiff, UK"), Bandcamp-only. */
  geo?: string
  /** ISO date string when known. */
  releaseDate?: string
  /** Bandcamp art id → build cover URLs via coverArtUrl(). */
  coverArtId?: number
  /** Pre-built CDN image URL (set by search normalizer where Bandcamp's
   *  autocomplete endpoint hands back a complete URL). Renderer prefers
   *  this over coverArtId-built URLs when present. */
  imageUrl?: string
  tracks: StoreTrack[]
  price?: number
  currency?: string
  isPurchasable: boolean
  /** Marked true by overlap-detection against Jake's library. */
  owned: boolean
}

/** One item in Jake's Bandcamp collection / wishlist. */
export interface BcItem {
  /** tralbum id when resolvable. */
  id?: number
  artist: string
  title: string
  url?: string
  tags: string[]
  label?: string
  geo?: string
  /** ISO date string when known. */
  releaseDate?: string
}

/** A Bandcamp band/label Jake follows. */
export interface BcFollow {
  name: string
  url?: string
  /** 'band' | 'label' when Bandcamp distinguishes; else undefined. */
  kind?: 'band' | 'label'
}

/** Raw scraped Bandcamp profile, persisted at userData/bandcamp-profile.json. */
export interface BandcampProfile {
  fanId: number
  username?: string
  fetchedAt: number
  collection: BcItem[]
  wishlist: BcItem[]
  following: BcFollow[]
}

/** A scored term (tag/label/place/decade). */
export interface ScoredTerm {
  term: string
  score: number
}

/** Per-artist depth-of-interest, engagement-weighted. */
export interface ArtistStaple {
  artist: string
  /** 0..1 normalized staple score (see ranking.stapleScore). */
  staple: number
  ownedAlbumCount: number
}

/**
 * Merged taste profile. Serialized form uses arrays everywhere (no Set) so
 * it survives the IPC boundary and JSON cache. Lookups rebuild Sets on the
 * consuming side where needed.
 */
export interface UnifiedProfile {
  computedAt: number
  topTags: ScoredTerm[]
  labelAffinity: ScoredTerm[]
  geoClusters: ScoredTerm[]
  decade: ScoredTerm[]
  followedArtists: string[]
  artistStaples: ArtistStaple[]
  /** audioFingerprint values present in the library. */
  ownedFingerprints: string[]
  /** normalized "artist|album" keys present in the library. */
  ownedArtistAlbum: string[]
  /** which sources contributed (cold-start UI). */
  sources: { library: boolean; bandcamp: boolean }
}

/** Normalized library row used for signal computation. */
export interface LibraryRow {
  id: number
  artist: string
  albumArtist: string
  album: string
  title: string
  genre: string
  year: number | null
  playCount: number
  rating: number | null
  lastPlayedAt: number | null
  skipCount: number
  audioFingerprint?: string
}

export type Tier1Surface = 'featured-for-you' | 'your-new-picks' | 'search-rerank'

/**
 * Discriminated union for Bandcamp catalog search results (Brief 036 v3
 * Decision 1). Artists and releases share the search surface but render
 * to distinct detail views (ArtistDetailView vs ReleaseDetailView). Code
 * that branches on result kind uses `if (r.kind === 'artist')`, not duck
 * typing on field presence.
 *
 * Image URLs are the absolute CDN URLs Bandcamp's autocomplete endpoint
 * emits (`https://f4.bcbits.com/img/…`); the renderer uses them directly.
 */
export type BandcampSearchResult =
  | { kind: 'artist'; name: string; bandUrl: string; imageUrl?: string }
  | {
      kind: 'release'
      title: string
      artist: string
      artistUrl: string
      releaseUrl: string
      imageUrl?: string
      releaseDate?: string
      priceCents?: number
      currency?: string
    }
