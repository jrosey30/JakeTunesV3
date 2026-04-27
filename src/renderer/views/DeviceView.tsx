import { useMemo, useState, useEffect, useRef } from 'react'
import { useLibrary } from '../context/LibraryContext'
import type { Playlist, Track } from '../types'
import IpodLibraryModal from '../components/IpodLibraryModal'
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

/** Regenerate smart playlists (Recently Added, Top 25, My Top Rated) with fresh data before syncing to iPod. */
function refreshSmartPlaylists(tracks: Track[], playlists: Playlist[]): Playlist[] {
  const SMART_NAMES = new Set(['Recently Added', 'Recently Played', 'Top 25 Most Played', 'My Top Rated'])

  // Build fresh smart playlist track lists
  const recentlyAdded = [...tracks]
    .filter(t => t.dateAdded)
    .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''))
    .slice(0, 100)
    .map(t => t.id)

  const top25 = [...tracks]
    .filter(t => t.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 25)
    .map(t => t.id)

  const topRated = [...tracks]
    .filter(t => t.rating > 0)
    .sort((a, b) => b.rating - a.rating || b.playCount - a.playCount)
    .slice(0, 25)
    .map(t => t.id)

  const smartData: Record<string, number[]> = {
    'Recently Added': recentlyAdded,
    'Top 25 Most Played': top25,
    'My Top Rated': topRated,
  }

  // Update existing smart playlists, keep user playlists as-is
  const result: Playlist[] = []
  const updated = new Set<string>()

  for (const pl of playlists) {
    if (pl.name in smartData) {
      result.push({ ...pl, trackIds: smartData[pl.name] })
      updated.add(pl.name)
    } else if (!SMART_NAMES.has(pl.name)) {
      result.push(pl)
    }
    // Skip "Recently Played" — we don't have reliable cross-session data for it
  }

  // Add smart playlists that weren't in the original list
  for (const [name, ids] of Object.entries(smartData)) {
    if (!updated.has(name) && ids.length > 0) {
      result.push({
        id: `smart-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        trackIds: ids,
      })
    }
  }

  return result
}

type SyncStatus = { state: 'idle' } | { state: 'syncing'; step: string } | { state: 'done'; copied: number; total: number; time: string } | { state: 'error'; message: string }

export default function DeviceView() {
  const { state, dispatch } = useLibrary()
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'idle' })
  const [ipodName, setIpodName] = useState('iPod')
  const [ipodCapacityBytes, setIpodCapacityBytes] = useState<number>(FALLBACK_CAPACITY_BYTES)
  const [showIpodLibrary, setShowIpodLibrary] = useState(false)

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

  useEffect(() => {
    window.electronAPI.checkIpodMounted().then(r => {
      if (r.name) setIpodName(r.name)
    }).catch(() => {})
    // Ask the main process for the real capacity of the mounted iPod
    // (modded units can be anything — 64GB, 128GB, 256GB, etc.).
    window.electronAPI.getIpodCapacity().then(r => {
      if (r.ok && r.totalBytes && r.totalBytes > 0) setIpodCapacityBytes(r.totalBytes)
    }).catch(() => {})
    // Load persisted device options out of ui-state.
    window.electronAPI.loadUiState().then(r => {
      if (!r.ok || !r.state) { optsLoaded.current = true; return }
      const s = r.state as Record<string, unknown>
      if (typeof s.optOpenOnConnect === 'boolean') setOptOpenOnConnect(s.optOpenOnConnect)
      if (typeof s.optSyncOnlyChecked === 'boolean') setOptSyncOnlyChecked(s.optSyncOnlyChecked)
      if (typeof s.optConvertBitrate === 'boolean') setOptConvertBitrate(s.optConvertBitrate)
      if (s.optConvertBitrateTarget === '128' || s.optConvertBitrateTarget === '192' || s.optConvertBitrateTarget === '256') {
        setOptConvertBitrateTarget(s.optConvertBitrateTarget)
      }
      if (typeof s.optManualManage === 'boolean') setOptManualManage(s.optManualManage)
      if (typeof s.optDiskUse === 'boolean') setOptDiskUse(s.optDiskUse)
      optsLoaded.current = true
    }).catch(() => { optsLoaded.current = true })
  }, [])

  // Persist device options on change — merged into ui-state, not overwriting.
  useEffect(() => {
    if (!optsLoaded.current) return
    window.electronAPI.loadUiState().then(r => {
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({
        ...existing,
        optOpenOnConnect,
        optSyncOnlyChecked,
        optConvertBitrate,
        optConvertBitrateTarget,
        optManualManage,
        optDiskUse,
      })
    }).catch(() => {})
  }, [optOpenOnConnect, optSyncOnlyChecked, optConvertBitrate, optConvertBitrateTarget, optManualManage, optDiskUse])

  const stats = useMemo(() => {
    const tracks = state.tracks
    const totalBytes = tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
    const totalMs = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const artists = new Set(tracks.map(t => t.artist).filter(Boolean))
    const albums = new Set(tracks.map(t => t.album).filter(Boolean))
    const genres = new Set(tracks.map(t => t.genre).filter(Boolean))
    const otherBytes = 500 * 1024 * 1024 // ~500MB for iPod OS/DB/artwork
    const freeBytes = Math.max(0, ipodCapacityBytes - totalBytes - otherBytes)
    const audioPercent = (totalBytes / ipodCapacityBytes) * 100
    const otherPercent = (otherBytes / ipodCapacityBytes) * 100
    const freePercent = Math.max(0, 100 - audioPercent - otherPercent)

    return {
      trackCount: tracks.length,
      artistCount: artists.size,
      albumCount: albums.size,
      genreCount: genres.size,
      totalBytes,
      totalMs,
      freeBytes,
      audioPercent,
      otherPercent,
      freePercent,
    }
  }, [state.tracks, ipodCapacityBytes])

  const handleSync = async () => {
    const activity = await import('../activity')

    // Guardrail: sync with no iPod mounted used to silently return an
    // error and leave the user wondering if anything happened at all.
    // Check up front and surface a clear error (and keep it in the
    // pill for a few seconds) instead of silently bailing.
    const mount = await window.electronAPI.checkIpodMounted()
    if (!mount?.mounted) {
      setSyncStatus({ state: 'error', message: 'No iPod detected — plug it in and try again.' })
      activity.setSync({ active: true, step: 'No iPod detected' })
      setTimeout(() => activity.setSync(null), 4000)
      return
    }

    setSyncing(true)
    setSyncStatus({ state: 'syncing', step: 'Preparing playlists...' })
    activity.setSync({ active: true, step: 'Preparing playlists...' })
    try {
      const syncPlaylists = refreshSmartPlaylists(state.tracks, state.playlists)
      setSyncStatus({ state: 'syncing', step: 'Copying new tracks to iPod...' })
      activity.setSync({ active: true, step: 'Copying new tracks to iPod...' })
      const result = await window.electronAPI.syncToIpod(state.tracks, syncPlaylists)
      if (!result.ok) {
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
      const now = new Date()
      const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      setSyncStatus({
        state: 'done',
        copied: result.copied || 0,
        total: result.totalTracks || state.tracks.length,
        time: timeStr,
      })
      activity.setSync({ active: true, step: `Sync complete — ${result.copied || 0} new tracks` })
      setTimeout(() => activity.setSync(null), 4000)
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
            <span className="device-itunes-value">{stats.trackCount.toLocaleString()}</span>
          </div>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Software Version:</span>
            <span className="device-itunes-value">JakeTunes 4.0.5</span>
          </div>
          <div className="device-itunes-info-line">
            <span className="device-itunes-label">Format:</span>
            <span className="device-itunes-value">Mac OS Extended (Journaled)</span>
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

      {/* ── Bottom: capacity bar + action buttons (iTunes-style footer) ── */}
      <div className="device-itunes-footer">
        <div className="device-itunes-capacity">
          <div className="device-itunes-capacity-bar">
            <div className="device-itunes-capacity-seg device-itunes-capacity-audio"
              style={{ width: `${stats.audioPercent}%` }}
              title={`Audio: ${formatBytes(stats.totalBytes)}`} />
            <div className="device-itunes-capacity-seg device-itunes-capacity-other"
              style={{ width: `${stats.otherPercent}%` }}
              title="Other (iPod OS, database, artwork)" />
            <div className="device-itunes-capacity-seg device-itunes-capacity-free"
              style={{ width: `${stats.freePercent}%` }}
              title={`Free: ${formatBytes(stats.freeBytes)}`} />
          </div>
          <div className="device-itunes-capacity-labels">
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-audio" />
              Audio&nbsp;<strong>{formatBytes(stats.totalBytes)}</strong>
            </span>
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-other" />
              Other&nbsp;<strong>500 MB</strong>
            </span>
            <span className="device-itunes-capacity-label">
              <span className="device-itunes-capacity-swatch device-itunes-capacity-free" />
              Free&nbsp;<strong>{formatBytes(stats.freeBytes)}</strong>
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
          <button
            className="device-itunes-btn device-itunes-btn--sync"
            disabled={syncing}
            onClick={handleSync}
          >{syncing ? 'Syncing…' : 'Sync'}</button>
        </div>
      </div>
      {showIpodLibrary && <IpodLibraryModal onClose={() => setShowIpodLibrary(false)} />}
    </div>
  )
}
