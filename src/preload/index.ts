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
  musicmanChat: (messages: { role: string; content: string }[]): Promise<{ ok: boolean; text: string; textRaw: string }> =>
    ipcRenderer.invoke('musicman-chat', messages),
  musicmanSpeak: (text: string, fast?: boolean, voiceId?: string): Promise<{ ok: boolean; audio?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-speak', text, fast, voiceId),
  musicmanDj: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen'): Promise<{ ok: boolean; text: string; transition?: 'talk' | 'scratch' | 'cut' }> =>
    ipcRenderer.invoke('musicman-dj', track, nextTrack, persona),
  // 4.5: streaming variant for the mic button. The renderer subscribes
  // to onMusicmanDjChunk before invoking; the resolved promise carries
  // the final text after the stream completes (or an error).
  musicmanDjStreaming: (track: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen'): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('musicman-dj-streaming', track, persona),
  onMusicmanDjChunk: (callback: (p: { chunk: string; accumulated: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { chunk: string; accumulated: string }) => callback(p)
    ipcRenderer.on('musicman-dj-chunk', handler)
    return () => { ipcRenderer.removeListener('musicman-dj-chunk', handler) }
  },
  // 4.5: hover-prefetch from the mic button — warms the per-artist
  // facts cache so the streaming Claude call starts ~500-1500ms sooner
  // on the subsequent click. Fire-and-forget.
  musicmanPrefetchFacts: (track: { artist: string; album: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('musicman-prefetch-facts', track),
  // 4.5: fired from main's before-quit handler, ~180ms before app
  // actually exits. Renderer uses this window to fade Howler volumes
  // to 0 so the OS doesn't snap audio buffers mid-waveform on cmd+Q.
  onAppQuitFade: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('app-quit-fade', handler)
    return () => { ipcRenderer.removeListener('app-quit-fade', handler) }
  },
  // 4.5: per-artist canonical discography from MusicBrainz, 7-day
  // disk cache. ArtistDetailView drill-down uses this to show
  // "owned vs not owned" per track for each album.
  getArtistDiscography: (artist: string): Promise<{ ok: boolean; albums?: Array<{ title: string; year: string; tracks: Array<{ title: string; position: number }> }>; error?: string }> =>
    ipcRenderer.invoke('get-artist-discography', artist),
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
  // 4.5: playlist track payload extended with playCount/rating/
  // lastPlayedAt/dateAdded so the Music Man can weight picks by your
  // actual taste, not just metadata. Optional on inbound so existing
  // call sites that haven't been updated still compile.
  musicmanPlaylist: (mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[]): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-playlist', mood, tracks),
  // 4.5: "Your Mixes" — fetch the SAME daily mixes / on-demand vibe the iOS app
  // shows, from the mobile backend on homemini (one source of truth).
  getMobileMixes: (): Promise<{ ok: boolean; date?: string; mixes?: Array<{ id: string; title: string; subtitle: string; trackIds: number[] }>; error?: string }> =>
    ipcRenderer.invoke('get-mobile-mixes'),
  getMobileVibeMix: (vibe: string): Promise<{ ok: boolean; mix?: { id: string; title: string; subtitle: string; trackIds: number[] }; error?: string }> =>
    ipcRenderer.invoke('get-mobile-vibe-mix', vibe),
  // 4.5: Radio Mode show planner. Generates a curated set list with a
  // theme + throughline before Radio playback starts, replacing the
  // random library shuffle that produced "jumpy with genres" shows.
  musicmanRadioPlan: (tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[], recentPlayedIds: number[]): Promise<{ ok: boolean; theme?: string; throughline?: string; trackIds?: number[]; error?: string }> =>
    ipcRenderer.invoke('musicman-radio-plan', tracks, recentPlayedIds),
  // 4.5: persist the planner's output to main-side radio-memory so
  // per-segment commentary can reference theme + throughline + arc
  // position. Clear on Radio toggle OFF.
  radioSetShowPlan: (plan: { theme: string; throughline: string; setList: { id: number; title: string; artist: string }[] }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('radio-set-show-plan', plan),
  radioClearShowPlan: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('radio-clear-show-plan'),
  // 4.5 radioV2: fetch the unified cast registry (speaker id → tag / pill label / voice id).
  radioGetCast: (): Promise<{ ok: boolean; cast?: Array<{ id: string; tag: string; label: string; voiceId?: string; kind: string }> }> =>
    ipcRenderer.invoke('radio-get-cast'),
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
  // Cynthia overhaul — background-sweep surface: precomputed findings,
  // dismissals, the auto-apply ledger (+revert), sweep status, progress.
  cynthiaGetFindings: (albumKeys: string[]): Promise<{ ok: boolean; findings: Record<string, { albumKey: string; albumLabel: string; scannedAt: number; findings: Array<{ trackId: number; field: string; oldValue: string; newValue: string; reason: string; source: string; confidence: string; provable: boolean }>; missingTracks: Array<{ trackNumber: number; discNumber: number; title: string; duration: number | null; reason: string }>; flags: Array<{ kind: string; detail: string }>; autoAppliedCount: number }> }> =>
    ipcRenderer.invoke('cynthia-get-findings', albumKeys),
  cynthiaDismissFix: (fix: { trackId: number; field: string; newValue: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cynthia-dismiss-fix', fix),
  cynthiaGetLedger: (limit?: number): Promise<{ ok: boolean; entries: Array<{ id: string; at: number; albumKey: string; albumLabel: string; trackId: number; field: string; oldValue: string; newValue: string; reason: string; source: string; reverted?: boolean }> }> =>
    ipcRenderer.invoke('cynthia-get-ledger', limit),
  cynthiaRevertLedgerEntry: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cynthia-revert-ledger-entry', id),
  cynthiaSweepStatus: (): Promise<{ ok: boolean; swept: number; queued: number; withFindings: number; autoAppliedTotal: number; lastSweptAt: number | null }> =>
    ipcRenderer.invoke('cynthia-sweep-status'),
  onCynthiaSweepProgress: (callback: (progress: { swept: number; total: number; withFindings: number; autoApplied: Array<{ trackId: number; field: string; newValue: string }>; currentAlbum?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { swept: number; total: number; withFindings: number; autoApplied: Array<{ trackId: number; field: string; newValue: string }>; currentAlbum?: string }) => callback(progress)
    ipcRenderer.on('cynthia-sweep:progress', handler)
    return () => { ipcRenderer.removeListener('cynthia-sweep:progress', handler) }
  },
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
  // 4.5.0-81 — 2-way stars: renderer asks main for the merged set of
  // trackIds the mobile app has starred (read from mobile-stars.json
  // sidecar). Desktop App.tsx calls this on startup + after every
  // sync-success event and bumps each track's rating to ≥1 so the
  // Starred smart playlist + inline-star UI light up. Desktop-side
  // stars also write to the same file (via save-metadata-override's
  // hook in main), so the file is the single source of truth that
  // sync replicates bidirectionally.
  loadMobileStars: (): Promise<{ ok: boolean; trackIds: string[] }> =>
    ipcRenderer.invoke('load-mobile-stars'),
  // Brief 121 — iOS-created playlists + iOS-side additions to V3
  // playlists. Both files live next to library.json on the NAS; the
  // mobile backend owns them, V3 is read-only. Always resolves; missing
  // or torn files return empty defaults.
  loadMobilePlaylists: (): Promise<{ ok: boolean; playlists: Array<{ id: string; name: string; trackIds: string[]; createdAt?: string; source?: string }> }> =>
    ipcRenderer.invoke('read-mobile-playlists'),
  loadPlaylistAdditions: (): Promise<{ ok: boolean; additions: Record<string, string[]> }> =>
    ipcRenderer.invoke('read-playlist-additions'),
  // Brief 122 — "Listen to the List". Read mirrors recommendations.json
  // (next to library.json on the NAS); add/delete route through the Mini
  // backend so it stays the single writer.
  loadRecommendations: () => ipcRenderer.invoke('read-recommendations'),
  addRecommendation: (input: { song?: string; artist?: string; album?: string; note?: string; source?: 'user' | 'mm' | 'radar'; from?: string; link?: string }) =>
    ipcRenderer.invoke('add-recommendation', input),
  deleteRecommendation: (id: string) => ipcRenderer.invoke('delete-recommendation', id),
  // Brief 126 — main pushes when the mirror changed (60s timer / mutations);
  // the renderer refetches instead of polling.
  onRecommendationsUpdated: (callback: (info: { reason: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { reason: string }) => callback(info)
    ipcRenderer.on('recommendations-updated', handler)
    return () => { ipcRenderer.removeListener('recommendations-updated', handler) }
  },
  // Brief 122 — Music Man suggests 3 things to add to the list.
  suggestRecommendations: (opts?: { force?: boolean }) => ipcRenderer.invoke('suggest-recommendations', opts),
  // Brief 122 Phase 2 — iTunes Search autocomplete for the add form.
  searchItunes: (query: string) => ipcRenderer.invoke('search-itunes', query),
  // Artist-verified cover art for radar/discovery cards (no wrong covers).
  lookupRecoArtwork: (input: { artist: string; title: string }) => ipcRenderer.invoke('lookup-reco-artwork', input),
  // 4.5.0-115 — album detail page: factual credits + Music Man blurb.
  getAlbumInfo: (artist: string, album: string, year?: string) => ipcRenderer.invoke('get-album-info', artist, album, year),
  getAlbumBlurb: (artist: string, album: string, year?: string | number) => ipcRenderer.invoke('get-album-blurb', artist, album, year),
  getAlbumTake: (artist: string, album: string, year?: string | number) => ipcRenderer.invoke('get-album-take', artist, album, year),
  // 4.5.0-117 — library backup/restore (Phase 0).
  listBackups: () => ipcRenderer.invoke('list-backups'),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  restoreBackup: (file: string) => ipcRenderer.invoke('restore-backup', file),
  // 4.5.0-118 — Discovery Brain Phase 1: taste fingerprint.
  getTasteFingerprint: () => ipcRenderer.invoke('get-taste-fingerprint'),
  loadArtistAliases: () => ipcRenderer.invoke('load-artist-aliases'),
  saveArtistAliases: (aliases: Record<string, string>) => ipcRenderer.invoke('save-artist-aliases', aliases),
  classifyArtistGroups: () => ipcRenderer.invoke('classify-artist-groups'),
  getRelatedArtists: (artist: string) => ipcRenderer.invoke('get-related-artists', artist),
  // 4.5.0-118 — Discovery Brain Phase 2: new-music radar.
  getNewMusicRadar: (force?: boolean) => ipcRenderer.invoke('get-new-music-radar', force),
  discoveryNotForMe: (artist: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('discovery-not-for-me', artist),
  getFriends: (): Promise<{ ok: boolean; friends: Array<{ name: string; adds: number; got: number; tossed: number; lastAt: number }> }> => ipcRenderer.invoke('get-friends'),
  friendEvent: (name: string, ev: 'add' | 'got' | 'tossed'): Promise<{ ok: boolean }> => ipcRenderer.invoke('friend-event', name, ev),
  captureResolveLink: (url: string): Promise<{ ok: boolean; kind?: string; title?: string; artist?: string; raw?: string }> => ipcRenderer.invoke('capture-resolve-link', url),
  getContacts: (): Promise<{ ok: boolean; names: string[] }> => ipcRenderer.invoke('get-contacts'),
  // 2026-07-19 — iMessage capture: texted Spotify/Apple Music links auto-land
  // on the list. Status drives the one-time Full Disk Access setup hint.
  imessageCaptureStatus: (): Promise<{ ok: boolean; access: 'granted' | 'denied' | 'unknown'; lastScanAt?: string; error?: string; pending: number; recent: Array<{ url: string; song?: string; artist?: string; album?: string; from?: string; at: string; status: string }> }> =>
    ipcRenderer.invoke('imessage-capture-status'),
  imessageCaptureScanNow: (): Promise<{ ok: boolean; access: 'granted' | 'denied' | 'unknown' }> => ipcRenderer.invoke('imessage-capture-scan'),
  getDiscoverFeed: (force?: boolean): Promise<{ ok: boolean; lanes?: Array<{ id: string; title: string; cards: Array<{ lane: string; type: 'song' | 'album' | 'artist'; artist: string; title: string; year?: string; why: string; artUrl?: string; previewUrl?: string; brainPct?: number }> }>; generatedAt?: number; cached?: boolean; error?: string }> => ipcRenderer.invoke('get-discover-feed', force),
  onDiscoverFeedUpdated: (callback: (p: { lanes: Array<{ id: string; title: string; cards: Array<{ lane: string; type: 'song' | 'album' | 'artist'; artist: string; title: string; year?: string; why: string; artUrl?: string; previewUrl?: string; brainPct?: number }> }>; generatedAt: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { lanes: Array<{ id: string; title: string; cards: Array<{ lane: string; type: 'song' | 'album' | 'artist'; artist: string; title: string; year?: string; why: string; artUrl?: string; previewUrl?: string; brainPct?: number }> }>; generatedAt: number }) => callback(p)
    ipcRenderer.on('discover-feed-updated', handler)
    return () => { ipcRenderer.removeListener('discover-feed-updated', handler) }
  },
  // 4.5.0-82 — windowed play counts derived from the per-play event
  // log. Returns { trackIdString: count } for plays in the last
  // `windowMs` ms. Used by Top 25's Last Week / Last Month views to
  // rank by ACTUAL plays in the window, not lifetime playCount.
  getWindowedPlayCounts: (windowMs: number): Promise<{ ok: boolean; counts: Record<string, number> }> =>
    ipcRenderer.invoke('get-windowed-play-counts', windowMs),
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
  // Brief 010 Phase 3 + Brief 014a: subscribe to worker progress. Fires
  // once per completed job with the current remaining count AND the
  // per-track analysis result so the renderer can dispatch UPDATE_TRACKS
  // and the audioAnalysisCounts memo recomputes in real time. The
  // per-track fields are optional — a job skipped at the librosa gate
  // emits only `remaining`. Returns an unsubscribe function.
  onAudioAnalysisProgress: (callback: (p: {
    remaining: number
    trackId?: number
    audioAnalysisAt?: number
    bpm?: number | null
    keyRoot?: string | null
    keyMode?: 'major' | 'minor' | '' | null
    camelotKey?: string | null
    ok?: boolean
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: {
      remaining: number
      trackId?: number
      audioAnalysisAt?: number
      bpm?: number | null
      keyRoot?: string | null
      keyMode?: 'major' | 'minor' | '' | null
      camelotKey?: string | null
      ok?: boolean
    }) => callback(p)
    ipcRenderer.on('audio-analysis:progress', handler)
    return () => { ipcRenderer.removeListener('audio-analysis:progress', handler) }
  },
  // Brief 010 Phase 4: queue-based backfill. Renderer sends jobs with
  // colon-paths; main resolves to absolute paths and enqueues. Status
  // poll fills in playback-paused state (no event for that — the worker
  // just keeps polling its own gate).
  audioAnalysisEnqueueMany: (jobs: Array<{ trackId: number; colonPath: string; fingerprint: string }>): Promise<{ ok: boolean; enqueued: number; totalQueued: number }> =>
    ipcRenderer.invoke('audio-analysis:enqueue-many', jobs),
  audioAnalysisStatus: (): Promise<{ ok: boolean; queueLength: number; workerRunning: boolean; isPlaybackActive: boolean }> =>
    ipcRenderer.invoke('audio-analysis:status'),
  audioAnalysisClearQueue: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('audio-analysis:clear-queue'),
  loadAppSettings: (): Promise<{ ok: boolean; settings: Record<string, unknown> | null }> =>
    ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('save-app-settings', settings),
  // 4.5: settings UI reads this on the Sync tab to show "Last backup:
  // X ago" instead of chirping every successful sync in the pill.
  getLastLibrarySync: (): Promise<{
    ok: boolean | null
    reason: string | null
    at: number | null
    durationMs: number | null
    error: string | null
    scriptPresent: boolean
  }> =>
    ipcRenderer.invoke('get-last-library-sync'),
  // 4.5.0-83 — count of user-locked covers. Surfaced in Settings →
  // Library so the user can verify their hand-set artwork is
  // protected without having to grep Console.app for the launch line.
  getArtworkLockCount: (): Promise<{ ok: boolean; count: number }> =>
    ipcRenderer.invoke('get-artwork-lock-count'),
  // 4.5.0-91 — Phase 2.5 storage-mode + conflict surface for the UI.
  getStateConflicts: (): Promise<{
    mode: 'NAS' | 'local-primary';
    nasDir: string;
    localDir: string;
    nasMounted: boolean;
    conflicts: Array<{ file: string; localMtimeMs: number; nasMtimeMs: number; localPath: string; nasPath: string; localSizeBytes: number }>;
  }> => ipcRenderer.invoke('get-state-conflicts'),
  reconcileStateConflicts: (): Promise<{ ok: boolean; pushed: number; backups: string[]; error?: string }> =>
    ipcRenderer.invoke('reconcile-state-conflicts'),
  onReconcileStateProgress: (callback: (p: {
    phase: 'backup' | 'push' | 'verify'
    file: string
    index: number
    total: number
    localSizeBytes?: number
    totalBytes: number
  }) => void): () => void => {
    const handler = (_e: unknown, p: {
      phase: 'backup' | 'push' | 'verify'
      file: string
      index: number
      total: number
      localSizeBytes?: number
      totalBytes: number
    }) => callback(p)
    ipcRenderer.on('reconcile-state-progress', handler)
    return () => ipcRenderer.removeListener('reconcile-state-progress', handler)
  },
  // 4.5.0-87 — RAG (per-track embeddings + cosine retrieval) status +
  // backfill controls. Settings → Library exposes both.
  embeddingStatus: (): Promise<{ configured: boolean; count: number; total: number; stale: number }> =>
    ipcRenderer.invoke('embedding-status'),
  embeddingBackfill: (opts?: { force?: boolean }): Promise<{ ok: boolean; embedded: number; total: number; error?: string }> =>
    ipcRenderer.invoke('embedding-backfill', opts),
  // 4.5: brain-driven playlist suggestions — the playlist's embedding centroid's
  // nearest library tracks (vibe match). PlaylistView's "Suggested" strip filters
  // these for freshness + diversity instead of the old artist-match heuristic.
  playlistSimilar: (playlistIds: number[], clusters?: number): Promise<{ ok: boolean; hits: Array<{ trackId: number; score: number; cluster: number }> }> =>
    ipcRenderer.invoke('playlist-similar', playlistIds, clusters),
  onEmbeddingBackfillProgress: (callback: (p: { done: number; total: number }) => void): () => void => {
    const handler = (_e: unknown, p: { done: number; total: number }) => callback(p)
    ipcRenderer.on('embedding-backfill-progress', handler)
    return () => ipcRenderer.removeListener('embedding-backfill-progress', handler)
  },
  // Brief 023: removed exportLibrarySnapshot / mobileOverridesPickFile /
  // mobileOverridesApply — vestigial mobile-sync feature that never
  // shipped. Plex (via Brief 020 tag write-back) is the mobile path now.
  setClaudeDailyCeiling: (ceiling: number): Promise<{ ok: boolean; dailyCeiling: number }> =>
    ipcRenderer.invoke('set-claude-daily-ceiling', ceiling),
  fetchAlbumArt: (artist: string, album: string, force?: boolean): Promise<{ ok: boolean; key?: string; hash?: string; error?: string }> =>
    ipcRenderer.invoke('fetch-album-art', artist, album, force),
  setCustomArtwork: (artist: string, album: string, imagePath: string): Promise<{ ok: boolean; key?: string; hash?: string; error?: string }> =>
    ipcRenderer.invoke('set-custom-artwork', artist, album, imagePath),
  removeArtwork: (artist: string, album: string, force?: boolean): Promise<{ ok: boolean; key?: string; locked?: boolean; error?: string }> =>
    ipcRenderer.invoke('remove-artwork', artist, album, force),
  chooseArtworkFile: (): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('choose-artwork-file'),
  getTrackLyrics: (trackId: number): Promise<{ ok: boolean; plain?: string; synced?: string; instrumental?: boolean }> =>
    ipcRenderer.invoke('get-track-lyrics', trackId),
  loadArtworkMap: (): Promise<{ ok: boolean; map: Record<string, string> }> =>
    ipcRenderer.invoke('load-artwork-map'),
  // 4.5.0-51: server-authoritative artwork resolver — used when the
  // renderer's in-memory map misses for an (artist, album) pair. Main
  // runs the full chain (exact key → normalized → recompute hash + disk
  // existence check) and returns the hash if the JPG is reachable.
  resolveArtwork: (artist: string, album: string): Promise<{ ok: boolean; hash: string | null }> =>
    ipcRenderer.invoke('resolve-artwork', artist, album),
  migrateArtworkKey: (oldArtist: string, oldAlbum: string, newArtist: string, newAlbum: string): Promise<{ ok: boolean; migrated?: boolean; hash?: string }> =>
    ipcRenderer.invoke('migrate-artwork-key', oldArtist, oldAlbum, newArtist, newAlbum),
  checkIpodMounted: (): Promise<{ mounted: boolean; name: string | null }> =>
    ipcRenderer.invoke('check-ipod-mounted'),
  getIpodCapacity: (): Promise<{ ok: boolean; totalBytes?: number; freeBytes?: number; mount?: string; error?: string }> =>
    ipcRenderer.invoke('get-ipod-capacity'),
  getMusicLibraryPath: (): Promise<string> =>
    ipcRenderer.invoke('get-music-library-path'),
  // Spotify-style offline "Download" (streaming/cache machines only)
  trackLocalState: (ipodPath: string): Promise<'local' | 'streamed' | 'unknown'> =>
    ipcRenderer.invoke('track-local-state', ipodPath),
  loadDownloadsState: (): Promise<{ pinned: string[]; streaming: boolean }> =>
    ipcRenderer.invoke('load-downloads-state'),
  downloadTrack: (ipodPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('download-track', ipodPath),
  removeDownload: (ipodPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('remove-download', ipodPath),
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
  // Brief 020: batch backfill of writable overrides into embedded file
  // tags so Plex sees user edits. Invoked from the
  // "Library → Apply Overrides to Files…" menu. Per-edit write-back
  // happens automatically inside save-metadata-override; no renderer-
  // side IPC for that case.
  applyOverridesBatch: (): Promise<{
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
  }> =>
    ipcRenderer.invoke('apply-overrides-batch'),
  onTagWritebackProgress: (callback: (p: { done: number; total: number; succeeded: number; failed: number; currentPath?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: { done: number; total: number; succeeded: number; failed: number; currentPath?: string }) => callback(p)
    ipcRenderer.on('tag-writeback:progress', handler)
    return () => { ipcRenderer.removeListener('tag-writeback:progress', handler) }
  },
  // Brief 016 commit 2: full-library fileSize refresh. Walks every
  // track, stats the on-disk file, updates library.json.fileSize if
  // it differs from the cached value. Use case is one-shot retrofit
  // of pre-existing drift (Brief 016 diagnostic found 29.7% of tracks
  // had stale fileSize, likely from a historical re-encode pass).
  refreshFileSizes: (): Promise<{ ok: boolean; refreshed?: number; error?: string }> =>
    ipcRenderer.invoke('refresh-file-sizes'),
  onRefreshFileSizesProgress: (callback: (p: { scanned: number; refreshed: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: { scanned: number; refreshed: number; total: number }) => callback(p)
    ipcRenderer.on('refresh-file-sizes:progress', handler)
    return () => { ipcRenderer.removeListener('refresh-file-sizes:progress', handler) }
  },
  // Resolve folders + glob filtering on the main side; renderer only
  // ever sees individual audio file paths in the queue.
  importResolvePaths: (paths: string[]): Promise<{ ok: boolean; paths?: string[]; error?: string }> =>
    ipcRenderer.invoke('import-resolve-paths', paths),
  importPickFiles: (): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('import-pick-files'),
  saveLibrary: (tracks: unknown[], playlists?: unknown[]): Promise<{ ok: boolean; deletedPaths?: number; preservedOrphanCount?: number; error?: string }> =>
    ipcRenderer.invoke('save-library', tracks, playlists),
  syncIpod: (existingIds: number[]): Promise<{ ok: boolean; newTracks: unknown[]; playlists: { name: string; trackIds: number[] }[]; totalIpod: number; error?: string }> =>
    ipcRenderer.invoke('sync-ipod', existingIds),
  // 4.5: third arg `convertOptions` enables iTunes-style "Convert
  // higher bit rate songs to N kbps AAC" at sync time. Lossless
  // sources are transcoded + cached; their iPod destination filename
  // is rewritten to .m4a and the iTunesDB entry updated. Optional —
  // omitted means original-quality copy (legacy behavior).
  syncToIpod: (tracks: unknown[], playlists: unknown[], convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }): Promise<{ ok: boolean; copied?: number; copyErrors?: number; totalTracks?: number; error?: string; cancelled?: boolean; pathRewrites?: Array<{ id: number; newPath: string }> }> =>
    ipcRenderer.invoke('sync-to-ipod', tracks, playlists, convertOptions),
  // 4.5.0-109: cancel an in-flight sync. Main flips a flag; the copy
  // loop checks it between files and bails with cancelled:true.
  cancelSync: (): Promise<{ ok: boolean; wasRunning: boolean }> =>
    ipcRenderer.invoke('cancel-sync'),
  buildWorkoutSyncSet: (tracks: Array<{
    id: number; title?: string; artist?: string; album?: string; genre?: string; year?: string | number
    playCount?: number; skipCount?: number; rating?: number; bpm?: number | null; codec?: string; fileSize?: number
  }>, opts?: { target?: number; brief?: Record<string, unknown>; saveProfile?: boolean }): Promise<{
    ok: boolean
    trackIds?: number[]
    name?: string
    commentary?: string
    alacCount?: number
    total?: number
    rotatedFrom?: number
    weather?: { tempF: number; condition: string; description: string; placeLabel: string } | null
    brief?: Record<string, unknown>
    error?: string
  }> => ipcRenderer.invoke('build-workout-sync-set', tracks, opts),
  listMixtapes: (): Promise<{ ok: boolean; mixtapes: unknown[] }> =>
    ipcRenderer.invoke('mixtapes-list'),
  buildMixtape: (tracks: unknown[], tapeLength: 60 | 90 | 120, dedication?: string, note?: string): Promise<{ ok: boolean; title?: string; commentary?: string; sideA?: number[]; sideB?: number[]; sideACutMs?: number; sideBCutMs?: number; linerNotes?: Array<{ id: number; note: string }>; leftovers?: number[]; sideBudgetMs?: number; error?: string }> =>
    ipcRenderer.invoke('build-mixtape', tracks, tapeLength, dedication, note),
  saveMixtape: (tape: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mixtape-save', tape),
  deleteMixtape: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mixtape-delete', id),
  dubMixtape: (payload: unknown): Promise<{ ok: boolean; outputs?: string[]; dir?: string; error?: string }> =>
    ipcRenderer.invoke('dub-mixtape', payload),
  saveMixtapeIntro: (data: ArrayBuffer, voiceId?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('save-mixtape-intro', data, voiceId),
  listMixtapeVoices: (): Promise<{ ok: boolean; voices: Array<{ id: string; name: string }> }> =>
    ipcRenderer.invoke('mixtape-voices'),
  previewIpodSync: (tracks: unknown[], convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }): Promise<{ ok: boolean; plan: Array<{ id: number; action: 'keep' | 'copy' }>; leaving: Array<{ path: string; title: string; artist: string }>; deviceFileCount?: number; error?: string }> =>
    ipcRenderer.invoke('preview-ipod-sync', tracks, convertOptions),
  commitWorkoutSyncSet: (payload: { trackIds: number[]; name: string; commentary: string; alacCount: number; brief: Record<string, unknown>; weather?: unknown; added?: Array<{ id: number; title: string; artist: string }>; removed?: Array<{ id: number; title: string; artist: string }> }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('commit-workout-sync-set', payload),
  getWorkoutSyncState: (): Promise<{ ok: boolean; state?: { trackIds: number[]; name: string; commentary: string; syncedAt: string; alacCount: number } | null }> =>
    ipcRenderer.invoke('get-workout-sync-state'),
  getActivityProfiles: (): Promise<{ ok: boolean; profiles?: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('get-activity-profiles'),
  getActivityBrainContext: (): Promise<{ ok: boolean; context?: unknown; promptBlock?: string }> =>
    ipcRenderer.invoke('get-activity-brain-context'),
  previewPlaceWeather: (place: string): Promise<{ ok: boolean; weather?: { tempF: number; condition: string; description: string; placeLabel?: string } | null }> =>
    ipcRenderer.invoke('preview-place-weather', place),
  onSyncProgress: (callback: (progress: { phase: 'copy' | 'preflight' | 'db' | 'cancelled'; current: number; total: number; title: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { phase: 'copy' | 'preflight' | 'db' | 'cancelled'; current: number; total: number; title: string }) => callback(progress)
    ipcRenderer.on('sync-progress', handler)
    return () => { ipcRenderer.removeListener('sync-progress', handler) }
  },
  onStateSaveLocked: (callback: (info: { reason: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { reason: string }) => callback(info)
    ipcRenderer.on('state-save-locked', handler)
    return () => { ipcRenderer.removeListener('state-save-locked', handler) }
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
  // V5 Live Concert Mode — merge a declared live album into one gapless
  // ALAC "live set" + per-song cue offsets; sidecar CRUD; scratch cleanup.
  liveSetMerge: (
    tracks: Array<{ id: number; title: string; artist: string; path: string; durationMs: number }>,
    album: { name: string; artist: string; genre?: string; year?: string | number },
  ): Promise<{ ok: boolean; mergedPath?: string; cues?: Array<{ trackId: number; title: string; artist: string; startMs: number; durationMs: number }>; totalDurationMs?: number; error?: string }> =>
    ipcRenderer.invoke('live-set-merge', tracks, album),
  onLiveSetProgress: (callback: (progress: { stage: 'decode' | 'concat' | 'encode'; current: number; total: number; label: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { stage: 'decode' | 'concat' | 'encode'; current: number; total: number; label: string }) => callback(progress)
    ipcRenderer.on('live-set-progress', handler)
    return () => { ipcRenderer.removeListener('live-set-progress', handler) }
  },
  loadLiveSets: (): Promise<{ ok: boolean; sets: Record<string, { mergedTrackId: number; cues: Array<{ trackId: number; title: string; artist: string; startMs: number; durationMs: number }>; totalDurationMs: number; createdAt: string }> }> =>
    ipcRenderer.invoke('load-live-sets'),
  saveLiveSet: (albumKey: string, entry: { mergedTrackId: number; cues: Array<{ trackId: number; title: string; artist: string; startMs: number; durationMs: number }>; totalDurationMs: number; createdAt: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('save-live-set', albumKey, entry),
  removeLiveSet: (albumKey: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('remove-live-set', albumKey),
  getConcertCrowd: (mergedTrackId: number): Promise<string | null> =>
    ipcRenderer.invoke('get-concert-crowd', mergedTrackId),
  saveCrowdTuning: (t: Record<string, number>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('save-crowd-tuning', t),
  loadCrowdTuning: (): Promise<Record<string, number> | null> =>
    ipcRenderer.invoke('load-crowd-tuning'),
  liveSetCleanup: (absPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('live-set-cleanup', absPath),
  openSoundSettings: (): Promise<void> =>
    ipcRenderer.invoke('open-sound-settings'),
  recordPlay: (track: { title: string; artist: string; album: string; genre: string; pct?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('record-play', track),
  recordSkip: (track: { title: string; artist: string; pct?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('record-skip', track),
  // Brain #1 — listening memory (streaks/habits computed from the play log).
  getListeningMemory: () => ipcRenderer.invoke('get-listening-memory'),
  // Brain — Rediscover: owned-but-overlooked library picks + Music Man's pitch.
  getRediscovery: (force?: boolean) => ipcRenderer.invoke('get-rediscovery', force),
  // SCOTUS Archive — Poppy's Beck v. Prupis exhibit (one-of-one, not a song).
  scotusGetArchive: () => ipcRenderer.invoke('scotus:get-archive'),
  scotusGetAudio: () => ipcRenderer.invoke('scotus:get-audio'),
  scotusAmicus: (input: { mode: 'explain' | 'ask'; time?: number; question?: string; history?: Array<{ role: string; text: string }> }) =>
    ipcRenderer.invoke('scotus:amicus', input),
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
  scanLibraryOrphans: (): Promise<{
    ok: boolean
    trackCount?: number
    diskCount?: number
    orphanCount?: number
    orphanBytes?: number
    samples?: Array<{ basename: string; mtimeMs: number; size: number }>
    error?: string
  }> => ipcRenderer.invoke('scan-library-orphans'),
  purgeLibraryOrphans: (): Promise<{ ok: boolean; deleted?: number; bytesFreed?: number; error?: string }> =>
    ipcRenderer.invoke('purge-library-orphans'),
  scanDeadTracks: (): Promise<{
    ok: boolean
    count?: number
    tracks?: Array<{ id: number; title: string; artist: string; path: string }>
    error?: string
  }> => ipcRenderer.invoke('scan-dead-tracks'),
  removeDeadTracks: (): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('remove-dead-tracks'),
  // Read the iPod's actual iTunesDB so the UI can show the real
  // device state (the "On This iPod" view from classic iTunes).
  brainStatus: (): Promise<Record<string, unknown> & { ok: boolean }> =>
    ipcRenderer.invoke('brain-status'),
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

  // ── Bandcamp Store v4 (embedded WebContentsView lifecycle) ──
  bandcampMount: (bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: true }> =>
    ipcRenderer.invoke('bandcamp:mount', bounds),
  bandcampResize: (bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: true }> =>
    ipcRenderer.invoke('bandcamp:resize', bounds),
  bandcampSetVisible: (visible: boolean): Promise<{ ok: true }> =>
    ipcRenderer.invoke('bandcamp:set-visible', visible),
  bandcampUnmount: (): Promise<{ ok: true }> => ipcRenderer.invoke('bandcamp:unmount'),
  // 4.5.0-47: Bandcamp in-browser nav controls so the renderer can paint
  // a real back arrow above the embedded WebContentsView.
  bandcampNavState: (): Promise<{ ok: boolean; canGoBack: boolean; canGoForward: boolean }> =>
    ipcRenderer.invoke('bandcamp:nav-state'),
  bandcampGoBack: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('bandcamp:go-back'),
  bandcampGoForward: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('bandcamp:go-forward'),
  // ── streamrip download store (paste-a-link → rip CLI → import) ──
  streamripStatus: (): Promise<{ ok: boolean; installed?: boolean; version?: string }> =>
    ipcRenderer.invoke('streamrip:status'),
  streamripDownload: (url: string): Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string }> =>
    ipcRenderer.invoke('streamrip:download', url),
  streamripSearch: (opts: { query: string; source?: string; mediaType?: string; numResults?: number }): Promise<{ ok: boolean; results?: Array<{ source: string; mediaType: string; id: string; desc: string }>; error?: string }> =>
    ipcRenderer.invoke('streamrip:search', opts),
  streamripDownloadId: (source: string, mediaType: string, id: string): Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string }> =>
    ipcRenderer.invoke('streamrip:download-id', source, mediaType, id),
  streamripDownloadByQuery: (opts: { artist?: string; title?: string; song?: string; album?: string }): Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string; matchDesc?: string }> =>
    ipcRenderer.invoke('streamrip:download-by-query', opts),
  streamripCancelActive: (): Promise<{ ok: boolean; killed: number }> =>
    ipcRenderer.invoke('streamrip:cancel-active'),
  streamripGetQobuz: (): Promise<{ ok: boolean; configured: boolean; email?: string }> =>
    ipcRenderer.invoke('streamrip:get-qobuz'),
  streamripSetQobuz: (email: string, password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('streamrip:set-qobuz', email, password),
  streamripSetQobuzToken: (userId: string, token: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('streamrip:set-qobuz-token', userId, token),

  // ── Music Man's Record Store (Brief 037) ──
  // Phase 0: get-shelves returns a heuristic ShelfBundle; blurb/speak/
  // cancel are wired but stubbed. Phase 1 swaps in the LLM-driven
  // curator; Phase 2 adds the scene/FSM/TTS layer.
  recordStore: {
    getShelves: (opts?: { forceRefresh?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('record-store:get-shelves', opts ?? {}),
    getBlurb: (args: { itemId: string; persona: 'music-man' | 'megan' | 'stephen-hands' }): Promise<unknown> =>
      ipcRenderer.invoke('record-store:get-blurb', args),
    speakBlurb: (args: { blurb: unknown }): Promise<{ ok: true; audioId: string }> =>
      ipcRenderer.invoke('record-store:speak-blurb', args),
    cancelSpeech: (args: { audioId: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('record-store:cancel-speech', args),
  },
  // ── Bandcamp Store v4 (download -> library events) ──
  onBandcampTrackImported: (callback: (track: { id?: number; title?: string; artist?: string; album?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, t: { id?: number; title?: string; artist?: string; album?: string }) => callback(t)
    ipcRenderer.on('bandcamp:track-imported', handler)
    return () => { ipcRenderer.removeListener('bandcamp:track-imported', handler) }
  },
  onBandcampImportFailed: (callback: (reason: { filename: string; error: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, r: { filename: string; error: string }) => callback(r)
    ipcRenderer.on('bandcamp:import-failed', handler)
    return () => { ipcRenderer.removeListener('bandcamp:import-failed', handler) }
  },
  // 4.5.0-46: per-FILE failure inside a Bandcamp batch. The wholesale
  // `bandcamp:import-failed` above fires once per download (zip/single
  // failed before importOneFile got to run); this fires once per
  // INDIVIDUAL file that importOneFile rejected, so Jake sees the
  // actual codec/permission/etc. reason in the LCD pill.
  onBandcampPerFileFailed: (callback: (reason: { filename: string; error: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, r: { filename: string; error: string }) => callback(r)
    ipcRenderer.on('bandcamp:per-file-failed', handler)
    return () => { ipcRenderer.removeListener('bandcamp:per-file-failed', handler) }
  },
  // 4.5.0-48: every track in an album zip was already in the library
  // (clean re-purchase). Soft INFO notice, not an error — pre-fix
  // these triggered "import produced no tracks (all duplicates?)"
  // which was technically accurate but read as broken.
  onBandcampAllDuplicates: (callback: (info: { filename: string; dupeCount: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, i: { filename: string; dupeCount: number }) => callback(i)
    ipcRenderer.on('bandcamp:all-duplicates', handler)
    return () => { ipcRenderer.removeListener('bandcamp:all-duplicates', handler) }
  },
  // 4.4.85: per-file progress so the now-playing pill renders Bandcamp
  // batches via the same setImport() drag-drop uses. Fires once per file
  // (running:true) + a final running:false when the batch finishes, then
  // a zero-total event ~1.5s later to clear the pill.
  onBandcampBatchProgress: (callback: (p: { current: number; total: number; trackTitle: string; errors: number; running: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { current: number; total: number; trackTitle: string; errors: number; running: boolean }) => callback(p)
    ipcRenderer.on('bandcamp:batch-progress', handler)
    return () => { ipcRenderer.removeListener('bandcamp:batch-progress', handler) }
  },
  // 4.5: navigation context for the library-ownership header strip.
  // Fires on every page navigation inside the Bandcamp WebContentsView.
  // Artist/album slugs are null when the page isn't a per-artist URL
  // (bandcamp.com home, search, account pages, etc.).
  onBandcampUrlChanged: (callback: (p: { url: string; artistSlug: string | null; albumSlug: string | null }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { url: string; artistSlug: string | null; albumSlug: string | null }) => callback(p)
    ipcRenderer.on('bandcamp:url-changed', handler)
    return () => { ipcRenderer.removeListener('bandcamp:url-changed', handler) }
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
  // 4.5: Wikipedia summary for artist detail page. 24h disk cache.
  getArtistWiki: (artist: string): Promise<{ ok: boolean; extract: string | null; pageUrl: string | null }> =>
    ipcRenderer.invoke('get-artist-wiki', artist),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
