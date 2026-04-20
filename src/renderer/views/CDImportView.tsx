import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { Track } from '../types'
import '../styles/cdimport.css'

interface CdTrack {
  number: number
  title: string
  duration: number
  filePath: string
}

interface CdInfo {
  volumeName: string
  volumePath: string
  artist: string
  album: string
  year: string
  genre: string
  tracks: CdTrack[]
}

type ImportStatus = 'idle' | 'loading' | 'ready' | 'importing' | 'done' | 'error'
type ImportFormat = 'aac-256' | 'aac-128' | 'aac-320' | 'alac' | 'aiff' | 'wav'

const FORMAT_LABELS: Record<ImportFormat, string> = {
  'aac-256': 'AAC (iTunes Plus, 256 kbps)',
  'aac-128': 'AAC (128 kbps)',
  'aac-320': 'AAC (320 kbps)',
  'alac': 'Apple Lossless',
  'aiff': 'AIFF (Uncompressed)',
  'wav': 'WAV (Uncompressed)',
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Module-level cache of the current CD's info + user's in-progress edits.
// Survives view re-mounts so navigating away and coming back doesn't
// re-fetch (and re-show "Reading CD..."). Invalidated when the CD's
// volumePath changes (a different disc was inserted) or on eject.
interface CdEditState {
  checked: number[]
  editArtist: string
  editAlbum: string
  editYear: string
  editGenre: string
  editTitles: Record<number, string>
}
let cachedCdInfo: CdInfo | null = null
let cachedEdits: CdEditState | null = null
// Preferred import format — seeded from ui-state.json on first render of
// CDImportView, then mirrored back out whenever the user changes it.
// Survives both view remounts AND app relaunches.
let cachedImportFormat: ImportFormat | null = null

// Rip-progress cache. Lives at the module level so navigating away from
// the CD Import view and coming back mid-rip doesn't hide the progress
// (and the view doesn't show the pre-rip "Import CD" button as if
// nothing were happening). Updated by both the App-level and the
// view-level onCdRipProgress listeners.
interface RipProgressCache {
  status: ImportStatus
  total: number                  // how many tracks are being ripped
  importCount: number            // how many have finished
  currentTrack: number | null    // track number currently ripping
  rippedTracks: number[]         // track numbers that finished (non-error)
}
let cachedRipProgress: RipProgressCache = {
  status: 'idle', total: 0, importCount: 0, currentTrack: null, rippedTracks: [],
}

export function clearCdImportCache() {
  cachedCdInfo = null
  cachedEdits = null
  cachedRipProgress = { status: 'idle', total: 0, importCount: 0, currentTrack: null, rippedTracks: [] }
}

/**
 * Update the module-level rip-progress cache from an external listener
 * (the App-level onCdRipProgress listener). Keeps the cache fresh even
 * when CDImportView is unmounted, so coming back shows real progress.
 */
export function noteCdRipProgress(progress: { trackNumber: number; current: number; error?: string }) {
  cachedRipProgress.currentTrack = progress.trackNumber
  cachedRipProgress.importCount = progress.current
  if (!progress.error && !cachedRipProgress.rippedTracks.includes(progress.trackNumber)) {
    cachedRipProgress.rippedTracks = [...cachedRipProgress.rippedTracks, progress.trackNumber]
  }
  // First event after a rip starts: if caller didn't already mark
  // status='importing', infer it now.
  if (cachedRipProgress.status !== 'importing') {
    cachedRipProgress.status = 'importing'
  }
}

function CdIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <circle cx="32" cy="32" r="30" fill="url(#cdGrad)" stroke="#888" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="10" fill="#e0e0e0" stroke="#999" strokeWidth="1" />
      <circle cx="32" cy="32" r="4" fill="#666" />
      <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
      <circle cx="32" cy="32" r="24" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
      <circle cx="32" cy="32" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
      <circle cx="32" cy="32" r="16" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
      <defs>
        <radialGradient id="cdGrad" cx="0.4" cy="0.35" r="0.65">
          <stop offset="0%" stopColor="#c8c8e0" />
          <stop offset="40%" stopColor="#a0a0c0" />
          <stop offset="100%" stopColor="#8888a8" />
        </radialGradient>
      </defs>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" fill="#4a90d9" />
      <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="cd-spinner">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="#ccc" strokeWidth="1.5" />
      <path d="M7 1.5a5.5 5.5 0 014.5 8.5" fill="none" stroke="#4a90d9" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export default function CDImportView() {
  const { state: libState, dispatch } = useLibrary()
  // Seed state from the module-level cache when available so navigating
  // away and coming back to the CD view doesn't re-run the "Reading
  // CD..." spinner and doesn't wipe edits or rip progress.
  const ripActive = cachedRipProgress.status === 'importing'
  const [status, setStatus] = useState<ImportStatus>(
    ripActive ? 'importing' : (cachedCdInfo ? 'ready' : 'loading')
  )
  const [cdInfo, setCdInfo] = useState<CdInfo | null>(cachedCdInfo)
  const [checked, setChecked] = useState<Set<number>>(
    cachedEdits ? new Set(cachedEdits.checked) : new Set()
  )
  const [error, setError] = useState('')
  const [rippedTracks, setRippedTracks] = useState<Set<number>>(new Set(cachedRipProgress.rippedTracks))
  const [currentTrack, setCurrentTrack] = useState<number | null>(cachedRipProgress.currentTrack)
  const [importCount, setImportCount] = useState(cachedRipProgress.importCount)

  // Import settings — seed from module cache so it survives view
  // remounts. A follow-up effect below also pulls from ui-state.json
  // on first mount to survive app relaunches, and mirrors changes
  // back out to both the module cache and ui-state.
  const [importFormat, setImportFormat] = useState<ImportFormat>(cachedImportFormat ?? 'aac-256')
  const importFormatLoaded = useRef(false)

  // Editable metadata — also seeded from cache
  const [editArtist, setEditArtist] = useState(cachedEdits?.editArtist ?? '')
  const [editAlbum, setEditAlbum] = useState(cachedEdits?.editAlbum ?? '')
  const [editYear, setEditYear] = useState(cachedEdits?.editYear ?? '')
  const [editGenre, setEditGenre] = useState(cachedEdits?.editGenre ?? '')
  const [editTitles, setEditTitles] = useState<Record<number, string>>(cachedEdits?.editTitles ?? {})

  const loadedRef = useRef(false)

  // Load CD info on mount.
  //
  // If we already have a cache for THIS CD (same volumePath), reuse it
  // and skip the fetch. If there's no cache or the inserted disc has
  // changed, fetch fresh. This kills the "shows 'Reading CD...' every
  // time you visit the CD view" annoyance without removing the re-fetch
  // behavior for genuinely new discs.
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    // If the cached CD matches what's currently mounted, no work to do.
    if (cachedCdInfo) {
      window.electronAPI.checkCdDrive().then(r => {
        if (r.hasCd && r.volumePath === cachedCdInfo!.volumePath) {
          // Still the same disc — keep using cached state.
          return
        }
        // Different disc (or no disc) — clear cache and fall through to fetch.
        clearCdImportCache()
        setCdInfo(null)
        setChecked(new Set())
        setEditArtist(''); setEditAlbum(''); setEditYear(''); setEditGenre('')
        setEditTitles({})
        doFetchCdInfo()
      }).catch(() => { doFetchCdInfo() })
      return
    }
    doFetchCdInfo()

    function doFetchCdInfo() {
      setStatus('loading')
      window.electronAPI.getCdInfo().then(result => {
        if (result.ok && result.tracks && result.tracks.length > 0) {
          const info: CdInfo = {
            volumeName: result.volumeName || 'Audio CD',
            volumePath: result.volumePath || '',
            artist: result.artist || '',
            album: result.album || 'Audio CD',
            year: result.year || '',
            genre: result.genre || '',
            tracks: result.tracks,
          }
          setCdInfo(info)
          cachedCdInfo = info
          setEditArtist(info.artist)
          setEditAlbum(info.album)
          setEditYear(info.year)
          setEditGenre(info.genre)
          // All tracks checked by default
          const defaultChecked = new Set(info.tracks.map(t => t.number))
          setChecked(defaultChecked)
          cachedEdits = {
            checked: Array.from(defaultChecked),
            editArtist: info.artist,
            editAlbum: info.album,
            editYear: info.year,
            editGenre: info.genre,
            editTitles: {},
          }
          setStatus('ready')
        } else {
          setError(result.error || 'Could not read CD')
          setStatus('error')
        }
      }).catch(err => {
        setError(String(err))
        setStatus('error')
      })
    }
  }, [])

  // Keep the module-level cache of user edits in sync so they survive
  // view remounts. Only update the cache once we actually have cdInfo.
  useEffect(() => {
    if (!cdInfo) return
    cachedEdits = {
      checked: Array.from(checked),
      editArtist,
      editAlbum,
      editYear,
      editGenre,
      editTitles,
    }
  }, [cdInfo, checked, editArtist, editAlbum, editYear, editGenre, editTitles])

  // Load the persisted import format from ui-state.json exactly once
  // on first mount, then mirror any user change back out. After the
  // initial load, the module-level cachedImportFormat is the source
  // of truth for subsequent remounts in the same session.
  useEffect(() => {
    if (importFormatLoaded.current) return
    importFormatLoaded.current = true
    if (cachedImportFormat) return  // already seeded from a previous visit
    window.electronAPI.loadUiState().then(r => {
      if (!r.ok || !r.state) return
      const f = (r.state as Record<string, unknown>).importFormat
      if (typeof f === 'string' && ['aac-256', 'aac-128', 'aac-320', 'alac', 'aiff', 'wav'].includes(f)) {
        cachedImportFormat = f as ImportFormat
        setImportFormat(f as ImportFormat)
      }
    }).catch(() => {})
  }, [])

  // Persist the user's format choice whenever it changes.
  useEffect(() => {
    cachedImportFormat = importFormat
    window.electronAPI.loadUiState().then(r => {
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({ ...existing, importFormat })
    }).catch(() => {})
  }, [importFormat])

  // Listen for rip progress. Also mirror progress into the module-level
  // cache so that remounting this view during an active rip (user
  // navigated away and came back) shows the live progress instead of
  // the pre-rip "Import CD" button.
  useEffect(() => {
    const cleanup = window.electronAPI.onCdRipProgress((progress) => {
      setCurrentTrack(progress.trackNumber)
      setImportCount(progress.current)
      cachedRipProgress.currentTrack = progress.trackNumber
      cachedRipProgress.importCount = progress.current
      if (!progress.error) {
        setRippedTracks(prev => {
          const next = new Set([...prev, progress.trackNumber])
          cachedRipProgress.rippedTracks = Array.from(next)
          return next
        })
      }
    })
    return cleanup
  }, [])

  const toggleTrack = useCallback((num: number) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(num)) next.delete(num)
      else next.add(num)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    if (!cdInfo) return
    if (checked.size === cdInfo.tracks.length) {
      setChecked(new Set())
    } else {
      setChecked(new Set(cdInfo.tracks.map(t => t.number)))
    }
  }, [cdInfo, checked])

  const updateTitle = useCallback((trackNum: number, title: string) => {
    setEditTitles(prev => ({ ...prev, [trackNum]: title }))
  }, [])

  const handleImport = useCallback(async () => {
    if (!cdInfo || checked.size === 0) return

    setStatus('importing')
    setRippedTracks(new Set())
    setCurrentTrack(null)
    setImportCount(0)
    // Mirror into module-level cache so view remounts mid-rip still
    // show live progress.
    cachedRipProgress = {
      status: 'importing',
      total: checked.size,
      importCount: 0,
      currentTrack: null,
      rippedTracks: [],
    }

    const tracksToRip = cdInfo.tracks
      .filter(t => checked.has(t.number))
      .map(t => ({
        ...t,
        title: editTitles[t.number] ?? t.title,
      }))

    const nextId = Math.max(0, ...libState.tracks.map(t => t.id)) + 1

    try {
      const result = await window.electronAPI.ripCdTracks(
        tracksToRip,
        { artist: editArtist, album: editAlbum, year: editYear, genre: editGenre },
        nextId,
        importFormat
      )

      if (result.ok && result.tracks && result.tracks.length > 0) {
        const newTracks = result.tracks as Track[]
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: newTracks })
        setStatus('done')
        cachedRipProgress.status = 'done'
      } else {
        setError(result.error || 'Import failed')
        setStatus('error')
        cachedRipProgress.status = 'error'
      }
    } catch (err) {
      setError(String(err))
      setStatus('error')
      cachedRipProgress.status = 'error'
    }
  }, [cdInfo, checked, editArtist, editAlbum, editYear, editGenre, editTitles, importFormat, libState.tracks, dispatch])

  const handleEject = useCallback(async () => {
    await window.electronAPI.ejectCd()
    // Drop cached CD state — the disc is gone, the next visit to this
    // view should read whatever (if anything) is in the drive.
    clearCdImportCache()
    dispatch({ type: 'SET_VIEW', view: 'songs' })
  }, [dispatch])

  const totalMs = useMemo(() => {
    if (!cdInfo) return 0
    return cdInfo.tracks
      .filter(t => checked.has(t.number))
      .reduce((sum, t) => sum + t.duration, 0)
  }, [cdInfo, checked])

  const totalMins = Math.floor(totalMs / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  const timeStr = hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`

  if (status === 'loading') {
    return (
      <div className="cd-view">
        <div className="cd-loading">
          <SpinnerIcon />
          <span>Reading CD...</span>
        </div>
      </div>
    )
  }

  if (status === 'error' && !cdInfo) {
    return (
      <div className="cd-view">
        <div className="cd-error">
          <p>Could not read the CD.</p>
          <p className="cd-error-detail">{error}</p>
          <button className="cd-btn" onClick={() => dispatch({ type: 'SET_VIEW', view: 'songs' })}>
            Back to Library
          </button>
        </div>
      </div>
    )
  }

  if (!cdInfo) return null

  const allChecked = checked.size === cdInfo.tracks.length
  const isImporting = status === 'importing'
  const isDone = status === 'done'

  return (
    <div className="cd-view">
      <div className="cd-header">
        <div className="cd-header-icon">
          <CdIcon />
        </div>
        <div className="cd-header-info">
          {status === 'ready' ? (
            <>
              <input
                className="cd-header-album"
                value={editAlbum}
                onChange={(e) => setEditAlbum(e.target.value)}
                placeholder="Album"
              />
              <input
                className="cd-header-artist"
                value={editArtist}
                onChange={(e) => setEditArtist(e.target.value)}
                placeholder="Artist"
              />
              <div className="cd-header-meta-row">
                <label className="cd-meta-label">
                  Genre
                  <input
                    className="cd-meta-input"
                    value={editGenre}
                    onChange={(e) => setEditGenre(e.target.value)}
                    placeholder="Genre"
                  />
                </label>
                <label className="cd-meta-label">
                  Year
                  <input
                    className="cd-meta-input cd-meta-input--year"
                    value={editYear}
                    onChange={(e) => setEditYear(e.target.value)}
                    placeholder="Year"
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <h2 className="cd-header-album cd-header-album--static">{editAlbum}</h2>
              <div className="cd-header-artist cd-header-artist--static">{editArtist}</div>
            </>
          )}
          <div className="cd-import-settings">
            <label className="cd-meta-label">
              Import Using
              <select
                className="cd-format-select"
                value={importFormat}
                onChange={(e) => setImportFormat(e.target.value as ImportFormat)}
                disabled={isImporting || isDone}
              >
                {Object.entries(FORMAT_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="cd-header-summary">
            {checked.size} of {cdInfo.tracks.length} songs selected, {timeStr}
          </div>
        </div>
        <div className="cd-header-actions">
          {isDone ? (
            <div className="cd-done-badge">Import Complete</div>
          ) : (
            <>
              <button className="cd-btn cd-btn--eject" onClick={handleEject} disabled={isImporting}>
                Eject
              </button>
              <button
                className="cd-btn cd-btn--import"
                onClick={handleImport}
                disabled={isImporting || checked.size === 0}
              >
                {isImporting ? `Importing ${importCount}/${checked.size}...` : 'Import CD'}
              </button>
            </>
          )}
        </div>
      </div>

      {isImporting && (
        <div className="cd-progress-bar">
          <div
            className="cd-progress-fill"
            style={{ width: `${(importCount / checked.size) * 100}%` }}
          />
        </div>
      )}

      <div className="cd-columns">
        <span className="cd-col cd-col--check">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            disabled={isImporting || isDone}
          />
        </span>
        <span className="cd-col cd-col--num">#</span>
        <span className="cd-col cd-col--title">Name</span>
        <span className="cd-col cd-col--duration">Time</span>
        <span className="cd-col cd-col--status">Status</span>
      </div>

      <div className="cd-tracks">
        {cdInfo.tracks.map((track) => {
          const isChecked = checked.has(track.number)
          const isRipped = rippedTracks.has(track.number)
          const isCurrent = currentTrack === track.number && isImporting
          const displayTitle = editTitles[track.number] ?? track.title

          return (
            <div
              key={track.number}
              className={`cd-track ${isCurrent ? 'cd-track--active' : ''} ${isRipped ? 'cd-track--done' : ''}`}
            >
              <span className="cd-track-check">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleTrack(track.number)}
                  disabled={isImporting || isDone}
                />
              </span>
              <span className="cd-track-num">{track.number}</span>
              <span className="cd-track-title">
                {status === 'ready' ? (
                  <input
                    className="cd-track-title-input"
                    value={displayTitle}
                    onChange={(e) => updateTitle(track.number, e.target.value)}
                  />
                ) : (
                  displayTitle
                )}
              </span>
              <span className="cd-track-duration">{formatDuration(track.duration)}</span>
              <span className="cd-track-status">
                {isRipped && <CheckIcon />}
                {isCurrent && !isRipped && <SpinnerIcon />}
              </span>
            </div>
          )
        })}
      </div>

      {isDone && (
        <div className="cd-done-message">
          Successfully imported {importCount} song{importCount !== 1 ? 's' : ''} to your library.
        </div>
      )}
    </div>
  )
}
