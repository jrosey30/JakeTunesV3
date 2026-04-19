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
      restoreXmlPickFile: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      restoreXmlScan: (xmlPath: string) => Promise<{ ok: boolean; data?: RestoreScanResult; error?: string }>
      restoreXmlApply: (xmlPath: string, approvedIds: number[]) => Promise<{ ok: boolean; data?: RestoreApplyResult; error?: string }>
      loadChatHistory: () => Promise<{ ok: boolean; conversations: ChatConversation[] }>
      saveChatHistory: (conversations: ChatConversation[]) => Promise<{ ok: boolean }>
      loadMetadataOverrides: () => Promise<{ ok: boolean; overrides: Record<string, unknown> }>
      saveMetadataOverride: (trackId: number, field: string, value: string, fingerprint?: string) => Promise<{ ok: boolean }>
      loadPlaylists: () => Promise<{ ok: boolean; playlists: Playlist[] }>
      savePlaylists: (playlists: Playlist[]) => Promise<{ ok: boolean }>
      fetchAlbumArt: (artist: string, album: string, force?: boolean) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      setCustomArtwork: (artist: string, album: string, imagePath: string) => Promise<{ ok: boolean; key?: string; hash?: string; error?: string }>
      removeArtwork: (artist: string, album: string) => Promise<{ ok: boolean; key?: string; error?: string }>
      chooseArtworkFile: () => Promise<{ ok: boolean; path?: string }>
      loadArtworkMap: () => Promise<{ ok: boolean; map: Record<string, string> }>
      checkIpodMounted: () => Promise<{ mounted: boolean; name: string | null }>
      getIpodCapacity: () => Promise<{ ok: boolean; totalBytes?: number; freeBytes?: number; mount?: string; error?: string }>
      getMusicLibraryPath: () => Promise<string>
      ejectIpod: () => Promise<{ ok: boolean; error?: string }>
      importTracks: (filePaths: string[], nextId: number) => Promise<{ ok: boolean; tracks: Track[] }>
      saveLibrary: (tracks: Track[], playlists?: Playlist[]) => Promise<{ ok: boolean }>
      syncIpod: (existingIds: number[]) => Promise<{ ok: boolean; newTracks: Track[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }>
      syncToIpod: (tracks: Track[], playlists: Playlist[]) => Promise<{ ok: boolean; copied?: number; copyErrors?: number; totalTracks?: number; error?: string }>
      loadUiState: () => Promise<{ ok: boolean; state: Record<string, unknown> | null }>
      saveUiState: (state: Record<string, unknown>) => Promise<{ ok: boolean }>
      // CD drive
      checkCdDrive: () => Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }>
      getCdInfo: () => Promise<{ ok: boolean; volumeName?: string; volumePath?: string; artist?: string; album?: string; year?: string; genre?: string; tracks?: { number: number; title: string; duration: number; filePath: string }[]; error?: string }>
      ripCdTracks: (tracks: { number: number; title: string; duration: number; filePath: string }[], metadata: { artist: string; album: string; year: string; genre: string }, nextId: number, format?: string) => Promise<{ ok: boolean; tracks?: Track[]; error?: string }>
      onCdRipProgress: (callback: (progress: { current: number; total: number; trackNumber: number; trackTitle: string; track?: Track; error?: string }) => void) => () => void
      ejectCd: () => Promise<{ ok: boolean; error?: string }>
      openSoundSettings: () => Promise<void>
      listAudioDevices: () => Promise<{ ok: boolean; devices: { id: number; name: string; transport: string; isDefault: boolean }[] }>
      setAudioDevice: (deviceId: number) => Promise<{ ok: boolean; error?: string }>
    }
  }
}
