import { useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { assembleSyncPlaylists, planIpodSync, planTracks } from '../utils/workoutIpodSync'
import type { OneSyncPlan } from '../../common/ipod-one-sync-plan'
import { readyLine, leftOffLine, syncButtonLabel, lastSyncedLine, syncingStep } from '../../common/ipod-one-sync-plan'
import { stickerHex } from '../components/IpodIdentityBar'
import { checkIpodName, macShowsLine } from '../../common/ipod-name'
// Called in runFullLibrarySync below. The comment at the top of this file has
// named this as the shared source of sync playlists since it was extracted, but
// the import was never added — so a full library sync threw ReferenceError
// before copying anything.
import { buildSmartPlaylistsForSync } from '../utils/smartPlaylists'
import ConfirmDialog from '../components/ConfirmDialog'
import IpodLibraryModal from '../components/IpodLibraryModal'
import SyncHistorySheet, { SyncHistoryRows, type SyncHistoryEntryLike } from '../components/SyncHistorySheet'
import { subscribeSyncTimeline, getSyncTimeline, startSyncTimeline, finishSyncTimeline, clearSyncTimeline, deviceFixtureRequested, subscribeEjectFailure, getEjectFailure, showEjectFailure } from '../syncTimeline'
import { SYNC_STEPS, timelinePercent, resultLine, elapsedLabel, stepLabel, ipodCountLabel } from '../../common/sync-progress-model'
import { syncOutcome, stoppedLabel, syncFailureCopy } from '../../common/sync-failure-copy'
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
  const [syncStatus, setSyncStatusState] = useState<SyncStatus>({ state: 'idle' })
  // Activity Sync front end (2026-09-06, found on the Mini): the engine's
  // cold remount during Verify drops the volume for a moment, the sidebar
  // bounces off this page, and the handler's result then lands on an
  // UNMOUNTED component — an effect on syncStatus never runs. So the sync
  // timeline (a module store) is fed HERE, in the setter every handler
  // already calls, which runs regardless of mount. Render-side only.
  const libraryCountRef = useRef(0)
  libraryCountRef.current = state.tracks.length
  const setSyncStatus = (next: SyncStatus): void => {
    setSyncStatusState(next)
    if (deviceFixtureRequested()) return
    const t = getSyncTimeline()
    if (next.state === 'syncing') {
      if (t.status !== 'running') {
        const m = /(\d[\d,]*) tracks/.exec(next.step)
        const target = m ? Number(m[1].replace(/,/g, '')) : (/whole library/i.test(next.step) ? libraryCountRef.current : null)
        startSyncTimeline(target, next.step)
      }
    } else if (next.state === 'done') {
      if (t.status === 'running' || t.status === 'idle') finishSyncTimeline({ ok: true, landed: next.total, target: t.target ?? next.total, copied: next.copied, sealedOk: true })
    } else if (next.state === 'error') {
      if (t.status === 'running' || t.status === 'idle') finishSyncTimeline({ ok: false, error: next.message })
    } else if (next.state === 'idle' && t.status === 'running') {
      // Back to idle while the timeline runs: either the build/review was
      // cancelled before the engine ever ran (no events seen → nothing to
      // show), or the engine's cancel path settled without a 'cancelled'
      // event reaching the store (events seen → say it was stopped).
      if (t.seen === 0) clearSyncTimeline()
      else finishSyncTimeline({ ok: false, cancelled: true, copied: t.current })
    }
  }
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
  const [showSyncHistory, setShowSyncHistory] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false)
  // ONE BUTTON PER iPod (Jake 2026-11-07: "activity sync is kind of obsolete.
  // can we just make the sync process for specific ipods easy and pretty
  // straight forward"). What one Sync puts on the plugged-in iPod is main's
  // plan (main/ipod-one-sync.ts): the Original's Top 1000, any other iPod's
  // list from homemini, an unknown iPod refused. No size, no profile, no
  // Music Man, no review step. This page shows the plan and syncs exactly it.
  const [plan, setPlan] = useState<OneSyncPlan | null>(null)
  const [showLeftOff, setShowLeftOff] = useState(false)
  // Rename the iPod (2026-11-07, Jake: "i actually want to name the actual ipod
  // punkPod"): click its name. Main renames the marker, the drive and homemini's
  // list in one go; the next sync writes it into the iPod's own catalog.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameMsg, setRenameMsg] = useState<string | null>(null)
  const tracksRef = useRef(state.tracks)
  tracksRef.current = state.tracks
  const planSeq = useRef(0)
  const refreshPlan = async (): Promise<OneSyncPlan> => {
    const seq = ++planSeq.current
    const p = await planIpodSync(tracksRef.current)
    if (seq === planSeq.current) setPlan(p)
    return p
  }

  // The page's phase strip and result line read the sync TIMELINE (fed by the
  // engine's own progress events via App and by setSyncStatus above).
  const timeline = useSyncExternalStore(subscribeSyncTimeline, getSyncTimeline)
  const fixture = deviceFixtureRequested()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (timeline.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [timeline.status])
  // Recent syncs — the same reader the Sync History sheet uses; refreshed
  // after every run so the list and the header line follow the ledger.
  const [history, setHistory] = useState<SyncHistoryEntryLike[] | null>(null)
  const loadHistory = () => { window.electronAPI.getSyncHistory().then((r) => setHistory(r.ok ? r.entries : [])).catch(() => setHistory([])) }
  useEffect(() => { loadHistory() }, [])
  useEffect(() => {
    if (timeline.status === 'done' || timeline.status === 'failed' || timeline.status === 'cancelled') { const t = window.setTimeout(loadHistory, 1500); return () => window.clearTimeout(t) }
  }, [timeline.status])
  const lastSync = useMemo(() => (history || []).find((e) => e.kind === 'sync' && e.landed != null) ?? null, [history])
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [failureDetails, setFailureDetails] = useState(false)
  // The plan follows the iPod: on open, when an iPod mounts or changes, when the
  // library loads, and after every sync. Read-only — nothing is written to the iPod.
  const libraryLoaded = state.tracks.length > 0
  useEffect(() => {
    if (!libraryLoaded || syncing) return
    void refreshPlan()
    const again = () => { void refreshPlan() }
    window.addEventListener('jaketunes-ipod-mounted', again)
    window.addEventListener('jaketunes-ipod-ejected', again)
    const off = window.electronAPI.onIpodDeviceChanged?.(again)
    return () => {
      window.removeEventListener('jaketunes-ipod-mounted', again)
      window.removeEventListener('jaketunes-ipod-ejected', again)
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryLoaded, syncing])
  const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  // Claims come from the phase evidence (which steps ran, where it stopped),
  // never from the message alone — see sync-failure-copy.ts.
  const outcome = syncOutcome(timeline)
  const ejectFailure = useSyncExternalStore(subscribeEjectFailure, getEjectFailure)
  const ejectCopy = ejectFailure ? syncFailureCopy(`Eject failed: ${ejectFailure}`) : null
  const countLabel = ipodCountLabel(lastSync, timeline.status)

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

  // Two explicit sync entry points: Sync (this iPod's own songs, below) and
  // Full Sync (confirm dialog → whole-library mirror, the ONLY path to a full
  // mirror).
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
      }, { origin: 'full-library-click' })
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

  const saveRename = async () => {
    if (renaming === null) return
    const check = checkIpodName(renaming)
    if (!check.ok) { setRenameMsg(check.error); return }
    setRenameBusy(true)
    try {
      const r = await window.electronAPI.renameIpodDevice?.(check.name)
      if (!r) { setRenameMsg('This build can’t rename iPods.'); return }
      if (!r.ok) { setRenameMsg(r.error); return }
      setRenaming(null)
      const later = r.homemini === 'later' ? ` homemini will hear the new name on the next sync.` : ''
      setRenameMsg(r.driveNote ? `${r.driveNote}${later}` : `Renamed to ${r.device.name}. The iPod shows it after the next sync.${later}`)
      setIpodName(r.mount.split('/').pop() || r.device.name)
      void refreshPlan()
      window.dispatchEvent(new Event('jaketunes-ipod-mounted'))
    } catch (err) {
      setRenameMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setRenameBusy(false)
    }
  }

  // THE one Sync: a fresh plan (the Original's Top 1000 is re-read and another
  // iPod's list re-fetched from homemini right now), then exactly those songs
  // through the activity engine — wipe, copy, verify, catalog, seal, and the
  // plays round trip, as before.
  const runOneSync = async () => {
    if (!(await ensureIpodMounted())) return
    const activity = await import('../activity')
    setSyncing(true)
    setShowLeftOff(false)
    try {
      const fresh = await refreshPlan()
      if (!fresh.ok) {
        setSyncStatus({ state: 'error', message: fresh.error })
        activity.setSync({ active: true, step: `Sync didn’t start — ${fresh.error}` })
        setTimeout(() => activity.setSync(null), 5000)
        return
      }
      const finalTracks = planTracks(fresh, state.tracks)
      if (finalTracks.length === 0) {
        setSyncStatus({ state: 'error', message: `None of ${fresh.ipodName}’s songs are in this library.` })
        return
      }
      // Playlists restored: the real root cause was the iTunesDB dataset assembly
      // (album list written before the track list + a stale type-5 section copied
      // verbatim from the old library). Fixed in core/db_reader.py, so playlists
      // are safe to write.
      const playlists = assembleSyncPlaylists(finalTracks, state.playlists, fresh.setName)
      setSyncStatus({ state: 'syncing', step: syncingStep(fresh.setName, finalTracks.length) })
      activity.setSync({ active: true, step: syncingStep(fresh.setName, finalTracks.length) })
      // The user's APPLIED convert setting — toggle ON = AAC mirrors, OFF = ALAC preserved.
      const targetKbpsNum: 128 | 192 | 256 =
        appliedSettings.optConvertBitrateTarget === '256' ? 256
        : appliedSettings.optConvertBitrateTarget === '192' ? 192
        : 128
      const result = await window.electronAPI.syncToIpod(finalTracks, playlists, {
        enabled: appliedSettings.optConvertBitrate,
        targetKbps: targetKbpsNum,
      }, { wipeFirst: true, origin: 'activity-click' })  // dedicated activity engine; click-only
      if (result.alreadyRunning) return
      if (!result.ok) {
        // Cancel is expected, not an error; flash a brief notice + return to idle.
        if (result.cancelled) {
          setSyncStatus({ state: 'idle' })
          activity.setSync({ active: true, step: `Sync cancelled (${result.copied || 0} files copied before stop)` })
          setTimeout(() => activity.setSync(null), 3000)
          return
        }
        const msg = result.error || 'Unknown error'
        if (result.verificationUpdates && result.verificationUpdates.length > 0) {
          const dead = result.verificationUpdates
            .filter((u) => u.audioMissing === true)
            .map((u) => ({ id: u.id, field: 'audioMissing', value: true as const }))
          if (dead.length > 0) dispatch({ type: 'UPDATE_TRACKS', updates: dead })
        }
        setSyncStatus({ state: 'error', message: msg })
        activity.setSync({ active: true, step: `Sync failed — ${msg}` })
        setTimeout(() => activity.setSync(null), 4000)
        return
      }
      // Smart-sync path re-links (main found a song's audio already on the iPod
      // under another F-dir) mirrored into the library.
      if (result.pathRewrites && result.pathRewrites.length > 0) {
        dispatch({
          type: 'UPDATE_TRACKS',
          updates: result.pathRewrites.map(r => ({ id: r.id, field: 'path', value: r.newPath })),
        })
      }
      // The identity verifier's silent updates: backfilled fingerprints, path
      // heals, audioMissing flags. It never deletes.
      if (result.verificationUpdates && result.verificationUpdates.length > 0) {
        const updates: { id: number; field: string; value: string | boolean }[] = []
        for (const u of result.verificationUpdates) {
          if (u.path) updates.push({ id: u.id, field: 'path', value: u.path })
          if (u.audioFingerprint) updates.push({ id: u.id, field: 'audioFingerprint', value: u.audioFingerprint })
          if (u.audioMissing !== undefined) updates.push({ id: u.id, field: 'audioMissing', value: u.audioMissing })
        }
        if (updates.length > 0) dispatch({ type: 'UPDATE_TRACKS', updates })
      }
      // Verified-count truth: `landed` is what committed to the card
      // (unmount/remount-verified), not what was sent. A shortfall is said
      // plainly, never a false "done".
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
          time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        })
        // The iPod firmware builds its own index from the DB, so its on-screen
        // count climbs up to the real number over the next moment.
        activity.setSync({
          active: true,
          step: `Synced ${landed} to ${fresh.ipodName} — all verified on the card. Give it a moment to finish counting up to ${landed}.`,
        })
        setTimeout(() => activity.setSync(null), 7000)
      }
    } catch (err) {
      console.error('Sync failed:', err)
      const msg = String(err)
      setSyncStatus({ state: 'error', message: msg })
      activity.setSync({ active: true, step: `Sync failed — ${msg}` })
      setTimeout(() => activity.setSync(null), 4000)
    } finally {
      setSyncing(false)
    }
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
          <div className="device-itunes-info-line device-now-line">
            {lastSync && countLabel
              ? <span>{countLabel}: <strong>{(lastSync.landed ?? 0).toLocaleString()} songs</strong> · {new Date(lastSync.when).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}{lastSync.target != null && lastSync.landed != null && lastSync.landed < lastSync.target ? ` (short of ${lastSync.target.toLocaleString()})` : ''}{countLabel === 'Last verified' ? ' — what the iPod holds now is not verified' : ''}</span>
              : <span>No sync recorded yet.</span>}
            {fixture && <span className="device-fixture-tag" title="Renderer fixture — no iPod, no engine">Fixture</span>}
          </div>
        </div>
      </div>

      <div className="device-itunes-divider" />

      {/* ── SYNC — one primary action, the phase strip, the result line ── */}
      <div className="device-itunes-section device-sync">
        <h2 className="device-itunes-section-title">Sync</h2>
        <div className="device-sync-primary">
          {plan && plan.ipodName && renaming === null && (
            <span className="device-sync-ipod">
              <span className="device-sync-sticker" style={{ background: stickerHex(plan.color) }} aria-hidden="true" />
              <button
                type="button"
                className="device-sync-name"
                disabled={syncing}
                title={syncing ? 'Wait for the sync to finish' : 'Rename this iPod'}
                onClick={() => { setRenaming(plan.ipodName); setRenameMsg(null) }}
              >{plan.ipodName}</button>
              {plan.ok ? readyLine(plan).slice(plan.ipodName.length) : ''}
            </span>
          )}
          {plan && plan.ipodName && renaming !== null && (() => {
            const check = checkIpodName(renaming)
            const upper = check.ok ? macShowsLine(check) : null
            return (
              <form className="device-sync-rename" onSubmit={(e) => { e.preventDefault(); void saveRename() }}>
                <span className="device-sync-sticker" style={{ background: stickerHex(plan.color) }} aria-hidden="true" />
                <input
                  value={renaming}
                  maxLength={20}
                  autoFocus
                  aria-label="iPod name"
                  disabled={renameBusy}
                  onChange={(e) => { setRenaming(e.target.value); setRenameMsg(null) }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(null); setRenameMsg(null) } }}
                />
                <button type="submit" className="device-itunes-btn" disabled={renameBusy || syncing || !check.ok}>{renameBusy ? 'Renaming…' : 'Rename'}</button>
                <button type="button" className="device-link-btn" disabled={renameBusy} onClick={() => { setRenaming(null); setRenameMsg(null) }}>Cancel</button>
                {!check.ok && renaming.trim() !== '' && <span className="device-sync-facts-error device-sync-rename-note">{check.error}</span>}
                {upper && <span className="device-sync-rename-note">{upper}</span>}
              </form>
            )
          })()}
          {plan?.ok && renaming === null && (
            <button
              className="device-itunes-btn device-itunes-btn--sync"
              disabled={syncing || isDirty}
              onClick={() => { void runOneSync() }}
              title={isDirty ? 'Click Apply first to save your setting changes' : (syncing ? 'Sync in progress…' : `Put these ${plan.trackIds.length.toLocaleString('en-US')} songs on ${plan.ipodName}`)}
            >{syncing ? 'Syncing…' : syncButtonLabel(plan.ipodName)}</button>
          )}
          <span className="device-sync-spacer" />
          <button type="button" className="device-link-btn" disabled={syncing || isDirty} onClick={handleFullSync} title={isDirty ? 'Click Apply first to save your setting changes' : 'Mirror the ENTIRE library to the iPod at your convert setting'}>Full Sync…</button>
          <button type="button" className="device-link-btn" aria-expanded={optionsOpen || isDirty} onClick={() => setOptionsOpen((o) => !o)}>Options {optionsOpen || isDirty ? '▾' : '▸'}</button>
        </div>
        <div className="device-sync-facts">
          {renameMsg && renaming === null && <span>{renameMsg}</span>}
          {renameMsg && renaming !== null && <span className="device-sync-facts-error">{renameMsg}</span>}
          {plan === null && <span>Reading what goes on this iPod…</span>}
          {plan && !plan.ok && plan.kind === 'unknown' && <span>Set this iPod up above, then it gets its own Sync button.</span>}
          {plan && !plan.ok && plan.kind !== 'unknown' && <span className="device-sync-facts-error">{plan.error}</span>}
          {plan?.ok && plan.note && <span>{plan.note}</span>}
          {plan?.ok && leftOffLine(plan) && (
            <span>
              {leftOffLine(plan)}{' '}
              <button type="button" className="device-link-btn" aria-expanded={showLeftOff} onClick={() => setShowLeftOff((v) => !v)}>{showLeftOff ? 'Hide' : 'Which ones'}</button>
            </span>
          )}
          <span>
            {lastSyncedLine(lastSync?.when)}{' · '}
            <button type="button" className="device-link-btn" onClick={() => setShowSyncHistory(true)}>Sync History</button>
          </span>
        </div>
        {plan?.ok && showLeftOff && plan.leftOff.length > 0 && (
          <ul className="device-sync-leftoff">
            {plan.leftOff.map((l) => (
              <li key={l.id}>{l.artist ? `${l.artist} — ` : ''}{l.title}: {l.why}</li>
            ))}
          </ul>
        )}

        {timeline.status !== 'idle' && (
          <div className={`device-sync-strip device-sync-strip--${timeline.status}`} role="status">
            <ol className="device-sync-steps">
              {SYNC_STEPS.map((st) => {
                const reached = timeline.reached.includes(st.id)
                const current = timeline.step === st.id && timeline.status === 'running'
                const stoppedHere = timeline.step === st.id && (timeline.status === 'failed' || timeline.status === 'cancelled')
                const done = reached && !current && !stoppedHere && (timeline.status === 'done' || SYNC_STEPS.findIndex((x) => x.id === st.id) < SYNC_STEPS.findIndex((x) => x.id === timeline.step))
                return (
                  <li key={st.id} className={`device-sync-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}${stoppedHere ? ' is-stopped' : ''}`}>
                    <span className="device-sync-step-mark" aria-hidden="true">{done ? '✓' : stoppedHere ? '✕' : ''}</span>
                    {stepLabel(st.id, timeline)}
                    {current && timeline.total > 1 && <span className="device-sync-step-count">{timeline.current.toLocaleString()}/{timeline.total.toLocaleString()}</span>}
                  </li>
                )
              })}
            </ol>
            {timeline.status === 'running' && (
              <div className="device-sync-live">
                <span className="device-sync-live-bar" aria-hidden="true"><i style={{ width: `${timelinePercent(timeline)}%` }} /></span>
                <span className="device-sync-live-text">{timeline.step ? stepLabel(timeline.step, timeline) : ''}{timeline.title ? ` — ${timeline.title}` : ''}</span>
                <span className="device-sync-live-elapsed">{elapsedLabel(timeline, now)}</span>
                <button
                  className="device-itunes-btn"
                  onClick={async () => {
                    const r = await window.electronAPI.cancelSync()
                    if (r.wasRunning) setSyncStatus({ state: 'syncing', step: 'Cancelling…' })
                  }}
                  title="Stop the current sync after the file in flight finishes"
                >Cancel</button>
              </div>
            )}
            {timeline.status === 'done' && (
              <div className="device-sync-result device-sync-result--done">
                <span className="device-sync-result-line">{resultLine(timeline, timeLabel)}</span>
                <button type="button" className="device-link-btn" onClick={clearSyncTimeline}>Dismiss</button>
              </div>
            )}
            {outcome && (
              <div className={`device-sync-result device-sync-result--${timeline.status} device-sync-result--changed-${outcome.changed}`}>
                <span className="device-sync-result-line">{stoppedLabel(outcome)}: {outcome.happened}{timeline.status === 'cancelled' && timeline.copied != null ? ` ${timeline.copied.toLocaleString()} copied before the stop.` : ''}</span>
                <span className="device-sync-result-sub">{outcome.changedLine} {outcome.next}</span>
                <span className="device-sync-result-actions">
                  <button type="button" className="device-link-btn" aria-expanded={failureDetails} onClick={() => setFailureDetails((d) => !d)}>{failureDetails ? 'Hide details' : 'Details'}</button>
                  <button type="button" className="device-link-btn" onClick={() => { setFailureDetails(false); clearSyncTimeline(); if (syncStatus.state === 'error') setSyncStatus({ state: 'idle' }) }}>Dismiss</button>
                </span>
                {failureDetails && <pre className="device-sync-result-raw">{outcome.raw}{outcome.fromEvidence ? `\n\nSteps reached: ${timeline.reached.map((s) => stepLabel(s, timeline)).join(' → ')}; stopped at ${timeline.step ? stepLabel(timeline.step, timeline) : '—'}.` : '\n\nNo phase events were received for this attempt.'}</pre>}
              </div>
            )}
          </div>
        )}

        {ejectCopy && (
          <div className="device-sync-strip device-sync-strip--failed device-eject-notice" role="status">
            <div className="device-sync-result device-sync-result--failed">
              <span className="device-sync-result-line">Eject failed: {ejectFailure}</span>
              <span className="device-sync-result-sub">Nothing on the iPod was changed by the eject. {ejectCopy.next}</span>
              <span className="device-sync-result-actions"><button type="button" className="device-link-btn" onClick={() => showEjectFailure(null)}>Dismiss</button></span>
            </div>
          </div>
        )}
        {(optionsOpen || isDirty) && (
          <div className="device-itunes-options device-itunes-options--disclosure">
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
            {isDirty && (
              <button
                className="device-itunes-btn device-itunes-btn--apply"
                onClick={handleApplySettings}
                title="Apply the changed sync settings before running Sync"
              >Apply</button>
            )}
          </div>
        )}
      </div>

      {/* ── RECENT SYNCS — the ledger, the same rows the Sync History sheet shows ── */}
      <div className="device-itunes-section device-recent">
        <h2 className="device-itunes-section-title">Recent syncs</h2>
        {history === null && <div className="sh-empty">Reading the ledgers…</div>}
        {history && history.length === 0 && <div className="sh-empty">No syncs recorded yet.</div>}
        {history && history.length > 0 && <SyncHistoryRows entries={history} limit={5} />}
        {history && history.length > 5 && (
          <button type="button" className="device-link-btn" onClick={() => setShowSyncHistory(true)}>See all ({history.length})</button>
        )}
      </div>

      {/* ── Bottom: capacity bar + the read-only buttons (iTunes-style footer) ── */}
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
            className="device-itunes-btn"
            onClick={() => setShowSyncHistory(true)}
            title="Every sync's cargo and every play the iPod brought home"
          >Sync History</button>
          <button
            className="device-itunes-btn device-itunes-btn--eject"
            onClick={async () => {
              const r = await window.electronAPI.ejectIpod()
              if (r && r.ok === false) { showEjectFailure(r.error || 'Eject failed'); return }
              showEjectFailure(null)
              window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
            }}
          >Eject</button>
        </div>
      </div>
      {showIpodLibrary && <IpodLibraryModal onClose={() => setShowIpodLibrary(false)} />}
      {showSyncHistory && <SyncHistorySheet onClose={() => setShowSyncHistory(false)} />}
      {showFullSyncConfirm && (
        <ConfirmDialog
          message="Mirror the ENTIRE library to the iPod?"
          detail={`All ${state.tracks.length.toLocaleString()} songs copy at ${appliedSettings.optConvertBitrate ? `${appliedSettings.optConvertBitrateTarget} kbps AAC` : 'original quality'}. Anything on the iPod that isn't in the library — including the songs from the last Sync — is replaced. On the Mini this takes hours; keep it plugged in.`}
          confirmLabel="Full Sync"
          destructive={false}
          onConfirm={() => { void runFullLibrarySync() }}
          onCancel={() => setShowFullSyncConfirm(false)}
        />
      )}
    </div>
  )
}
