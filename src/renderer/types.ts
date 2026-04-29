// ⚠️ TWIN: mobile/src/types.ts (JakeTunes Mobile). Desktop is the
// authoritative source for the Track/Playlist shape. When you add a
// field here that the mobile app needs to display or filter on, add
// it to the mobile twin too and document the divergence in
// mobile/README.md. Mobile-only mutations (play counts queued on
// device) live in MobileTrackOverrides on the mobile side, never here.
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
}

export interface Playlist {
  id: string
  name: string
  trackIds: number[]
  commentary?: string
}

export type ViewName = 'songs' | 'artists' | 'albums' | 'genres' | 'musicman' | 'playlist' | 'smart-playlist' | 'device' | 'cd-import'
export type SmartPlaylistId = 'recently-added' | 'recently-played' | 'top-25' | 'top-rated' | 'musicman-picks'

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
  }
  eq: EqSettings   // 10-band parametric EQ (4.0 §6.5)
  // Mobile export — fires after every save-library when snapshotExportPath
  // is set. Set via File → Library → Export Snapshot for Mobile…
  // (the menu item also runs a one-shot export on first selection).
  // Path is an absolute filesystem path; `null` = export disabled.
  // The user typically points this at a folder that lives on their
  // NAS-synced share (e.g. ~/Synology/music/.jaketunes/library.json
  // or a mounted SMB share). The desktop is path-agnostic — the
  // exporter just writes wherever told.
  mobile: {
    snapshotExportPath: string | null
  }
}

// EQ default is duplicated from audio/eq.ts::DEFAULT_EQ rather than
// imported as a value, to avoid pulling howler into types.ts. The two
// must stay in sync — App.tsx merges by field anyway, so the source of
// truth at runtime is whichever is more permissive (the eq module).
export const DEFAULT_APP_SETTINGS: AppSettings = {
  crossfade: { enabled: false, seconds: 6 },
  library: { defaultImportFormat: 'aac-256' },
  sync: { autoSyncOnConnect: false, autoRemoveDeletedFromIpod: false },
  ai: { musicManVoiceEnabled: true, claudeDailyCeiling: 200 },
  eq: {
    enabled: false,
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preset: 'Flat',
  },
  mobile: { snapshotExportPath: null },
}

export type RepeatMode = 'off' | 'all' | 'one'
export type SortColumn = 'title' | 'artist' | 'album' | 'genre' | 'year' | 'dateAdded' | 'playCount' | 'rating'
export type SortDirection = 'asc' | 'desc'

declare global {
  interface Window {
    electronAPI: {
      loadTracks: () => Promise<{ tracks: Track[]; playlists: { name: string; trackIds: number[] }[] }>
      onMenuAction: (callback: (action: string) => void) => () => void
      setLibraryContext: (ctx: string) => Promise<void>
      musicmanChat: (messages: { role: string; content: string }[]) => Promise<{ ok: boolean; text: string }>
      musicmanSpeak: (text: string, fast?: boolean) => Promise<{ ok: boolean; audio?: string; error?: string }>
      musicmanDj: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }) => Promise<{ ok: boolean; text: string }>
      musicmanDjSet: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], recentIds: number[]) => Promise<{ ok: boolean; intro?: string; trackIds?: number[]; theme?: string; error?: string }>
      musicmanPlaylist: (mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
      musicmanPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>
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
      restoreXmlPickFile: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      restoreXmlScan: (xmlPath: string) => Promise<{ ok: boolean; data?: RestoreScanResult; error?: string }>
      restoreXmlApply: (xmlPath: string, approvedIds: number[]) => Promise<{ ok: boolean; data?: RestoreApplyResult; error?: string }>
      loadChatHistory: () => Promise<{ ok: boolean; conversations: ChatConversation[] }>
      saveChatHistory: (conversations: ChatConversation[]) => Promise<{ ok: boolean }>
      loadMetadataOverrides: () => Promise<{ ok: boolean; overrides: Record<string, unknown> }>
      saveMetadataOverride: (trackId: number, field: string, value: string, fingerprint?: string) => Promise<{ ok: boolean }>
      loadPlaylists: () => Promise<{ ok: boolean; playlists: Playlist[] }>
      savePlaylists: (playlists: Playlist[]) => Promise<{ ok: boolean }>
      getClaudeStats: () => Promise<{ ok: boolean; sessionCallCount: number; callsToday: number; dailyCeiling: number; lastResetDate: string; cachedKeys: string[] }>
      analyzeTrack: (trackId: number, colonPath: string, fingerprint: string) => Promise<{ ok: boolean; bpm?: number; keyRoot?: string; keyMode?: 'major' | 'minor' | ''; camelotKey?: string; error?: string }>
      loadAppSettings: () => Promise<{ ok: boolean; settings: Record<string, unknown> | null }>
      saveAppSettings: (settings: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
      exportLibrarySnapshot: (payload: { tracks: unknown[]; playlists: unknown[] }) => Promise<{
        ok: boolean
        canceled?: boolean
        path?: string
        trackCount?: number
        bytes?: number
        error?: string
      }>
      setClaudeDailyCeiling: (ceiling: number) => Promise<{ ok: boolean; dailyCeiling: number }>
      fetchAlbumArt: (artist: string, album: string, force?: boolean) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      setCustomArtwork: (artist: string, album: string, imagePath: string) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      removeArtwork: (artist: string, album: string) => Promise<{ ok: boolean; key?: string; error?: string }>
      chooseArtworkFile: () => Promise<{ ok: boolean; path?: string }>
      loadArtworkMap: () => Promise<{ ok: boolean; map: Record<string, string> }>
      checkIpodMounted: () => Promise<{ mounted: boolean; name: string | null }>
      getIpodCapacity: () => Promise<{ ok: boolean; totalBytes?: number; freeBytes?: number; mount?: string; error?: string }>
      getMusicLibraryPath: () => Promise<string>
      ejectIpod: () => Promise<{ ok: boolean; error?: string }>
      importTracks: (filePaths: string[], nextId: number, format?: string) => Promise<{ ok: boolean; tracks: Track[]; skippedDupes?: Array<{ src: string; matchedTitle: string; matchedArtist: string }> }>
      importTrack: (srcPath: string, id: number, format?: string) => Promise<{ ok: boolean; track?: Track; dupe?: { src: string; matchedTitle: string; matchedArtist: string }; error?: string }>
      importResolvePaths: (paths: string[]) => Promise<{ ok: boolean; paths?: string[]; error?: string }>
      importPickFiles: () => Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }>
      saveLibrary: (tracks: Track[], playlists?: Playlist[]) => Promise<{ ok: boolean }>
      syncIpod: (existingIds: number[]) => Promise<{ ok: boolean; newTracks: Track[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }>
      syncToIpod: (tracks: Track[], playlists: Playlist[]) => Promise<{
        ok: boolean
        copied?: number
        copyErrors?: number
        totalTracks?: number
        error?: string
        pathRewrites?: Array<{ id: number; newPath: string }>
        // Updates from the silent post-sync identity verifier. Renderer
        // applies these as UPDATE_TRACKS so library.json reflects the
        // verified state and the UI can show audioMissing flags.
        verificationUpdates?: Array<{ id: number; audioFingerprint?: string; path?: string; audioMissing?: boolean }>
      }>
      onSyncProgress: (callback: (progress: { phase: 'copy' | 'preflight' | 'db'; current: number; total: number; title: string }) => void) => () => void
      loadUiState: () => Promise<{ ok: boolean; state: Record<string, unknown> | null }>
      saveUiState: (state: Record<string, unknown>) => Promise<{ ok: boolean }>
      // CD drive
      checkCdDrive: () => Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }>
      getCdInfo: () => Promise<{ ok: boolean; volumeName?: string; volumePath?: string; artist?: string; album?: string; year?: string; genre?: string; tracks?: { number: number; title: string; duration: number; filePath: string }[]; error?: string }>
      ripCdTracks: (tracks: { number: number; title: string; duration: number; filePath: string }[], metadata: { artist: string; album: string; year: string; genre: string }, nextId: number, format?: string) => Promise<{ ok: boolean; tracks?: Track[]; error?: string }>
      onCdRipProgress: (callback: (progress: { current: number; total: number; trackNumber: number; trackTitle: string; track?: Track; error?: string }) => void) => () => void
      onImportProgress: (callback: (progress: { current: number; total: number; title: string; error?: string }) => void) => () => void
      ejectCd: () => Promise<{ ok: boolean; error?: string }>
      openSoundSettings: () => Promise<void>
      listAudioDevices: () => Promise<{ ok: boolean; devices: { id: number; name: string; transport: string; isDefault: boolean }[] }>
      setAudioDevice: (deviceId: number) => Promise<{ ok: boolean; error?: string }>
      alacCompatScan: () => Promise<{ ok: boolean; count?: number; samples?: unknown[]; error?: string }>
      alacCompatFix: () => Promise<{ ok: boolean; error?: string; summary?: string }>
      onAlacCompatProgress: (callback: (p: { current: number; total: number; file: string }) => void) => () => void
      getIpodDbTracks: () => Promise<{ ok: boolean; tracks: Track[]; playlists: { name: string; trackIds: number[] }[]; total: number; error?: string }>
      onLibraryExternalChange: (callback: () => void) => () => void
    }
  }
}
