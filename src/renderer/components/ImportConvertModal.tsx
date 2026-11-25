import { useEscape } from '../hooks/useKeyboard'
import { useCallback, useEffect, useState } from 'react'
import { enqueueFiles } from '../importQueue'
import { IMPORT_FORMAT_LABELS, importFormatFromSettings, type ImportFormat } from '../../common/import-format'
import '../styles/import-convert.css'
import CloseButton from './CloseButton'

interface Props {
  onClose: () => void
}

/**
 * File > Import and Convert dialog. Pick audio files or entire
 * folders and the app converts + imports each file with live progress
 * in the pill. Supports drag-and-drop onto the dialog too. The format is
 * Settings › Library's, the one every import uses (common/import-format.ts);
 * this dialog has no picker of its own.
 */
export default function ImportConvertModal({ onClose }: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [format, setFormat] = useState<ImportFormat | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [dropHere, setDropHere] = useState(false)
  const [error, setError] = useState('')
  useEscape('import-convert', true, onClose)

  // Shown only: the main process reads the same setting for each file.
  useEffect(() => {
    window.electronAPI.loadAppSettings()
      .then(r => setFormat(importFormatFromSettings(r.ok ? r.settings : null)))
      .catch(() => setFormat(importFormatFromSettings(null)))
  }, [])

  const handlePick = useCallback(async () => {
    const r = await window.electronAPI.importPickFiles()
    if (!r.ok || !r.paths) return
    setPaths(prev => {
      const seen = new Set(prev)
      for (const p of r.paths!) seen.add(p)
      return Array.from(seen)
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropHere(false)
    const fileList = Array.from(e.dataTransfer.files)
    if (fileList.length === 0) return
    void (async () => {
      const granted = await window.electronAPI.allowDroppedImportPaths(fileList).catch(() => null)
      const dropped = granted?.ok && granted.paths ? granted.paths : []
      if (dropped.length === 0) return
      setPaths(prev => {
        const seen = new Set(prev)
        for (const p of dropped) seen.add(p)
        return Array.from(seen)
      })
    })()
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropHere(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDropHere(false)
  }, [])

  const removePath = useCallback((p: string) => {
    setPaths(prev => prev.filter(x => x !== p))
  }, [])

  const clearAll = useCallback(() => {
    setPaths([])
    setSubmitted(false)
    setError('')
  }, [])

  const handleStart = useCallback(async () => {
    if (paths.length === 0) return
    setError('')
    // Hand the paths off to the global import queue and close the
    // dialog. The floating queue panel takes over from here — the
    // user gets per-file progress, retry on failure, and the modal
    // doesn't need to babysit a 30-minute import.
    const added = await enqueueFiles(paths)
    setSubmitted(true)
    if (added === 0) {
      setError('Those files are already queued or already in your library.')
      return
    }
    // Brief confirmation, then close so the queue panel is unobstructed.
    setTimeout(() => onClose(), 600)
  }, [paths, onClose])

  const baseName = (p: string): string => p.substring(p.lastIndexOf('/') + 1) || p

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>Import and Convert</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="imp-body">
          <p className="imp-help">
            Add files or whole folders (WAV, FLAC, AIFF, MP3, M4A, etc.). Everything you
            add will be converted and dropped into your library.
          </p>

          <div
            className={`imp-dropzone ${dropHere ? 'imp-dropzone--active' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <button className="imp-pick-btn" onClick={handlePick}>
              Choose Files or Folders…
            </button>
            <span className="imp-dropzone-hint">or drag them here</span>
          </div>

          <p className="imp-help imp-format-note">
            Converts to {format ? IMPORT_FORMAT_LABELS[format] : '…'}. Change it in Settings › Library.
          </p>

          {paths.length > 0 && (
            <>
              <div className="imp-list-header">
                <span>{paths.length} item{paths.length !== 1 ? 's' : ''} queued</span>
                <button className="imp-clear" onClick={clearAll}>Clear</button>
              </div>
              <div className="imp-list">
                {paths.map(p => (
                  <div key={p} className="imp-list-item">
                    <span className="imp-list-name" title={p}>{baseName(p)}</span>
                    <button
                      className="imp-list-remove"
                      onClick={() => removePath(p)}
                      title="Remove"
                    >×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {submitted && !error && (
            <div className="imp-result imp-result--done">
              ✓ Added to import queue. Watch the dock in the bottom-right for progress.
            </div>
          )}
          {error && (
            <div className="imp-result imp-result--error">{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={onClose}>
            {submitted ? 'Close' : 'Cancel'}
          </button>
          <button
            className="imp-btn imp-btn--start"
            onClick={handleStart}
            disabled={paths.length === 0 || submitted}
          >
            {`Import ${paths.length || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  )
}
