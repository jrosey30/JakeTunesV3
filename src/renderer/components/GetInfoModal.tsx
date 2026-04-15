import { useState, useCallback, useEffect, useRef } from 'react'
import type { Track } from '../types'
import '../styles/getinfo.css'

interface GetInfoModalProps {
  tracks: Track[]
  allTracks: Track[]
  initialIndex: number
  artworkMap: Record<string, string>
  onClose: () => void
  onSave: (updates: { id: number; field: string; value: string }[]) => void
  onFetchArt: (artist: string, album: string, force?: boolean) => Promise<{ key: string; hash: string } | null>
  onSetCustomArt: (artist: string, album: string, imagePath: string) => Promise<{ key: string; hash: string } | null>
}

const EDITABLE_FIELDS = [
  { key: 'title', label: 'Name' },
  { key: 'artist', label: 'Artist' },
  { key: 'albumArtist', label: 'Album Artist' },
  { key: 'album', label: 'Album' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year' },
]

// iTunes-style paired fields: "X of Y"
const PAIRED_FIELDS = [
  { label: 'Track', numKey: 'trackNumber', ofKey: 'trackCount' },
  { label: 'Disc', numKey: 'discNumber', ofKey: 'discCount' },
]

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '\u2014'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function GetInfoModal({
  tracks,
  allTracks,
  initialIndex,
  artworkMap,
  onClose,
  onSave,
  onFetchArt,
  onSetCustomArt,
}: GetInfoModalProps) {
  const isMulti = tracks.length > 1
  const [currentIdx, setCurrentIdx] = useState(initialIndex)
  const [editedFields, setEditedFields] = useState<Record<string, string>>({})
  // Accumulated edits from prev/next navigation, keyed by track id
  const [allEdits, setAllEdits] = useState<Record<number, Record<string, string>>>({})
  const [fetchingArt, setFetchingArt] = useState(false)
  const [localArtHash, setLocalArtHash] = useState<string | null>(null)
  const [artCacheBust, setArtCacheBust] = useState('')
  const firstInputRef = useRef<HTMLInputElement>(null)

  const currentTrack = isMulti ? null : allTracks[currentIdx]

  // Focus first input on mount and after navigation
  useEffect(() => {
    const t = setTimeout(() => firstInputRef.current?.select(), 50)
    return () => clearTimeout(t)
  }, [currentIdx])

  // Reset per-track edits when navigating
  useEffect(() => {
    setEditedFields({})
  }, [currentIdx])

  const getFieldValue = useCallback(
    (field: string): string => {
      // 1. Current unsaved edits (highest priority)
      if (field in editedFields) return editedFields[field]

      if (isMulti) {
        const vals = new Set(
          tracks.map((t) => String((t as unknown as Record<string, unknown>)[field] ?? ''))
        )
        return vals.size === 1 ? [...vals][0] : ''
      }

      if (currentTrack) {
        // 2. Previously accumulated edits from navigation
        const accum = allEdits[currentTrack.id]
        if (accum && field in accum) return accum[field]
        // 3. Original track value
        return String((currentTrack as unknown as Record<string, unknown>)[field] ?? '')
      }
      return ''
    },
    [editedFields, isMulti, tracks, currentTrack, allEdits]
  )

  const getPlaceholder = useCallback(
    (field: string): string => {
      if (isMulti) {
        const vals = new Set(
          tracks.map((t) => String((t as unknown as Record<string, unknown>)[field] ?? ''))
        )
        return vals.size > 1 ? 'Multiple Values' : ''
      }
      return ''
    },
    [isMulti, tracks]
  )

  // Merge current edits into allEdits for the current track
  const commitCurrentEdits = useCallback(() => {
    if (Object.keys(editedFields).length === 0) return
    if (currentTrack) {
      setAllEdits((prev) => ({
        ...prev,
        [currentTrack.id]: { ...(prev[currentTrack.id] || {}), ...editedFields },
      }))
    }
  }, [editedFields, currentTrack])

  const handleSave = useCallback(() => {
    // Build final edits map including current unsaved edits
    const updates: { id: number; field: string; value: string }[] = []

    if (isMulti) {
      // Multi-track: apply editedFields to all selected tracks
      for (const [field, value] of Object.entries(editedFields)) {
        for (const t of tracks) {
          const original = String((t as unknown as Record<string, unknown>)[field] ?? '')
          if (original !== value) {
            updates.push({ id: t.id, field, value })
          }
        }
      }
    } else {
      // Single-track: merge current edits, then process all accumulated
      const finalEdits = { ...allEdits }
      if (currentTrack) {
        finalEdits[currentTrack.id] = {
          ...(finalEdits[currentTrack.id] || {}),
          ...editedFields,
        }
      }
      for (const [trackIdStr, fields] of Object.entries(finalEdits)) {
        const id = Number(trackIdStr)
        const track = allTracks.find((t) => t.id === id)
        if (!track) continue
        for (const [field, value] of Object.entries(fields)) {
          const original = String((track as unknown as Record<string, unknown>)[field] ?? '')
          if (original !== value) {
            updates.push({ id, field, value })
          }
        }
      }
    }

    if (updates.length > 0) onSave(updates)
    onClose()
  }, [allEdits, editedFields, isMulti, currentTrack, tracks, allTracks, onSave, onClose])

  const goPrev = useCallback(() => {
    if (currentIdx > 0) {
      commitCurrentEdits()
      setCurrentIdx((i) => i - 1)
    }
  }, [currentIdx, commitCurrentEdits])

  const goNext = useCallback(() => {
    if (currentIdx < allTracks.length - 1) {
      commitCurrentEdits()
      setCurrentIdx((i) => i + 1)
    }
  }, [currentIdx, allTracks.length, commitCurrentEdits])

  // Keyboard: Escape to close, Enter to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
      // Enter (not in a textarea) saves and closes
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        (e.target as HTMLElement)?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose, handleSave])

  // Artwork lookup — works for single track AND multi-track (shows first match)
  const artTrack = currentTrack || (isMulti ? tracks[0] : null)
  const artKey = artTrack
    ? `${(artTrack.artist || '').toLowerCase().trim()}|||${(artTrack.album || '').toLowerCase().trim()}`
    : null
  // Use local override for instant feedback, fall back to artworkMap prop
  const artHashFromMap = artKey ? artworkMap[artKey] : null
  const artHash = localArtHash || artHashFromMap

  const handleFetchArt = useCallback(async () => {
    if (!artTrack) return
    setFetchingArt(true)
    try {
      let lastResult: { key: string; hash: string } | null = null
      if (isMulti) {
        const pairs = new Map<string, { artist: string; album: string }>()
        for (const t of tracks) {
          if (t.artist && t.album) {
            const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
            if (!pairs.has(k)) pairs.set(k, { artist: t.artist, album: t.album })
          }
        }
        for (const { artist, album } of pairs.values()) {
          const r = await onFetchArt(artist, album, true)
          if (r) lastResult = r
        }
      } else {
        lastResult = await onFetchArt(artTrack.artist, artTrack.album, true)
      }
      if (lastResult) setLocalArtHash(lastResult.hash)
      setArtCacheBust(`?v=${Date.now()}`)
    } finally {
      setFetchingArt(false)
    }
  }, [artTrack, isMulti, tracks, onFetchArt])

  const handleChooseArt = useCallback(async () => {
    if (!artTrack) return
    const file = await window.electronAPI.chooseArtworkFile()
    if (!file.ok || !file.path) return
    let lastResult: { key: string; hash: string } | null = null
    if (isMulti) {
      const pairs = new Map<string, { artist: string; album: string }>()
      for (const t of tracks) {
        if (t.artist && t.album) {
          const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
          if (!pairs.has(k)) pairs.set(k, { artist: t.artist, album: t.album })
        }
      }
      for (const { artist, album } of pairs.values()) {
        const r = await onSetCustomArt(artist, album, file.path)
        if (r) lastResult = r
      }
    } else {
      lastResult = await onSetCustomArt(artTrack.artist, artTrack.album, file.path)
    }
    if (lastResult) setLocalArtHash(lastResult.hash)
    setArtCacheBust(`?v=${Date.now()}`)
  }, [artTrack, isMulti, tracks, onSetCustomArt])

  return (
    <div className="getinfo-overlay" onMouseDown={onClose}>
      <div className="getinfo-modal" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="getinfo-header">
          <span className="getinfo-title">
            {isMulti
              ? `${tracks.length} Songs`
              : currentTrack?.title || 'Get Info'}
          </span>
        </div>

        {/* Body */}
        <div className="getinfo-body">
          {/* Left: artwork + file info */}
          <div className="getinfo-art-section">
            <div className="getinfo-art">
              {artHash ? (
                <img src={`album-art://${artHash}.jpg${artCacheBust}`} alt="" />
              ) : (
                <div className="getinfo-art-placeholder">
                  <svg viewBox="0 0 48 48" width="48" height="48">
                    <circle cx="24" cy="24" r="20" fill="none" stroke="#999" strokeWidth="1.5" />
                    <circle cx="24" cy="24" r="4" fill="#999" />
                  </svg>
                </div>
              )}
            </div>
            {artTrack && (
              <div className="getinfo-art-actions">
                <button
                  className="getinfo-fetch-art-btn"
                  onClick={handleChooseArt}
                >
                  {artHash ? 'Replace Artwork\u2026' : 'Add Artwork\u2026'}
                </button>
                <button
                  className="getinfo-fetch-art-btn"
                  onClick={handleFetchArt}
                  disabled={fetchingArt}
                >
                  {fetchingArt ? 'Searching\u2026' : artHash ? 'Re-fetch from Internet' : 'Fetch Artwork'}
                </button>
              </div>
            )}
            {!isMulti && currentTrack && (
              <div className="getinfo-file-info">
                <div className="getinfo-file-row">
                  <span className="getinfo-file-label">Duration</span>
                  <span className="getinfo-file-value">
                    {formatDuration(currentTrack.duration)}
                  </span>
                </div>
                <div className="getinfo-file-row">
                  <span className="getinfo-file-label">Plays</span>
                  <span className="getinfo-file-value">
                    {currentTrack.playCount || 0}
                  </span>
                </div>
                <div className="getinfo-file-row">
                  <span className="getinfo-file-label">Added</span>
                  <span className="getinfo-file-value">
                    {currentTrack.dateAdded || '\u2014'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Right: editable fields */}
          <div className="getinfo-fields">
            {EDITABLE_FIELDS.map(({ key, label }, i) => (
              <div className="getinfo-field-row" key={key}>
                <label className="getinfo-label">{label}</label>
                <input
                  ref={i === 0 ? firstInputRef : undefined}
                  className="getinfo-input"
                  type="text"
                  value={getFieldValue(key)}
                  placeholder={getPlaceholder(key)}
                  onChange={(e) =>
                    setEditedFields((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                />
              </div>
            ))}
            {/* iTunes-style "X of Y" paired fields for Track and Disc */}
            {PAIRED_FIELDS.map(({ label, numKey, ofKey }) => (
              <div className="getinfo-field-row" key={numKey}>
                <label className="getinfo-label">{label}</label>
                <div className="getinfo-paired">
                  <input
                    className="getinfo-input getinfo-input--short"
                    type="text"
                    inputMode="numeric"
                    value={getFieldValue(numKey)}
                    placeholder={getPlaceholder(numKey) || '#'}
                    onChange={(e) =>
                      setEditedFields((prev) => ({ ...prev, [numKey]: e.target.value }))
                    }
                  />
                  <span className="getinfo-paired-of">of</span>
                  <input
                    className="getinfo-input getinfo-input--short"
                    type="text"
                    inputMode="numeric"
                    value={getFieldValue(ofKey)}
                    placeholder={getPlaceholder(ofKey) || '#'}
                    onChange={(e) =>
                      setEditedFields((prev) => ({ ...prev, [ofKey]: e.target.value }))
                    }
                  />
                </div>
              </div>
            ))}
            {!isMulti && currentTrack && (
              <div className="getinfo-field-row getinfo-field-row--readonly">
                <label className="getinfo-label">File</label>
                <span className="getinfo-path">{currentTrack.path}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="getinfo-footer">
          {!isMulti && (
            <div className="getinfo-nav">
              <button
                className="getinfo-nav-btn"
                onClick={goPrev}
                disabled={currentIdx <= 0}
              >
                &#9664;
              </button>
              <span className="getinfo-nav-pos">
                {currentIdx + 1} of {allTracks.length}
              </span>
              <button
                className="getinfo-nav-btn"
                onClick={goNext}
                disabled={currentIdx >= allTracks.length - 1}
              >
                &#9654;
              </button>
            </div>
          )}
          <div className="getinfo-actions">
            <button className="getinfo-btn getinfo-btn--cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="getinfo-btn getinfo-btn--ok" onClick={handleSave}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
