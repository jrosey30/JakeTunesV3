// JakeTunes Mobile — type definitions.
//
// ⚠️ TWIN: src/renderer/types.ts (desktop). The desktop app is the
// authoritative source for the Track/Playlist data model. The mobile
// app is a read-only client (Phase 0) and consumes a subset of the
// desktop fields. When the desktop type changes:
//   1. Add the field to the desktop interface
//   2. If mobile needs to display or filter on it, add it here
//   3. Document the divergence in mobile/README.md
//
// Do NOT add mobile-only mutations to Track here. Mobile mutations go
// in MobileTrackOverrides so the round-trip back to the desktop
// library is unambiguous.

export interface Track {
  id: number
  title: string
  // path is server-side: a Synology NAS path the desktop wrote into
  // library.json. The mobile app NEVER opens this directly — it
  // resolves to a stream URL via services/nas/streamUrl.ts.
  path: string
  album: string
  artist: string
  albumArtist: string
  genre: string
  year: number | string
  // ⚠️ Unit: MILLISECONDS. Set by src/main/index.ts (durationMs).
  // See mobile/README.md "Unit contracts" before reading this in any
  // component. Mobile twin must stay in sync with the desktop type.
  duration: number
  dateAdded: string
  playCount: number
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  fileSize: number
  rating: number
  audioFingerprint?: string
  // Desktop-only signals retained for parity but unused on mobile in Phase 0.
  audioMissing?: boolean
  lastPlayedAt?: number
  skipCount?: number
  bpm?: number
  keyRoot?: string
  keyMode?: 'major' | 'minor'
  camelotKey?: string
  audioAnalysisAt?: number
}

export interface Playlist {
  id: string
  name: string
  trackIds: number[]
  commentary?: string
}

// Mobile-only mutations the user makes on the device. Synced back to
// the desktop library on the next NAS write window.
//
// ⚠️ Identity rule (per docs/postmortems/2026-04-25-verify-repair-cascade):
// reconciliation MUST gate on identity, not on `trackId` alone.
// Track.id is reassigned on re-import — a play count queued for
// id=4709 ("Another Brick in the Wall, Part 1") would silently apply
// to a totally different song if the user re-imported the album
// between mobile-play and desktop-merge.
//
// The desktop merge MUST verify `audioFingerprint` matches the
// current track at id=trackId before applying the override. If the
// fingerprint doesn't match, the override is stale and discarded
// (logged, not silently dropped — see Phase 1 desktop merge code).
//
// `audioFingerprint` is captured from the Track at queue time. If the
// snapshot doesn't carry one (older desktop builds), the override is
// recorded but applied conservatively: the desktop falls back to
// (title, artist, album, duration) — and if that ambiguity bites,
// the override is dropped, never force-merged.
export interface MobileTrackOverrides {
  trackId: number
  // Identity at queue time. SHA-1 + duration; matches the desktop's
  // computeAudioFingerprint contract.
  audioFingerprint?: string
  // Set on natural completion (TrackPlayer 'PlaybackQueueEnded' or
  // explicit end-of-track). Skip-ended plays are counted in skipDelta
  // instead, mirroring the desktop's lastPlayedAt vs skipCount split.
  playCountDelta?: number
  lastPlayedAt?: number
  skipCountDelta?: number
  rating?: number
  // Epoch ms of when this override was queued on the device. The
  // desktop merge uses this to break ties when the same track was
  // played on both desktop and mobile in the same sync window.
  queuedAt: number
}

// ─────────────────────────────────────────────────────────────────────
// NAS connection
// ─────────────────────────────────────────────────────────────────────

// Synology DS224 will run DSM (DiskStation Manager). The mobile app
// connects via one of these transports, in priority order:
//   1. Audio Station HTTP API (best metadata + streaming, requires
//      Audio Station package installed)
//   2. WebDAV (universal, requires WebDAV Server package)
//   3. SMB (only over local Wi-Fi; not used for streaming)
//
// Phase 0 scaffolds (1) and (2) and defers (3).
export type NasTransport = 'synology-audio-station' | 'webdav' | 'auto'

export interface NasConnectionConfig {
  // The host as the user enters it: "synology.local", "192.168.1.42",
  // or a QuickConnect ID. The Synology client normalizes to a URL.
  host: string
  port?: number          // default 5000 (DSM HTTP) / 5001 (HTTPS)
  https: boolean
  username: string
  // Stored in iOS Keychain via react-native-keychain (NOT AsyncStorage).
  // The presence of this field on a serialized config means it has
  // been migrated to keychain — the value itself is read from
  // services/secureStore on use.
  hasStoredCredential: boolean
  transport: NasTransport
  // Path on the NAS where the desktop app writes library.json.
  // Default matches the desktop's planned export location:
  //   /music/.jaketunes/library.json
  libraryJsonPath: string
  // Path prefix on the NAS that the desktop's track paths share.
  // The mobile stream-URL builder strips this prefix and appends the
  // remainder to the transport's stream endpoint.
  libraryRootPath: string
}

export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; serverInfo: { dsmVersion?: string; hostname?: string } }
  | { status: 'error'; message: string }

// ─────────────────────────────────────────────────────────────────────
// Mobile app settings (subset of desktop AppSettings, stored locally)
// ─────────────────────────────────────────────────────────────────────

export interface MobileSettings {
  playback: {
    // Volume normalization; desktop has crossfade — mobile defers
    // crossfade to a later phase because TrackPlayer's crossfade
    // model differs.
    gaplessOnly: boolean
  }
  network: {
    // When false, streaming is blocked unless on Wi-Fi. Default true
    // so first-time users on cellular can still test.
    streamOverCellular: boolean
    // When true, library.json is refreshed on app foreground if the
    // last refresh is older than refreshIntervalMinutes.
    autoRefreshLibrary: boolean
    refreshIntervalMinutes: number
  }
  cache: {
    // MB. When the on-device audio cache exceeds this, oldest tracks
    // are evicted by lastPlayedAt. 0 = no cache (always stream).
    audioCacheMaxMB: number
  }
}

export const DEFAULT_MOBILE_SETTINGS: MobileSettings = {
  playback: { gaplessOnly: true },
  network: {
    streamOverCellular: true,
    autoRefreshLibrary: true,
    refreshIntervalMinutes: 30,
  },
  cache: { audioCacheMaxMB: 1024 },
}

// ─────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────

export type RootTabParamList = {
  Songs: undefined
  Albums: undefined
  Artists: undefined
  Playlists: undefined
  Settings: undefined
}

export type RootStackParamList = {
  Tabs: undefined
  Album: { albumKey: string }
  Artist: { artistName: string }
  Playlist: { playlistId: string }
  NowPlaying: undefined
  Connection: undefined
}

// ─────────────────────────────────────────────────────────────────────
// Sort / filter (mirrors desktop)
// ─────────────────────────────────────────────────────────────────────

export type SortColumn =
  | 'title' | 'artist' | 'album' | 'genre' | 'year'
  | 'dateAdded' | 'playCount' | 'rating'
export type SortDirection = 'asc' | 'desc'
export type RepeatMode = 'off' | 'all' | 'one'

// ─────────────────────────────────────────────────────────────────────
// Library snapshot — what the desktop writes to NAS at library.json
// ─────────────────────────────────────────────────────────────────────

// ⚠️ TWIN: src/main/library-snapshot.ts (producer). Both sides
// must agree on this shape. When the desktop bumps the version
// constant below, update the mobile reader (services/nas/libraryFetcher.ts)
// in the same commit. Never silently re-purpose a field — see the
// 0x64 mediaKind incident in
// docs/postmortems/2026-04-26-ipod-songcount-counter.md for what
// happens when a writer treats a field as A and a reader treats it as B.
export interface LibrarySnapshot {
  // Schema version. Bumped when the desktop side changes the snapshot
  // shape. Mobile refuses to load snapshots with a version it doesn't
  // recognize and surfaces a "desktop and mobile are out of sync"
  // banner instead of crashing.
  version: number
  exportedAt: string  // ISO timestamp
  tracks: Track[]
  playlists: Playlist[]
  // Hint from the desktop about where it expects mobile to find the
  // music share. Empty string = "use whatever the user configured on
  // the mobile side." Currently always empty (Phase 0); reserved for
  // a future preference that lets the desktop pre-populate this.
  libraryRootPath: string
}

// ⚠️ Must equal LIBRARY_SNAPSHOT_VERSION in src/main/library-snapshot.ts.
// Bump on both sides in the same commit; update the mobile reader
// to handle the new shape before shipping the desktop change.
export const LIBRARY_SNAPSHOT_VERSION = 1
