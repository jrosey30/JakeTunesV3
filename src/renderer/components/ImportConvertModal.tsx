import { useCallback, useEffect, useState } from 'react'
import { enqueueFiles } from '../importQueue'
import '../styles/import-convert.css'

type ImportFormat = 'aac-256' | 'aac-128' | 'aac-320' | 'alac' | 'aiff' | 'wav'

const FORMAT_LABELS: Record<ImportFormat, string> = {
  'aac-256': 'AAC (iTunes Plus, 256 kbps)',
  'aac-128': 'AAC (128 kbps)',
  'aac-320': 'AAC (320 kbps)',
  'alac': 'Apple Lossless (ALAC)',
  'aiff': 'AIFF (Uncompressed)',
  'wav': 'WAV (Uncompressed)',
}

interface Props {
  onClose: () => void
}

/**
 * File > Import and Convert dialog. Pick audio files or entire
 * folders, choose an output format (e.g. ALAC for WAV/FLAC sources),
 * and the app will convert + import each file with live progress
 * in the pill. Supports drag-and-drop onto the dialog too.
 */
export default function ImportConvertModal({ onClose }: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [format, setFormat] = useState<ImportFormat>('alac')
  const [submitted, setSubmitted] = useState(false)
  const [dropHere, setDropHere] = useState(false)
  const [error, setError] = useState('')

  // Seed format from persisted preference (same one CD Import uses).
  useEffect(() => {
    window.electronAPI.loadUiState().then(r => {
      const f = (r.ok && r.state && typeof (r.state as Record<string, unknown>).importFormat === 'string')
        ? (r.state as Record<string, unknown>).importFormat as ImportFormat
        : null
      if (f && ['aac-256', 'aac-128', 'aac-320', 'alac', 'aiff', 'wav'].includes(f)) {
        setFormat(f)
      }
    }).catch(() => {})
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
    const dropped = fileList.map(f => (f as unknown as { path?: string }).path).filter((p): p is string => !!p)
    if (dropped.length === 0) return
    setPaths(prev => {
      const seen = new Set(prev)
      for (const p of dropped) seen.add(p)
      return Array.from(seen)
    })
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
    // Persist format so future drops and CD rips match this choice.
    try {
      const ui = await window.electronAPI.loadUiState()
      const existing = (ui.ok && ui.state) ? ui.state : {}
      await window.electronAPI.saveUiState({ ...existing, importFormat: format })
    } catch { /* non-fatal */ }

    // Hand the paths off to the global import queue and close the
    // dialog. The floating queue panel takes over from here — the
    // user gets per-file progress, retry on failure, and the modal
    // doesn't need to babysit a 30-minute import.
    const added = await enqueueFiles(paths, format)
    setSubmitted(true)
    if (added === 0) {
      setError('Those files are already queued or already in your library.')
      return
    }
    // Brief confirmation, then close so the queue panel is unobstructed.
    setTimeout(() => onClose(), 600)
  }, [paths, format, onClose])

  const baseName = (p: string): string => p.substring(p.lastIndexOf('/') + 1) || p

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>Import and Convert</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body">
          <p className="imp-help">
            Add files or whole folders (WAV, FLAC, AIFF, MP3, M4A, etc.) and pick a target
            format. Everything you add will be converted and dropped into your library.
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

          <div className="imp-format-row">
            <label htmlFor="imp-format">Convert to:</label>
            <select
              id="imp-format"
              value={format}
              onChange={e => setFormat(e.target.value as ImportFormat)}
            >
              {(Object.entries(FORMAT_LABELS) as [ImportFormat, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

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
