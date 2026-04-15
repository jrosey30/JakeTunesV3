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
  const [status, setStatus] = useState<ImportStatus>('loading')
  const [cdInfo, setCdInfo] = useState<CdInfo | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const [rippedTracks, setRippedTracks] = useState<Set<number>>(new Set())
  const [currentTrack, setCurrentTrack] = useState<number | null>(null)
  const [importCount, setImportCount] = useState(0)

  // Import settings
  const [importFormat, setImportFormat] = useState<ImportFormat>('aac-256')

  // Editable metadata
  const [editArtist, setEditArtist] = useState('')
  const [editAlbum, setEditAlbum] = useState('')
  const [editYear, setEditYear] = useState('')
  const [editGenre, setEditGenre] = useState('')
  const [editTitles, setEditTitles] = useState<Record<number, string>>({})

  const loadedRef = useRef(false)

  // Load CD info on mount
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

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
        setEditArtist(info.artist)
        setEditAlbum(info.album)
        setEditYear(info.year)
        setEditGenre(info.genre)
        // All tracks checked by default
        setChecked(new Set(info.tracks.map(t => t.number)))
        setStatus('ready')
      } else {
        setError(result.error || 'Could not read CD')
        setStatus('error')
      }
    }).catch(err => {
      setError(String(err))
      setStatus('error')
    })
  }, [])

  // Listen for rip progress
  useEffect(() => {
    const cleanup = window.electronAPI.onCdRipProgress((progress) => {
      setCurrentTrack(progress.trackNumber)
      if (!progress.error) {
        setRippedTracks(prev => new Set([...prev, progress.trackNumber]))
      }
      setImportCount(progress.current)
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
      } else {
        setError(result.error || 'Import failed')
        setStatus('error')
      }
    } catch (err) {
      setError(String(err))
      setStatus('error')
    }
  }, [cdInfo, checked, editArtist, editAlbum, editYear, editGenre, editTitles, importFormat, libState.tracks, dispatch])

  const handleEject = useCallback(async () => {
    await window.electronAPI.ejectCd()
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
