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
  /** Seconds, when the clicked row knew its runtime; 0 = unknown, and a clean
   *  row's is unknown (exact-recording.ts requestedLength). */
  durationSec: number
  /** ± seconds. Tight for the exact pressing; wide when we deliberately
   *  searched for the SONG rather than that pressing (remaster, masked title). */
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
  /** Other names MusicBrainz knows the artist by, when the store filed the song
   *  under one ("The Beat" for The English Beat). Compared whole. */
  artistAliases?: string[]
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
  /** Absent on a clean row: a censored edit's length says nothing about the
   *  explicit cut (album-identity.ts buildRequestedAlbum). */
  durationSec?: number
  explicitness?: string
}

export interface RequestedAlbum {
  artist: string
  /** RequestedRecording.artistAliases: Qobuz files the albums under that name too. */
  artistAliases?: string[]
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
