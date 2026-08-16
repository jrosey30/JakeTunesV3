export interface Track {
  id: number
  title: string
  path: string
  album: string
  artist: string
  albumArtist: string
  genre: string
  year: number | string
  duration: number
  dateAdded: string
  playCount: number
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  fileSize: number
  rating: number
  // Brief 031 Phase 4: derived from `artist` and the approved
  // collab-split map. For sole-artist tracks: [artist]. For tracks
  // whose `artist` field is a collab string (e.g., "JAY-Z & Linkin
  // Park"): the array of contributing canonical artists (e.g.,
  // ["JAY-Z", "Linkin Park"]). Renderer (ArtistsView, GenresView,
  // SongsView's Artist Radio) filters tracks by
  // `contributingArtists.includes(X)` rather than `artist === X` so
  // a collab track surfaces on every contributing artist's page.
  // Optional in the type so legacy tracks from iPod sync or pre-
  // Brief-031 library.json files still typecheck — the fallback
  // pattern `(t.contributingArtists ?? [t.artist]).includes(X)`
  // makes the field defensive at every read site.
  contributingArtists?: string[]
  // 4.4.85: codec recorded at import time so the ipod-audio:// protocol
  // handler can skip the ~200-500 ms ffprobe call on every first-play.
  // Value is the AudioFormat the encoder produced ('aac-256', 'alac',
  // 'wav', etc.); protocol handler only branches on === 'alac' (cache
  // hit) vs anything else (serve raw). Legacy tracks (pre-this-fix)
  // have it undefined and fall through to the ffprobe path.
  codec?: string
  // Identity-based per-file fingerprint set at import time. Used by the
  // silent post-sync verifier (main/index.ts::verifyAndHealTracks) to
  // detect cross-linked paths without text matching.
  audioFingerprint?: string
  // Set by the verifier when the track's path resolves to nothing on
  // any known mount AND no other file with the same fingerprint can be
  // found. Recoverable by re-import; the entry is never deleted.
  audioMissing?: boolean
  // Background-only signals (4.0). Not surfaced in any UI. Persisted via
  // metadata-overrides.json so they survive across sessions. Consumed by
  // recommendation flows in main/index.ts.
  // Epoch ms of the most recent natural completion (onend). Skip-ended
  // plays do not update this.
  lastPlayedAt?: number
  // Count of times the user skipped this track within the first 30s.
  // Distinct from listenerProfile.artistSkips (artist-aggregate, 80% gate).
  skipCount?: number
  // Audio analysis enrichment (4.0 §2.4). Computed once per track via
  // core/audio_analysis.py (aubio + librosa). Not surfaced in any UI in
  // Phase 0 — consumed by Music Man v2, Auto-DJ, and (stretch) smart
  // playlists. Stored as overrides; analyze-once, persist forever.
  bpm?: number                                 // beats per minute, ~±1 BPM accuracy
  keyRoot?: string                             // pitch class: C, C#, D, ..., B
  keyMode?: 'major' | 'minor'                  // tonality
  camelotKey?: string                          // Camelot wheel position: "1A"-"12B"
  // Epoch ms of the last analysis attempt. Set on success AND failure so
  // we don't re-analyze every session. Re-tried after audioAnalysisRetryAfter
  // (see consumer) when audio_analysis.py rolls forward.
  audioAnalysisAt?: number
  // 4.5: user-set channel-mode tag. Background-only metadata — not
  // surfaced in the track title, song row, or playback engine. Lives
  // in Get Info as a dropdown (blank / 'mono' / 'stereo') so the
  // user can tag tracks for future categorization without affecting
  // playback. Persisted via metadata-overrides.json like the rest of
  // the user-editable fields.
  channelMode?: 'mono' | 'stereo' | ''
  // 4.5: AI taxonomy (additive, applied from metadata-overrides). subgenre = the
  // broad subgenre shown in the Song View column; subgenrePath = the full
  // general→specific path (hover tooltip); subgenreLean = the runner-up "web" link.
  subgenre?: string
  subgenrePath?: string
  subgenreLean?: string
  // 4.5: epoch-ms timestamp of the most recent star toggle ON. Drives
  // the Starred smart playlist's default sort (recent-first). Cleared
  // is OK — legacy starred tracks without this field sort to the
  // bottom (undefined → 0). Updated on every star action (per-cell
  // toggle, right-click bulk Star, Get Info checkbox).
  starredAt?: number
}

export interface Playlist {
  id: string
  name: string
  trackIds: number[]
  commentary?: string
  // Brief 121 — playlists synced from the iOS app. Renderer can use this
  // to badge or order them differently; absence = V3-owned.
  source?: 'mobile'
  // 2026-07-18 — saved activity syncs live in their own sidebar section
  // ("SYNCED SETS"), not among regular playlists.
  category?: 'synced-set'
}

// Mixtapes (2026-07-18) — a group of songs turned into a REAL cassette:
// C60/C90/C120, Music Man-sequenced Side A/B that fit the tape, J-card
// liner notes, and optionally Jake's own voice intro processed to sound
// like 1979. Stored main-side in mixtapes.json (not library.json).
export interface Mixtape {
  id: string
  title: string
  commentary: string
  dedication?: string
  // The tape in play order — THE field as of 2026-08-08 (no more sides,
  // 25 songs max). Always read it via tapeTracks() from common/tape-physics
  // so tapes recorded under the two-sided rules keep playing.
  tracks?: number[]
  // Legacy, two-sided era. Read for old tapes; never written anew.
  tapeLength: 60 | 90 | 120
  sideA: number[]
  sideB: number[]
  // Tape ran out mid-song: ms into the LAST song of that side where the
  // cassette ends. Playback stops the song right there (TapeMonitor).
  sideACutMs?: number
  sideBCutMs?: number
  linerNotes: Array<{ id: number; note: string }>
  introPath?: string
  // Voice recorded WITH the music (TALK button while REC armed) — plays
  // over the song at atMs into that side during tape playback.
  talkovers?: Array<{ side: 'A' | 'B'; atMs: number; path: string }>
  // REC pressed mid-song: that song recorded FROM this ms (sparse map,
  // keyed by track id as string). Playback seeks there; dub trims there.
  startOffsets?: Record<string, number>
  createdAt: string
  inkColor?: string
  // Season tape marker ('YYYY-MM') — Music Man's monthly auto-dub.
  seasonal?: string
}

export type ViewName = 'home' | 'songs' | 'artists' | 'artist-detail' | 'albums' | 'album-detail' | 'genres' | 'musicman' | 'playlist' | 'smart-playlist' | 'device' | 'cd-import' | 'store' | 'download' | 'scotus' | 'recordstore' |'listen-to-the-list' | 'new-for-you' | 'discovery' | 'mix-detail' | 'concerts' | 'concert-detail' | 'mixtape-detail' | 'dj'

// V5 Live Concert Mode — a declared album's merged "live set". Key'd by
// albumKey (artist|||album) in live-sets.json; the merged file is a REAL
// library track (mergedTrackId) so it plays on desktop + mobile alike.
// Cues are EXACT per-song offsets derived from PCM byte counts at merge
// time — the pill maps playhead position → current setlist song with them.
// ⚠️ TWIN: src/main/index.ts LiveSetEntry (the sidecar's writer-side type).
export interface LiveSetCue {
  trackId: number
  title: string
  artist: string
  startMs: number
  durationMs: number
}
export interface LiveSetEntry {
  mergedTrackId: number
  cues: LiveSetCue[]
  totalDurationMs: number
  createdAt: string
  // Constituent track ids the user has "reimported" back into the regular
  // library (right-click a setlist song → Add to Library). A declared concert
  // hides its merged track + all constituents from the regular library; a
  // promoted id is exempted so that one song shows as a normal track again.
  promotedTrackIds?: number[]
  // Concert-native metadata (the "poster universe"). Grounded from tags/user,
  // never fabricated. Optional + back-compat: older sidecar rows omit it.
  concert?: ConcertMeta
}
export interface ConcertMeta {
  venue?: string
  city?: string
  date?: string        // display string, e.g. "May 15–16, 1980"
  poster?: string      // artwork key/hash for the concert poster (portrait)
  // Companion panel (tour-book layer). All grounded or user-authored, never
  // fabricated. facts = short grounded blurbs; notes = the user's own memories;
  // source/label = recording lineage; merchUrl = a real store link.
  facts?: string[]
  notes?: string
  source?: string
  label?: string
  merchUrl?: string
}

// Brief 122 — a "Listen to the List" recommendation. User-authored "jot
// it down" entries, owned by the mobile backend (recommendations.json on
// the NAS, next to library.json) and mirrored to desktop. The optional
// matched* / *Url fields are filled by the backend's iTunes Search
// resolve at creation time (Brief 094); absent when no confident match.
// Metadata hierarchy Phase 2 — one AI classification of an artist tag.
export interface ArtistGroupProposal {
  tag: string
  type: 'persona' | 'collaboration' | 'standalone'
  canonical?: string
  contributors?: string[]
  why?: string
}

// Related-artists graph — a distinct artist linked to this one (associate,
// not merge): a band, its members, side projects, key collaborators.
export interface RelatedArtist {
  name: string
  relation: string // 'band' | 'member' | 'sideProject' | 'bandmate' | 'collaborator' | 'related'
}

export interface Recommendation {
  id: string
  song?: string
  artist?: string
  album?: string
  note?: string
  createdAt: string
  artworkUrl?: string
  appleMusicUrl?: string
  previewUrl?: string
  matchedTitle?: string
  matchedArtist?: string
  matchedAlbum?: string
  resolvedAt?: string
  // Who added it: 'user' = you jotted it; 'mm' = a Music Man suggestion you
  // accepted; 'radar' = added from New for You. Legacy rows have no source →
  // shown under "Your jots". Drives the Your List sections.
  source?: 'user' | 'mm' | 'radar'
  // Brief 126 — sync protocol v2: what the jot wants + stable external id
  // (archive.org concert item). Fulfillment fields land via the sweep.
  kind?: 'track' | 'album' | 'concert'
  externalId?: string
  owned?: boolean
  ownedAt?: string
  ownedVia?: string
  ownedDesc?: string
}

// Brief 126 — sync state the UI renders instead of silent empty lists.
export interface RecoSyncMeta {
  source: 'backend' | 'cache' | 'nas-fallback'
  backendReachable: boolean
  syncedAt: number | null
  pendingOps: number
}

// Brief 122 Phase 2 — an iTunes Search autocomplete suggestion for the
// "Listen to the List" add form.
/** ⚠️ TWIN: src/main/index.ts (ItunesSuggestion). Crosses IPC — a field added
 *  on one side only is silently dropped, never caught. Change both together. */
/** What the brain has learned, as reported by main/discovery-learned.ts. */
export interface DiscoveryLearned {
  discoverSignals: number
  accepts: number
  rejects: number
  totalSignals: number
  stripSignals: number
  lanes: Array<{ lane: string; accepts: number; rejects: number }>
  stoppedShowing: Array<{ artist: string; at: number }>
  confidence: 'none' | 'thin' | 'growing' | 'solid'
  headline: string
  learnedAt?: string
  daysCovered: number
}

export interface ItunesSuggestion {
  song: string
  artist: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  appleMusicUrl?: string
  /** Release year, and the collection's real track count — what lets the
   *  Download list say "EP · 2019" instead of a hardcoded "ALBUM" with no
   *  date (Jake, 2026-08-09). Absent when the source can't state it (the
   *  Deezer failover has no release date), and a blank beats a guess. */
  releaseYear?: number
  trackCount?: number
  /** iTunes' primaryGenreName — a third real fact for a release card. */
  genre?: string
  /** 'explicit' | 'cleaned' | 'notExplicit' — so a censored edition can say so
   *  BEFORE it is downloaded (Jake, 2026-08-09). */
  explicitness?: string
  /** iTunes album (collection) id — lets the Download view expand an album
   *  into its FULL tracklist via itunesAlbumTracks (2026-07-23). */
  collectionId?: number
  /** Track position within its album (from the album-tracks lookup). */
  trackNumber?: number
  /** Track length in seconds (from the album-tracks lookup). */
  durationSecs?: number
}
export type SmartPlaylistId = 'recently-added' | 'recently-played' | 'top-25' | 'top-rated' | 'youd-star' | 'musicman-picks' | 'megan-picks' | 'dj-hands-picks'

export interface ChatConversation {
  id: string
  title: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  createdAt: string
}

export interface MetadataIssue {
  type: 'misspelling' | 'inconsistent' | 'generic' | 'missing' | 'genre'
  trackIds: number[]
  altTrackIds?: number[]
  field: string
  current: string
  altCurrent?: string
  suggested: string
  commentary: string
}

// Cynthia's report on a single right-click investigation. fixes[] are
// proposed metadata edits the user approves before they hit the library;
// missingTracks[] are tracks Cynthia confirmed should be on the album
// but aren't in the user's files (the user has to source those manually).
export interface CynthiaFix {
  trackId: number
  field: string
  oldValue: unknown
  newValue: unknown
  reason: string
  // Cynthia overhaul — every fix cites the source that proved it (the
  // parser drops unsourced fixes main-side) + a confidence grade.
  source?: 'musicbrainz' | 'discogs' | 'wikidata' | 'file-tags' | 'internal-consistency'
  confidence?: 'high' | 'medium'
}

// Cynthia overhaul — background-sweep surface types.
// ⚠️ TWIN: src/main/cynthia-scan.ts CynthiaFinding / cynthia-sweep.ts
// CynthiaAlbumFindings + CynthiaLedgerEntry (main-side originals).
export interface CynthiaSweepFinding {
  trackId: number
  field: string
  oldValue: string
  newValue: string
  reason: string
  source: string
  confidence: string
  provable: boolean
}
export interface CynthiaAlbumFindings {
  albumKey: string
  albumLabel: string
  scannedAt: number
  findings: CynthiaSweepFinding[]
  missingTracks: CynthiaMissingTrack[]
  flags: Array<{ kind: string; detail: string }>
  autoAppliedCount: number
}
export interface CynthiaLedgerEntry {
  id: string
  at: number
  albumKey: string
  albumLabel: string
  trackId: number
  field: string
  oldValue: string
  newValue: string
  reason: string
  source: string
  reverted?: boolean
}
export interface CynthiaMissingTrack {
  trackNumber: number
  discNumber?: number
  title: string
  duration: number | null
  reason: string
}
export interface CynthiaScope {
  type: 'tracks' | 'album' | 'artist' | 'playlist'
  label: string
  tracks: Array<{
    id: number; title: string; artist: string; album: string; albumArtist: string
    trackNumber: number | string; trackCount: number | string
    discNumber: number | string; discCount: number | string
    year: number | string; genre: string; duration: number
  }>
}
export interface CynthiaResult {
  ok: boolean
  summary?: string
  fixes?: CynthiaFix[]
  missingTracks?: CynthiaMissingTrack[]
  rationale?: string
  error?: string
  text?: string
}

export interface RestoreDiff {
  id: number
  dbid: number
  path: string
  xmlPersistentId: string
  xmlTrackId: number
  matchMethod: 'duration' | 'duration+artist' | 'duration+album' | 'duration+track#'
  old: Record<string, string | number>
  new: Record<string, string | number>
  changed: string[]
  groupKey: string
  groupAlbum: string
  groupArtist: string
}

export interface RestoreUnmatched {
  id: number
  dbid: number
  path: string
  duration: number
  currentTitle: string
  currentArtist: string
  currentAlbum: string
}

export interface RestoreScanResult {
  ipodMount: string
  xmlPath: string
  total: number
  changed: number
  unchanged: number
  unmatched: RestoreUnmatched[]
  ambiguous: RestoreUnmatched[]
  diffs: RestoreDiff[]
}

export interface RestoreApplyResult {
  ok: boolean
  backup?: string
  tracksApproved?: number
  tracksRestored?: number
  tracksSkipped?: number
  tracksWritten?: number
  error?: string
}
// User preferences (4.0 §6.7+). Persisted to userData/app-settings.json
// via electronAPI.loadAppSettings / saveAppSettings. New fields added
// here should also be reflected in DEFAULT_APP_SETTINGS so renderer
// fallback is total.
export type ImportFormatChoice = 'aac-128' | 'aac-256' | 'aac-320' | 'alac' | 'aiff' | 'wav'

// EQ (4.0 §6.5). Type lives in audio/eq.ts but is re-exported here so
// it's reachable through the same single types module the rest of the
// app already imports from. `import type` keeps types.ts free of a
// runtime dep on howler.
import type { EqSettings } from './audio/eq'
export type { EqSettings } from './audio/eq'

export interface AppSettings {
  crossfade: {
    enabled: boolean
    seconds: number   // 1..12, iTunes-default 6
  }
  library: {
    defaultImportFormat: ImportFormatChoice   // applied when user imports new tracks
  }
  sync: {
    autoSyncOnConnect: boolean        // auto-fire sync when iPod is mounted
    autoRemoveDeletedFromIpod: boolean // gate the existing debounced delete-sync
  }
  ai: {
    musicManVoiceEnabled: boolean   // when off, skip ElevenLabs and chat in text only
    claudeDailyCeiling: number      // mirrored to claude-stats.json on save
    aiHost: 'mm' | 'megan'          // 4.2.5: which persona is the solo host. Radio Mode always co-hosts both regardless.
    /** Draft-only: typed key to save. Never returned by load-app-settings. */
    exaApiKey?: string
    /** True when main has an Exa key in env / prior settings (secret not exposed). */
    exaConfigured?: boolean
    /** When true on save, clears the stored Exa key. */
    clearExaKey?: boolean
  }
  eq: EqSettings   // 10-band parametric EQ (4.0 §6.5)
  // 4.4.13 — Inbox auto-import. Main-side chokidar watches `path` and
  // forwards new audio files to the renderer queue. Source files are
  // deleted after successful import (the iPod_Control copy is the
  // canonical version). Empty `path` falls back to ~/Music2/_inbox.
  inbox: {
    enabled: boolean
    path: string
  }
  // 4.4.51 — auto-route-on-call. When `callRouteEnabled` is on and music
  // is playing, JakeTunes watches the mic; when a call starts it routes
  // its OWN audio output (AudioContext.setSinkId — system default
  // untouched) to the device named in `callRouteDeviceLabel`, then
  // routes back when the call ends. Stored by device NAME because
  // Web Audio deviceIds are unstable across sessions/replug.
  audio: {
    callRouteEnabled: boolean
    callRouteDeviceLabel: string   // '' = not configured yet
    // 4.5: opt-in master-output stereo-width enhancer. 1.0 = off (transparent);
    // up to ~1.8 widens panned content while preserving the mono center.
    // Kept for settings-file migration — the band controls below supersede it.
    stereoWidth: number
    // 2026-08-06 band-split width: Linkwitz-Riley crossovers at 250 Hz / 5 kHz,
    // independent width per band. Low defaults to hard mono (0) — bass side
    // content only destabilizes the low end.
    widthOn: boolean
    widthLow: number      // 0 = mono … 1 = natural (max 1.2)
    widthMid: number      // 1 = natural … 1.5
    widthHigh: number     // 1 = natural … 2.2
    // bs2b-style headphone crossfeed: separate toggle, one amount control.
    crossfeedOn: boolean
    crossfeedAmount: number   // 0..1 of the standard 700 Hz / −4.5 dB feed
  }
  // Brief 023: removed `mobile.snapshotExportPath`. The mobile-sync
  // feature (Export Snapshot for Mobile / Apply Mobile Overrides) is
  // gone. Plex via Brief 020 tag write-back is the mobile path now.
  // Old settings.json files may still have a `mobile.snapshotExportPath`
  // key on disk; it's silently ignored — JSON tolerates extra fields.
}

// EQ default is duplicated from audio/eq.ts::DEFAULT_EQ rather than
// imported as a value, to avoid pulling howler into types.ts. The two
// must stay in sync — App.tsx merges by field anyway, so the source of
// truth at runtime is whichever is more permissive (the eq module).
export const DEFAULT_APP_SETTINGS: AppSettings = {
  crossfade: { enabled: false, seconds: 6 },
  library: { defaultImportFormat: 'aac-256' },
  sync: { autoSyncOnConnect: false, autoRemoveDeletedFromIpod: false },
  ai: { musicManVoiceEnabled: true, claudeDailyCeiling: 200, aiHost: 'mm', exaApiKey: '', exaConfigured: false },
  eq: {
    enabled: false,
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preset: 'Flat',
  },
  // Default-on with empty path → main resolves to ~/Music2/_inbox.
  inbox: { enabled: true, path: '' },
  // Off until the user picks a speaker in Preferences → Audio.
  audio: {
    callRouteEnabled: false, callRouteDeviceLabel: '', stereoWidth: 1.3,
    // Width ON by default at the migration of the old 1.3 broadband default:
    // mono bass, gentle body, open air.
    widthOn: true, widthLow: 0, widthMid: 1.15, widthHigh: 1.6,
    crossfeedOn: false, crossfeedAmount: 1.0,
  },
}

export type RepeatMode = 'off' | 'all' | 'one'
// Brain #1 — Listening Memory. Mirrors ListeningMemoryInsights in
// src/main/listening-memory.ts (the IPC payload shape).
// ── SCOTUS Archive (Beck v. Prupis) — mirrors src/main/scotus-archive ──
export interface ScotusSegment { start: number; stop: number; speaker: string; role: string; text: string }
export interface ScotusJustice {
  name: string; slug: string; title: string; vote: string; note: string; portrait: string | null
  nominatedBy?: string; service?: string; died?: string; bio?: string
}
export interface ScotusAdvocate { name: string; role: string; side: string; note: string; slug?: string; photo?: string | null }
export interface ScotusCase {
  name: string; citation: string; docket: string; argued: string; decided: string
  court: string; poppy: string; vote: string; opinionBy: string
  question: string; background: string; holding: string; significance: string
}
export interface ScotusQuote { title: string; time: number; note?: string; lines: Array<{ speaker: string; text: string }> }
// The decision — verbatim slip-opinion text (mirrors OpinionData in
// src/main/scotus-archive/index.ts; sourced from vault opinion.json).
export interface ScotusOpinionDoc {
  label: string; author: string; slug: string; joined: string
  blocks: Array<{ kind: 'opener' | 'head' | 'p' | 'end'; text: string }>
  notes: Array<{ n: number; text: string }>
}
export interface ScotusOpinion { source: string; decided: string; lineup: string; majority: ScotusOpinionDoc; dissent: ScotusOpinionDoc }
export interface ScotusArchiveData {
  exists: boolean
  case?: ScotusCase
  advocates?: ScotusAdvocate[]
  justices?: ScotusJustice[]
  segments?: ScotusSegment[]
  quotes?: ScotusQuote[]
  opinion?: ScotusOpinion | null
}

// Brain — Rediscover pick (mirrors RediscoveryPick in src/main/rediscovery.ts).
export interface RediscoveryPick {
  artist: string
  album: string
  genre: string
  ownedTracks: number
  plays: number
  rating: number
  addedAt: string
  reason: string
}

export interface ListeningMemoryData {
  insights: {
    totals: { plays: number; skips: number; skipRatePct: number; distinctArtists: number; daysActive: number; sinceTs: string | null }
    streak: { currentDays: number; bestDays: number; bestEndedOn: string | null }
    clock: { byHour: number[]; byWeekday: number[]; peakHourLabel: string | null; peakWeekdayLabel: string | null }
    topArtists7d: Array<{ artist: string; plays: number }>
    topArtists30d: Array<{ artist: string; plays: number }>
    rising: { artist: string; plays7d: number } | null
    comeback: { artist: string; gapDays: number } | null
    binge: { artist: string; plays: number; date: string } | null
  }
  lifetime: { totalPlays: number; firstSeen: string }
  observations: string[]
}

export type SortColumn = 'title' | 'artist' | 'album' | 'genre' | 'subgenre' | 'year' | 'dateAdded' | 'playCount' | 'rating' | 'channelMode' | 'bpm' | 'camelotKey'
export type SortDirection = 'asc' | 'desc'

declare global {
  interface Window {
    electronAPI: {
      loadTracks: () => Promise<{ tracks: Track[]; playlists: { name: string; trackIds: number[] }[] }>
      getAppVersion: () => Promise<string>
      onMenuAction: (callback: (action: string) => void) => () => void
      setLibraryContext: (ctx: string) => Promise<void>
      musicmanChat: (messages: { role: string; content: string }[]) => Promise<{ ok: boolean; text: string; textRaw: string; createdPlaylist?: { name: string; trackIds: number[] } | null }>
      musicmanSpeak: (text: string, fast?: boolean, voiceId?: string) => Promise<{ ok: boolean; audio?: string; error?: string }>
      musicmanDj: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen') => Promise<{ ok: boolean; text: string; transition?: 'talk' | 'scratch' | 'cut' }>
      // 4.4.52: active mic-button persona ('mm' | 'megan') for speech-bubble attribution
      getActiveHost: () => Promise<'mm' | 'megan'>
      audioLog: (line: string) => void
      // 4.1.6: Radio Mode — between-song WJLR-style commentary (distinct from
      // the one-shot mic-click `musicmanDj`). Forwards to ipcMain 'musicman-radio'.
      musicmanRadio: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }, opener?: boolean, forceAnnouncer?: boolean, callerSegment?: boolean, djHandsSegment?: boolean, callerId?: string, archetypeId?: string, slot?: number, hourCounter?: number, miniId?: boolean) => Promise<{ ok: boolean; text: string; error?: string }>
      musicmanDjSet: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], recentIds: number[]) => Promise<{ ok: boolean; intro?: string; trackIds?: number[]; theme?: string; error?: string }>
      musicmanPlaylist: (mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[]) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
      getMobileMixes: () => Promise<{ ok: boolean; date?: string; mixes?: Array<{ id: string; title: string; subtitle: string; trackIds: number[] }>; error?: string }>
      getMobileVibeMix: (vibe: string) => Promise<{ ok: boolean; mix?: { id: string; title: string; subtitle: string; trackIds: number[] }; error?: string }>
      musicmanRadioPlan: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[], recentPlayedIds: number[]) => Promise<{ ok: boolean; theme?: string; throughline?: string; trackIds?: number[]; error?: string }>
      radioSetShowPlan: (plan: { theme: string; throughline: string; setList: { id: number; title: string; artist: string }[] }) => Promise<{ ok: boolean; error?: string }>
      radioClearShowPlan: () => Promise<{ ok: boolean; error?: string }>
      // 4.5 radioV2: unified cast registry (speaker id → tag / pill label / voice id).
      radioGetCast: () => Promise<{ ok: boolean; cast?: Array<{ id: string; tag: string; label: string; voiceId?: string; kind: string }> }>
      // 4.5: streaming mic-button path + hover prefetch.
      musicmanDjStreaming: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen') => Promise<{ ok: boolean; text?: string; error?: string }>
      onMusicmanDjChunk: (callback: (p: { chunk: string; accumulated: string }) => void) => () => void
      musicmanPrefetchFacts: (track: { artist: string; album: string }) => Promise<{ ok: boolean }>
      onAppQuitFade: (callback: () => void) => () => void
      getArtistDiscography: (artist: string) => Promise<{ ok: boolean; albums?: Array<{ title: string; year: string; tracks: Array<{ title: string; position: number }> }>; error?: string }>
      musicmanPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
      meganPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
      djHandsPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
      saveRecordingMp3: (audioBytes: Uint8Array, mimeType: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      musicmanScanMetadata: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => Promise<{ ok: boolean; issues?: MetadataIssue[]; error?: string }>
      musicmanRecommendations: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => Promise<{ ok: boolean; recommendations?: { title: string; artist: string; year: number; genre: string; source: string; why: string; artUrl?: string }[]; error?: string }>
      cynthiaInvestigate: (input: { userPrompt: string; scope: CynthiaScope }) => Promise<CynthiaResult>
      cynthiaChat: (input: { scope: CynthiaScope; messages: { role: 'user' | 'assistant'; content: string }[] }) => Promise<{
        ok: boolean
        text?: string
        investigation?: { summary: string; fixes: CynthiaFix[]; missingTracks: CynthiaMissingTrack[]; rationale: string } | null
        error?: string
      }>
      cynthiaReportToMusicMan: (payload: { rationale: string; summary?: string }) => Promise<{ ok: boolean; error?: string }>
      // Cynthia overhaul — background-sweep surface.
      cynthiaGetFindings: (albumKeys: string[]) => Promise<{ ok: boolean; findings: Record<string, CynthiaAlbumFindings> }>
      cynthiaDismissFix: (fix: { trackId: number; field: string; newValue: string }) => Promise<{ ok: boolean; error?: string }>
      cynthiaGetLedger: (limit?: number) => Promise<{ ok: boolean; entries: CynthiaLedgerEntry[] }>
      cynthiaRevertLedgerEntry: (id: string) => Promise<{ ok: boolean; error?: string }>
      cynthiaSweepStatus: () => Promise<{ ok: boolean; swept: number; queued: number; withFindings: number; autoAppliedTotal: number; lastSweptAt: number | null }>
      onCynthiaSweepProgress: (callback: (progress: { swept: number; total: number; withFindings: number; autoApplied: Array<{ trackId: number; field: string; newValue: string }>; currentAlbum?: string }) => void) => () => void
      restoreXmlPickFile: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      restoreXmlScan: (xmlPath: string) => Promise<{ ok: boolean; data?: RestoreScanResult; error?: string }>
      restoreXmlApply: (xmlPath: string, approvedIds: number[]) => Promise<{ ok: boolean; data?: RestoreApplyResult; error?: string }>
      loadChatHistory: () => Promise<{ ok: boolean; conversations: ChatConversation[] }>
      saveChatHistory: (conversations: ChatConversation[]) => Promise<{ ok: boolean }>
      loadMetadataOverrides: () => Promise<{ ok: boolean; overrides: Record<string, unknown> }>
      saveMetadataOverride: (trackId: number, field: string, value: string, fingerprint?: string) => Promise<{ ok: boolean }>
      loadMobileStars: () => Promise<{ ok: boolean; trackIds: string[] }>
      loadMobilePlaylists: () => Promise<{ ok: boolean; playlists: Array<{ id: string; name: string; trackIds: string[]; createdAt?: string; source?: string }> }>
      loadPlaylistAdditions: () => Promise<{ ok: boolean; additions: Record<string, string[]> }>
      // Brief 122 — "Listen to the List". Read mirrors recommendations.json
      // from the NAS state dir; add/delete route through the Mini backend
      // so it stays the single writer (cache-coherent + iTunes-enriched).
      loadRecommendations: () => Promise<{ ok: boolean; recommendations: Recommendation[]; meta?: RecoSyncMeta }>
      onRecommendationsUpdated?: (callback: (info: { reason: string }) => void) => () => void
      addRecommendation: (input: { song?: string; artist?: string; album?: string; note?: string; source?: 'user' | 'mm' | 'radar'; from?: string; link?: string }) => Promise<{ ok: boolean; recommendation?: Recommendation; error?: string; savedLocally?: boolean; deduped?: boolean }>
      deleteRecommendation: (id: string) => Promise<{ ok: boolean; error?: string }>
      suggestRecommendations: (opts?: { force?: boolean }) => Promise<{ ok: boolean; suggestions?: Array<{ song: string; artist: string; note: string }>; error?: string }>
      searchItunes: (query: string) => Promise<{ ok: boolean; results: ItunesSuggestion[] }>
      itunesAlbumTracks: (collectionId: number) => Promise<{ ok: boolean; tracks: ItunesSuggestion[]; album?: string; artist?: string; artworkUrl?: string; releaseYear?: number; trackCount?: number; genre?: string; explicitness?: string }>
      // Artist-verified cover art for radar/discovery cards — returns art only
      // when an iTunes row's artist matches the candidate, else {} (no art).
      lookupRecoArtwork: (input: { artist: string; title: string }) => Promise<{ artworkUrl?: string; previewUrl?: string }>
      lookupAlbumPreview?: (input: { artist: string; album: string }) => Promise<{ previewUrl?: string; trackTitle?: string }>
      // Album detail page (4.5.0-115): factual credits (MusicBrainz + iTunes,
      // honest gaps where unknown) and a grounded Music Man blurb.
      getAlbumInfo: (artist: string, album: string, year?: string) => Promise<{ ok: boolean; credits?: { released?: string; label?: string; producer?: string; recorded?: string }; error?: string }>
      getAlbumBlurb: (artist: string, album: string, year?: string | number) => Promise<{ ok: boolean; blurb?: string; error?: string }>
      getAlbumTake: (artist: string, album: string, year?: string | number) => Promise<{ ok: boolean; take?: string; error?: string }>
      // 4.5.0-117 — library backup/restore (Phase 0).
      listBackups: () => Promise<{ ok: boolean; backups: Array<{ file: string; date: string; mtimeMs: number; trackCount: number; sizeBytes: number; reason: string }> }>
      createBackup: () => Promise<{ ok: boolean; backup?: { file: string; date: string; trackCount: number }; error?: string }>
      restoreBackup: (file: string) => Promise<{ ok: boolean; trackCount?: number; error?: string }>
      // 4.5.0-118 — Discovery Brain Phase 1: taste fingerprint.
      getTasteFingerprint: () => Promise<{ ok: boolean; fingerprint?: { totalTracks: number; totalPlays: number; summary: string; spines: Array<{ name: string; tracks: number; weight: number }>; topGenres: Array<{ genre: string; tracks: number; plays: number; weight: number }>; topArtists: Array<{ artist: string; tracks: number; plays: number }>; peakDecade: number | null; ownedArtists: string[] }; error?: string }>
      loadArtistAliases: () => Promise<{ ok: boolean; aliases: Record<string, string> }>
      saveArtistAliases: (aliases: Record<string, string>) => Promise<{ ok: boolean; error?: string }>
      classifyArtistGroups: () => Promise<{ ok: boolean; proposals?: ArtistGroupProposal[]; candidateCount?: number; error?: string }>
      getRelatedArtists: (artist: string) => Promise<{ ok: boolean; related?: RelatedArtist[]; error?: string }>
      // 4.5.0-118 — Discovery Brain Phase 2: new-music radar. anchor/anchors/
      // fingerprintSummary feed the "Seeded from" chips + "because you play X" reasoning.
      getNewMusicRadar: (force?: boolean) => Promise<{ ok: boolean; candidates?: Array<{ artist: string; title: string; genre: string; year: string; why: string; anchor?: string; score: number; brainPct?: number; reasons: string[] }>; generatedAt?: number; cached?: boolean; fingerprintSummary?: string; anchors?: Array<{ artist: string; plays: number; tracks: number; primaryGenre: string }>; error?: string }>
      discoveryNotForMe: (artist: string, cardKey?: string) => Promise<{ ok: boolean; scope?: string }>
      discoveryAllowAgain?: (artist: string) => Promise<{ ok: boolean }>
      discoveryLearned?: () => Promise<{ ok: boolean; summary?: DiscoveryLearned; error?: string }>
      getFriends: () => Promise<{ ok: boolean; friends: Array<{ name: string; adds: number; got: number; tossed: number; lastAt: number; imported: number }> }>
      tasteLedgerAppend?: (events: Array<{ surface: string; verdict: string; key?: Record<string, unknown>; ctx?: Record<string, unknown> }>) => Promise<{ ok: boolean; appended?: number }>
      getTasteWeights?: () => Promise<{ ok: boolean; weights: Record<string, unknown> }>
      getFriendStandings: () => Promise<{ ok: boolean; standings?: Array<{ name: string; points: number; adds: number; tossed: number; credits: Array<{ status: 'kept' | 'partial' | 'deleted' | 'legacy'; points: number; record: { kind: 'song' | 'album'; label: string; creditedAt: string } }> }>; error?: string }>
      sweepFriendImports: () => Promise<{ ok: boolean; credited: number }>
      imessageCaptureStatus: () => Promise<{ ok: boolean; access: 'granted' | 'denied' | 'unknown'; lastScanAt?: string; error?: string; pending: number; recent: Array<{ url: string; song?: string; artist?: string; album?: string; from?: string; at: string; status: string }> }>
      openFullDiskAccessSettings: () => Promise<{ ok: boolean }>

      friendEvent: (name: string, ev: 'add' | 'got' | 'tossed') => Promise<{ ok: boolean }>
      captureResolveLink: (url: string) => Promise<{ ok: boolean; kind?: string; title?: string; artist?: string; raw?: string }>
      getContacts: () => Promise<{ ok: boolean; names: string[] }>
      getDiscoverFeed: (force?: boolean) => Promise<{ ok: boolean; lanes?: Array<{ id: string; title: string; cards: Array<{ lane: string; type: 'song' | 'album' | 'artist'; artist: string; title: string; year?: string; why: string; artUrl?: string; previewUrl?: string; brainPct?: number }> }>; generatedAt?: number; cached?: boolean; error?: string }>
      getMobileImports?: () => Promise<{ tracks: unknown[]; overrides?: Record<string, { fp?: string; fields?: Record<string, string> }> }>
  onMobileImportsUpdated?: (callback: (p: { tracks: unknown[] }) => void) => () => void
  onMobileOverridesUpdated?: (callback: (p: { overrides: Record<string, { fp?: string; fields?: Record<string, string> }> }) => void) => () => void
      onDiscoverFeedUpdated: (callback: (p: { lanes: Array<{ id: string; title: string; cards: Array<{ lane: string; type: 'song' | 'album' | 'artist'; artist: string; title: string; year?: string; why: string; artUrl?: string; previewUrl?: string; brainPct?: number }> }>; generatedAt: number }) => void) => () => void
      getWindowedPlayCounts: (windowMs: number) => Promise<{ ok: boolean; counts: Record<string, number> }>
      loadPlaylists: () => Promise<{ ok: boolean; playlists: Playlist[] }>
      savePlaylists: (playlists: Playlist[]) => Promise<{ ok: boolean }>
      getClaudeStats: () => Promise<{ ok: boolean; sessionCallCount: number; callsToday: number; dailyCeiling: number; lastResetDate: string; cachedKeys: string[] }>
      // Declared to match src/preload/index.ts:240-241. Both the preload
      // method and the main handler exist; only this type surface had drifted,
      // which made the renderer typecheck report them as missing.
      getIpodSyncJournal: () => Promise<{ phase: string; at?: string } | null>
      inspectIpodTsaSeal?: () => Promise<{
        ok: boolean
        sealed: boolean
        drifted: boolean
        unmounted?: boolean
        target: number
        present: number
        missing: Array<{ id: number; destPath: string; reason: string }>
        error?: string
      }>
      onIpodSyncIncomplete: (callback: (info: { phase: string; at?: string }) => void) => () => void
      analyzeTrack: (trackId: number, colonPath: string, fingerprint: string) => Promise<{ ok: boolean; bpm?: number; keyRoot?: string; keyMode?: 'major' | 'minor' | ''; camelotKey?: string; error?: string }>
      // Brief 010 Phase 3 + Brief 014a: audio-analysis worker progress
      // subscription. Per-track fields are populated on completed jobs;
      // a skipped-no-librosa emission carries only `remaining`.
      onAudioAnalysisProgress: (callback: (p: {
        remaining: number
        trackId?: number
        audioAnalysisAt?: number
        bpm?: number | null
        keyRoot?: string | null
        keyMode?: 'major' | 'minor' | '' | null
        camelotKey?: string | null
        ok?: boolean
      }) => void) => () => void
      // Brief 010 Phase 4: queue-based backfill IPCs.
      audioAnalysisEnqueueMany: (jobs: Array<{ trackId: number; colonPath: string; fingerprint: string }>) => Promise<{ ok: boolean; enqueued: number; totalQueued: number }>
      audioAnalysisStatus: () => Promise<{ ok: boolean; queueLength: number; workerRunning: boolean; isPlaybackActive: boolean }>
      audioAnalysisClearQueue: () => Promise<{ ok: boolean }>
      loadAppSettings: () => Promise<{ ok: boolean; settings: Record<string, unknown> | null }>
      saveAppSettings: (settings: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
      // 4.5 — last homemini sync snapshot for Settings → Sync panel.
      getLastLibrarySync: () => Promise<{
        ok: boolean | null
        reason: string | null
        at: number | null
        durationMs: number | null
        error: string | null
        scriptPresent: boolean
      }>
      getArtworkLockCount: () => Promise<{ ok: boolean; count: number }>
      getStateConflicts: () => Promise<{
        mode: 'NAS' | 'local-primary'
        nasDir: string
        localDir: string
        nasMounted: boolean
        conflicts: Array<{ file: string; localMtimeMs: number; nasMtimeMs: number; localPath: string; nasPath: string; localSizeBytes: number }>
      }>
      reconcileStateConflicts: () => Promise<{ ok: boolean; pushed: number; backups: string[]; error?: string }>
      onReconcileStateProgress: (callback: (p: {
        phase: 'backup' | 'push' | 'verify'
        file: string
        index: number
        total: number
        localSizeBytes?: number
        totalBytes: number
      }) => void) => () => void
      embeddingStatus: () => Promise<{ configured: boolean; count: number; total: number; stale: number }>
      embeddingBackfill: (opts?: { force?: boolean }) => Promise<{ ok: boolean; embedded: number; total: number; error?: string }>
      // 4.5: brain-driven playlist suggestions — centroid nearest library tracks.
      playlistSimilar: (playlistIds: number[], clusters?: number) => Promise<{ ok: boolean; hits: Array<{ trackId: number; score: number; cluster: number }>; clusterSeeds?: number[] }>
      onEmbeddingBackfillProgress: (callback: (p: { done: number; total: number }) => void) => () => void
      // Brief 023: removed exportLibrarySnapshot / mobileOverridesPickFile
      // / mobileOverridesApply types — vestigial mobile-sync feature gone.
      setClaudeDailyCeiling: (ceiling: number) => Promise<{ ok: boolean; dailyCeiling: number }>
      fetchAlbumArt: (artist: string, album: string, force?: boolean) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      setCustomArtwork: (artist: string, album: string, imagePath: string) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      removeArtwork: (artist: string, album: string, force?: boolean) => Promise<{ ok: boolean; key?: string; locked?: boolean; error?: string }>
      chooseArtworkFile: () => Promise<{ ok: boolean; path?: string }>
      getTrackLyrics: (trackId: number) => Promise<{ ok: boolean; plain?: string; synced?: string; instrumental?: boolean }>
      loadArtworkMap: () => Promise<{ ok: boolean; map: Record<string, string> }>
      resolveArtwork: (artist: string, album: string) => Promise<{ ok: boolean; hash: string | null }>
      migrateArtworkKey: (oldArtist: string, oldAlbum: string, newArtist: string, newAlbum: string) => Promise<{ ok: boolean; migrated?: boolean; hash?: string }>
      checkIpodMounted: () => Promise<{ mounted: boolean; name: string | null }>
      getIpodCapacity: () => Promise<{ ok: boolean; totalBytes?: number; freeBytes?: number; mount?: string; fsName?: string; error?: string }>
      getMusicLibraryPath: () => Promise<string>
      trackLocalState: (ipodPath: string) => Promise<'local' | 'streamed' | 'unknown'>
      loadDownloadsState: () => Promise<{ pinned: string[]; streaming: boolean }>
      downloadTrack: (ipodPath: string) => Promise<{ ok: boolean; error?: string }>
      removeDownload: (ipodPath: string) => Promise<{ ok: boolean; error?: string }>
      ejectIpod: () => Promise<{ ok: boolean; error?: string }>
      importTracks: (filePaths: string[], nextId: number, format?: string) => Promise<{ ok: boolean; tracks: Track[]; skippedDupes?: Array<{ src: string; matchedTitle: string; matchedArtist: string }>; artwork?: Array<{ key: string; hash: string }> }>
      importTrack: (srcPath: string, id: number, format?: string) => Promise<{ ok: boolean; track?: Track; dupe?: { src: string; matchedTitle: string; matchedArtist: string }; error?: string; artwork?: { key: string; hash: string } }>
      artworkBackfillStatus: () => Promise<{ ok: boolean; done: boolean }>
      backfillEmbeddedArtwork: (tracks: Array<{ path: string; artist: string; album: string }>) => Promise<{ ok: boolean; artwork?: Array<{ key: string; hash: string }>; error?: string }>
      onArtworkBackfillProgress: (callback: (progress: { processed: number; total: number }) => void) => () => void
      // Brief 020: tag write-back batch + progress subscription. Per-edit
      // write-back fires automatically in save-metadata-override; only
      // the batch + progress need a renderer-side surface.
      applyOverridesBatch: () => Promise<{
        ok: boolean
        total?: number
        succeeded?: number
        failed?: number
        skippedNoTrack?: number
        skippedFpMismatch?: number
        skippedNoWritable?: number
        fileSizesRefreshed?: number
        failures?: Array<{ filePath: string; error?: string }>
        error?: string
      }>
      onTagWritebackProgress: (callback: (p: { done: number; total: number; succeeded: number; failed: number; currentPath?: string }) => void) => () => void
      // Brief 016 commit 2: full-library fileSize refresh + progress.
      refreshFileSizes: () => Promise<{ ok: boolean; refreshed?: number; error?: string }>
      onRefreshFileSizesProgress: (callback: (p: { scanned: number; refreshed: number; total: number }) => void) => () => void
      importResolvePaths: (paths: string[]) => Promise<{ ok: boolean; paths?: string[]; error?: string }>
      importPickFiles: () => Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }>
      allowDroppedImportPaths: (files: File[]) => Promise<{ ok: boolean; paths?: string[]; error?: string }>
      saveLibrary: (tracks: Track[], playlists?: Playlist[]) => Promise<{ ok: boolean; deletedPaths?: number; preservedOrphanCount?: number; error?: string }>
      syncIpod: (existingIds: number[]) => Promise<{ ok: boolean; newTracks: Track[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }>
      syncToIpod: (tracks: Track[], playlists: Playlist[], convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }, syncOpts?: { wipeFirst?: boolean; origin?: 'activity-click' | 'full-library-click' }) => Promise<{
        ok: boolean
        copied?: number
        copyErrors?: number
        totalTracks?: number
        // Verified-count truth (2026-07-24): target = number picked, landed =
        // number that actually committed to the card (unmount/remount-verified),
        // shortfall = target - landed, verifyAttempts = passes it took.
        target?: number
        landed?: number
        shortfall?: number
        verifyAttempts?: number
        error?: string
        cancelled?: boolean
        alreadyRunning?: boolean
        pathRewrites?: Array<{ id: number; newPath: string }>
        // Updates from the silent post-sync identity verifier. Renderer
        // applies these as UPDATE_TRACKS so library.json reflects the
        // verified state and the UI can show audioMissing flags.
        verificationUpdates?: Array<{ id: number; audioFingerprint?: string; path?: string; audioMissing?: boolean }>
      }>
      cancelSync: () => Promise<{ ok: boolean; wasRunning: boolean }>
      onSyncProgress: (callback: (progress: { phase: 'copy' | 'preflight' | 'db' | 'verify' | 'cancelled'; current: number; total: number; title: string }) => void) => () => void
      onStateSaveLocked: (callback: (info: { reason: string }) => void) => () => void
      buildWorkoutSyncSet?: (tracks: Array<{
        id: number; title?: string; artist?: string; album?: string; genre?: string; year?: string | number
        playCount?: number; skipCount?: number; rating?: number; bpm?: number | null; codec?: string; fileSize?: number
        path?: string; audioMissing?: boolean
      }>, opts?: { target?: number; brief?: {
        id?: string; profileName?: string; activity: string; intensity: string; setting: string
        place: string; social: string; note?: string
      }; saveProfile?: boolean }) => Promise<{
        ok: boolean
        trackIds?: number[]
        name?: string
        commentary?: string
        alacCount?: number
        total?: number
        rotatedFrom?: number
        weather?: { tempF: number; condition: string; description: string; placeLabel: string } | null
        error?: string
      }>
      listMixtapes?: () => Promise<{ ok: boolean; mixtapes: Mixtape[] }>
      buildMixtape?: (tracks: unknown[], dedication?: string, note?: string) => Promise<{ ok: boolean; title?: string; commentary?: string; tracks?: number[]; linerNotes?: Array<{ id: number; note: string }>; leftovers?: number[]; error?: string }>
      saveMixtape?: (tape: Mixtape) => Promise<{ ok: boolean; error?: string }>
      deleteMixtape?: (id: string) => Promise<{ ok: boolean; error?: string }>
      dubMixtape?: (payload: { title: string; sides: Array<{ label: 'A' | 'B'; songs: Array<{ absPath: string; cutMs?: number }>; talkovers: Array<{ atMs: number; path: string }>; introPath?: string }> }) => Promise<{ ok: boolean; outputs?: string[]; dir?: string; error?: string }>
      playlistNotesGet?: () => Promise<{ ok: boolean; notes: Record<string, string> }>
      playlistNoteSet?: (playlistId: string, text: string) => Promise<{ ok: boolean; error?: string }>
      playlistCoversMap?: () => Promise<{ ok: boolean; covers: Record<string, number>; dir: string }>
      pickPlaylistCover?: (playlistId: string) => Promise<{ ok: boolean; path?: string; stamp?: number; canceled?: boolean; error?: string }>
      copyPlaylistCover?: (fromId: string, toId: string) => Promise<{ ok: boolean; copied?: boolean; error?: string }>
      clearPlaylistCover?: (playlistId: string) => Promise<{ ok: boolean; error?: string }>
      gaplessTrim?: (absPath: string) => Promise<{ delaySamples: number; paddingSamples: number; sampleRate: number; delaySec: number; paddingSec: number } | null>
      saveMixtapeIntro?: (data: ArrayBuffer, voiceId?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      listMixtapeVoices?: () => Promise<{ ok: boolean; voices: Array<{ id: string; name: string }> }>
      previewIpodSync?: (tracks: Track[], convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }) => Promise<{ ok: boolean; plan: Array<{ id: number; action: 'keep' | 'copy' }>; leaving: Array<{ path: string; title: string; artist: string }>; deviceFileCount?: number; error?: string }>
      commitWorkoutSyncSet?: (payload: { trackIds: number[]; name: string; commentary: string; alacCount: number; brief: Record<string, unknown>; weather?: unknown; convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }; added?: Array<{ id: number; title: string; artist: string }>; removed?: Array<{ id: number; title: string; artist: string }> }) => Promise<{ ok: boolean; error?: string }>
      getWorkoutSyncState?: () => Promise<{ ok: boolean; state?: { trackIds: number[]; name: string; convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }; commentary: string; syncedAt: string; alacCount: number } | null }>
      getActivityProfiles?: () => Promise<{ ok: boolean; profiles?: Array<Record<string, unknown>> }>
      getActivityBrainContext?: () => Promise<{ ok: boolean; context?: unknown; promptBlock?: string }>
      previewPlaceWeather?: (place: string) => Promise<{ ok: boolean; weather?: { tempF: number; condition: string; description: string; placeLabel?: string } | null }>
      loadUiState: () => Promise<{ ok: boolean; state: Record<string, unknown> | null }>
      saveUiState: (state: Record<string, unknown>) => Promise<{ ok: boolean }>
      // CD drive
      checkCdDrive: () => Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }>
      getCdInfo: () => Promise<{ ok: boolean; volumeName?: string; volumePath?: string; artist?: string; album?: string; year?: string; genre?: string; tracks?: { number: number; title: string; duration: number; filePath: string }[]; error?: string }>
      ripCdTracks: (tracks: { number: number; title: string; duration: number; filePath: string }[], metadata: { artist: string; album: string; year: string; genre: string }, nextId: number, format?: string) => Promise<{ ok: boolean; tracks?: Track[]; error?: string }>
      onCdRipProgress: (callback: (progress: { current: number; total: number; trackNumber: number; trackTitle: string; track?: Track; error?: string }) => void) => () => void
      onImportProgress: (callback: (progress: { current: number; total: number; title: string; error?: string }) => void) => () => void
      ejectCd: () => Promise<{ ok: boolean; error?: string }>
      // V5 Live Concert Mode — merge/sidecar/cleanup family (see
      // src/main/live-set-merge.ts + the live-set-* handlers in main).
      liveSetMerge: (
        tracks: Array<{ id: number; title: string; artist: string; path: string; durationMs: number }>,
        album: { name: string; artist: string; genre?: string; year?: string | number },
      ) => Promise<{ ok: boolean; mergedPath?: string; cues?: LiveSetCue[]; totalDurationMs?: number; error?: string }>
      onLiveSetProgress: (callback: (progress: { stage: 'decode' | 'concat' | 'encode'; current: number; total: number; label: string }) => void) => () => void
      loadLiveSets: () => Promise<{ ok: boolean; sets: Record<string, LiveSetEntry> }>
      saveLiveSet: (albumKey: string, entry: LiveSetEntry) => Promise<{ ok: boolean; error?: string }>
      removeLiveSet: (albumKey: string) => Promise<{ ok: boolean }>
      getConcertCrowd: (mergedTrackId: number) => Promise<string | null>
      saveCrowdTuning: (t: Record<string, number>) => Promise<{ ok: boolean }>
      loadCrowdTuning: () => Promise<Record<string, number> | null>
      liveSetCleanup: (absPath: string) => Promise<{ ok: boolean; error?: string }>
      openSoundSettings: () => Promise<void>
      // Music Man taste-learning telemetry. The main process records these
      // into the listener profile; renderer fires-and-forgets, so the
      // bridge functions are optional from the renderer's POV (preload
      // may not have wired them in older builds — we soft-call with `?.`).
      recordPlay?: (track: { title: string; artist: string; album: string; genre: string; pct?: number }) => Promise<{ ok: boolean }>
      recordSkip?: (track: { title: string; artist: string; pct?: number }) => Promise<{ ok: boolean }>
      recordRating?: (track: { title: string; artist: string; album: string; rating: number }) => Promise<{ ok: boolean }>
      getListeningMemory?: () => Promise<{ ok: boolean; error?: string } & Partial<ListeningMemoryData>>
      getRediscovery?: (force?: boolean) => Promise<{ ok: boolean; picks?: RediscoveryPick[]; error?: string }>
      scotusGetArchive?: () => Promise<{ ok: boolean } & ScotusArchiveData>
      scotusGetAudio?: () => Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }>
      scotusAmicus?: (input: { mode: 'explain' | 'ask'; time?: number; question?: string; history?: Array<{ role: string; text: string }> }) => Promise<{ ok: boolean; answer?: string; cues?: Array<{ time: number; label: string }>; speaker?: string; error?: string }>
      listAudioDevices: () => Promise<{ ok: boolean; devices: { id: number; name: string; transport: string; isDefault: boolean }[] }>
      setAudioDevice: (deviceId: number) => Promise<{ ok: boolean; error?: string }>
      setCallWatch: (armed: boolean) => Promise<{ ok: boolean }>
      onCallStateChanged: (callback: (state: { onCall: boolean }) => void) => () => void
      alacCompatScan: () => Promise<{ ok: boolean; count?: number; samples?: unknown[]; error?: string }>
      alacCompatFix: () => Promise<{ ok: boolean; error?: string; summary?: string }>
      onAlacCompatProgress: (callback: (p: { current: number; total: number; file: string }) => void) => () => void
      // 4.1 Library Maintenance: ALAC play-cache management (replaces launch-time prewarm)
      prepareAlacCache: () => Promise<{ ok: boolean; processed?: number; transcoded?: number; total?: number; cancelled?: boolean; error?: string }>
      cancelAlacCache: () => void
      onPrepareAlacCacheProgress: (callback: (p: { processed: number; transcoded: number; total: number; title: string; artist: string }) => void) => () => void
      pruneAlacCache: () => Promise<{ ok: boolean; pruned?: number; bytesFreed?: number; error?: string }>
      scanLibraryOrphans: () => Promise<{
        ok: boolean
        trackCount?: number
        diskCount?: number
        orphanCount?: number
        orphanBytes?: number
        samples?: Array<{ basename: string; mtimeMs: number; size: number }>
        error?: string
      }>
      purgeLibraryOrphans: () => Promise<{ ok: boolean; deleted?: number; bytesFreed?: number; error?: string }>
      scanDeadTracks: () => Promise<{
        ok: boolean
        count?: number
        tracks?: Array<{ id: number; title: string; artist: string; path: string }>
        error?: string
      }>
      removeDeadTracks: () => Promise<{ ok: boolean; removed?: number; error?: string }>
      brainStatus?: () => Promise<{ ok: boolean; tracks?: number; subgenred?: number; starred?: number; descriptors?: number; themed?: number; descriptorsMtime?: number; lyrics?: number; embeddingsMtime?: number; embeddingsBytes?: number; syncs?: number; syncEdits?: number; lastSync?: string | null }>
      getIpodDbTracks: () => Promise<{ ok: boolean; tracks: Track[]; playlists: { name: string; trackIds: number[] }[]; total: number; error?: string }>
      onLibraryExternalChange: (callback: () => void) => () => void
      // ── Bandcamp Store v4 (embedded WebContentsView lifecycle) ──
      bandcampMount: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: true }>
      bandcampResize: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: true }>
      bandcampUnmount: () => Promise<{ ok: true }>
      bandcampSetVisible?: (visible: boolean) => Promise<{ ok: true }>
      bandcampNavState: () => Promise<{ ok: boolean; canGoBack: boolean; canGoForward: boolean }>
      bandcampGoBack: () => Promise<{ ok: boolean }>
      bandcampGoForward: () => Promise<{ ok: boolean }>
      // ── streamrip download store (paste-a-link → rip CLI → import) ──
      streamripStatus: () => Promise<{ ok: boolean; installed?: boolean; version?: string; reason?: string }>
      streamripDownload: (url: string) => Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string }>
      streamripSearch?: (opts: { query: string; source?: string; mediaType?: string; numResults?: number }) => Promise<{ ok: boolean; results?: Array<{ source: string; mediaType: string; id: string; desc: string }>; error?: string }>
      streamripDownloadId?: (source: string, mediaType: string, id: string) => Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string }>
      streamripDownloadByQuery?: (opts: { artist?: string; title?: string; song?: string; album?: string; durationMs?: number; cleanedSource?: boolean }) => Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string; matchDesc?: string }>
      streamripCancelActive?: () => Promise<{ ok: boolean; killed: number }>
      streamripGetQobuz?: () => Promise<{ ok: boolean; configured: boolean; email?: string }>
      streamripSetQobuz?: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
      streamripSetQobuzToken?: (userId: string, token: string) => Promise<{ ok: boolean; error?: string }>
      // ── Bandcamp Store v4 (download -> library events) ──
      // Payload is the full Track record minted by importOneFile() — same
      // shape the drag-drop importQueue delivers. App.tsx dispatches it
      // into LibraryContext; recentlyAdded.ts uses just id/title/album.
      onBandcampTrackImported: (callback: (track: Track) => void) => () => void
      onBandcampImportFailed: (callback: (reason: { filename: string; error: string }) => void) => () => void
      onBandcampPerFileFailed: (callback: (reason: { filename: string; error: string }) => void) => () => void
      onBandcampAllDuplicates: (callback: (info: { filename: string; dupeCount: number }) => void) => () => void
      // 4.4.85: per-file progress for the now-playing pill's import mode.
      onBandcampBatchProgress: (callback: (p: { current: number; total: number; trackTitle: string; errors: number; running: boolean }) => void) => () => void
      // 4.5 — Bandcamp navigation context for the library-ownership header.
      onBandcampUrlChanged: (callback: (p: { url: string; artistSlug: string | null; albumSlug: string | null }) => void) => () => void
      // 4.4.13 — Inbox auto-import (Qobuz → JakeTunes pipeline).
      onInboxFilesDetected: (callback: (paths: string[]) => void) => () => void
      deleteInboxSource: (filePath: string) => Promise<{ ok: boolean; error?: string }>
      getDefaultInboxPath: () => Promise<{ ok: boolean; path: string }>
      // 4.4.18 — Library sync orchestrator status (laptop → homemini).
      onLibrarySyncStatus: (callback: (status: {
        ok: boolean
        reason: 'import' | 'metadata-edit' | 'playlist' | 'safety-net' | 'manual'
        error?: string
        durationMs?: number
      }) => void) => () => void
      // 4.4.28 — Home view: music news + notable releases.
      getMusicNews: () => Promise<{ ok: boolean; items: MusicNewsItem[] }>
      getNotableReleases: () => Promise<{ ok: boolean; items: MusicNewsItem[] }>
      openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
      // 4.4.29 — Brooklyn weather for the Home view greeting.
      getBrooklynWeather: () => Promise<{ ok: boolean; weather: { tempF: number; condition: string; description: string } | null }>
      // 4.4.32 — Bandsintown tour dates for top library artists.
      getVenueShows: () => Promise<{ ok: boolean; shows: VenueShow[] }>
      getTourDates: () => Promise<{ ok: boolean; dates: TourDate[] }>
      // 4.4.34 — MusicBrainz upcoming releases (not yet out) for top
      // library artists.
      getUpcomingReleasesPersonal: () => Promise<{ ok: boolean; items: UpcomingRelease[] }>

      // 4.4.40 — Per-artist photo slug; renderer loads via the
      // artist-image:// protocol scheme.
      getArtistImage: (artist: string) => Promise<{ ok: boolean; slug: string | null }>
      // 4.5 — Wikipedia summary for the artist detail page. 24h disk
      // cache in main; both fields null on no-result so UI can fall
      // back to photo + name only.
      getArtistWiki: (artist: string) => Promise<{ ok: boolean; extract: string | null; pageUrl: string | null }>
    }
  }
}

// 4.4.28 — News item shape for Home view's News and Releases sections.
// Mirrors src/main/external.ts MusicNewsItem.
export interface MusicNewsItem {
  title: string
  link: string
  source: string
  pubDate: string
  imageUrl?: string
  isReleaseReview: boolean
  /** Release reviews only — enriched from the review page (artist + genre). */
  artist?: string
  genre?: string
}

// 4.4.32 — Tour date shape from Bandsintown.
/** A show at one of Jake's rooms, sourced from the venue itself (2026-08-08).
 *  `known` marks artists already in the library — everything else is the
 *  discovery half: the Ceremony-at-Warsaw show he'd otherwise never see. */
export interface VenueShow {
  artist: string
  date: string
  venue: string
  venueKey: string
  city: string
  url: string
  known?: boolean
}

export interface TourDate {
  artist: string
  date: string         // ISO
  venue: string
  city: string         // "Brooklyn, NY"
  url: string
  imageUrl?: string
  miles?: number       // crow-flies miles from Brooklyn — proximity hint on the card
}

// 4.4.34 — Upcoming-release shape from MusicBrainz.
export interface UpcomingRelease {
  title: string
  artist: string
  /** May be partial: "2026", "2026-09", "2026-09-15" */
  releaseDate: string
  mbid: string
  coverUrl: string
}
