import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  loadTracks: (): Promise<{ tracks: unknown[]; playlists: { name: string; trackIds: number[] }[] }> => ipcRenderer.invoke('load-tracks'),
  onMenuAction: (callback: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('menu-action', handler)
    return () => { ipcRenderer.removeListener('menu-action', handler) }
  },
  setLibraryContext: (ctx: string): Promise<void> => ipcRenderer.invoke('set-library-context', ctx),
  musicmanChat: (messages: { role: string; content: string }[]): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke('musicman-chat', messages),
  musicmanSpeak: (text: string, fast?: boolean): Promise<{ ok: boolean; audio?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-speak', text, fast),
  musicmanDj: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke('musicman-dj', track, nextTrack),
  musicmanDjSet: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], recentIds: number[]): Promise<{ ok: boolean; intro?: string; trackIds?: number[]; theme?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-dj-set', tracks, recentIds),
  musicmanPlaylist: (mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-playlist', mood, tracks),
  musicmanPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-picks', tracks),
  musicmanScanMetadata: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('musicman-scan-metadata', tracks),
  musicmanRecommendations: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; recommendations?: { title: string; artist: string; year: number; genre: string; source: string; why: string }[]; error?: string }> =>
    ipcRenderer.invoke('musicman-recommendations', tracks),
  restoreXmlPickFile: (): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('restore-xml-pick-file'),
  restoreXmlScan: (xmlPath: string): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke('restore-xml-scan', xmlPath),
  restoreXmlApply: (xmlPath: string, approvedIds: number[]): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke('restore-xml-apply', xmlPath, approvedIds),
  loadMetadataOverrides: (): Promise<{ ok: boolean; overrides: Record<string, unknown> }> =>
    ipcRenderer.invoke('load-metadata-overrides'),
  saveMetadataOverride: (trackId: number, field: string, value: string, fingerprint?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-metadata-override', trackId, field, value, fingerprint),
  loadChatHistory: (): Promise<{ ok: boolean; conversations: unknown[] }> =>
    ipcRenderer.invoke('load-chat-history'),
  saveChatHistory: (conversations: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-chat-history', conversations),
  loadPlaylists: (): Promise<{ ok: boolean; playlists: unknown[] }> =>
    ipcRenderer.invoke('load-playlists'),
  savePlaylists: (playlists: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-playlists', playlists),
  fetchAlbumArt: (artist: string, album: string, force?: boolean): Promise<{ ok: boolean; key?: string; hash?: string; error?: string }> =>
    ipcRenderer.invoke('fetch-album-art', artist, album, force),
  setCustomArtwork: (artist: string, album: string, imagePath: string): Promise<{ ok: boolean; key?: string; hash?: string; error?: string }> =>
    ipcRenderer.invoke('set-custom-artwork', artist, album, imagePath),
  removeArtwork: (artist: string, album: string): Promise<{ ok: boolean; key?: string; error?: string }> =>
    ipcRenderer.invoke('remove-artwork', artist, album),
  chooseArtworkFile: (): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('choose-artwork-file'),
  loadArtworkMap: (): Promise<{ ok: boolean; map: Record<string, string> }> =>
    ipcRenderer.invoke('load-artwork-map'),
  checkIpodMounted: (): Promise<{ mounted: boolean; name: string | null }> =>
    ipcRenderer.invoke('check-ipod-mounted'),
  getIpodCapacity: (): Promise<{ ok: boolean; totalBytes?: number; freeBytes?: number; mount?: string; error?: string }> =>
    ipcRenderer.invoke('get-ipod-capacity'),
  getMusicLibraryPath: (): Promise<string> =>
    ipcRenderer.invoke('get-music-library-path'),
  ejectIpod: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('eject-ipod'),
  importTracks: (filePaths: string[], nextId: number, format?: string): Promise<{ ok: boolean; tracks: unknown[] }> =>
    ipcRenderer.invoke('import-tracks', filePaths, nextId, format),
  importPickFiles: (): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('import-pick-files'),
  saveLibrary: (tracks: unknown[], playlists?: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-library', tracks, playlists),
  syncIpod: (existingIds: number[]): Promise<{ ok: boolean; newTracks: unknown[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }> =>
    ipcRenderer.invoke('sync-ipod', existingIds),
  syncToIpod: (tracks: unknown[], playlists: unknown[]): Promise<{ ok: boolean; copied?: number; copyErrors?: number; totalTracks?: number; error?: string; pathRewrites?: Array<{ id: number; newPath: string }> }> =>
    ipcRenderer.invoke('sync-to-ipod', tracks, playlists),
  onSyncProgress: (callback: (progress: { phase: 'copy' | 'db'; current: number; total: number; title: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { phase: 'copy' | 'db'; current: number; total: number; title: string }) => callback(progress)
    ipcRenderer.on('sync-progress', handler)
    return () => { ipcRenderer.removeListener('sync-progress', handler) }
  },
  loadUiState: (): Promise<{ ok: boolean; state: Record<string, unknown> | null }> =>
    ipcRenderer.invoke('load-ui-state'),
  saveUiState: (state: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-ui-state', state),
  // CD drive
  checkCdDrive: (): Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }> =>
    ipcRenderer.invoke('check-cd-drive'),
  getCdInfo: (): Promise<{ ok: boolean; volumeName?: string; volumePath?: string; artist?: string; album?: string; year?: string; genre?: string; tracks?: { number: number; title: string; duration: number; filePath: string }[]; error?: string }> =>
    ipcRenderer.invoke('get-cd-info'),
  ripCdTracks: (tracks: { number: number; title: string; duration: number; filePath: string }[], metadata: { artist: string; album: string; year: string; genre: string }, nextId: number, format?: string): Promise<{ ok: boolean; tracks?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('rip-cd-tracks', tracks, metadata, nextId, format),
  onCdRipProgress: (callback: (progress: { current: number; total: number; trackNumber: number; trackTitle: string; track?: unknown; error?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; trackNumber: number; trackTitle: string; track?: unknown; error?: string }) => callback(progress)
    ipcRenderer.on('cd-rip-progress', handler)
    return () => { ipcRenderer.removeListener('cd-rip-progress', handler) }
  },
  onImportProgress: (callback: (progress: { current: number; total: number; title: string; error?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; title: string; error?: string }) => callback(progress)
    ipcRenderer.on('import-progress', handler)
    return () => { ipcRenderer.removeListener('import-progress', handler) }
  },
  ejectCd: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('eject-cd'),
  openSoundSettings: (): Promise<void> =>
    ipcRenderer.invoke('open-sound-settings'),
  recordPlay: (track: { title: string; artist: string; album: string; genre: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('record-play', track),
  recordSkip: (track: { title: string; artist: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('record-skip', track),
  recordRating: (track: { title: string; artist: string; album: string; rating: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('record-rating', track),
  listAudioDevices: (): Promise<{ ok: boolean; devices: { id: number; name: string; transport: string; isDefault: boolean }[] }> =>
    ipcRenderer.invoke('list-audio-devices'),
  setAudioDevice: (deviceId: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('set-audio-device', deviceId),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
