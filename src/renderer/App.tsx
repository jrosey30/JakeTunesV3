import { useEffect, useState, useCallback, useRef } from 'react'
import { LibraryProvider, useLibrary } from './context/LibraryContext'
import { PlaybackProvider, usePlayback } from './context/PlaybackContext'
import { CynthiaProvider } from './context/CynthiaContext'
import { useAudio } from './hooks/useAudio'
import Toolbar from './components/playback/Toolbar'
import Sidebar from './components/sidebar/Sidebar'
import MainContent from './components/MainContent'
import SplashScreen from './components/SplashScreen'
import QueuePanel from './components/playback/QueuePanel'
import ImportConvertModal from './components/ImportConvertModal'
import LibraryMaintenanceModal from './components/LibraryMaintenanceModal'
import ShowDuplicatesModal from './components/ShowDuplicatesModal'
import PlayCacheModal from './components/PlayCacheModal'
import SettingsModal from './components/SettingsModal'
import ImportQueuePanel from './components/ImportQueuePanel'
import StatusBar from './components/chrome/StatusBar'
import { enqueueFiles, onTrackImported, setNextLibraryId } from './importQueue'
import { buildSmartPlaylistsForSync } from './utils/smartPlaylists'
import { setCrossfadeSettings } from './hooks/useAudio'
import { setEqSettings, setAudioOutputSink, getAudioOutputSink } from './audio/eq'
import { AppSettings, DEFAULT_APP_SETTINGS } from './types'
import { setNotice } from './activity'
import './styles/variables.css'
import './styles/reset.css'
import './styles/app.css'
import './styles/toolbar.css'
import './styles/sidebar.css'

function AppInner() {
  const { state: libState, dispatch } = useLibrary()
  const { togglePlayPause, nextTrack, prevTrack, seek, setVolume, stopPlayback } = useAudio()
  const { state: pbState } = usePlayback()
  const [sidebarWidth, setSidebarWidth] = useState(170)
  const [showQueue, setShowQueue] = useState(false)
  const [importConvertOpen, setImportConvertOpen] = useState(false)
  const [alacCompatOpen, setAlacCompatOpen] = useState(false)
  const [playCacheMode, setPlayCacheMode] = useState<'prepare' | 'prune' | null>(null)
  const [showDuplicatesOpen, setShowDuplicatesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [uiReady, setUiReady] = useState(false)
  // 4.4.39: minimum splash display time. Even on a warm cache where the
  // library Promise.all settles in <500ms, we hold the splash for ≥1400ms
  // so the wordmark/greeting/EQ-bars actually get to land — otherwise
  // it's a strobe. App becomes interactive only when BOTH the library is
  // loaded AND the min-time has elapsed.
  const [splashMinElapsed, setSplashMinElapsed] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSplashMinElapsed(true), 1400)
    return () => window.clearTimeout(t)
  }, [])

  // Load persisted settings once on mount and push to the audio layer.
  useEffect(() => {
    window.electronAPI.loadAppSettings().then(r => {
      const raw = (r.settings || {}) as Partial<AppSettings>
      const merged: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        ...raw,
        crossfade: { ...DEFAULT_APP_SETTINGS.crossfade, ...(raw.crossfade || {}) },
        library:   { ...DEFAULT_APP_SETTINGS.library,   ...(raw.library || {}) },
        sync:      { ...DEFAULT_APP_SETTINGS.sync,      ...(raw.sync || {}) },
        ai:        { ...DEFAULT_APP_SETTINGS.ai,        ...(raw.ai || {}) },
        eq:        { ...DEFAULT_APP_SETTINGS.eq,        ...(raw.eq || {}) },
        inbox:     { ...DEFAULT_APP_SETTINGS.inbox,     ...(raw.inbox || {}) },
        audio:     { ...DEFAULT_APP_SETTINGS.audio,     ...(raw.audio || {}) },
      }
      setAppSettings(merged)
      setCrossfadeSettings(merged.crossfade)
      setEqSettings(merged.eq)
    })
  }, [])

  // 4.4.13: Inbox auto-import subscription. Main-side chokidar watches
  // ~/Music2/_inbox (or wherever the user pointed it) and fires this
  // event with a batched array of newly-arrived audio file paths. We
  // route them through the EXACT same enqueueFiles() drag-and-drop uses
  // — full per-file queue state, dupe detection, retry — and set
  // deleteSourceOnSuccess so each file gets removed from the inbox once
  // its iPod_Control copy is in place. Format is left undefined so the
  // main-side import-track handler falls back to the user's
  // AppSettings.library.defaultImportFormat. Subscription is always-on;
  // the watcher itself is the on/off gate via Settings.
  useEffect(() => {
    const cleanup = window.electronAPI.onInboxFilesDetected((paths) => {
      if (!paths || paths.length === 0) return
      void enqueueFiles(paths, undefined, { deleteSourceOnSuccess: true })
    })
    return cleanup
  }, [])

  // 4.4.51: auto-route-on-call. While the call-route setting is on AND
  // music is playing, arm main's mic-activity watcher. When a call
  // starts (the mic goes live — Teams/Zoom/etc. all grab it), route
  // JakeTunes' OWN audio output to the configured speaker via
  // AudioContext.setSinkId — the macOS system default is never touched,
  // so the call app keeps using whatever the OS has it on. Route back
  // when the call ends. Solves "I don't want to pause music every time
  // I hop on a Teams call" without the AirPlay-latency problem of
  // playing to two devices at once (it's always one device at a time).
  useEffect(() => {
    const cfg = appSettings.audio
    if (!cfg?.callRouteEnabled || !cfg.callRouteDeviceLabel || !pbState.isPlaying) {
      window.electronAPI.setCallWatch(false)
      return
    }
    window.electronAPI.setCallWatch(true)
    let savedSink = ''
    let routed = false
    const cleanup = window.electronAPI.onCallStateChanged(async ({ onCall }) => {
      try {
        if (onCall && !routed) {
          // Resolve the configured device's Web Audio sink id. We store
          // the device by NAME (Web Audio ids churn across sessions) and
          // match it against enumerateDevices() at route time.
          const devices = await navigator.mediaDevices.enumerateDevices()
          const target = devices.find(d => d.kind === 'audiooutput' && d.label === cfg.callRouteDeviceLabel)
          if (!target) {
            setNotice(`Call started — couldn't find "${cfg.callRouteDeviceLabel}" to move music to.`, { kind: 'error', durationMs: 6000 })
            return
          }
          savedSink = getAudioOutputSink()
          const ok = await setAudioOutputSink(target.deviceId)
          if (ok) {
            routed = true
            setNotice(`On a call — music moved to ${cfg.callRouteDeviceLabel}.`, { kind: 'info', durationMs: 4000 })
          } else {
            setNotice("Call started — couldn't move music (this runtime can't per-app route).", { kind: 'error', durationMs: 6000 })
          }
        } else if (!onCall && routed) {
          await setAudioOutputSink(savedSink)
          routed = false
          setNotice('Call ended — music back on your speakers.', { kind: 'info', durationMs: 3000 })
        }
      } catch { /* best-effort routing — never throw into the IPC handler */ }
    })
    return () => {
      cleanup()
      window.electronAPI.setCallWatch(false)
      // Disabling / unmounting mid-route: put the sink back so we don't
      // leave music stranded on the call speaker.
      if (routed) void setAudioOutputSink(savedSink)
    }
  }, [appSettings.audio?.callRouteEnabled, appSettings.audio?.callRouteDeviceLabel, pbState.isPlaying])

  // 4.4.53: macOS "Now Playing" integration. Without this the Control
  // Center / lock-screen widget just shows the app name ("JakeTunes
  // V3") — Chromium surfaces the <audio> element to the OS but has no
  // track metadata to hand it. MediaSession is the bridge.
  //
  // (1) Metadata — title / artist / album / artwork, refreshed on every
  // track change. Title/artist/album are set immediately; artwork is
  // fetched and upgraded in asynchronously.
  //
  // 4.4.54: MediaSession will NOT load a custom-scheme (album-art://)
  // URL as artwork — even though the scheme is registered with
  // supportFetchAPI. So we fetch the image ourselves and hand it a
  // blob: URL, which Chromium's media layer does accept. Key scheme
  // matches AlbumArtPanel (`${artist}|||${album}`, lowercased).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const np = pbState.nowPlaying
    if (!np) {
      navigator.mediaSession.metadata = null
      return
    }
    let blobUrl: string | null = null
    let cancelled = false
    const apply = (artwork: MediaImage[]) => {
      if (cancelled) return
      navigator.mediaSession.metadata = new MediaMetadata({
        title: np.title || 'Unknown Track',
        artist: np.artist || 'Unknown Artist',
        album: np.album || '',
        artwork,
      })
    }
    apply([]) // show title/artist/album immediately; art upgrades below
    const artKey = `${(np.artist || '').toLowerCase().trim()}|||${(np.album || '').toLowerCase().trim()}`
    const artHash = libState.artworkMap[artKey]
    if (artHash) {
      fetch(`album-art://${artHash}.jpg`)
        .then(r => (r.ok ? r.blob() : Promise.reject(new Error('artwork not found'))))
        .then(blob => {
          if (cancelled) return
          blobUrl = URL.createObjectURL(blob)
          apply([{ src: blobUrl, sizes: '512x512', type: 'image/jpeg' }])
        })
        .catch(() => { /* no cached cover — metadata already set without art */ })
    }
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [pbState.nowPlaying, libState.artworkMap])

  // (2) Transport controls — route the widget's buttons back into
  // JakeTunes' own playback logic. togglePlayPause already branches on
  // play/pause state, so it's correct for both actions. seek() takes a
  // 0-1 fraction; the OS hands us absolute seconds.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, handler) } catch { /* action unsupported in this runtime */ }
    }
    set('play', () => togglePlayPause())
    set('pause', () => togglePlayPause())
    set('previoustrack', () => prevTrack())
    set('nexttrack', () => nextTrack())
    set('seekto', (details) => {
      if (details.seekTime != null && pbState.duration > 0) {
        seek(details.seekTime / pbState.duration)
      }
    })
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'] as MediaSessionAction[]) {
        set(a, null)
      }
    }
  }, [togglePlayPause, nextTrack, prevTrack, seek, pbState.duration])

  // (3) Keep the widget's play/pause indicator + scrubber in sync.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = pbState.nowPlaying
      ? (pbState.isPlaying ? 'playing' : 'paused')
      : 'none'
    const { position, duration } = pbState
    if (duration > 0 && position >= 0 && position <= duration) {
      try {
        navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 })
      } catch { /* setPositionState rejects odd values — ignore */ }
    }
  }, [pbState.isPlaying, pbState.position, pbState.duration, pbState.nowPlaying])

  // 4.4.18: Library sync orchestrator status. Surface success/failure
  // of laptop → homemini sync via the LCD-pill notice (4.4.12). Only
  // surface FAILURES on success because the safety-net tick fires
  // every 10 min and we don't want a "synced ok" popup that often;
  // the user only needs to know when something's actually broken.
  // Exception: post-import sync success IS surfaced so the user gets
  // the "boom, it's on homemini" feeling after a new import.
  useEffect(() => {
    const cleanup = window.electronAPI.onLibrarySyncStatus((status) => {
      if (!status.ok) {
        setNotice(
          status.error
            ? `Couldn't sync to homemini: ${status.error}`
            : "Couldn't sync to homemini.",
          { kind: 'error', durationMs: 6000 },
        )
        return
      }
      // OK path — only chirp on import/metadata-edit/playlist triggers.
      // safety-net silent (10 min noise = bad UX).
      if (status.reason === 'import') {
        setNotice('Synced new imports to homemini.', { kind: 'info', durationMs: 4000 })
      } else if (status.reason === 'metadata-edit') {
        setNotice('Synced edits to homemini.', { kind: 'info', durationMs: 3000 })
      } else if (status.reason === 'playlist') {
        setNotice('Synced playlists to homemini.', { kind: 'info', durationMs: 3000 })
      }
    })
    return cleanup
  }, [])

  // Auto-sync on iPod connect (4.0 Settings → Sync). Sidebar dispatches
  // 'jaketunes-ipod-mounted' on each false→true transition; we react
  // here only when the user has opted in.
  const appSettingsRef = useRef(appSettings)
  appSettingsRef.current = appSettings
  const libStateRef = useRef(libState)
  libStateRef.current = libState
  useEffect(() => {
    const onIpodMounted = () => {
      const settings = appSettingsRef.current
      if (!settings.sync.autoSyncOnConnect) return
      const lib = libStateRef.current
      if (lib.tracks.length === 0) return
      // 4.4.46: auto-sync now ships the SAME playlist set the manual
      // Device-view "Sync" button does — the user's regular playlists
      // PLUS the four built-in smart playlists (Recently Added,
      // Recently Played, Top 25, My Top Rated), freshly evaluated.
      // Before this, auto-sync passed only `lib.playlists` filtered to
      // non-iPod entries — so plugging the iPod in and letting it
      // auto-sync silently dropped every built-in smart playlist. The
      // iTunesDB writer takes whatever it's handed as THE complete
      // playlist set, so `buildSmartPlaylistsForSync` returns regular
      // playlists too (kept as-is) — they are NOT dropped.
      const playlists = buildSmartPlaylistsForSync(lib.tracks, lib.playlists || [])
      window.electronAPI.syncToIpod(lib.tracks, playlists).catch((err) => {
        console.warn('[auto-sync] failed:', err)
      })
    }
    window.addEventListener('jaketunes-ipod-mounted', onIpodMounted)
    return () => window.removeEventListener('jaketunes-ipod-mounted', onIpodMounted)
  }, [])

  useEffect(() => {
    Promise.all([
      window.electronAPI.loadTracks(),
      window.electronAPI.loadMetadataOverrides(),
      window.electronAPI.loadPlaylists(),
      window.electronAPI.loadUiState(),
    ]).then(([dbResult, overridesResult, playlistsResult, uiResult]) => {
      const tracks = dbResult.tracks || []
      const ipodPlaylists = dbResult.playlists || []

      // Apply saved metadata overrides.
      //
      // v2 entries carry a fingerprint ("title|artist|duration_ms") that
      // matches the track they were saved against. If the fingerprint no
      // longer matches the track at that ID, skip it — IDs shift when
      // the iTunesDB track set changes, and stale overrides were the
      // root cause of the hybrid-row metadata bug.
      //
      // v1 entries (no fingerprint, fields at top level) have no way to
      // be validated, so we ignore them rather than risk mis-applying.
      // Numeric override fields are persisted as strings (saveMetadataOverride
      // signature is value: string), but the Track interface declares them as
      // numbers. Coerce on apply so consumers don't have to wrap every read in
      // Number(). Existing JS coercion masked this for playCount/rating;
      // 4.0's lastPlayedAt/skipCount need correct types for arithmetic.
      const NUMERIC_OVERRIDE_FIELDS = new Set([
        'playCount', 'rating', 'duration', 'fileSize',
        'year', 'trackNumber', 'trackCount', 'discNumber', 'discCount',
        'lastPlayedAt', 'skipCount',
        'bpm', 'audioAnalysisAt',
      ])
      let appliedCount = 0, skippedStale = 0, skippedLegacy = 0
      if (overridesResult.ok && overridesResult.overrides) {
        const ov = overridesResult.overrides as Record<string, unknown>
        for (const t of tracks) {
          const entry = ov[String(t.id)] as { fp?: string; fields?: Record<string, string> } | undefined
          if (!entry || typeof entry !== 'object') continue
          if (!('fields' in entry) || !entry.fields) {
            skippedLegacy++
            continue
          }
          const fp = `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`
          if (entry.fp !== fp) {
            skippedStale++
            continue
          }
          // The override payload is intentionally schema-loose — Cynthia
          // and the user can edit any of Track's stringy fields and
          // we replay them by name. Track is a closed interface so we
          // route through `unknown` to satisfy tsc; field names are
          // validated by Cynthia's emitter, not here.
          const tr = t as unknown as Record<string, unknown>
          for (const [field, value] of Object.entries(entry.fields)) {
            const coerced = NUMERIC_OVERRIDE_FIELDS.has(field) && typeof value === 'string'
              ? (Number(value) || 0)
              : value
            tr[field] = coerced
          }
          appliedCount++
        }
        if (skippedStale || skippedLegacy) {
          console.warn(`metadata overrides: applied ${appliedCount}, skipped ${skippedStale} stale and ${skippedLegacy} legacy entries`)
        }
      }
      dispatch({ type: 'SET_TRACKS', tracks })

      // Merge iPod playlists with user-saved playlists (only on first load).
      // Respect tombstones: if the user explicitly deleted an iPod-sourced
      // playlist in a previous session, don't re-add it from the iPod DB
      // on the next mount/load.
      const savedPlaylists: import('./types').Playlist[] =
        (playlistsResult.ok && playlistsResult.playlists) ? playlistsResult.playlists : []
      const tombstones = new Set<string>(
        Array.isArray(uiResult?.state?.deletedIpodPlaylistNames)
          ? uiResult.state.deletedIpodPlaylistNames as string[]
          : []
      )
      dispatch({ type: 'LOAD_DELETED_IPOD_PLAYLISTS', names: Array.from(tombstones) })
      if (ipodPlaylists.length > 0) {
        const savedNames = new Set(savedPlaylists.map(p => p.name))
        const merged = [...savedPlaylists]
        for (const ip of ipodPlaylists) {
          if (savedNames.has(ip.name)) continue
          if (tombstones.has(ip.name)) continue  // user explicitly deleted this one
          merged.push({
            id: `ipod-${ip.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: ip.name,
            trackIds: ip.trackIds,
          })
        }
        dispatch({ type: 'LOAD_PLAYLISTS', playlists: merged })
      } else {
        dispatch({ type: 'LOAD_PLAYLISTS', playlists: savedPlaylists })
      }
      // Restore UI state
      if (uiResult.ok && uiResult.state) {
        const ui = uiResult.state
        if (typeof ui.sidebarWidth === 'number') setSidebarWidth(ui.sidebarWidth)
        if (typeof ui.currentView === 'string') {
          dispatch({ type: 'SET_VIEW', view: ui.currentView as import('./types').ViewName })
        }
        if (typeof ui.activePlaylistId === 'string') {
          dispatch({ type: 'VIEW_PLAYLIST', id: ui.activePlaylistId })
        }
        if (typeof ui.activeSmartPlaylist === 'string') {
          dispatch({ type: 'VIEW_SMART_PLAYLIST', id: ui.activeSmartPlaylist as import('./types').SmartPlaylistId })
        }
        if (typeof ui.sortColumn === 'string') {
          // Restore sort state — dispatch twice if needed to match saved direction
          dispatch({ type: 'SET_SORT', column: ui.sortColumn as import('./types').SortColumn })
          if (ui.sortDirection === 'desc') {
            dispatch({ type: 'SET_SORT', column: ui.sortColumn as import('./types').SortColumn })
          }
        }
        // Column state is restored via custom event so SongsView can pick it up
        if (ui.colWidthMap || ui.hiddenCols) {
          window.dispatchEvent(new CustomEvent('jaketunes-restore-columns', {
            detail: { colWidthMap: ui.colWidthMap, hiddenCols: ui.hiddenCols }
          }))
        }
      }
      setUiReady(true)
      // Load artwork map, then auto-fetch any missing album art in background
      if (typeof window.electronAPI.loadArtworkMap === 'function') {
        window.electronAPI.loadArtworkMap().then(async (r) => {
          if (!r?.ok) return
          const map = r.map || {}
          dispatch({ type: 'SET_ARTWORK_MAP', map })

          // 4.4.12: ONE-SHOT EMBEDDED-ART BACKFILL.
          // Tracks imported before the import-time extractor landed (any
          // build prior to 4.4.12) don't have their embedded covers on
          // disk. Run a one-time pass that parseFile's every track,
          // pulls the embedded picture, and writes it through the same
          // (now atomic + single-flight) artwork pipeline. The backfill
          // IPC writes a marker file when done; we check that first so
          // we never re-run.
          //
          // We run this BEFORE the missing-art auto-fetch loop below so
          // embedded-art recovery (free + offline) beats the network
          // fetch (slow + can fail) when both could supply a cover.
          try {
            const status = await window.electronAPI.artworkBackfillStatus?.()
            if (status?.ok && !status.done) {
              const candidates = tracks
                .filter(t => t.artist && t.album && t.path)
                .map(t => ({ path: t.path, artist: t.artist, album: t.album }))
              if (candidates.length > 0) {
                const result = await window.electronAPI.backfillEmbeddedArtwork(candidates)
                if (result?.ok && result.artwork) {
                  for (const a of result.artwork) {
                    dispatch({ type: 'ADD_ARTWORK', key: a.key, hash: a.hash })
                  }
                }
              }
            }
          } catch { /* backfill best-effort; never block app launch on it */ }

          // Refresh the in-memory map so the missing-art scan below sees
          // anything the backfill just added (avoids fetching covers from
          // the network for albums we already have embedded).
          let postBackfillMap = map
          try {
            const r2 = await window.electronAPI.loadArtworkMap?.()
            if (r2?.ok && r2.map) {
              postBackfillMap = r2.map
              dispatch({ type: 'SET_ARTWORK_MAP', map: r2.map })
            }
          } catch { /* keep original map */ }

          // Collect all unique artist+album pairs from the library
          const albums = new Map<string, { artist: string; album: string }>()
          for (const t of tracks) {
            if (t.artist && t.album) {
              const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
              if (!albums.has(k)) albums.set(k, { artist: t.artist, album: t.album })
            }
          }

          // Find which albums are missing artwork
          const missing: { artist: string; album: string }[] = []
          for (const [k, v] of albums) {
            if (!postBackfillMap[k]) missing.push(v)
          }

          if (missing.length === 0) return

          // Fetch missing artwork in background, one at a time to avoid hammering the API
          for (const { artist, album } of missing) {
            try {
              const result = await window.electronAPI.fetchAlbumArt(artist, album)
              if (result.ok && result.key && result.hash) {
                dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
              }
            } catch { /* ignore individual failures */ }
          }
        }).catch(() => {})
      }
      // 4.4.41: Music Man library summary now includes skipCount signals.
      // Jake: "music man should know that if i have no plays on a song....
      // that doesnt mean i didnt skip it." Previously the context was just
      // top artists by track count + top genres — Music Man had no way to
      // tell the difference between "Jake never heard this" and "Jake
      // skipped this every time it came on." Both showed playCount: 0.
      //
      // New profile dimensions:
      //   • topArtistsByTracks  — what's in the library (catalog signal)
      //   • topArtistsByPlays   — what Jake actually engages with
      //   • topArtistsBySkips   — what Jake actively rejects
      //   • heardButSkipped     — artists with skips>0 AND plays==0
      //                           ("Jake's heard it; he just doesn't want it")
      //   • activeDislikeTracks — specific tracks with skipCount≥3 AND
      //                           playCount==0 (a strong "don't recommend")
      //
      // Plus an explicit NOTE telling Music Man not to treat playCount==0
      // as "unfamiliar" without checking the skip signals.
      const artistsByTracks: Record<string, number> = {}
      const artistsByPlays: Record<string, number> = {}
      const artistsBySkips: Record<string, number> = {}
      const heardButSkipped = new Set<string>()
      const activeDislikeTracks: string[] = []
      const genres: Record<string, number> = {}
      for (const t of tracks) {
        const a = t.artist
        const plays = Number((t as { playCount?: number }).playCount) || 0
        const skips = Number((t as { skipCount?: number }).skipCount) || 0
        if (a) {
          artistsByTracks[a] = (artistsByTracks[a] || 0) + 1
          artistsByPlays[a] = (artistsByPlays[a] || 0) + plays
          artistsBySkips[a] = (artistsBySkips[a] || 0) + skips
          if (skips > 0 && plays === 0) heardButSkipped.add(a)
        }
        if (t.genre) genres[t.genre] = (genres[t.genre] || 0) + 1
        if (skips >= 3 && plays === 0 && t.title) {
          activeDislikeTracks.push(`"${t.title}" by ${a || 'Unknown'}`)
        }
      }
      const fmtPairs = (rec: Record<string, number>, n: number) =>
        Object.entries(rec)
          .filter(([, c]) => c > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([name, c]) => `${name} (${c})`)
          .join(', ')
      const topByTracks = fmtPairs(artistsByTracks, 50)
      const topByPlays = fmtPairs(artistsByPlays, 30)
      const topBySkips = fmtPairs(artistsBySkips, 20)
      const heardSkippedList = Array.from(heardButSkipped).sort().slice(0, 30).join(', ')
      const dislikedTracksList = activeDislikeTracks.slice(0, 30).join(', ')
      const topGenres = fmtPairs(genres, 20)

      const ctxParts: string[] = [
        `${tracks.length} total tracks.`,
        `Top artists by track count: ${topByTracks}`,
        `Top genres: ${topGenres}`,
      ]
      if (topByPlays) ctxParts.push(`Most-played artists (engagement signal — total playCount across their tracks): ${topByPlays}`)
      if (topBySkips) ctxParts.push(`Most-skipped artists (rejection signal — total skipCount across their tracks): ${topBySkips}`)
      if (heardSkippedList) ctxParts.push(`Heard-but-skipped artists (skipCount > 0, playCount == 0 — the user has heard them and chosen NOT to play through): ${heardSkippedList}`)
      if (dislikedTracksList) ctxParts.push(`Specific actively-rejected tracks (skipped ≥3 times AND never played through): ${dislikedTracksList}`)
      ctxParts.push(
        `IMPORTANT REASONING NOTE: A track with playCount == 0 is NOT necessarily unfamiliar to the user. Always check skipCount first. If a track or artist appears in the "Heard-but-skipped" or "actively-rejected" lists above, the user has heard it and chosen to skip — do not surface it as a "discovery" or "you should try this." The true preference signal is roughly (playCount − 0.5 × skipCount), not playCount alone.`
      )
      window.electronAPI.setLibraryContext(ctxParts.join('\n'))
    }).catch((err) => {
      console.error('Failed to load tracks:', err)
    })
  }, [dispatch])

  // Persist playlists whenever they change
  const playlistsLoaded = useRef(false)
  useEffect(() => {
    if (!playlistsLoaded.current) {
      if (libState.playlists.length > 0 || libState.tracks.length > 0) playlistsLoaded.current = true
      return
    }
    window.electronAPI.savePlaylists(libState.playlists)
  }, [libState.playlists])

  // Persist library (tracks + playlists) whenever tracks change (debounced)
  const libraryLoaded = useRef(false)
  const librarySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!libraryLoaded.current) {
      if (libState.tracks.length > 0) libraryLoaded.current = true
      return
    }
    if (librarySaveRef.current) clearTimeout(librarySaveRef.current)
    librarySaveRef.current = setTimeout(() => {
      window.electronAPI.saveLibrary(libState.tracks, libState.playlists)
    }, 1000)
  }, [libState.tracks, libState.playlists])

  // Save UI state on changes (debounced). Merges into the existing
  // ui-state file instead of overwriting it, because SongsView writes
  // colWidthMap/hiddenCols separately via the save-columns event.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!uiReady) return
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      const existing = await window.electronAPI.loadUiState().then(r => (r.ok && r.state) ? r.state : {}).catch(() => ({}))
      const uiState: Record<string, unknown> = {
        ...existing,
        sidebarWidth,
        currentView: libState.currentView,
        activePlaylistId: libState.activePlaylistId,
        activeSmartPlaylist: libState.activeSmartPlaylist,
        sortColumn: libState.sortColumn,
        sortDirection: libState.sortDirection,
        deletedIpodPlaylistNames: Array.from(libState.deletedIpodPlaylistNames),
      }
      window.electronAPI.saveUiState(uiState)
    }, 500)
  }, [uiReady, sidebarWidth, libState.currentView, libState.activePlaylistId, libState.activeSmartPlaylist, libState.sortColumn, libState.sortDirection, libState.deletedIpodPlaylistNames])

  // Expose saveUiState for SongsView to piggyback column state
  useEffect(() => {
    const handler = (e: Event) => {
      const { colWidthMap, hiddenCols } = (e as CustomEvent).detail
      // Merge column state into next save
      window.electronAPI.loadUiState().then(r => {
        const existing = (r.ok && r.state) ? r.state : {}
        window.electronAPI.saveUiState({ ...existing, colWidthMap, hiddenCols })
      })
    }
    window.addEventListener('jaketunes-save-columns', handler)
    return () => window.removeEventListener('jaketunes-save-columns', handler)
  }, [])

  // If the track that's currently playing gets deleted from the library,
  // stop playback. The DELETE_TRACKS reducer only removes the track from
  // state.tracks — it doesn't touch PlaybackContext, and the underlying
  // Howl keeps streaming audio from the now-ghost source. This effect
  // watches for the disappearance and hard-stops (unloads) the Howl.
  useEffect(() => {
    const playingId = pbState.nowPlaying?.id
    if (playingId == null) return
    const stillExists = libState.tracks.some(t => t.id === playingId)
    if (!stillExists) stopPlayback()
  }, [libState.tracks, pbState.nowPlaying, stopPlayback])

  // Track accumulated error count across a single rip session.
  const ripErrorsRef = useRef(0)
  const ripHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Global file-import progress listener. When the user drops
  // FLAC/WAV/folder contents onto the app, main emits per-file
  // progress events; mirror them into the activity store so the
  // LCD pill shows 'Importing N/M' just like a CD rip.
  const importHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const cleanup = window.electronAPI.onImportProgress((progress) => {
      import('./activity').then(a => {
        const active = progress.current < progress.total
        a.setRip({
          active,
          current: progress.current,
          total: progress.total,
          trackTitle: progress.title || '',
          errors: 0,
        })
        if (!active) {
          if (importHideTimerRef.current) clearTimeout(importHideTimerRef.current)
          importHideTimerRef.current = setTimeout(() => a.setRip(null), 4000)
        }
      }).catch(() => {})
    })
    return cleanup
  }, [])

  // Global sync-progress listener. DeviceView's handleSync seeds an
  // initial "Preparing..." state into the activity store, but the
  // per-file + db-write progress during an active sync comes from the
  // main process as 'sync-progress' events. Refine the store's `step`
  // text to show real numbers ("Copying 12/30 to iPod — <title>")
  // instead of a perpetually indeterminate pulse.
  useEffect(() => {
    const cleanup = window.electronAPI.onSyncProgress((progress) => {
      import('./activity').then(a => {
        if (progress.phase === 'copy') {
          a.setSync({
            active: true,
            step: progress.total > 0
              ? `Copying ${progress.current}/${progress.total} to iPod${progress.title ? ' — ' + progress.title : ''}`
              : 'Copying to iPod...',
          })
        } else if (progress.phase === 'preflight') {
          a.setSync({
            active: true,
            step: progress.total > 0
              ? `Verifying ${progress.current}/${progress.total} audio files…`
              : 'Verifying audio files…',
          })
        } else if (progress.phase === 'db') {
          a.setSync({
            active: true,
            step: progress.current < progress.total
              ? 'Writing iTunesDB...'
              : 'iTunesDB written',
          })
        }
      }).catch(() => {})
    })
    return cleanup
  }, [])

  // Global CD-rip progress listener. Lives at the App level so it survives
  // when the user navigates away from the CD Import view mid-rip — the
  // main process keeps ripping regardless, and tracks continue to appear
  // in the library one by one as each finishes. ADD_IMPORTED_TRACKS
  // dedupes by id, so the final batched return from ripCdTracks is a
  // no-op if we've already streamed everything in here.
  //
  // Also mirrors progress into the activity store so the LCD pill in
  // the toolbar can surface it.
  useEffect(() => {
    const cleanup = window.electronAPI.onCdRipProgress((progress) => {
      if (progress.track) {
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: [progress.track as import('./types').Track] })
      }
      import('./views/CDImportView').then(m => m.noteCdRipProgress(progress)).catch(() => {})
      if (progress.error) ripErrorsRef.current += 1
      if (progress.current === 0 && progress.total === 0) ripErrorsRef.current = 0
      const active = progress.current < progress.total
      import('./activity').then(a => a.setRip({
        active,
        current: progress.current,
        total: progress.total,
        trackTitle: progress.trackTitle || '',
        errors: ripErrorsRef.current,
      })).catch(() => {})
      // Auto-clear a few seconds after the rip finishes so the LCD
      // isn't permanently stuck on "Import complete".
      if (!active) {
        if (ripHideTimerRef.current) clearTimeout(ripHideTimerRef.current)
        ripHideTimerRef.current = setTimeout(() => {
          import('./activity').then(a => a.setRip(null)).catch(() => {})
          ripErrorsRef.current = 0
        }, 6000)
      }
    })
    return cleanup
  }, [dispatch])

  useEffect(() => {
    const cleanup = window.electronAPI.onMenuAction((action: string) => {
      switch (action) {
        case 'play-pause': togglePlayPause(); break
        case 'next-track': nextTrack(); break
        case 'prev-track': prevTrack(); break
        case 'volume-up': setVolume(Math.min(1, pbState.volume + 0.1)); break
        case 'volume-down': setVolume(Math.max(0, pbState.volume - 0.1)); break
        case 'get-info': window.dispatchEvent(new Event('jaketunes-get-info')); break
        case 'show-now-playing': window.dispatchEvent(new Event('jaketunes-show-now-playing')); break
        case 'view-songs': dispatch({ type: 'SET_VIEW', view: 'songs' }); break
        case 'view-artists': dispatch({ type: 'SET_VIEW', view: 'artists' }); break
        case 'view-albums': dispatch({ type: 'SET_VIEW', view: 'albums' }); break
        case 'view-genres': dispatch({ type: 'SET_VIEW', view: 'genres' }); break
        case 'open-import-convert': setImportConvertOpen(true); break
        case 'fix-ipod-compat':     setAlacCompatOpen(true); break
        case 'prepare-alac-cache':  setPlayCacheMode('prepare'); break
        case 'prune-alac-cache':    setPlayCacheMode('prune'); break
        case 'show-duplicates':     setShowDuplicatesOpen(true); break
        case 'open-preferences':    setSettingsOpen(true); break
        case 'export-mobile-snapshot': {
          // Read latest library state via ref (closure captured stale
          // libState on first render). Strip iPod-only playlists —
          // those are reconstructed from the device on next sync, not
          // something mobile should see.
          const lib = libStateRef.current
          const playlists = (lib.playlists || []).filter(
            (p: import('./types').Playlist) => !p.id.startsWith('ipod-'),
          )
          window.electronAPI
            .exportLibrarySnapshot({ tracks: lib.tracks, playlists })
            .then((r) => {
              if (r.canceled) return
              if (r.ok) {
                console.log(`[snapshot] wrote ${r.trackCount} tracks (${r.bytes} B) to ${r.path}`)
              } else {
                console.warn(`[snapshot] export failed: ${r.error}`)
              }
            })
          break
        }
        case 'apply-mobile-overrides': {
          // Two-step: pick file, then apply. Identity-gated on
          // audioFingerprint per the postmortem rule (see
          // src/main/library-overrides.ts). On success the renderer
          // dispatches the merged tracks and fires save-library so
          // library.json AND the auto-snapshot both reflect the
          // applied counts.
          void (async () => {
            const pick = await window.electronAPI.mobileOverridesPickFile()
            if (pick.canceled || !pick.path) return
            const lib = libStateRef.current
            const result = await window.electronAPI.mobileOverridesApply({
              path: pick.path,
              tracks: lib.tracks,
            })
            if (!result.ok) {
              console.warn(`[overrides] apply failed: ${result.error}`)
              return
            }
            console.log(
              `[overrides] applied ${result.applied}/${result.overrideCount} from device ${result.deviceId} (exported ${result.exportedAt})`,
            )
            if (result.discarded && result.discarded.length > 0) {
              console.warn('[overrides] discarded entries:', result.discarded)
            }
            if (result.tracks && result.applied && result.applied > 0) {
              const merged = result.tracks as import('./types').Track[]
              dispatch({ type: 'SET_TRACKS', tracks: merged })
              // Persist immediately so the snapshot exporter (auto-fired
              // from save-library) reflects the merged counts on the
              // next mobile fetch.
              const playlists = (lib.playlists || []).filter(
                (p: import('./types').Playlist) => !p.id.startsWith('ipod-'),
              )
              await window.electronAPI.saveLibrary(merged, playlists)
            }
          })()
          break
        }
      }
    })
    // Main process watches library.json on disk and fires this when
    // something OTHER than us writes it. Reload automatically so the UI
    // stays consistent with disk and save-library doesn't overwrite the
    // external edit later.
    const reloadHandler = () => {
      window.electronAPI.loadTracks().then((r) => {
        if (r.tracks) dispatch({ type: 'SET_TRACKS', tracks: r.tracks })
      })
    }
    const unsubExt = window.electronAPI.onLibraryExternalChange(() => {
      console.log('library.json changed externally, reloading in-memory state')
      reloadHandler()
    })
    return () => {
      cleanup()
      unsubExt()
    }
  }, [togglePlayPause, nextTrack, prevTrack, setVolume, dispatch])

  // Global keyboard shortcuts
  const toggleRef = useRef(togglePlayPause)
  toggleRef.current = togglePlayPause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable

      // Space = play/pause (unless typing in an input)
      if (e.code === 'Space' && !isInput) {
        e.preventDefault()
        e.stopPropagation()
        toggleRef.current()
        return
      }

      // Cmd+I = Get Info (dispatched as custom event, SongsView/PlaylistView handles it)
      if ((e.metaKey || e.ctrlKey) && e.key === 'i' && !e.shiftKey) {
        // Don't intercept if Alt is held (DevTools toggle is Alt+Cmd+I)
        if (e.altKey) return
        e.preventDefault()
        window.dispatchEvent(new Event('jaketunes-get-info'))
        return
      }

      // Cmd+L = scroll to now-playing track
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        window.dispatchEvent(new Event('jaketunes-show-now-playing'))
        return
      }
    }
    // Use capture phase to beat scrollable div's default behavior
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(120, Math.min(350, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Drag-and-drop file import ──
  // Routes through the import queue (importQueue.ts) so each dropped
  // file gets its own pending/running/done/failed state and back-to-
  // back drops accumulate cleanly instead of racing. The user gets
  // per-item visibility + retry on every failure.
  const [dropActive, setDropActive] = useState(false)

  // Keep the queue's nextId in sync with the library so each import
  // gets a fresh, non-colliding library id.
  //
  // We seed from the MAX of two sources, not just `max(track.id)`:
  //
  //   (1) max library id — the obvious one
  //   (2) max imported_NNNN seen in any track's `path` field
  //
  // (2) matters because Import N to Library can pull tracks back from
  // the iPod whose paths were generated in a prior epoch (when the
  // library had different state). Those paths can carry imported_NNNN
  // numbers higher than any current library.id. Without including (2),
  // a fresh drag-drop import gets a library-id whose path slot is
  // already taken on disk — the file gets overwritten and the library
  // ends up with two entries pointing at the same path. (Apr 26
  // 78-collision postmortem; the import-track main handler now also
  // has a defensive `findFreeImportedId` second line of defense.)
  useEffect(() => {
    if (libState.tracks.length > 0) {
      const maxId = Math.max(0, ...libState.tracks.map(t => t.id))
      const maxPathNum = Math.max(0, ...libState.tracks.map(t => {
        const m = (t.path || '').match(/imported_(\d+)/)
        return m ? parseInt(m[1], 10) : 0
      }))
      setNextLibraryId(Math.max(maxId, maxPathNum) + 1)
    }
  }, [libState.tracks])

  // As the queue worker finishes each item, push it into the library
  // immediately. The user sees their drop landing one track at a time.
  // 4.4.12: if the import handler extracted embedded album art, dispatch
  // ADD_ARTWORK in the same React batch so the cover shows up alongside
  // the track on first render (instead of one render of "no art" then a
  // second render after a per-track IPC).
  useEffect(() => {
    return onTrackImported((t, artwork) => {
      dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: [t] })
      if (artwork) {
        dispatch({ type: 'ADD_ARTWORK', key: artwork.key, hash: artwork.hash })
      }
    })
  }, [dispatch])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)

    const files = Array.from(e.dataTransfer.files)
    const droppedPaths = files.map(f => f.path).filter(Boolean)
    if (droppedPaths.length === 0) return

    // Honor the user's persisted import format (ALAC / AAC 256 / etc).
    const ui = await window.electronAPI.loadUiState().catch(() => ({ ok: false, state: null }))
    const importFormat = (ui.ok && ui.state && typeof (ui.state as Record<string, unknown>).importFormat === 'string')
      ? (ui.state as Record<string, unknown>).importFormat as string
      : undefined
    void enqueueFiles(droppedPaths, importFormat)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      setDropActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false)
    }
  }, [])

  // 4.4.39: hold splash until BOTH library is loaded AND minimum display
  // time has elapsed. Pass isReady so the splash can pop progress to 100%
  // + status to "Ready." once the data side has resolved but before the
  // min-time releases — gives a satisfying finish frame instead of a snap.
  if (!uiReady || !splashMinElapsed) {
    return <SplashScreen isReady={uiReady} />
  }

  return (
    <div
      className="app-shell"
      style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` } as React.CSSProperties}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="titlebar">JakeTunes</div>
      <div className="toolbar-area">
        <Toolbar onToggleQueue={() => setShowQueue(q => !q)} onOpenQueue={() => setShowQueue(true)} showQueue={showQueue} />
      </div>
      <div className="sidebar-area" style={{ width: sidebarWidth }}>
        <Sidebar />
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarDrag} />
      </div>
      <div className="content-area" style={{ position: 'relative' }}>
        <MainContent />
        {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
        {importConvertOpen && <ImportConvertModal onClose={() => setImportConvertOpen(false)} />}
        {alacCompatOpen && <LibraryMaintenanceModal mode="alac" onClose={() => setAlacCompatOpen(false)} />}
        {playCacheMode && <PlayCacheModal mode={playCacheMode} onClose={() => setPlayCacheMode(null)} />}
        {settingsOpen && (
          <SettingsModal
            initial={appSettings}
            onClose={() => setSettingsOpen(false)}
            onSaved={(next) => {
              setAppSettings(next)
              setCrossfadeSettings(next.crossfade)
              setEqSettings(next.eq)
              setSettingsOpen(false)
            }}
          />
        )}
        {showDuplicatesOpen && (
          <ShowDuplicatesModal
            tracks={libState.tracks}
            onClose={() => setShowDuplicatesOpen(false)}
            onDelete={(id) => dispatch({ type: 'DELETE_TRACKS', ids: [id] })}
          />
        )}
      </div>
      {/* 4.4.42: import queue moved out of the floating bottom-right
          overlay into its own grid row, docked above the status bar.
          When the queue is empty the panel returns null and the row
          collapses to 0 height — same UX outcome as before, no
          modality, never covers content. */}
      <div className="imports-area">
        <ImportQueuePanel />
      </div>
      <div className="statusbar-area">
        <StatusBar />
      </div>
      {dropActive && (
        <div className="app-drop-overlay">
          <div className="app-drop-message">Drop to import</div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (
    <LibraryProvider>
      <PlaybackProvider>
        <CynthiaProvider>
          <AppInner />
        </CynthiaProvider>
      </PlaybackProvider>
    </LibraryProvider>
  )
}
