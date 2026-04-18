import { useMemo, useState, useCallback, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import type { Playlist, Track } from '../types'
import '../styles/device.css'

// iPod Mini CF-modded capacity
const IPOD_CAPACITY_GB = 64
const IPOD_CAPACITY_BYTES = IPOD_CAPACITY_GB * 1024 * 1024 * 1024

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

  useEffect(() => {
    window.electronAPI.checkIpodMounted().then(r => { if (r.name) setIpodName(r.name) }).catch(() => {})
  }, [])

  const stats = useMemo(() => {
    const tracks = state.tracks
    const totalBytes = tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
    const totalMs = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const artists = new Set(tracks.map(t => t.artist).filter(Boolean))
    const albums = new Set(tracks.map(t => t.album).filter(Boolean))
    const genres = new Set(tracks.map(t => t.genre).filter(Boolean))
    const otherBytes = 500 * 1024 * 1024 // ~500MB for iPod OS/DB/artwork
    const freeBytes = Math.max(0, IPOD_CAPACITY_BYTES - totalBytes - otherBytes)
    const audioPercent = (totalBytes / IPOD_CAPACITY_BYTES) * 100
    const otherPercent = (otherBytes / IPOD_CAPACITY_BYTES) * 100
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
  }, [state.tracks])

  return (
    <div className="device-view">
      <div className="device-header">
        <div className="device-icon">
          <IpodLargeIcon />
        </div>
        <div className="device-header-info">
          <h1 className="device-name">{ipodName}</h1>
          <div className="device-model">iPod</div>
        </div>
      </div>

      <div className="device-section">
        <h3 className="device-section-title">Summary</h3>
        <div className="device-stats-grid">
          <div className="device-stat">
            <span className="device-stat-value">{stats.trackCount.toLocaleString()}</span>
            <span className="device-stat-label">Songs</span>
          </div>
          <div className="device-stat">
            <span className="device-stat-value">{stats.artistCount.toLocaleString()}</span>
            <span className="device-stat-label">Artists</span>
          </div>
          <div className="device-stat">
            <span className="device-stat-value">{stats.albumCount.toLocaleString()}</span>
            <span className="device-stat-label">Albums</span>
          </div>
          <div className="device-stat">
            <span className="device-stat-value">{stats.genreCount}</span>
            <span className="device-stat-label">Genres</span>
          </div>
          <div className="device-stat">
            <span className="device-stat-value">{formatDurationLong(stats.totalMs)}</span>
            <span className="device-stat-label">Total Time</span>
          </div>
          <div className="device-stat">
            <span className="device-stat-value">{formatBytes(stats.totalBytes)}</span>
            <span className="device-stat-label">Audio</span>
          </div>
        </div>
      </div>

      <div className="device-section">
        <h3 className="device-section-title">Capacity</h3>
        <div className="device-capacity-bar">
          <div
            className="device-capacity-segment device-capacity-audio"
            style={{ width: `${stats.audioPercent}%` }}
            title={`Audio: ${formatBytes(stats.totalBytes)}`}
          />
          <div
            className="device-capacity-segment device-capacity-other"
            style={{ width: `${stats.otherPercent}%` }}
            title="Other (iPod OS, database, artwork)"
          />
          <div
            className="device-capacity-segment device-capacity-free"
            style={{ width: `${stats.freePercent}%` }}
            title={`Free: ${formatBytes(stats.freeBytes)}`}
          />
        </div>
        <div className="device-capacity-legend">
          <div className="device-legend-item">
            <span className="device-legend-swatch device-legend-audio" />
            <span>Audio ({formatBytes(stats.totalBytes)})</span>
          </div>
          <div className="device-legend-item">
            <span className="device-legend-swatch device-legend-other" />
            <span>Other (500 MB)</span>
          </div>
          <div className="device-legend-item">
            <span className="device-legend-swatch device-legend-free" />
            <span>Free ({formatBytes(stats.freeBytes)})</span>
          </div>
        </div>
      </div>

      <div className="device-section">
        <h3 className="device-section-title">Options</h3>
        <div className="device-options">
          <label className="device-option">
            <input type="checkbox" checked disabled />
            <span>Manually manage music</span>
          </label>
          <label className="device-option">
            <input type="checkbox" checked disabled />
            <span>Enable disk use</span>
          </label>
        </div>
      </div>

      <div className="device-actions">
        <button
          className="device-eject-btn"
          onClick={async () => {
            await window.electronAPI.ejectIpod()
            window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
          }}
        >
          Eject
        </button>
        <button
          className="device-sync-btn"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true)
            setSyncStatus({ state: 'syncing', step: 'Preparing playlists...' })
            try {
              // Regenerate smart playlists with fresh data before syncing
              const syncPlaylists = refreshSmartPlaylists(state.tracks, state.playlists)

              setSyncStatus({ state: 'syncing', step: 'Copying new tracks to iPod...' })
              const result = await window.electronAPI.syncToIpod(state.tracks, syncPlaylists)

              if (!result.ok) {
                setSyncStatus({ state: 'error', message: result.error || 'Unknown error' })
                setSyncing(false)
                return
              }

              const now = new Date()
              const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
              setSyncStatus({
                state: 'done',
                copied: result.copied || 0,
                total: result.totalTracks || state.tracks.length,
                time: timeStr,
              })
            } catch (err) {
              console.error('Sync failed:', err)
              setSyncStatus({ state: 'error', message: String(err) })
            }
            setSyncing(false)
          }}
        >
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>

      {syncStatus.state !== 'idle' && (
        <div className={`device-sync-status device-sync-status--${syncStatus.state}`}>
          {syncStatus.state === 'syncing' && (
            <>
              <div className="device-sync-progress-bar"><div className="device-sync-progress-fill" /></div>
              <span className="device-sync-message">{syncStatus.step}</span>
            </>
          )}
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

      <div className="device-capacity-footer">
        <span>{formatBytes(IPOD_CAPACITY_BYTES)} total capacity</span>
        <span>{formatBytes(stats.freeBytes)} available</span>
      </div>
    </div>
  )
}
