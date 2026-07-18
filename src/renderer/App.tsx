import { useEffect, useState, useCallback, useRef } from 'react'
import { LibraryProvider, useLibrary } from './context/LibraryContext'
import { PlaybackProvider, usePlayback } from './context/PlaybackContext'
import { CynthiaProvider } from './context/CynthiaContext'
import { NavigationProvider, useNavigation } from './context/NavigationContext'
import { ViewModeProvider } from './context/ViewModeContext'
import { useAudio } from './hooks/useAudio'
import Toolbar from './components/playback/Toolbar'
import Sidebar from './components/sidebar/Sidebar'
import MainContent from './components/MainContent'
import Visualizer from './components/Visualizer'
import SplashScreen from './components/SplashScreen'
import QueuePanel, { type QueuePanelHandle } from './components/playback/QueuePanel'
import ImportConvertModal from './components/ImportConvertModal'
import LibraryMaintenanceModal from './components/LibraryMaintenanceModal'
import ShowDuplicatesModal from './components/ShowDuplicatesModal'
import PlayCacheModal from './components/PlayCacheModal'
import OrphanCleanupModal from './components/OrphanCleanupModal'
import SettingsModal from './components/SettingsModal'
import ImportQueuePanel from './components/ImportQueuePanel'
import Breadcrumb from './components/chrome/Breadcrumb'
import StatusBar from './components/chrome/StatusBar'
import ConfirmDialog from './components/ConfirmDialog'
import BandcampImportToast from './components/BandcampImportToast'
import { initRecentlyAdded, isRecentlyAdded } from './state/recentlyAdded'
import {
  enqueueFiles,
  onTrackImported,
  setNextLibraryId,
  subscribe as subscribeImportQueue,
  getQueueState,
  getActiveItem,
  getPendingCount,
  getDoneCount,
  getFailedCount,
  getDupeCount,
} from './importQueue'
import { setImport } from './activity'
import { buildSmartPlaylistsForSync } from './utils/smartPlaylists'
import { setCrossfadeSettings, fadeAllForQuit } from './hooks/useAudio'
import { lookupArtworkOneShot, queueArtworkResolutions } from './utils/artworkLookup'
import { setEqSettings, setAudioOutputSink, getAudioOutputSink } from './audio/eq'
import { setStereoWidth } from './audio/audioEnhance'
import { setUserAliases } from './utils/artistAlias'
import { initDownloads } from './utils/downloadStore'
import { ensureLiveSetsLoaded } from './liveSets'
import { hydrateScrollCacheFromUiState } from './hooks/useScrollPersistence'
import { AppSettings, DEFAULT_APP_SETTINGS } from './types'
import { setNotice } from './activity'
import './styles/variables.css'
import './styles/primitives.css'
import './styles/motion.css'
import './styles/reset.css'
import './styles/scrollbars.css'
import './styles/app.css'
import './styles/toolbar.css'
import './styles/sidebar.css'

// Session cap — startup must not walk every missing album via fetchAlbumArt.
const STARTUP_NETWORK_ART_CAP = 16
const STARTUP_NETWORK_ART_CONCURRENCY = 2
let startupNetworkArtStarted = false

function AppInner() {
  const { state: libState, dispatch } = useLibrary()
  const { canGoBack, canGoForward, goBack, goForward } = useNavigation()
  // Brief 033c: App is the single "primary" useAudio consumer — it owns
  // the heartbeat diagnostic/recovery interval. App never unmounts, so
  // exactly one interval runs regardless of how many other components
  // call useAudio() for accessor functions. See useAudio.ts heartbeat
  // effect for the full rationale.
  const { togglePlayPause, nextTrack, prevTrack, seek, setVolume, stopPlayback } = useAudio({ primary: true })
  const { state: pbState } = usePlayback()
  const [sidebarWidth, setSidebarWidth] = useState(170)
  const [showQueue, setShowQueue] = useState(false)
  const queueRef = useRef<QueuePanelHandle>(null)
  const [importConvertOpen, setImportConvertOpen] = useState(false)
  const [alacCompatOpen, setAlacCompatOpen] = useState(false)
  const [playCacheMode, setPlayCacheMode] = useState<'prepare' | 'prune' | null>(null)
  const [orphanCleanupOpen, setOrphanCleanupOpen] = useState(false)
  const [showDuplicatesOpen, setShowDuplicatesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Brief 020: tag write-back batch UI state. Two phases:
  //   - applyOverridesConfirmOpen → confirm modal
  //   - applyOverridesProgress != null → in-flight modal (counter + bar)
  //   - applyOverridesResult != null → result summary modal
  const [applyOverridesConfirmOpen, setApplyOverridesConfirmOpen] = useState(false)
  const [applyOverridesProgress, setApplyOverridesProgress] = useState<{ done: number; total: number; succeeded: number; failed: number } | null>(null)
  const [applyOverridesResult, setApplyOverridesResult] = useState<{ total: number; succeeded: number; failed: number; skippedNoTrack: number; skippedFpMismatch: number; skippedNoWritable: number; failures: Array<{ filePath: string; error?: string }> } | null>(null)
  // Brief 016 commit 2: refresh-file-sizes UI state — same three-phase
  // confirm/progress/result pattern as Brief 020's apply-overrides flow.
  const [refreshSizesConfirmOpen, setRefreshSizesConfirmOpen] = useState(false)
  const [refreshSizesProgress, setRefreshSizesProgress] = useState<{ scanned: number; refreshed: number; total: number } | null>(null)
  const [refreshSizesResult, setRefreshSizesResult] = useState<{ refreshed: number; error?: string } | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  // Bug #1 data-loss guard: shown when NAS reconnects mid-session while
  // we're in local-fallback mode. Saves get refused in main until restart.
  const [saveLockReason, setSaveLockReason] = useState<string | null>(null)
  const [preservedOrphanBanner, setPreservedOrphanBanner] = useState<number | null>(null)
  useEffect(() => {
    return window.electronAPI.onStateSaveLocked(({ reason }) => setSaveLockReason(reason))
  }, [])
  // 4.5: the "local state is ahead of NAS" banner is gone — the NAS backup now
  // pushes automatically + silently in the background (main: autoBackupStateToNas).
  const [uiReady, setUiReady] = useState(false)
  // 4.4.39: minimum splash display time. Even on a warm cache where the
  // library Promise.all settles in <500ms, we hold the splash for ≥1400ms
  // so the wordmark/greeting/EQ-bars actually get to land — otherwise
  // it's a strobe. App becomes interactive only when BOTH the library is
  // loaded AND the min-time has elapsed.
  const [splashMinElapsed, setSplashMinElapsed] = useState(false)
  useEffect(() => {
    // 4.5: bumped 1400 → 2800ms. The splash is a grand welcome — Jake's
    // direction — and 1.4s wasn't enough room for the logo entrance,
    // halo pulse, and floating notes to actually read as a scene.
    // Library still loads in parallel; this just holds the splash for
    // the visual beat to land before AppInner shows.
    const t = window.setTimeout(() => setSplashMinElapsed(true), 2800)
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
      setStereoWidth(merged.audio.stereoWidth)
    })
  }, [])

  // Load the user/AI artist-alias map once on boot so canonicalArtist groups
  // (Wings, Paul & Linda McCartney → Paul McCartney) from the very first render.
  useEffect(() => {
    window.electronAPI.loadArtistAliases?.().then((r) => {
      if (r?.ok) setUserAliases(r.aliases)
    }).catch(() => { /* no overrides — the curated baseline still applies */ })
  }, [])

  // Init the offline-download (pin) store app-wide so the Download controls work
  // in any song-list view (not just Songs), even if a playlist is the first view
  // opened after launch. Idempotent (guarded inside initDownloads).
  useEffect(() => { void initDownloads() }, [])

  // Load declared live concerts at boot so the regular-library projection
  // (Songs/Albums/Artists/count) excludes concert tracks on first paint,
  // not after a flash. Idempotent (first caller wins inside the store).
  useEffect(() => { void ensureLiveSetsLoaded() }, [])

  // Subscribe the renderer-side recently-added store to the main-process
  // Bandcamp download-router events. Idempotent.
  useEffect(() => { initRecentlyAdded() }, [])

  // Mirror the drag-drop importQueue pattern (see line below): each
  // Bandcamp/squid purchase track produced by importOneFile lands in
  // the library state the same way a manually-dropped file does.
  // Wrapped in try/catch because a 20-track squid Drake-Views import
  // (4.5.0) crashed the renderer mid-burst with a SIGTRAP; without a
  // catch a malformed payload would tear down the entire UI.
  useEffect(() => {
    return window.electronAPI.onBandcampTrackImported((t) => {
      try {
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: [t] })
      } catch (err) {
        console.error('[bandcamp:track-imported handler] crash-guard:', err, t)
      }
    })
  }, [dispatch])

  // 4.4.85: Bandcamp batch imports feed the same pill the drag-drop
  // bridge below uses. Main emits per-file events so the bar advances
  // visibly (vs the previous "all 11 finish before any UI feedback"
  // experience). Final running:false + zero-total clears the pill.
  useEffect(() => {
    return window.electronAPI.onBandcampBatchProgress((p) => {
      try {
        if (p.total === 0) {
          setImport(null)
          return
        }
        setImport({
          active: true,
          current: p.current,
          total: p.total,
          trackTitle: p.trackTitle,
          errors: p.errors,
          barFraction: Math.min(1, (p.current + (p.running ? 0.5 : 0)) / p.total),
        })
      } catch (err) {
        console.error('[bandcamp:batch-progress handler] crash-guard:', err, p)
      }
    })
  }, [])

  // 4.5.0-46: surface Bandcamp per-file failures in the LCD pill so the
  // user sees the actual reason (codec, ENOENT, transcode failure) the
  // moment it happens — matches the drag-drop importQueue behavior.
  useEffect(() => {
    return window.electronAPI.onBandcampPerFileFailed((r) => {
      import('./activity').then(a => {
        a.setNotice(`Can't import "${r.filename}" — ${r.error}`, { kind: 'error', durationMs: 9000 })
      }).catch(() => {})
    })
  }, [])

  // 4.5.0-46: same for the WHOLESALE Bandcamp failures (zip with no
  // audio, download interrupted, all-dupes batch). These never even hit
  // importOneFile so the per-file handler above wouldn't catch them.
  useEffect(() => {
    return window.electronAPI.onBandcampImportFailed((r) => {
      import('./activity').then(a => {
        a.setNotice(`Bandcamp: "${r.filename}" — ${r.error}`, { kind: 'error', durationMs: 9000 })
      }).catch(() => {})
    })
  }, [])

  // 4.5.0-48: clean re-purchase — every track in the zip was already
  // in the library. INFO notice (not error) so Jake knows nothing
  // broke; this is just "you already own this album".
  useEffect(() => {
    return window.electronAPI.onBandcampAllDuplicates((info) => {
      import('./activity').then(a => {
        a.setNotice(
          `Already in your library: "${info.filename}" — all ${info.dupeCount} track${info.dupeCount === 1 ? '' : 's'} skipped`,
          { kind: 'info', durationMs: 6000 }
        )
      }).catch(() => {})
    })
  }, [])

  // Bridge the importQueue (drag-drop) state into the activity store so
  // the now-playing pill surfaces "Importing X of N" progress at the top
  // of the window — instead of (only) the bottom-corner ImportQueuePanel,
  // which is now hidden during normal progress and shows up only on
  // failures (where retry UX matters).
  useEffect(() => {
    return subscribeImportQueue(() => {
      const pending = getPendingCount()
      if (pending === 0) {
        setImport(null)
        return
      }
      const items = getQueueState().items
      const active = getActiveItem()
      const trackTitle = active ? (active.srcPath.split('/').pop() || active.srcPath) : ''
      // current = integer done count (drives the "X of N" label).
      // total subtracts both dupes and failures so the visible count
      // reflects what'll actually land in the library — neither is "being
      // imported" in the sense the user means.
      // barFraction = a smooth 0..1 fill for the bar that also credits
      // half a step for the file currently being encoded, so the bar
      // doesn't sit frozen for the 10-30 s an ALAC two-step takes.
      const doneCount = getDoneCount()
      const total = Math.max(1, items.length - getDupeCount() - getFailedCount())
      const inFlight = active && active.status === 'running' ? 0.5 : 0
      setImport({
        active: true,
        current: doneCount,
        total,
        trackTitle,
        errors: getFailedCount(),
        barFraction: Math.min(1, (doneCount + inFlight) / total),
      })
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
    // 4.5: lookupArtworkOneShot — normalized + fuzzy fallback so the
    // MediaSession cover (lock-screen, Now-Playing widget) sticks
    // even when album/artist drift between import and play time.
    const artHash = lookupArtworkOneShot(libState.artworkMap, np.artist || '', np.album || '')
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

  // 4.4.18 / 4.5: Library sync orchestrator status. Only FAILURES
  // surface in the now-playing pill — success info lives in Settings →
  // Sync ("Last backup: X minutes ago"). Pre-4.5 the import/metadata/
  // playlist success cases each chirped the pill; turned out to be too
  // chatty given the orchestrator now debounces at 5s and the safety
  // net fires every 10 min. The user only wants to know when something
  // is actually broken; routine "boom it synced" became visual noise
  // and was disabled in 4.5.
  useEffect(() => {
    const cleanup = window.electronAPI.onLibrarySyncStatus((status) => {
      if (!status.ok) {
        setNotice(
          status.error
            ? `Couldn't sync to homemini: ${status.error}`
            : "Couldn't sync to homemini.",
          { kind: 'error', durationMs: 6000 },
        )
      }
    })
    return cleanup
  }, [])

  // 4.5: fade-on-quit. Main intercepts cmd+Q, fires 'app-quit-fade'
  // and waits ~180ms before actually exiting. We ramp every live Howl
  // to 0 in that window so the OS audio buffer isn't snapped from
  // mid-waveform amplitude — eliminates the speaker-cone pop on quit.
  useEffect(() => {
    return window.electronAPI.onAppQuitFade?.(() => {
      void fadeAllForQuit(140)
    }) || (() => {})
  }, [])

  // 4.5: clear stale sync activity from the pill when the iPod ejects.
  // Pre-fix the "Writing iTunesDB..." sync-progress message lingered
  // long after the device was gone, because main kept emitting sync-
  // progress events even though the writes were failing. Listening
  // for the eject event and proactively clearing the sync activity
  // gives the user honest UI: if the iPod's gone, no sync banner.
  useEffect(() => {
    const onEject = () => {
      import('./activity').then(a => a.setSync(null)).catch(() => {})
    }
    window.addEventListener('jaketunes-ipod-ejected', onEject)
    return () => window.removeEventListener('jaketunes-ipod-ejected', onEject)
  }, [])

  // Auto-sync on iPod connect (4.0 Settings → Sync). Sidebar dispatches
  // 'jaketunes-ipod-mounted' on each false→true transition; we react
  // here only when the user has opted in.
  const appSettingsRef = useRef(appSettings)
  appSettingsRef.current = appSettings
  const libStateRef = useRef(libState)
  libStateRef.current = libState
  // Brief 016: playback state ref so closures (the library-external-change
  // reload handler in particular) can read the currently playing track id
  // without staleness. The reload handler protects the playing track's
  // libState entry from being overwritten during playback — otherwise the
  // overwrite cascades into UI desync (stale now-playing title, frozen
  // scrubber) because the playback engine has the source of truth for
  // that track's playback state.
  const pbStateRef = useRef(pbState)
  pbStateRef.current = pbState

  // 4.5: global keyboard shortcuts. Bound to document.keydown so they
  // fire from anywhere in the app, but every transport key bails when
  // focus is inside a text input — otherwise Space typed into the
  // search field would steal the keypress and toggle playback instead
  // of inserting a space character. ⌘F always works; "/" only works
  // outside text inputs so it can still be typed normally in search
  // boxes, tag fields, Get Info, etc. Esc both blurs the focused
  // input and clears the search query for a one-stroke reset.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false
      const tag = t.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (t.isContentEditable) return true
      return false
    }
    function focusSearch() {
      const el = document.querySelector<HTMLInputElement>('.search-pill .search-input')
      if (el) {
        el.focus()
        el.select()
      }
    }
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const typing = isTypingTarget(e.target)

      if (e.key === 'Escape') {
        if (typing && e.target instanceof HTMLElement) e.target.blur()
        if (libStateRef.current.searchQuery) dispatch({ type: 'SET_SEARCH', query: '' })
        return
      }
      if (meta && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        focusSearch()
        return
      }
      if (!typing && e.key === '/') {
        e.preventDefault()
        focusSearch()
        return
      }
      if (typing) return

      // Dedicated media keys (some keyboards deliver these to the renderer).
      if (e.key === 'MediaPlayPause' || e.code === 'MediaPlayPause') {
        e.preventDefault()
        togglePlayPause()
        return
      }
      if (e.key === 'MediaTrackNext' || e.code === 'MediaTrackNext' || e.key === 'MediaNextTrack' || e.code === 'MediaNextTrack') {
        e.preventDefault()
        nextTrack()
        return
      }
      if (e.key === 'MediaTrackPrevious' || e.code === 'MediaTrackPrevious' || e.key === 'MediaPreviousTrack' || e.code === 'MediaPreviousTrack') {
        e.preventDefault()
        prevTrack()
        return
      }

      if (e.key === ' ') {
        e.preventDefault()
        togglePlayPause()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        nextTrack()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prevTrack()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const v = pbStateRef.current.volume
        setVolume(Math.min(1, v + 0.05))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const v = pbStateRef.current.volume
        setVolume(Math.max(0, v - 0.05))
        return
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [togglePlayPause, nextTrack, prevTrack, setVolume, dispatch])

  useEffect(() => {
    const onIpodMounted = async () => {
      const settings = appSettingsRef.current
      if (!settings.sync.autoSyncOnConnect) return
      const lib = libStateRef.current
      if (lib.tracks.length === 0) return
      // MERGE 2026-07-18: plug-in AUTO-sync stays the FULL-LIBRARY mirror with
      // the convert-gate (Cursor's activity flow would sync a ~1000-track
      // subset on every plug-in and orphan-clean the rest off the device).
      // Activity sets are a deliberate act — the Device view's Sync sheet.
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
      //
      // 4.5.0-109: auto-sync now reads the persisted convert toggle from
      // ui-state.json and passes it along. Pre-fix this call ALWAYS sent
      // `convertOptions=undefined` → main treated it as off → every
      // auto-sync silently re-copied lossless originals over previously-
      // converted AAC files on the iPod. That's how Jake's 2,917 cached
      // AAC mirrors never made it to the device.
      const playlists = buildSmartPlaylistsForSync(lib.tracks, lib.playlists || [])
      // Bug #4: previous logic defaulted `enabled=false` on any ambiguity
      // (load failure, missing field, exception). That's the *destructive*
      // default — convert-off means full ALAC copies to the iPod, which is
      // exactly how 2,540 lossless files landed there this afternoon.
      //
      // New rule: if we can't confidently read both convert fields, ABORT
      // the auto-sync entirely. The user can still trigger a manual sync
      // from Device view (which uses appliedSettings, gated by Apply).
      // Silent destructive defaults are how we end up overwriting hours
      // of work in 30 seconds.
      let convertOptions: { enabled: boolean; targetKbps: 128 | 192 | 256 } | null = null
      let abortReason: string | null = null
      try {
        const ui = await window.electronAPI.loadUiState()
        if (!ui.ok || !ui.state) {
          abortReason = 'loadUiState returned no state'
        } else {
          const s = ui.state as Record<string, unknown>
          const enabledRaw = s.optConvertBitrate
          const targetRaw = s.optConvertBitrateTarget
          if (typeof enabledRaw !== 'boolean') {
            abortReason = `optConvertBitrate field missing or non-bool (got ${typeof enabledRaw}=${JSON.stringify(enabledRaw)})`
          } else if (targetRaw !== '128' && targetRaw !== '192' && targetRaw !== '256') {
            abortReason = `optConvertBitrateTarget missing or invalid (got ${JSON.stringify(targetRaw)})`
          } else {
            const targetKbps: 128 | 192 | 256 = targetRaw === '256' ? 256 : targetRaw === '192' ? 192 : 128
            convertOptions = { enabled: enabledRaw, targetKbps }
          }
        }
      } catch (err) {
        abortReason = `exception while reading ui-state: ${err instanceof Error ? err.message : String(err)}`
      }
      if (!convertOptions) {
        console.warn(`[auto-sync] ABORTED — convert preference unreadable: ${abortReason}. Open Device view and click Apply to commit a known-good convert state.`)
        return
      }
      console.log(`[auto-sync] firing with convertOptions=`, convertOptions)
      window.electronAPI.syncToIpod(lib.tracks, playlists, convertOptions).catch((err) => {
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
      // 4.5.0-81 — 2-way star sync. Pulled alongside the other startup
      // reads so the first render of any list already shows mobile-set
      // stars without a re-render flash. Empty set if file missing.
      window.electronAPI.loadMobileStars?.().catch(() => ({ ok: false, trackIds: [] as string[] })),
      // Brief 121 — iOS-created playlists + iOS-side additions to V3
      // playlists. Same startup-parallel pattern as mobile-stars so the
      // first sidebar render already includes them.
      window.electronAPI.loadMobilePlaylists?.().catch(() => ({ ok: false, playlists: [] as Array<{ id: string; name: string; trackIds: string[]; createdAt?: string; source?: string }> })),
      window.electronAPI.loadPlaylistAdditions?.().catch(() => ({ ok: false, additions: {} as Record<string, string[]> })),
    ]).then(([dbResult, overridesResult, playlistsResult, uiResult, mobileStarsResult, mobilePlaylistsResult, playlistAdditionsResult]) => {
      if (uiResult.ok && uiResult.state) {
        hydrateScrollCacheFromUiState(uiResult.state as Record<string, unknown>)
      }
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
      // 4.5.0-81 — apply mobile-set stars on top of overrides. The
      // mobile-stars.json sidecar is the canonical truth-of-record for
      // binary star state across desktop ↔ mobile (Brief 054 on the
      // iOS side, hooked from save-metadata-override on desktop). Any
      // trackId in the set gets its rating bumped to ≥ 1 so the
      // existing Starred smart-playlist filter (rating > 0) and inline
      // star widget light up. Doesn't lower ratings (mobile is
      // additive-only), so multi-star desktop ratings are preserved.
      if (mobileStarsResult?.ok && Array.isArray(mobileStarsResult.trackIds) && mobileStarsResult.trackIds.length > 0) {
        const mobileStarred = new Set(mobileStarsResult.trackIds.map(String))
        let mobileBumped = 0
        for (const t of tracks) {
          if (mobileStarred.has(String(t.id))) {
            const cur = Number(t.rating) || 0
            if (cur < 1) {
              const tr = t as unknown as Record<string, unknown>
              tr.rating = 5
              mobileBumped++
            }
          }
        }
        if (mobileBumped > 0) {
          console.log(`[mobile-stars] applied ${mobileBumped} mobile-set stars on top of overrides (${mobileStarsResult.trackIds.length} total in sidecar)`)
        }
      }
      dispatch({ type: 'SET_TRACKS', tracks })

      // Merge iPod playlists with user-saved playlists (only on first load).
      // Respect tombstones: if the user explicitly deleted an iPod-sourced
      // playlist in a previous session, don't re-add it from the iPod DB
      // on the next mount/load.
      const savedPlaylists: import('./types').Playlist[] =
        (playlistsResult.ok && playlistsResult.playlists) ? playlistsResult.playlists : []

      // Brief 121 — fold iOS-side additions into the V3 playlists they
      // target. Additions are appended to the end and deduped (mobile
      // owns its sidecar; V3 treats it read-only). Mobile writes track
      // IDs as strings — coerce to numbers to match the Playlist schema.
      if (playlistAdditionsResult?.ok && playlistAdditionsResult.additions) {
        const additions = playlistAdditionsResult.additions
        let mergedCount = 0
        for (const pl of savedPlaylists) {
          const extras = additions[pl.id]
          if (!Array.isArray(extras) || extras.length === 0) continue
          const existing = new Set(pl.trackIds)
          const toAppend: number[] = []
          for (const raw of extras) {
            const n = Number(raw)
            if (!Number.isFinite(n) || existing.has(n)) continue
            existing.add(n)
            toAppend.push(n)
          }
          if (toAppend.length > 0) {
            pl.trackIds = [...pl.trackIds, ...toAppend]
            mergedCount += toAppend.length
          }
        }
        if (mergedCount > 0) {
          console.log(`[mobile-playlist-additions] merged ${mergedCount} iOS-side track adds across V3 playlists`)
        }
      }

      // Brief 121 — append iOS-created playlists to the list. IDs are
      // already prefixed `mobile:` by the mobile backend, so they can't
      // collide with V3 IDs. Marked source:'mobile' so the sidebar can
      // badge them later.
      if (mobilePlaylistsResult?.ok && Array.isArray(mobilePlaylistsResult.playlists)) {
        const existingIds = new Set(savedPlaylists.map(p => p.id))
        let added = 0
        for (const mp of mobilePlaylistsResult.playlists) {
          if (!mp?.id || existingIds.has(mp.id)) continue
          const trackIds = Array.isArray(mp.trackIds)
            ? mp.trackIds.map(Number).filter(n => Number.isFinite(n))
            : []
          savedPlaylists.push({
            id: mp.id,
            name: mp.name || 'Untitled playlist',
            trackIds,
            source: 'mobile',
          })
          added++
        }
        if (added > 0) {
          console.log(`[mobile-playlists] loaded ${added} iOS-created playlists`)
        }
      }
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
          // 4.5.0-63: if a prior session left the user on the now-hidden
          // Record Store view (Brief 037 placeholder), fall back to
          // Songs on relaunch so they don't open into a dead view with
          // no sidebar entry to navigate away from.
          const restoredView = ui.currentView === 'recordstore' ? 'songs' : ui.currentView
          dispatch({ type: 'SET_VIEW', view: restoredView as import('./types').ViewName })
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
        if (ui.colWidthMap || ui.hiddenCols || ui.columnOrder) {
          window.dispatchEvent(new CustomEvent('jaketunes-restore-columns', {
            detail: { colWidthMap: ui.colWidthMap, hiddenCols: ui.hiddenCols, columnOrder: ui.columnOrder, colsV: ui.colsV }
          }))
        }
      }
      setUiReady(true)
      // Load artwork map, then auto-fetch any missing album art in background
      if (typeof window.electronAPI.loadArtworkMap === 'function') {
        window.electronAPI.loadArtworkMap().then((r) => {
          if (!r?.ok) return
          const map = r.map || {}
          dispatch({ type: 'SET_ARTWORK_MAP', map })

          // 4.4.12: ONE-SHOT EMBEDDED-ART BACKFILL — deferred so first paint
          // never waits on parseFile across the whole library. Fire-and-forget
          // after an idle window; views resolve disk misses on demand.
          const scheduleIdle = typeof requestIdleCallback === 'function'
            ? (cb: () => void, ms: number) => requestIdleCallback(cb, { timeout: ms })
            : (cb: () => void, ms: number) => window.setTimeout(cb, Math.min(ms, 32))
          scheduleIdle(() => {
            void (async () => {
              try {
                const status = await window.electronAPI.artworkBackfillStatus?.()
                if (!status?.ok || status.done) return
                const candidates = tracks
                  .filter(t => t.artist && t.album && t.path)
                  .map(t => ({ path: t.path, artist: t.artist, album: t.album }))
                if (candidates.length === 0) return
                const result = await window.electronAPI.backfillEmbeddedArtwork(candidates)
                if (result?.ok && result.artwork) {
                  for (const a of result.artwork) {
                    dispatch({ type: 'ADD_ARTWORK', key: a.key, hash: a.hash })
                  }
                }
              } catch { /* backfill best-effort */ }
            })()
          }, 12_000)

          // Missing-art enrichment: disk resolve first (cheap), then a tiny
          // capped network sample. Pre-fix walked EVERY missing album sequentially
          // at launch — thousands of fetchAlbumArt IPCs pinned the main process.
          if (startupNetworkArtStarted) return
          startupNetworkArtStarted = true
          scheduleIdle(() => {
            const albums = new Map<string, { artist: string; album: string }>()
            for (const t of tracks) {
              if (t.artist && t.album) {
                const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
                if (!albums.has(k)) albums.set(k, { artist: t.artist, album: t.album })
              }
            }
            const missing: { artist: string; album: string }[] = []
            for (const [k, v] of albums) {
              if (!map[k]) missing.push(v)
            }
            if (missing.length === 0) return
            queueArtworkResolutions(missing.slice(0, 48), dispatch)
            const networkBatch = missing.slice(0, STARTUP_NETWORK_ART_CAP)
            void (async () => {
              for (let i = 0; i < networkBatch.length; i += STARTUP_NETWORK_ART_CONCURRENCY) {
                const chunk = networkBatch.slice(i, i + STARTUP_NETWORK_ART_CONCURRENCY)
                await Promise.all(chunk.map(async ({ artist, album }) => {
                  try {
                    const result = await window.electronAPI.fetchAlbumArt(artist, album)
                    if (result.ok && result.key && result.hash) {
                      dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
                    }
                  } catch { /* ignore individual failures */ }
                }))
                await new Promise(r => window.setTimeout(r, 400))
              }
            })()
          }, 8_000)
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
      window.electronAPI.saveLibrary(libState.tracks, libState.playlists).then((r) => {
        if (r.ok && (r.preservedOrphanCount ?? 0) > 0) {
          setPreservedOrphanBanner(r.preservedOrphanCount ?? 0)
        }
      }).catch(() => {})
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
      const { colWidthMap, hiddenCols, columnOrder, colsV } = (e as CustomEvent).detail
      // Merge column state into next save
      window.electronAPI.loadUiState().then(r => {
        const existing = (r.ok && r.state) ? r.state : {}
        window.electronAPI.saveUiState({ ...existing, colWidthMap, hiddenCols, columnOrder, colsV })
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
    // 4.5.0-109: auto-clear the activity pill when the sync genuinely
    // ends. Pre-fix the 'iTunesDB written' message stuck forever for
    // auto-syncs (DeviceView's 4-sec timeout only runs for manual ones),
    // which is why Jake saw "Syncing..." after sync was actually done.
    // We clear after the same 4-sec dwell so the user sees the final
    // status briefly, then the pill drops.
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.electronAPI.onSyncProgress((progress) => {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null }
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
          const done = progress.current >= progress.total
          a.setSync({
            active: true,
            step: done ? 'iTunesDB written' : 'Writing iTunesDB...',
          })
          if (done) {
            clearTimer = setTimeout(() => { a.setSync(null) }, 4000)
          }
        } else if (progress.phase === 'cancelled') {
          a.setSync({ active: true, step: `Sync cancelled (${progress.current} copied)` })
          clearTimer = setTimeout(() => { a.setSync(null) }, 3000)
        }
      }).catch(() => {})
    })
    return () => { if (clearTimer) clearTimeout(clearTimer); cleanup() }
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
        case 'new-playlist': window.dispatchEvent(new Event('jaketunes-new-playlist')); break
        case 'import-files': window.dispatchEvent(new Event('jaketunes-import-files')); break
        case 'show-now-playing': window.dispatchEvent(new Event('jaketunes-show-now-playing')); break
        case 'view-songs': dispatch({ type: 'SET_VIEW', view: 'songs' }); break
        case 'view-artists': dispatch({ type: 'SET_VIEW', view: 'artists' }); break
        case 'view-albums': dispatch({ type: 'SET_VIEW', view: 'albums' }); break
        case 'view-genres': dispatch({ type: 'SET_VIEW', view: 'genres' }); break
        case 'open-import-convert': setImportConvertOpen(true); break
        case 'fix-ipod-compat':     setAlacCompatOpen(true); break
        case 'prepare-alac-cache':  setPlayCacheMode('prepare'); break
        case 'prune-alac-cache':    setPlayCacheMode('prune'); break
        case 'clean-orphan-files':  setOrphanCleanupOpen(true); break
        case 'show-duplicates':     setShowDuplicatesOpen(true); break
        case 'open-preferences':    setSettingsOpen(true); break
        // Brief 023: 'export-mobile-snapshot' and 'apply-mobile-overrides'
        // removed — vestigial mobile-sync feature that never shipped.
        // Tag write-back (Brief 020) is the path Plex/mobile consume now.
        case 'apply-overrides-to-files': {
          // Brief 020 batch backfill — push every writable override
          // (~1.6k entries at ship time) into the corresponding audio
          // file's embedded tags so Plex sees the corrected metadata.
          // Just opens the confirm; the actual run happens after
          // onConfirm in the ConfirmDialog renders below.
          setApplyOverridesConfirmOpen(true)
          break
        }
        case 'refresh-file-sizes': {
          // Brief 016 commit 2 retrofit — walk every track, stat the
          // on-disk file, update library.json.fileSize when stale.
          // Eliminates the ~30% fileSize drift Matt's mobile probe v2
          // flagged. Confirm-then-run pattern, identical shape to the
          // apply-overrides flow above.
          setRefreshSizesConfirmOpen(true)
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
        if (!r.tracks) return
        // Brief 016: compute a diff against the current in-memory library
        // and dispatch a partial UPDATE_TRACKS for small changes instead
        // of a full SET_TRACKS that replaces the entire 6195-element
        // array. Full replacement cascades through every memo and view
        // watching libState.tracks, clobbering playback UI state (stale
        // now-playing title, frozen scrubber) — that was the proximate
        // cause of the "auto-repeat" symptom Brief 015 instrumented.
        //
        // The currently playing track is never overwritten during
        // playback — the audio engine has the source of truth for that
        // track's playback state.
        const currentTracks = libStateRef.current.tracks
        // Rescue just-imported tracks the disk copy doesn't have yet. A
        // Bandcamp/squid import adds the track to memory immediately but
        // only persists via the 1s-debounced saveLibrary; if an external
        // write (NAS/Mini sync, or the import's own write) fires the
        // library watcher inside that window, this reload reads a
        // library.json WITHOUT the fresh track and the count-mismatch
        // branch below would SET_TRACKS it away — the "album appears then
        // disappears post-download" bug. recentlyAdded marks imports for
        // 10s (well past the 1s save), so keep any such track that's
        // missing from disk; the next reload after the save has it and
        // this is a no-op.
        const diskIds = new Set(r.tracks.map(t => t.id))
        const rescued = currentTracks.filter(t => !diskIds.has(t.id) && isRecentlyAdded(t.id))
        if (rescued.length > 0) {
          console.log('[lib-reload] rescued', rescued.length, 'just-imported track(s) missing from disk reload')
        }
        const newTracks = rescued.length > 0 ? [...r.tracks, ...rescued] : r.tracks
        const nowPlayingId = pbStateRef.current.nowPlaying?.id

        // Large structural change → fall back to SET_TRACKS so things
        // like fresh imports or iPod-sync arrivals work as before.
        if (newTracks.length !== currentTracks.length) {
          console.log('[dx.repeat.lib-reload]', {
            message: 'track count changed, dispatching SET_TRACKS',
            oldCount: currentTracks.length,
            newCount: newTracks.length,
            protectedNowPlaying: nowPlayingId,
          })
          dispatch({ type: 'SET_TRACKS', tracks: newTracks })
          return
        }

        // Same count → compute per-field diff.
        const currentById = new Map(currentTracks.map(t => [t.id, t]))
        const changed: Array<{ id: number; field: string; value: string | boolean }> = []
        let needFullReload = false
        for (const newTrack of newTracks) {
          const oldTrack = currentById.get(newTrack.id)
          if (!oldTrack) {
            // Same total count but a new id appeared — id set is
            // disjoint, partial merge isn't safe. Fall back to full.
            needFullReload = true
            break
          }
          // Protect the currently playing track entirely.
          if (nowPlayingId !== undefined && newTrack.id === nowPlayingId) continue
          const keys = new Set([
            ...Object.keys(oldTrack as unknown as Record<string, unknown>),
            ...Object.keys(newTrack as unknown as Record<string, unknown>),
          ])
          for (const key of keys) {
            const oldVal = (oldTrack as unknown as Record<string, unknown>)[key]
            const newVal = (newTrack as unknown as Record<string, unknown>)[key]
            if (oldVal === newVal) continue
            // UPDATE_TRACKS values are string | boolean; coerce numeric
            // and undefined uniformly. Functions/objects aren't valid
            // track fields, so skipping them is safe.
            if (typeof newVal === 'boolean') {
              changed.push({ id: newTrack.id, field: key, value: newVal })
            } else if (newVal === undefined || newVal === null) {
              changed.push({ id: newTrack.id, field: key, value: '' })
            } else if (typeof newVal === 'string' || typeof newVal === 'number') {
              changed.push({ id: newTrack.id, field: key, value: String(newVal) })
            }
            // arrays/objects skipped — Track has none of those today
          }
        }

        if (needFullReload) {
          console.log('[dx.repeat.lib-reload]', {
            message: 'disjoint id set, falling back to SET_TRACKS',
            count: newTracks.length,
            protectedNowPlaying: nowPlayingId,
          })
          dispatch({ type: 'SET_TRACKS', tracks: newTracks })
          return
        }

        if (changed.length === 0) {
          console.log('[dx.repeat.lib-reload]', {
            message: 'no detectable diff, skipping dispatch',
            protectedNowPlaying: nowPlayingId,
          })
          return
        }

        // Threshold: huge diffs are cheaper as a single SET_TRACKS
        // dispatch. 200 was chosen as the rough boundary between
        // "incremental analysis result" (1–10 fields) and "large
        // external rewrite" (hundreds of fields).
        if (changed.length > 200) {
          console.log('[dx.repeat.lib-reload]', {
            message: 'large diff, falling back to SET_TRACKS',
            changedFields: changed.length,
            protectedNowPlaying: nowPlayingId,
          })
          dispatch({ type: 'SET_TRACKS', tracks: newTracks })
          return
        }

        console.log('[dx.repeat.lib-reload]', {
          message: 'dispatching partial UPDATE_TRACKS',
          changedFields: changed.length,
          protectedNowPlaying: nowPlayingId,
        })
        dispatch({ type: 'UPDATE_TRACKS', updates: changed })
      })
    }
    const unsubExt = window.electronAPI.onLibraryExternalChange(() => {
      console.log('library.json changed externally, reloading in-memory state')
      setNotice('Library updated on disk — reloaded.', { durationMs: 4000 })
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

  // Cynthia overhaul — when the background sweep auto-applies a provable
  // fix (main process, overrides file), mirror it into the in-memory
  // library so the UI reflects it live instead of after next relaunch.
  useEffect(() => {
    if (!window.electronAPI.onCynthiaSweepProgress) return
    return window.electronAPI.onCynthiaSweepProgress((p) => {
      if (p.autoApplied.length === 0) return
      dispatch({
        type: 'UPDATE_TRACKS',
        updates: p.autoApplied.map(f => ({ id: f.trackId, field: f.field, value: f.newValue })),
      })
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

  // File → Import… (⌘O): native file picker feeding the EXACT same
  // enqueueFiles() pipeline as drag-and-drop (format pref honored, dedupe,
  // queue panel progress).
  useEffect(() => {
    const handler = async () => {
      const r = await window.electronAPI.importPickFiles()
      if (!r?.ok || !r.paths || r.paths.length === 0) return
      const ui = await window.electronAPI.loadUiState().catch(() => ({ ok: false as const, state: null }))
      const importFormat = (ui.ok && ui.state && typeof (ui.state as Record<string, unknown>).importFormat === 'string')
        ? (ui.state as Record<string, unknown>).importFormat as string
        : undefined
      void enqueueFiles(r.paths, importFormat)
    }
    const listener = () => { void handler() }
    window.addEventListener('jaketunes-import-files', listener)
    return () => window.removeEventListener('jaketunes-import-files', listener)
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
      {saveLockReason && (
        <div className="state-save-locked-banner" role="alert">
          <strong>Library writes paused.</strong> {saveLockReason}
          <button onClick={() => window.location.reload()}>Reload (restart this window)</button>
        </div>
      )}
      {preservedOrphanBanner != null && preservedOrphanBanner > 0 && (
        <div className="state-save-locked-banner" role="alert">
          <strong>{preservedOrphanBanner} file{preservedOrphanBanner === 1 ? '' : 's'} removed from library but kept on disk.</strong>
          {' '}Use File → Library → Clean Orphan Files to reclaim space.
          <button onClick={() => { setOrphanCleanupOpen(true); setPreservedOrphanBanner(null) }}>Clean Now</button>
          <button onClick={() => setPreservedOrphanBanner(null)}>Dismiss</button>
        </div>
      )}
      <div className="titlebar">
        <div className="titlebar-nav">
          <button className="titlebar-nav-btn" disabled={!canGoBack} onClick={goBack} title="Back  ⌘[" aria-label="Back">‹</button>
          <button className="titlebar-nav-btn" disabled={!canGoForward} onClick={goForward} title="Forward  ⌘]" aria-label="Forward">›</button>
        </div>
        <Breadcrumb />
      </div>
      <div className="toolbar-area">
        <Toolbar
          onToggleQueue={() => {
            if (showQueue) queueRef.current?.requestClose()
            else setShowQueue(true)
          }}
          onOpenQueue={() => setShowQueue(true)}
          showQueue={showQueue}
        />
      </div>
      <div className="sidebar-area" style={{ width: sidebarWidth }}>
        <Sidebar />
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarDrag} />
      </div>
      <div className="content-area" style={{ position: 'relative' }}>
        <MainContent />
        {showQueue && <QueuePanel ref={queueRef} onClose={() => setShowQueue(false)} />}
        {importConvertOpen && <ImportConvertModal onClose={() => setImportConvertOpen(false)} />}
        {alacCompatOpen && <LibraryMaintenanceModal mode="alac" onClose={() => setAlacCompatOpen(false)} />}
        {playCacheMode && <PlayCacheModal mode={playCacheMode} onClose={() => setPlayCacheMode(null)} />}
        {orphanCleanupOpen && (
          <OrphanCleanupModal
            onClose={() => setOrphanCleanupOpen(false)}
            onLibraryChanged={() => {
              window.electronAPI.loadTracks().then((r) => {
                if (r.tracks) dispatch({ type: 'SET_TRACKS', tracks: r.tracks })
              }).catch(() => {})
            }}
          />
        )}
        {settingsOpen && (
          <SettingsModal
            initial={appSettings}
            onClose={() => setSettingsOpen(false)}
            onSaved={(next) => {
              setAppSettings(next)
              setCrossfadeSettings(next.crossfade)
              setEqSettings(next.eq)
              setStereoWidth(next.audio.stereoWidth)
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
        {/* Brief 020: Apply-Overrides-to-Files three-phase modal flow.
            Confirm → progress → result. Each phase shares the
            ConfirmDialog styling for visual consistency; progress is
            a custom inline modal since ConfirmDialog assumes buttoned
            interaction and the in-flight phase has nothing to click. */}
        {applyOverridesConfirmOpen && (
          <ConfirmDialog
            message="Apply JakeTunes overrides to audio files?"
            detail="This writes your edited metadata (title, artist, album, genre, year, track/disc numbers) into the audio files' embedded tags. Plex will pick up the corrected values on its next scan. Each file's original tags are backed up to a sidecar (<path>.original-tags.json) before any change — reversible. Analysis fields (BPM, key) and listener stats stay JakeTunes-only and are NOT written."
            confirmLabel="Apply Overrides"
            cancelLabel="Cancel"
            destructive={false}
            onCancel={() => setApplyOverridesConfirmOpen(false)}
            onConfirm={() => {
              setApplyOverridesConfirmOpen(false)
              setApplyOverridesProgress({ done: 0, total: 0, succeeded: 0, failed: 0 })
              const unsub = window.electronAPI.onTagWritebackProgress((p) => {
                setApplyOverridesProgress(p)
              })
              void (async () => {
                try {
                  const r = await window.electronAPI.applyOverridesBatch()
                  unsub()
                  setApplyOverridesProgress(null)
                  if (r.ok) {
                    setApplyOverridesResult({
                      total: r.total ?? 0,
                      succeeded: r.succeeded ?? 0,
                      failed: r.failed ?? 0,
                      skippedNoTrack: r.skippedNoTrack ?? 0,
                      skippedFpMismatch: r.skippedFpMismatch ?? 0,
                      skippedNoWritable: r.skippedNoWritable ?? 0,
                      failures: r.failures ?? [],
                    })
                  } else {
                    setApplyOverridesResult({
                      total: 0, succeeded: 0, failed: 0,
                      skippedNoTrack: 0, skippedFpMismatch: 0, skippedNoWritable: 0,
                      failures: [{ filePath: '(batch error)', error: r.error }],
                    })
                  }
                } catch (err) {
                  unsub()
                  setApplyOverridesProgress(null)
                  setApplyOverridesResult({
                    total: 0, succeeded: 0, failed: 0,
                    skippedNoTrack: 0, skippedFpMismatch: 0, skippedNoWritable: 0,
                    failures: [{ filePath: '(client error)', error: err instanceof Error ? err.message : String(err) }],
                  })
                }
              })()
            }}
          />
        )}
        {applyOverridesProgress && (
          <div className="confirm-overlay">
            <div className="confirm-dialog">
              <div className="confirm-message">Applying overrides to files…</div>
              <div className="confirm-detail">
                {applyOverridesProgress.total === 0
                  ? 'Preparing…'
                  : `${applyOverridesProgress.done.toLocaleString()} of ${applyOverridesProgress.total.toLocaleString()} files (${applyOverridesProgress.succeeded.toLocaleString()} written, ${applyOverridesProgress.failed.toLocaleString()} failed)`}
              </div>
              <div style={{
                marginTop: 12,
                height: 6,
                background: '#2a2a2a',
                borderRadius: 3,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${applyOverridesProgress.total > 0 ? (applyOverridesProgress.done / applyOverridesProgress.total) * 100 : 0}%`,
                  background: '#e0812e',
                  transition: 'width 200ms ease-out',
                }} />
              </div>
            </div>
          </div>
        )}
        {applyOverridesResult && (
          <ConfirmDialog
            message={
              applyOverridesResult.failed > 0
                ? `Wrote tags to ${applyOverridesResult.succeeded.toLocaleString()} files; ${applyOverridesResult.failed.toLocaleString()} failed.`
                : `Wrote tags to ${applyOverridesResult.succeeded.toLocaleString()} files.`
            }
            detail={
              `Skipped: ${applyOverridesResult.skippedNoTrack.toLocaleString()} missing-track, ` +
              `${applyOverridesResult.skippedFpMismatch.toLocaleString()} fingerprint-mismatch, ` +
              `${applyOverridesResult.skippedNoWritable.toLocaleString()} analysis-only.` +
              (applyOverridesResult.failures.length > 0
                ? `\n\nFirst failures:\n${applyOverridesResult.failures.slice(0, 5).map(f => `• ${f.filePath.split('/').pop()}: ${f.error || 'unknown'}`).join('\n')}`
                : '')
            }
            confirmLabel="Done"
            hideCancel
            destructive={false}
            onCancel={() => setApplyOverridesResult(null)}
            onConfirm={() => setApplyOverridesResult(null)}
          />
        )}
        {/* Brief 016 commit 2: three-phase Refresh File Sizes flow.
            Same shape as the Brief 020 Apply-Overrides flow above —
            ConfirmDialog → inline progress modal → ConfirmDialog
            result summary. Reuses the .confirm-overlay / .confirm-
            dialog CSS classes plus the brand-orange progress bar. */}
        {refreshSizesConfirmOpen && (
          <ConfirmDialog
            message="Refresh library.json file sizes from disk?"
            detail="Walks every track in your library, stats the actual audio file, and updates library.json's cached fileSize when it differs. Audio files themselves are NOT modified. Fixes a known ~30% fileSize drift that prevents mobile (Plex via JakeTunes Mobile) from validating tracks correctly."
            confirmLabel="Refresh Sizes"
            cancelLabel="Cancel"
            destructive={false}
            onCancel={() => setRefreshSizesConfirmOpen(false)}
            onConfirm={() => {
              setRefreshSizesConfirmOpen(false)
              setRefreshSizesProgress({ scanned: 0, refreshed: 0, total: 0 })
              const unsub = window.electronAPI.onRefreshFileSizesProgress((p) => {
                setRefreshSizesProgress(p)
              })
              void (async () => {
                try {
                  const r = await window.electronAPI.refreshFileSizes()
                  unsub()
                  setRefreshSizesProgress(null)
                  if (r.ok) {
                    setRefreshSizesResult({ refreshed: r.refreshed ?? 0 })
                  } else {
                    setRefreshSizesResult({ refreshed: 0, error: r.error })
                  }
                } catch (err) {
                  unsub()
                  setRefreshSizesProgress(null)
                  setRefreshSizesResult({ refreshed: 0, error: err instanceof Error ? err.message : String(err) })
                }
              })()
            }}
          />
        )}
        {refreshSizesProgress && (
          <div className="confirm-overlay">
            <div className="confirm-dialog">
              <div className="confirm-message">Refreshing file sizes…</div>
              <div className="confirm-detail">
                {refreshSizesProgress.total === 0
                  ? 'Preparing…'
                  : `Scanned ${refreshSizesProgress.scanned.toLocaleString()} of ${refreshSizesProgress.total.toLocaleString()} (${refreshSizesProgress.refreshed.toLocaleString()} refreshed so far)`}
              </div>
              <div style={{
                marginTop: 12,
                height: 6,
                background: '#2a2a2a',
                borderRadius: 3,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${refreshSizesProgress.total > 0 ? (refreshSizesProgress.scanned / refreshSizesProgress.total) * 100 : 0}%`,
                  background: '#e0812e',
                  transition: 'width 200ms ease-out',
                }} />
              </div>
            </div>
          </div>
        )}
        {refreshSizesResult && (
          <ConfirmDialog
            message={
              refreshSizesResult.error
                ? 'Refresh failed.'
                : `Refreshed fileSize on ${refreshSizesResult.refreshed.toLocaleString()} tracks.`
            }
            detail={
              refreshSizesResult.error
                ? refreshSizesResult.error
                : (refreshSizesResult.refreshed === 0
                    ? 'No drift found. library.json fileSize already matched disk for every track.'
                    : 'library.json has been updated. The next sync will propagate the corrected sizes to Mini.')
            }
            confirmLabel="Done"
            hideCancel
            destructive={false}
            onCancel={() => setRefreshSizesResult(null)}
            onConfirm={() => setRefreshSizesResult(null)}
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
      <BandcampImportToast />
      <Visualizer />
    </div>
  )
}

export default function App() {
  return (
    <LibraryProvider>
      <NavigationProvider>
        {/* V5 facelift: view-mode (List/Grid/CoverFlow) observer — reads
            LibraryContext only, so it sits above PlaybackProvider. */}
        <ViewModeProvider>
          <PlaybackProvider>
            <CynthiaProvider>
              <AppInner />
            </CynthiaProvider>
          </PlaybackProvider>
        </ViewModeProvider>
      </NavigationProvider>
    </LibraryProvider>
  )
}
