import { useMemo, useState, useEffect, useRef } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { buildWorkoutIpodSyncPayload, assembleSyncPlaylists, type WorkoutSyncPayload } from '../utils/workoutIpodSync'
// Called in runFullLibrarySync below. The comment at the top of this file has
// named this as the shared source of sync playlists since it was extracted, but
// the import was never added — so a full library sync threw ReferenceError
// before copying anything.
import { buildSmartPlaylistsForSync } from '../utils/smartPlaylists'
import ActivitySheet, { type ActivityBrief } from '../components/ActivitySheet'
import SyncReviewSheet from '../components/SyncReviewSheet'
import ConfirmDialog from '../components/ConfirmDialog'
import IpodLibraryModal from '../components/IpodLibraryModal'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import '../styles/device.css'

// Fallback capacity shown before the main process reports the real size.
// This used to be hardcoded to 64GB, which misreports SD-card-modded iPods.
// The actual size now comes from statfs() via get-ipod-capacity.
const FALLBACK_CAPACITY_BYTES = 64 * 1024 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function formatDurationLong(ms: number): string {
  const totalMins = Math.floor(ms / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}, ${remHours} hour${remHours !== 1 ? 's' : ''}`
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}, ${mins} minute${mins !== 1 ? 's' : ''}`
  return `${mins} minute${mins !== 1 ? 's' : ''}`
}

function IpodLargeIcon() {
  return (
    <svg width="64" height="100" viewBox="0 0 64 100" fill="none">
      <rect x="2" y="2" width="60" height="96" rx="8" fill="url(#ipodBody)" stroke="#888" strokeWidth="1.5" />
      <rect x="8" y="8" width="48" height="36" rx="4" fill="#b8d8b0" stroke="#999" strokeWidth="0.8" />
      <text x="32" y="30" textAnchor="middle" fill="#444" fontSize="7" fontWeight="500" fontFamily="-apple-system, sans-serif">iPod</text>
      <circle cx="32" cy="70" r="16" fill="none" stroke="#aaa" strokeWidth="1.5" />
      <circle cx="32" cy="70" r="6" fill="#ddd" stroke="#aaa" strokeWidth="1" />
      <defs>
        <linearGradient id="ipodBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8e8e8" />
          <stop offset="100%" stopColor="#c8c8c8" />
        </linearGradient>
      </defs>
    </svg>
  )
}

// 4.4.46 — `refreshSmartPlaylists` used to live here as a local copy
// that diverged from what `SmartPlaylistView` displayed (different
// counts; Recently Played skipped). It's now the shared
// `buildSmartPlaylistsForSync` in `utils/smartPlaylists.ts`, backed by
// the same `evaluateSmartPlaylist` the view uses. See that file's
// header for the full why.

type SyncStatus = { state: 'idle' } | { state: 'syncing'; step: string } | { state: 'done'; copied: number; total: number; time: string } | { state: 'error'; message: string }

export default function DeviceView() {
  const { state, dispatch } = useLibrary()
  // 2026-07-24 (Jake: "on top it says i have 8676 songs but on the bottom i have
  // 8621. thats an issue!!"). The status bar counts REGULAR library songs — it
  // excludes the individual tracks inside declared full concerts (3 concerts =
  // 55 tracks: Nassau '80 24, Everything Will Change 17, Alive 2007 14). This
  // view was using the raw state.tracks.length and so reported 8,676. Same
  // source of truth as StatusBar now, so the two numbers always agree.
  const regularTracks = useRegularLibraryTracks(state.tracks)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'idle' })
  const [ipodName, setIpodName] = useState('iPod')
  // 2026-07-20 (Jake: "this shouldnt say ~1000 songs. it has to be 1000"):
  // the EXACT on-device catalog count, read from the iPod's own iTunesDB.
  // null until a device answers; the Songs line falls back to the ~estimate.
  const [deviceSongCount, setDeviceSongCount] = useState<number | null>(null)
  const [ipodCapacityBytes, setIpodCapacityBytes] = useState<number>(FALLBACK_CAPACITY_BYTES)
  // Real statfs() free bytes from the mounted iPod (via get-ipod-capacity).
  // Preferred over the library-sum estimate because library `fileSize` can
  // drift from on-iPod reality whenever bitrate conversion has run — the
  // library stores source-side ALAC sizes while the iPod holds smaller AAC
  // mirrors, leaving the synthetic free-space calc 50+GB off.
  const [ipodFreeBytes, setIpodFreeBytes] = useState<number | null>(null)
  // Real filesystem from the mount table — the panel used to assert HFS+ on a
  // FAT32 device (2026-07-25).
  const [ipodFsName, setIpodFsName] = useState<string | null>(null)
  const [showIpodLibrary, setShowIpodLibrary] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [showActivitySheet, setShowActivitySheet] = useState(false)
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false)
  const [lastBrief, setLastBrief] = useState<ActivityBrief | null>(null)
  // REVIEW GATE: set after Music Man builds a proposal; nothing syncs or
  // persists until the user confirms the (possibly edited) list.
  const [reviewData, setReviewData] = useState<{
    payload: WorkoutSyncPayload
    brief: ActivityBrief
    keepIds: Set<number>
    leaving: Array<{ path: string; title: string; artist: string }>
  } | null>(null)
  // Last CONFIRMED activity set — offered as "Save as playlist" (its own
  // SYNCED SETS sidebar category) when Jake really likes a sync.
  const [lastCommitted, setLastCommitted] = useState<{ name: string; trackIds: number[] } | null>(null)
  const [savedSetNotice, setSavedSetNotice] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getWorkoutSyncState?.().then((r) => {
      if (r?.ok && r.state?.trackIds?.length) {
        setLastCommitted({ name: r.state.name, trackIds: r.state.trackIds })
      }
    }).catch(() => {})
  }, [])

  const saveLastSetAsPlaylist = () => {
    if (!lastCommitted) return
    const exists = state.playlists.some((p) => p.category === 'synced-set' && p.name === lastCommitted.name)
    const name = exists
      ? `${lastCommitted.name} (${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })})`
      : lastCommitted.name
    dispatch({
      type: 'ADD_PLAYLIST',
      playlist: {
        id: `synced-set-${Date.now()}`,
        name,
        trackIds: lastCommitted.trackIds,
        category: 'synced-set' as const,
      },
    })
    setSavedSetNotice(`Saved “${name}” to Synced Sets`)
    setTimeout(() => setSavedSetNotice(null), 4000)
  }

  // Pull the version from main once on mount. Sourced from package.json
  // via app.getVersion() so it auto-tracks the actual installed build.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getAppVersion().then(v => { if (!cancelled) setAppVersion(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // iTunes-style device options. Stored in ui-state.json so they persist
  // across launches. Behavior for each option is implemented as the
  // corresponding feature lands; for now they at least remember the
  // user's preference.
  const [optOpenOnConnect, setOptOpenOnConnect] = useState(false)
  const [optSyncOnlyChecked, setOptSyncOnlyChecked] = useState(false)
  const [optConvertBitrate, setOptConvertBitrate] = useState(false)
  const [optConvertBitrateTarget, setOptConvertBitrateTarget] = useState<'128' | '192' | '256'>('128')
  const [optManualManage, setOptManualManage] = useState(true)
  const [optDiskUse, setOptDiskUse] = useState(true)
  const optsLoaded = useRef(false)
  // 4.5: iTunes-style Apply pattern. The "applied" snapshot is what's
  // currently persisted to disk + considered live; the working state
  // (above) is what the user is editing. Sync is gated on
  // applied === working — if the user has unsaved settings changes,
  // Apply must run first. Initial value matches the defaults so the
  // first session post-load is clean.
  const [appliedSettings, setAppliedSettings] = useState({
    optOpenOnConnect: false,
    optSyncOnlyChecked: false,
    optConvertBitrate: false,
    optConvertBitrateTarget: '128' as '128' | '192' | '256',
    optManualManage: true,
    optDiskUse: true,
  })

  // The EXACT on-device song count, straight from the iPod's own catalog
  // (the sync's readback guard keeps that catalog honest). Refreshes on
  // view open, after every sync finishes, and when a device mounts.
  useEffect(() => {
    let alive = true
    const refresh = () => {
      window.electronAPI.checkIpodMounted().then(async (r) => {
        if (!alive) return
        if (!r.mounted) { setDeviceSongCount(null); return }
        const db = await window.electronAPI.getIpodDbTracks()
        if (alive && db.ok) setDeviceSongCount(db.total)
      }).catch(() => { if (alive) setDeviceSongCount(null) })
    }
    if (!syncing) refresh()
    window.addEventListener('jaketunes-ipod-mounted', refresh)
    return () => { alive = false; window.removeEventListener('jaketunes-ipod-mounted', refresh) }
  }, [syncing])

  useEffect(() => {
    window.electronAPI.checkIpodMounted().then(r => {
      if (r.name) setIpodName(r.name)
    }).catch(() => {})
    // Ask the main process for the real capacity of the mounted iPod
    // (modded units can be anything — 64GB, 128GB, 256GB, etc.).
    window.electronAPI.getIpodCapacity().then(r => {
      if (r.ok && r.totalBytes && r.totalBytes > 0) setIpodCapacityBytes(r.totalBytes)
      if (r.ok && typeof r.freeBytes === 'number') setIpodFreeBytes(r.freeBytes)
      if (r.ok && r.fsName) setIpodFsName(r.fsName)
    }).catch(() => {})
    // Load persisted device options out of ui-state.
    window.electronAPI.loadUiState().then(r => {
      if (!r.ok || !r.state) { optsLoaded.current = true; return }
      const s = r.state as Record<string, unknown>
      const loaded = {
        optOpenOnConnect: typeof s.optOpenOnConnect === 'boolean' ? s.optOpenOnConnect : false,
        optSyncOnlyChecked: typeof s.optSyncOnlyChecked === 'boolean' ? s.optSyncOnlyChecked : false,
        optConvertBitrate: typeof s.optConvertBitrate === 'boolean' ? s.optConvertBitrate : false,
        optConvertBitrateTarget: (s.optConvertBitrateTarget === '128' || s.optConvertBitrateTarget === '192' || s.optConvertBitrateTarget === '256')
          ? s.optConvertBitrateTarget as '128' | '192' | '256'
          : '128' as const,
        optManualManage: typeof s.optManualManage === 'boolean' ? s.optManualManage : true,
        optDiskUse: typeof s.optDiskUse === 'boolean' ? s.optDiskUse : true,
      }
      setOptOpenOnConnect(loaded.optOpenOnConnect)
      setOptSyncOnlyChecked(loaded.optSyncOnlyChecked)
      setOptConvertBitrate(loaded.optConvertBitrate)
      setOptConvertBitrateTarget(loaded.optConvertBitrateTarget)
      setOptManualManage(loaded.optManualManage)
      setOptDiskUse(loaded.optDiskUse)
      // 4.5: applied snapshot matches what was loaded — fresh session
      // starts in a non-dirty state regardless of what the persisted
      // values are.
      setAppliedSettings(loaded)
      optsLoaded.current = true
    }).catch(() => { optsLoaded.current = true })
  }, [])

  // 4.5: dirty detector. True when any working value differs from the
  // applied snapshot. Apply button appears + Sync gets gated when dirty.
  const isDirty =
    optOpenOnConnect !== appliedSettings.optOpenOnConnect ||
    optSyncOnlyChecked !== appliedSettings.optSyncOnlyChecked ||
    optConvertBitrate !== appliedSettings.optConvertBitrate ||
    optConvertBitrateTarget !== appliedSettings.optConvertBitrateTarget ||
    optManualManage !== appliedSettings.optManualManage ||
    optDiskUse !== appliedSettings.optDiskUse

  // 4.5: Apply persists current state to disk AND updates the applied
  // snapshot so the dirty flag drops to false. Sync becomes available.
  // The auto-save-on-change useEffect above was REMOVED — settings now
  // only persist on Apply click, matching iTunes' commit pattern Jake
  // asked for.
  const handleApplySettings = async () => {
    try {
      const r = await window.electronAPI.loadUiState()
      const existing = (r.ok && r.state) ? r.state : {}
      const snapshot = {
        optOpenOnConnect, optSyncOnlyChecked, optConvertBitrate,
        optConvertBitrateTarget, optManualManage, optDiskUse,
      }
      await window.electronAPI.saveUiState({ ...existing, ...snapshot })
      setAppliedSettings(snapshot)
    } catch (err) {
      console.warn('[device-settings] apply failed:', err)
    }
  }

  const stats = useMemo(() => {
    // Capacity bar estimates the NEXT workout sync (~1000 tracks), not the
    // full library — that's what actually lands on the iPod now.
    const WORKOUT_ESTIMATE = 1000
    const sortedBySize = [...state.tracks]
      .filter((t) => (t.fileSize || 0) > 0)
      .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
    const estimateTracks = sortedBySize.slice(0, Math.min(WORKOUT_ESTIMATE, sortedBySize.length))
    const tracks = estimateTracks.length > 0 ? estimateTracks : state.tracks.slice(0, WORKOUT_ESTIMATE)
    const totalBytes = tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
    const totalMs = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const artists = new Set(tracks.map(t => t.artist).filter(Boolean))
    const albums = new Set(tracks.map(t => t.album).filter(Boolean))
    const genres = new Set(tracks.map(t => t.genre).filter(Boolean))
    // Prefer the real statfs() free bytes when available — library
    // `fileSize` drifts from on-iPod reality after AAC conversion (the
    // library keeps source-side ALAC sizes, iPod has smaller AAC mirrors).
    // Fall back to library-sum math only on the very first paint before
    // get-ipod-capacity has responded.
    const freeBytes = ipodFreeBytes != null
      ? ipodFreeBytes
      : Math.max(0, ipodCapacityBytes - totalBytes - 500 * 1024 * 1024)
    // Ground truth: bytes the filesystem reports as in-use. Everything on
    // the bar (Audio + Other) has to fit inside this number, or the bar
    // sums to more than the iPod is physically capable of holding.
    const usedBytes = Math.max(0, ipodCapacityBytes - freeBytes)
    // The library's totalBytes can overstate reality whenever bitrate
    // conversion ran (library keeps source ALAC size, iPod has smaller
    // AAC mirror). Clamp Audio to what can actually fit on the device so
    // the bar tells the truth even when library `fileSize` is stale.
    const audioBytes = Math.min(totalBytes, usedBytes)
    // "Other" = everything else taking space (macOS dotfiles, iTunesDB,
    // artwork, orphans from past sync states). Derived so Audio + Other
    // + Free always adds up to capacity.
    const otherBytes = Math.max(0, usedBytes - audioBytes)
    const audioPercent = (audioBytes / ipodCapacityBytes) * 100
    const otherPercent = (otherBytes / ipodCapacityBytes) * 100
    const freePercent = Math.max(0, 100 - audioPercent - otherPercent)
    // Self-calibrating "room for N more songs": uses average bytes per
    // track on the device right now as the predictor, so it tracks the
    // user's actual library bitrate/length distribution rather than a
    // hardcoded "4 min @ 128k" assumption that's wrong for everyone.
    const avgBytesPerTrack = tracks.length > 0 ? audioBytes / tracks.length : 0
    const roomForSongs = avgBytesPerTrack > 0
      ? Math.max(0, Math.round(freeBytes / avgBytesPerTrack))
      : null

    return {
      trackCount: Math.min(WORKOUT_ESTIMATE, state.tracks.length),
      artistCount: artists.size,
      albumCount: albums.size,
      genreCount: genres.size,
      totalBytes,
      totalMs,
      freeBytes,
      audioBytes,
      otherBytes,
      audioPercent,
      otherPercent,
      freePercent,
      roomForSongs,
      libraryTotal: regularTracks.length,
    }
  }, [state.tracks, regularTracks, ipodCapacityBytes, ipodFreeBytes])

  const ensureIpodMounted = async (): Promise<boolean> => {
    const mount = await window.electronAPI.checkIpodMounted()
    if (mount?.mounted) return true
    const activity = await import('../activity')
    setSyncStatus({ state: 'error', message: 'No iPod detected — plug it in and try again.' })
    activity.setSync({ active: true, step: 'No iPod detected' })
    setTimeout(() => activity.setSync(null), 4000)
    return false
  }

  // Two explicit sync entry points (Jake, 2026-07-18: "separate activity
  // sync or supersync button… everything needs to work as planned. no
  // exceptions"). Each button does exactly ONE thing:
  //   Activity Sync → sheet → ~1,000-track set. Can never full-mirror.
  //   Full Sync → confirm dialog → whole-library mirror. The ONLY path
  //   to a full mirror; the sheet's "whole library" escape was removed.
  const handleActivitySync = async () => {
    if (await ensureIpodMounted()) setShowActivitySheet(true)
  }

  const handleFullSync = async () => {
    if (await ensureIpodMounted()) setShowFullSyncConfirm(true)
  }

  // The FULL-LIBRARY mirror (pre-activity behavior) — used for clean-slate
  // rebuilds (like the fragmentation cure) where the device must carry
  // everything, at the applied convert setting.
  const runFullLibrarySync = async () => {
    setShowFullSyncConfirm(false)
    const activity = await import('../activity')
    setSyncing(true)
    setSyncStatus({ state: 'syncing', step: 'Copying your whole library to iPod…' })
    activity.setSync({ active: true, step: 'Copying your whole library to iPod…' })
    try {
      const syncPlaylists = buildSmartPlaylistsForSync(state.tracks, state.playlists)
      const targetKbpsNum: 128 | 192 | 256 =
        appliedSettings.optConvertBitrateTarget === '256' ? 256
        : appliedSettings.optConvertBitrateTarget === '192' ? 192
        : 128
      const result = await window.electronAPI.syncToIpod(state.tracks, syncPlaylists, {
        enabled: appliedSettings.optConvertBitrate,
        targetKbps: targetKbpsNum,
      })
      if (result.alreadyRunning) return
      if (!result.ok) {
        const msg = result.error || 'Sync failed'
        setSyncStatus({ state: 'error', message: msg })
        activity.setSync({ active: true, step: `Sync failed — ${msg}` })
        setTimeout(() => activity.setSync(null), 4000)
        return
      }
      // Must match the 'done' variant's shape: the success renderer reads
      // total/copied/time directly, so a `message` here left total undefined
      // and threw on .toLocaleString() the moment the sync succeeded.
      setSyncStatus({
        state: 'done',
        copied: result.copied ?? 0,
        total: result.totalTracks ?? state.tracks.length,
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      })
      activity.setSync({ active: true, step: 'Sync complete' })
      setTimeout(() => activity.setSync(null), 4000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed'
      setSyncStatus({ state: 'error', message: msg })
    } finally {
      setSyncing(false)
    }
  }

  const runSyncWithBrief = async (brief: ActivityBrief) => {
    setShowActivitySheet(false)
    setLastBrief(brief)
    const activity = await import('../activity')

    setSyncing(true)
    setSyncStatus({ state: 'syncing', step: 'Music Man building your activity set…' })
    activity.setSync({ active: true, step: 'Music Man building your activity set…' })
    try {
      const built = await buildWorkoutIpodSyncPayload(state.tracks, state.playlists, brief)
      if (!built.ok) {
        const msg = built.error || 'Could not build activity set'
        setSyncStatus({ state: 'error', message: msg })
        activity.setSync({ active: true, step: `Sync failed — ${msg}` })
        setTimeout(() => activity.setSync(null), 4000)
        setSyncing(false)
        return
      }
      // REVIEW GATE (Jake 2026-07-18): stop here and show the proposed
      // set. previewIpodSync runs the ENGINE'S OWN planning criteria
      // (real files on the device + size matches vs source/cached
      // mirror) — never the iTunesDB, which is a stale template after a
      // gut. Nothing has synced or persisted — the build handler no
      // longer saves state, so Cancel = no trace.
      const targetKbpsPrev: 128 | 192 | 256 =
        appliedSettings.optConvertBitrateTarget === '256' ? 256
        : appliedSettings.optConvertBitrateTarget === '192' ? 192
        : 128
      const preview = await window.electronAPI.previewIpodSync?.(built.payload.tracks, {
        enabled: appliedSettings.optConvertBitrate,
        targetKbps: targetKbpsPrev,
      })
      const keepIds = new Set<number>(
        (preview?.ok ? preview.plan : []).filter((r) => r.action === 'keep').map((r) => r.id),
      )
      setReviewData({
        payload: built.payload,
        brief,
        keepIds,
        leaving: preview?.ok ? preview.leaving : [],
      })
      setSyncing(false)
      setSyncStatus({ state: 'idle' })
      activity.setSync(null)
    } catch (err) {
      console.error('Activity set build failed:', err)
      const msg = String(err)
      setSyncStatus({ state: 'error', message: msg })
      activity.setSync({ active: true, step: `Build failed — ${msg}` })
      setTimeout(() => activity.setSync(null), 4000)
      setSyncing(false)
    }
  }

  // The sync half — runs only after the user confirms the (possibly
  // edited) list in the review sheet. Commits the set as ground truth
  // ONLY after the device sync succeeds.
  const runConfirmedActivitySync = async (finalTracks: typeof state.tracks) => {
    const review = reviewData
    setReviewData(null)
    if (!review || finalTracks.length === 0) return
    const activity = await import('../activity')
    setSyncing(true)
    const name = review.payload.name
    // Playlists restored: the real root cause was the iTunesDB dataset assembly
    // (album list written before the track list + a stale type-5 section copied
    // verbatim from the old library, whose items pointed at deleted track ids —
    // the Mini's index build aborted on the dangling ref). Fixed in
    // core/db_reader.py (clean [tracks, playlists, albums] order, stale sections
    // dropped, num_children corrected), so playlists are safe to write again.
    const playlists = assembleSyncPlaylists(finalTracks, state.playlists, name)
    const wx = review.payload.weatherLine ? ` · ${review.payload.weatherLine}` : ''
    setSyncStatus({
      state: 'syncing',
      step: `Syncing “${name}” — ${finalTracks.length} tracks${wx}…`,
    })
    activity.setSync({ active: true, step: `Syncing “${name}” — ${finalTracks.length} tracks…` })
    try {
      // Activity sets ride the user's APPLIED convert setting — toggle
      // ON = 128k CBR mirrors (the chirp cure), OFF = ALAC preserved.
      const targetKbpsNum: 128 | 192 | 256 =
        appliedSettings.optConvertBitrateTarget === '256' ? 256
        : appliedSettings.optConvertBitrateTarget === '192' ? 192
        : 128
      const result = await window.electronAPI.syncToIpod(finalTracks, playlists, {
        enabled: appliedSettings.optConvertBitrate,
        targetKbps: targetKbpsNum,
      }, { wipeFirst: true })  // clean-slate rebuild every activity sync (Jake, 2026-07-24)
      if (result.alreadyRunning) {
        return
      }
      if (!result.ok) {
        // 4.5.0-109: distinguish user-cancelled from real failure. Cancel
        // is expected, not an error; flash a brief notice + return to idle.
        if (result.cancelled) {
          setSyncStatus({ state: 'idle' })
          activity.setSync({ active: true, step: `Sync cancelled (${result.copied || 0} files copied before stop)` })
          setTimeout(() => activity.setSync(null), 3000)
          setSyncing(false)
          return
        }
        const msg = result.error || 'Unknown error'
        setSyncStatus({ state: 'error', message: msg })
        activity.setSync({ active: true, step: `Sync failed — ${msg}` })
        setTimeout(() => activity.setSync(null), 4000)
        setSyncing(false)
        return
      }
      // Apply smart-sync path rewrites: when main detected that a
      // track's audio already lived on the iPod under a different
      // F-dir, it updated the in-flight tracks array for the DB
      // write. Mirror those rewrites into library.json so the
      // renderer stays consistent with what's now on the device.
      if (result.pathRewrites && result.pathRewrites.length > 0) {
        dispatch({
          type: 'UPDATE_TRACKS',
          updates: result.pathRewrites.map(r => ({ id: r.id, field: 'path', value: r.newPath })),
        })
      }
      // Apply silent post-sync identity-verifier updates: backfilled
      // audioFingerprints for older tracks that never got one,
      // path heals when a track's audio moved to a different F-dir,
      // and audioMissing flags when a track's file genuinely can't
      // be located on any known mount. The verifier never deletes —
      // worst case we just set audioMissing=true so the UI dims the
      // row. This is the identity-based replacement for the old
      // text-matching verify-and-repair flow that nuked Pink Floyd's
      // "Another Brick in the Wall, Pt. 1" because "Pt." didn't
      // match "Part" in its normalize().
      if (result.verificationUpdates && result.verificationUpdates.length > 0) {
        const updates: { id: number; field: string; value: string | boolean }[] = []
        for (const u of result.verificationUpdates) {
          if (u.path) updates.push({ id: u.id, field: 'path', value: u.path })
          if (u.audioFingerprint) updates.push({ id: u.id, field: 'audioFingerprint', value: u.audioFingerprint })
          if (u.audioMissing !== undefined) updates.push({ id: u.id, field: 'audioMissing', value: u.audioMissing })
        }
        if (updates.length > 0) dispatch({ type: 'UPDATE_TRACKS', updates })
      }
      // Sync landed — NOW commit the set as "what's on the iPod". This
      // is what plug-in auto-sync repairs and the next build rotates
      // away from. Also feeds Music Man's activity brain context.
      const proposedIds = new Set(review.payload.tracks.map((t) => t.id))
      const finalIds = new Set(finalTracks.map((t) => t.id))
      await window.electronAPI.commitWorkoutSyncSet?.({
        trackIds: finalTracks.map((t) => t.id),
        name,
        commentary: review.payload.commentary,
        alacCount: review.payload.alacCount,
        brief: review.brief as unknown as Record<string, unknown>,
        // Jake's review edits — the strongest taste signal the brain
        // gets: removed = demote next time, added = boost.
        added: finalTracks.filter((t) => !proposedIds.has(t.id))
          .map((t) => ({ id: t.id, title: String(t.title || ''), artist: String(t.artist || '') })),
        removed: review.payload.tracks.filter((t) => !finalIds.has(t.id))
          .map((t) => ({ id: t.id, title: String(t.title || ''), artist: String(t.artist || '') })),
      })
      setLastCommitted({ name, trackIds: finalTracks.map((t) => t.id) })
      const now = new Date()
      const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      // Verified-count truth (2026-07-24): `landed` is what actually committed to
      // the card (unmount/remount-verified), not what we sent. If it fell short of
      // the target, say so plainly instead of a false "done" — never claim a
      // number the card doesn't hold.
      const target = result.target ?? finalTracks.length
      const landed = result.landed ?? (result.totalTracks || finalTracks.length)
      const shortfall = result.shortfall ?? 0
      if (shortfall > 0) {
        const msg = `Only ${landed} of ${target} songs actually stuck on the iPod after ${result.verifyAttempts ?? 0} tries — the card keeps dropping writes. A reformat is likely needed to reach ${target}.`
        setSyncStatus({ state: 'error', message: msg })
        activity.setSync({ active: true, step: `iPod: ${landed}/${target} verified on device — card dropping writes` })
        setTimeout(() => activity.setSync(null), 6000)
      } else {
        setSyncStatus({
          state: 'done',
          copied: result.copied || 0,
          total: landed,
          time: timeStr,
        })
        // "done" now means everything is flushed + verified on the card (main
        // remounts before declaring success). The iPod firmware still builds its
        // own library index from the DB, so its on-screen count climbs up to the
        // real number over the next moment — set that expectation so a mid-index
        // read isn't mistaken for a short sync.
        activity.setSync({
          active: true,
          step: `Synced ${landed} to the iPod — all verified on the card. Give it a moment to finish counting up to ${landed}.`,
        })
        setTimeout(() => activity.setSync(null), 7000)
      }
    } catch (err) {
      console.error('Sync failed:', err)
      const msg = String(err)
      setSyncStatus({ state: 'error', message: msg })
      activity.setSync({ active: true, step: `Sync failed — ${msg}` })
      setTimeout(() => activity.setSync(null), 4000)
    }
    setSyncing(false)
  }

  return (
    <div className="device-view device-view--itunes">
      {/* ── Top info block: iPod image left, info grid right, update block far right ── */}
      <div className="device-itunes-top">
        <div className="device-itunes-icon"><IpodLargeIcon /></div>
        <div className="device-itunes-info">
          <h1 className="device-itunes-name">{ipodName || 'iPod'}</h1>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Capacity:</span>
            <span className="device-itunes-value">{formatBytes(ipodCapacityBytes)}</span>
          </div>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Songs:</span>
            <span className="device-itunes-value">
              {deviceSongCount != null
                // The device's own catalog — an exact, counted number.
                ? `${deviceSongCount.toLocaleString()} workout`
                // No device attached — the next sync's target, marked as such.
                : `~${stats.trackCount.toLocaleString()} workout`}
              {stats.libraryTotal > (deviceSongCount ?? stats.trackCount)
                ? ` (of ${stats.libraryTotal.toLocaleString()} in library)`
                : ''}
            </span>
          </div>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Software Version:</span>
            <span className="device-itunes-value">JakeTunes{appVersion ? ` ${appVersion}` : ''}</span>
          </div>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Format:</span>
            <span className="device-itunes-value">{ipodFsName || 'Unknown'}</span>
          </div>
        </div>
      </div>

      <div className="device-itunes-divider" />

      {/* ── Options ── */}
      <div className="device-itunes-section">
        <h2 className="device-itunes-section-title">Options</h2>
        <div className="device-itunes-options">
          <label className="device-itunes-option">
            <input
              type="checkbox"
              checked={optOpenOnConnect}
              onChange={e => setOptOpenOnConnect(e.target.checked)}
            />
            <span>Open JakeTunes when this iPod is connected</span>
          </label>
          <label className="device-itunes-option">
            <input
              type="checkbox"
              checked={optSyncOnlyChecked}
              onChange={e => setOptSyncOnlyChecked(e.target.checked)}
            />
            <span>Sync only checked songs</span>
          </label>
          <label className="device-itunes-option device-itunes-option--note">
            <span>
            Sync mode: answer a few questions → Music Man builds ~1,000 tracks for that
            activity/place/weather. Rotates every sync. Songs land at the convert
            setting below.
            </span>
          </label>
          <label className="device-itunes-option">
            <input
              type="checkbox"
              checked={optConvertBitrate}
              onChange={e => setOptConvertBitrate(e.target.checked)}
            />
            <span>Convert higher bit rate songs to <select
              className="device-itunes-select"
              value={optConvertBitrateTarget}
              disabled={!optConvertBitrate}
              onChange={e => setOptConvertBitrateTarget(e.target.value as '128' | '192' | '256')}
            ><option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option></select> AAC</span>
          </label>
          <label className="device-itunes-option">
            <input
              type="checkbox"
              checked={optManualManage}
              onChange={e => setOptManualManage(e.target.checked)}
            />
            <span>Manually manage music</span>
          </label>
          <label className="device-itunes-option">
            <input
              type="checkbox"
              checked={optDiskUse}
              onChange={e => setOptDiskUse(e.target.checked)}
            />
            <span>Enable disk use</span>
          </label>
        </div>
      </div>

      {/* The "Out of sync — Library: X · iPod: Y" badge that used to
          live here was removed — it consistently showed stale or
          confusing counts (especially right after a wipe + restore,
          where the iTunesDB on the iPod takes a moment to settle)
          and the user reported it might also be interfering with the
          live sync flow by reading the iTunesDB at inopportune
          moments. The Sync button below is the source of truth now;
          if you want to inspect what's actually on the iPod, the
          sidebar has the dedicated iPod library modal. */}

      {/* ── Sync status (only shows done / error here — live sync
            progress lives in the toolbar's LCD pill, no need for a
            second bar in the iPod view that duplicates it). ── */}
      {(syncStatus.state === 'done' || syncStatus.state === 'error') && (
        <div className={`device-sync-status device-sync-status--${syncStatus.state}`}>
          {syncStatus.state === 'done' && (
            <span className="device-sync-message">
              ✓ Sync complete — {syncStatus.total.toLocaleString()} songs{syncStatus.copied > 0 ? ` (${syncStatus.copied} new copied)` : ''} synced to iPod at {syncStatus.time}
            </span>
          )}
          {syncStatus.state === 'error' && (
            <span className="device-sync-message">✗ Sync failed — {syncStatus.message}</span>
          )}
        </div>
      )}

      {(lastCommitted || savedSetNotice) && (
        <div className="device-sync-status device-sync-status--saveset">
          {savedSetNotice ? (
            <span className="device-sync-message">✓ {savedSetNotice}</span>
          ) : (
            <button
              className="device-itunes-btn device-itunes-btn--saveset"
              onClick={saveLastSetAsPlaylist}
              title="Keep this sync's track list as a playlist in the SYNCED SETS sidebar section"
            >Save “{lastCommitted!.name}” as playlist</button>
          )}
        </div>
      )}

      {/* ── Bottom: capacity bar + action buttons (iTunes-style footer) ── */}
      <div className="device-itunes-footer">
        <div className="device-itunes-capacity">
          <div className="device-itunes-capacity-bar">
            <div className="device-itunes-capacity-seg device-itunes-capacity-audio"
              style={{ width: `${stats.audioPercent}%` }}
              title={`Audio: ${formatBytes(stats.audioBytes)}`} />
            <div className="device-itunes-capacity-seg device-itunes-capacity-other"
              style={{ width: `${stats.otherPercent}%` }}
              title="Other (iPod OS, database, artwork, orphan files)" />
            <div className="device-itunes-capacity-seg device-itunes-capacity-free"
              style={{ width: `${stats.freePercent}%` }}
              title={`Free: ${formatBytes(stats.freeBytes)}`} />
          </div>
          <div className="device-itunes-capacity-labels">
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-audio" />
              Audio&nbsp;<strong>{formatBytes(stats.audioBytes)}</strong>
            </span>
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-other" />
              Other&nbsp;<strong>{formatBytes(stats.otherBytes)}</strong>
            </span>
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-free" />
              Free&nbsp;<strong>{formatBytes(stats.freeBytes)}</strong>
              {stats.roomForSongs != null && stats.roomForSongs > 0 && (
                <span className="device-itunes-capacity-room"
                  title="Estimated room for additional songs based on your average track size">
                  &nbsp;· ~{stats.roomForSongs.toLocaleString()} more songs
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="device-itunes-actions">
          <button
            className="device-itunes-btn"
            onClick={() => setShowIpodLibrary(true)}
            title="See exactly what tracks and playlists are on the iPod right now"
          >On This iPod…</button>
          <button
            className="device-itunes-btn device-itunes-btn--eject"
            onClick={async () => {
              await window.electronAPI.ejectIpod()
              window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
            }}
          >Eject</button>
          {/* 4.5: Apply button — iTunes-style. Appears only when one
              of the sync settings has been changed since the last
              Apply (or session load). Click to persist; the button
              disappears once the working state matches the applied
              snapshot. Sync is disabled while dirty so the user
              can't run a sync against half-committed settings. */}
          {isDirty && (
            <button
              className="device-itunes-btn device-itunes-btn--apply"
              onClick={handleApplySettings}
              title="Apply the changed sync settings before running Sync"
            >Apply</button>
          )}
          <button
            className="device-itunes-btn"
            disabled={syncing || isDirty}
            onClick={handleFullSync}
            title={isDirty ? 'Click Apply first to save your setting changes' : (syncing ? 'Sync in progress…' : 'Mirror the ENTIRE library to the iPod at your convert setting')}
          >Full Sync</button>
          <button
            className="device-itunes-btn device-itunes-btn--sync"
            disabled={syncing || isDirty}
            onClick={handleActivitySync}
            title={isDirty ? 'Click Apply first to save your setting changes' : (syncing ? 'Sync in progress…' : 'Answer a few questions — Music Man builds a ~1,000-track set for the activity')}
          >{syncing ? 'Syncing…' : 'Activity Sync'}</button>
          {/* 4.5.0-109: Cancel button — only rendered while a sync is in
              flight. Hits cancel-sync IPC which flips a flag main checks
              between each file copy. Pre-fix, force-quitting the app was
              the only way to stop a runaway sync (which would also leave
              the iPod in an undefined state). */}
          {syncing && (
            <button
              className="device-itunes-btn"
              onClick={async () => {
                const r = await window.electronAPI.cancelSync()
                if (r.wasRunning) {
                  setSyncStatus({ state: 'syncing', step: 'Cancelling…' })
                }
              }}
              title="Stop the current sync after the file in flight finishes"
            >Cancel</button>
          )}
        </div>
      </div>
      {showIpodLibrary && <IpodLibraryModal onClose={() => setShowIpodLibrary(false)} />}
      {showActivitySheet && (
        <ActivitySheet
          initial={lastBrief}
          onCancel={() => setShowActivitySheet(false)}
          onConfirm={(brief) => { void runSyncWithBrief(brief) }}
        />
      )}
      {showFullSyncConfirm && (
        <ConfirmDialog
          message="Mirror the ENTIRE library to the iPod?"
          detail={`All ${state.tracks.length.toLocaleString()} songs copy at ${appliedSettings.optConvertBitrate ? `${appliedSettings.optConvertBitrateTarget} kbps AAC` : 'original quality'}. Anything on the iPod that isn't in the library — including the current activity set — is replaced. On the Mini this takes hours; keep it plugged in.`}
          confirmLabel="Full Sync"
          destructive={false}
          onConfirm={() => { void runFullLibrarySync() }}
          onCancel={() => setShowFullSyncConfirm(false)}
        />
      )}
      {reviewData && (
        <SyncReviewSheet
          setName={reviewData.payload.name}
          commentary={reviewData.payload.commentary}
          weatherLine={reviewData.payload.weatherLine}
          initialTracks={reviewData.payload.tracks}
          keepIds={reviewData.keepIds}
          leaving={reviewData.leaving}
          allTracks={state.tracks}
          onCancel={() => setReviewData(null)}
          onConfirm={(tracks) => { void runConfirmedActivitySync(tracks) }}
        />
      )}
    </div>
  )
}
