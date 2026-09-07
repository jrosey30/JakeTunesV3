/** Shared identity DTOs. Matching/building stays in main/exact-recording.ts
 * and main/album-identity.ts; their public type exports remain compatible.
 * No Electron, renderer, filesystem, or matching dependencies here. */

export type Provider = 'qobuz' | 'bandcamp' | 'soundcloud'

export interface RequestedRecording {
  /** As displayed by the source Jake clicked (iTunes / Deezer / a card). */
  artist: string
  title: string
  album: string
  /** Normalised forms, for logs and equality. */
  artistNorm: string
  titleNorm: string
  /** Seconds, when the clicked row knew its runtime; 0 = unknown. */
  durationSec: number
  /** ± seconds. Tight for the exact pressing; wide when we deliberately
   *  searched for the SONG rather than that pressing (censored/remaster). */
  durationTolSec: number
  releaseYear?: number
  /** What was ASKED for. 'clean' only when a clean record was deliberately
   *  requested (`cleanRequested`) — an Apple listing that merely happened to
   *  be the cleaned edition (`cleanedSource`) is NOT a request for
   *  censorship: the ladder's explicit-first rule (Jake, 2026-09-04: "why do
   *  these clean versions keep appearing???") still prefers the explicit
   *  master there, so it stays 'unknown' for the judge. */
  explicit: 'explicit' | 'clean' | 'unknown'
  /** Version markers Jake asked for by name ("(Live)", "(Acoustic)"). Empty =
   *  the ordinary studio recording was requested. */
  requestedMarkers: string[]
  /** Provider ids that travelled with the pick, when any did. */
  providerIds: { itunesTrackId?: number; isrc?: string }
}

/** A rejected or unverifiable candidate and its reason, for result details. */
export interface AlternativeTrack { title: string; trackNumber?: number; discNumber?: number; durationSec?: number | null }
/** A judged-and-refused edition or recording. `tracks`/`url` ride along when
 *  the judge had them (Compare editions needs the full list, not the first
 *  mismatch). */
export interface Alternative { provider: Provider; desc: string; reason: string; tracks?: AlternativeTrack[]; trackCount?: number; url?: string }

export type DownloadOutcome =
  | 'imported'
  | 'exact-not-found'        // sources answered; nothing was the exact recording
  | 'not-found'              // no source had anything resembling it
  | 'unverifiable'           // a file arrived that could not be judged; not imported
  | 'provider-failed'        // a match was found, the rip/transfer itself died — try again
  | 'provider-unavailable'   // a service could not even be asked (auth, tool, network)
  | 'canceled'
  | 'not-released'

export interface RequestedAlbumTrack {
  title: string
  trackNumber?: number
  discNumber?: number
  durationSec?: number
  explicitness?: string
}

export interface RequestedAlbum {
  artist: string
  /** As clicked ("Drums and Wires (Bonus Track Version)"). */
  title: string
  /** Packaging stripped, version markers kept ("Drums and Wires"). */
  baseTitle: string
  /** Packaging words on the request: bonus, deluxe, anniversary, expanded… */
  packaging: string[]
  /** Recording-changing markers Jake asked for by name: live, remix… */
  versionMarkers: string[]
  trackCount?: number
  discCount?: number
  /** Ordered as the catalogue lists them; may be empty when the lookup failed. */
  tracks: RequestedAlbumTrack[]
  releaseYear?: number
  explicit: 'explicit' | 'clean' | 'unknown'
  providerIds: { itunesCollectionId?: number; upc?: string }
}
