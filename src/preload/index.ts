import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  loadTracks: (): Promise<{ tracks: unknown[]; playlists: { name: string; trackIds: number[] }[] }> => ipcRenderer.invoke('load-tracks'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  // One-way notify: tells main "playback state changed" so background
  // workers (audio analysis, prewarm) can yield while music is live.
  // Fire-and-forget — no return value needed, no async overhead.
  setPlaybackActive: (active: boolean): void => { ipcRenderer.send('set-playback-active', active) },
  onMenuAction: (callback: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('menu-action', handler)
    return () => { ipcRenderer.removeListener('menu-action', handler) }
  },
  setLibraryContext: (ctx: string): Promise<void> => ipcRenderer.invoke('set-library-context', ctx),
  musicmanChat: (messages: { role: string; content: string }[]): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke('musicman-chat', messages),
  musicmanSpeak: (text: string, fast?: boolean, voiceId?: string): Promise<{ ok: boolean; audio?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-speak', text, fast, voiceId),
  musicmanDj: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen'): Promise<{ ok: boolean; text: string; transition?: 'talk' | 'scratch' | 'cut' }> =>
    ipcRenderer.invoke('musicman-dj', track, nextTrack, persona),
  // 4.4.52: which persona the mic button speaks as right now ('mm' or
  // 'megan') — the toolbar speech bubble reads this to attribute and
  // colour itself correctly.
  getActiveHost: (): Promise<'mm' | 'megan'> =>
    ipcRenderer.invoke('get-active-host'),
  // 4.1.6: Radio Mode — between-song WJLR-style commentary, distinct
  // from one-shot DJ comment (mic click). Same shape, different system
  // prompt + voice.
  musicmanRadio: (
    track: { title: string; artist: string; album: string; genre: string; year: string | number },
    nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number },
    opener?: boolean,
    forceAnnouncer?: boolean,
    callerSegment?: boolean,
    djHandsSegment?: boolean,
    callerId?: string,
    archetypeId?: string,
    slot?: number,
    hourCounter?: number,
    miniId?: boolean,
  ): Promise<{ ok: boolean; text: string; error?: string }> =>
    ipcRenderer.invoke('musicman-radio', track, nextTrack, opener, forceAnnouncer, callerSegment, djHandsSegment, callerId, archetypeId, slot, hourCounter, miniId),
  musicmanDjSet: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], recentIds: number[]): Promise<{ ok: boolean; intro?: string; trackIds?: number[]; theme?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-dj-set', tracks, recentIds),
  musicmanPlaylist: (mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-playlist', mood, tracks),
  // 4.4.48: optional `force` bypasses the main-process weekly cache
  // (the Regenerate button passes it). Omitted/false → main returns
  // this week's cached picks with no Claude call.
  musicmanPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-picks', tracks, force),
  meganPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('megan-picks', tracks, force),
  djHandsPicks: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], force?: boolean): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('dj-hands-picks', tracks, force),
  saveRecordingMp3: (audioBytes: Uint8Array, mimeType: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('save-recording-mp3', audioBytes, mimeType),
  musicmanScanMetadata: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('musicman-scan-metadata', tracks),
  musicmanRecommendations: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]): Promise<{ ok: boolean; recommendations?: { title: string; artist: string; year: number; genre: string; source: string; why: string }[]; error?: string }> =>
    ipcRenderer.invoke('musicman-recommendations', tracks),
  // ── Cynthia (digital file archivist sub-agent) ──
  cynthiaInvestigate: (input: {
    userPrompt: string
    scope: {
      type: 'tracks' | 'album' | 'artist' | 'playlist'
      label: string
      tracks: Array<{ id: number; title: string; artist: string; album: string; albumArtist: string; trackNumber: number | string; trackCount: number | string; discNumber: number | string; discCount: number | string; year: number | string; genre: string; duration: number }>
    }
  }): Promise<{
    ok: boolean
    summary?: string
    fixes?: Array<{ trackId: number; field: string; oldValue: unknown; newValue: unknown; reason: string }>
    missingTracks?: Array<{ trackNumber: number; discNumber?: number; title: string; duration: number | null; reason: string }>
    rationale?: string
    error?: string
    text?: string
  }> => ipcRenderer.invoke('cynthia-investigate', input),
  cynthiaChat: (input: {
    scope: {
      type: 'tracks' | 'album' | 'artist' | 'playlist'
      label: string
      tracks: Array<{ id: number; title: string; artist: string; album: string; albumArtist: string; trackNumber: number | string; trackCount: number | string; discNumber: number | string; discCount: number | string; year: number | string; genre: string; duration: number }>
    }
    messages: { role: 'user' | 'assistant'; content: string }[]
  }): Promise<{
    ok: boolean
    text?: string
    investigation?: {
      summary: string
      fixes: Array<{ trackId: number; field: string; oldValue: unknown; newValue: unknown; reason: string }>
      missingTracks: Array<{ trackNumber: number; discNumber?: number; title: string; duration: number | null; reason: string }>
      rationale: string
    } | null
    error?: string
  }> => ipcRenderer.invoke('cynthia-chat', input),
  cynthiaReportToMusicMan: (payload: { rationale: string; summary?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cynthia-report-to-musicman', payload),
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
  getClaudeStats: (): Promise<{ ok: boolean; sessionCallCount: number; callsToday: number; dailyCeiling: number; lastResetDate: string; cachedKeys: string[] }> =>
    ipcRenderer.invoke('get-claude-stats'),
  analyzeTrack: (trackId: number, colonPath: string, fingerprint: string): Promise<{ ok: boolean; bpm?: number; keyRoot?: string; keyMode?: 'major' | 'minor' | ''; camelotKey?: string; error?: string }> =>
    ipcRenderer.invoke('analyze-track', trackId, colonPath, fingerprint),
  loadAppSettings: (): Promise<{ ok: boolean; settings: Record<string, unknown> | null }> =>
    ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('save-app-settings', settings),
  // Mobile snapshot export — see src/main/library-snapshot.ts. The
  // first call (no path saved) opens a Save dialog and persists the
  // chosen path; later calls reuse it. save-library auto-fires the
  // same writer when the path is configured, so manual export is
  // mostly a one-time setup action.
  exportLibrarySnapshot: (payload: {
    tracks: unknown[]
    playlists: unknown[]
  }): Promise<{ ok: boolean; canceled?: boolean; path?: string; trackCount?: number; bytes?: number; error?: string }> =>
    ipcRenderer.invoke('export-library-snapshot', payload),
  setClaudeDailyCeiling: (ceiling: number): Promise<{ ok: boolean; dailyCeiling: number }> =>
    ipcRenderer.invoke('set-claude-daily-ceiling', ceiling),
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
  // 4.4.12: import results now include an `artwork` field when the
  // imported file(s) had embedded album art that we successfully saved.
  // import-tracks de-duplicates by key (10 tracks from one album → one
  // artwork record). The renderer dispatches ADD_ARTWORK for each.
  importTracks: (filePaths: string[], nextId: number, format?: string): Promise<{
    ok: boolean
    tracks: unknown[]
    skippedDupes?: Array<{ src: string; matchedTitle: string; matchedArtist: string }>
    artwork?: Array<{ key: string; hash: string }>
  }> =>
    ipcRenderer.invoke('import-tracks', filePaths, nextId, format),
  // Single-file import for the renderer-side queue. Failures are
  // returned (not thrown) so the queue can mark and retry per item.
  importTrack: (srcPath: string, id: number, format?: string): Promise<{
    ok: boolean
    track?: unknown
    dupe?: { src: string; matchedTitle: string; matchedArtist: string }
    error?: string
    artwork?: { key: string; hash: string }
  }> =>
    ipcRenderer.invoke('import-track', srcPath, id, format),
  // 4.4.12: one-shot backfill for tracks imported before the import-time
  // extractor landed. Status check is cheap (single fs.stat); the
  // backfill itself is a longer-running parseFile loop that fires
  // `artwork-backfill-progress` events along the way.
  artworkBackfillStatus: (): Promise<{ ok: boolean; done: boolean }> =>
    ipcRenderer.invoke('artwork-backfill-status'),
  backfillEmbeddedArtwork: (tracks: Array<{ path: string; artist: string; album: string }>): Promise<{
    ok: boolean
    artwork?: Array<{ key: string; hash: string }>
    error?: string
  }> =>
    ipcRenderer.invoke('backfill-embedded-artwork', tracks),
  onArtworkBackfillProgress: (callback: (progress: { processed: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { processed: number; total: number }) => callback(progress)
    ipcRenderer.on('artwork-backfill-progress', handler)
    return () => { ipcRenderer.removeListener('artwork-backfill-progress', handler) }
  },
  // Resolve folders + glob filtering on the main side; renderer only
  // ever sees individual audio file paths in the queue.
  importResolvePaths: (paths: string[]): Promise<{ ok: boolean; paths?: string[]; error?: string }> =>
    ipcRenderer.invoke('import-resolve-paths', paths),
  importPickFiles: (): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('import-pick-files'),
  saveLibrary: (tracks: unknown[], playlists?: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-library', tracks, playlists),
  syncIpod: (existingIds: number[]): Promise<{ ok: boolean; newTracks: unknown[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }> =>
    ipcRenderer.invoke('sync-ipod', existingIds),
  syncToIpod: (tracks: unknown[], playlists: unknown[]): Promise<{ ok: boolean; copied?: number; copyErrors?: number; totalTracks?: number; error?: string; pathRewrites?: Array<{ id: number; newPath: string }> }> =>
    ipcRenderer.invoke('sync-to-ipod', tracks, playlists),
  onSyncProgress: (callback: (progress: { phase: 'copy' | 'preflight' | 'db'; current: number; total: number; title: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { phase: 'copy' | 'preflight' | 'db'; current: number; total: number; title: string }) => callback(progress)
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
  // 4.4.51 — auto-route-on-call. Renderer arms the mic-activity watcher
  // while music is playing + the feature is on; main polls and fires
  // call-state-changed on each mic on↔off flip.
  setCallWatch: (armed: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('set-call-watch', armed),
  onCallStateChanged: (callback: (state: { onCall: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: { onCall: boolean }) => callback(state)
    ipcRenderer.on('call-state-changed', handler)
    return () => { ipcRenderer.removeListener('call-state-changed', handler) }
  },
  // iPod Classic ALAC compatibility (File → Library → Fix iPod Compatibility…)
  alacCompatScan: (): Promise<{ ok: boolean; count?: number; samples?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('alac-compat-scan'),
  alacCompatFix: (): Promise<{ ok: boolean; error?: string; summary?: string }> =>
    ipcRenderer.invoke('alac-compat-fix'),
  onAlacCompatProgress: (callback: (p: { current: number; total: number; file: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: { current: number; total: number; file: string }) => callback(p)
    ipcRenderer.on('alac-compat-progress', handler)
    return () => { ipcRenderer.removeListener('alac-compat-progress', handler) }
  },
  // 4.1 Library Maintenance: ALAC play-cache management. Replaces the
  // launch-time prewarm scanner with explicit user-triggered actions.
  prepareAlacCache: (): Promise<{ ok: boolean; processed?: number; transcoded?: number; total?: number; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('prepare-alac-cache'),
  cancelAlacCache: (): void => { ipcRenderer.send('cancel-alac-cache') },
  onPrepareAlacCacheProgress: (callback: (p: { processed: number; transcoded: number; total: number; title: string; artist: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: { processed: number; transcoded: number; total: number; title: string; artist: string }) => callback(p)
    ipcRenderer.on('prepare-alac-cache:progress', handler)
    return () => { ipcRenderer.removeListener('prepare-alac-cache:progress', handler) }
  },
  pruneAlacCache: (): Promise<{ ok: boolean; pruned?: number; bytesFreed?: number; error?: string }> =>
    ipcRenderer.invoke('prune-alac-cache'),
  // Read the iPod's actual iTunesDB so the UI can show the real
  // device state (the "On This iPod" view from classic iTunes).
  getIpodDbTracks: (): Promise<{ ok: boolean; tracks: unknown[]; playlists: { name: string; trackIds: number[] }[]; total: number; error?: string }> =>
    ipcRenderer.invoke('get-ipod-db-tracks'),
  // Fires when library.json is modified on disk by something other than
  // the running app (e.g. a core/ Python maintenance script). The
  // renderer responds by calling loadTracks() and dispatching the fresh
  // state — preventing the "app overwrote the repair" class of bug.
  onLibraryExternalChange: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('library-external-change', handler)
    return () => { ipcRenderer.removeListener('library-external-change', handler) }
  },
  // 4.4.13 — Inbox auto-import. Main-side chokidar watches a folder
  // (default ~/Music2/_inbox) and emits `inbox-files-detected` with a
  // batched array of audio file paths whenever new files appear. App.tsx
  // subscribes once on mount and calls the same enqueueFiles() that
  // drag-and-drop uses, with deleteSourceOnSuccess set so the queue
  // worker removes each file from the inbox after a successful import.
  onInboxFilesDetected: (callback: (paths: string[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paths: string[]) => callback(paths)
    ipcRenderer.on('inbox-files-detected', handler)
    return () => { ipcRenderer.removeListener('inbox-files-detected', handler) }
  },
  // Called by the import queue worker after a successful (or dupe-skipped)
  // import of an inbox file. Main-side delete is path-gated to the
  // currently-watched inbox, so even a confused renderer can't ask main
  // to rm an arbitrary file.
  deleteInboxSource: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('delete-inbox-source', filePath),
  // SettingsModal uses this to show the resolved default path (~/Music2/_inbox)
  // as a placeholder when the user hasn't picked a custom location yet.
  getDefaultInboxPath: (): Promise<{ ok: boolean; path: string }> =>
    ipcRenderer.invoke('get-default-inbox-path'),
  // 4.4.18 — Library sync orchestrator status. Main fires this after
  // each sync run (post-import / post-metadata-edit / post-playlist /
  // 10-min safety-net tick). App.tsx maps the result to a setNotice
  // call so the user sees outcomes in NowPlaying's LCD-pill mode 4.
  onLibrarySyncStatus: (callback: (status: {
    ok: boolean
    reason: 'import' | 'metadata-edit' | 'playlist' | 'safety-net' | 'manual'
    error?: string
    durationMs?: number
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
    ipcRenderer.on('library-sync-status', handler)
    return () => { ipcRenderer.removeListener('library-sync-status', handler) }
  },

  // 4.4.28 — Home view: structured music news + notable releases from
  // the existing RSS infrastructure (Pitchfork BNA / Stereogum /
  // The Quietus). Both share a one-hour parsed cache in main, so
  // calling both from HomeView is one network round-trip per hour.
  getMusicNews: (): Promise<{ ok: boolean; items: Array<{ title: string; link: string; source: string; pubDate: string; imageUrl?: string; isReleaseReview: boolean }> }> =>
    ipcRenderer.invoke('get-music-news'),
  getNotableReleases: (): Promise<{ ok: boolean; items: Array<{ title: string; link: string; source: string; pubDate: string; imageUrl?: string; isReleaseReview: boolean }> }> =>
    ipcRenderer.invoke('get-notable-releases'),
  openExternalUrl: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('open-external-url', url),

  // 4.4.29 — Brooklyn weather for the Home view greeting (10-min cache
  // in main). Returns null weather if the OPENWEATHER_API_KEY isn't
  // configured; renderer should fall back to a date-only header.
  getBrooklynWeather: (): Promise<{ ok: boolean; weather: { tempF: number; condition: string; description: string } | null }> =>
    ipcRenderer.invoke('get-brooklyn-weather'),

  // 4.4.32 — Tour dates per Bandsintown for the user's top library
  // artists. First call on a cold cache takes a few seconds; subsequent
  // calls within 24h return instantly from main-side cache.
  getTourDates: (): Promise<{ ok: boolean; dates: Array<{ artist: string; date: string; venue: string; city: string; url: string; imageUrl?: string }> }> =>
    ipcRenderer.invoke('get-tour-dates'),

  // 4.4.34 — Upcoming releases (not yet out) for the user's top library
  // artists, via MusicBrainz release-group queries. Batched 25-OR
  // clauses per request so 60 artists = ~3 requests. 24h aggregate
  // cache in main; cold call ~2-4 sec.
  getUpcomingReleasesPersonal: (): Promise<{ ok: boolean; items: Array<{ title: string; artist: string; releaseDate: string; mbid: string; coverUrl: string }> }> =>
    ipcRenderer.invoke('get-upcoming-releases-personal'),

  // 4.4.40 — Per-artist photo via Bandsintown, with 30-day disk cache
  // (hit + miss tombstone) and single-flight gating in main. Returns
  // { ok: true, slug: '<slug>' | null }. The renderer loads photos via
  // the artist-image:// custom protocol scheme; this IPC just kicks
  // the fetch + tells the renderer when a slug is ready to render.
  getArtistImage: (artist: string): Promise<{ ok: boolean; slug: string | null }> =>
    ipcRenderer.invoke('get-artist-image', artist),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
