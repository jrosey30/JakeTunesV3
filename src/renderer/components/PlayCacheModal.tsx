import { useEffect, useState } from 'react'
import '../styles/import-convert.css'

/**
 * 4.1 ALAC play-cache management. Replaces the launch-time
 * `schedulePrewarmFromLibrary` scanner that ran on every load-tracks
 * and silently fought playback for CPU + disk.
 *
 * Two modes:
 *  - 'prepare': walk the library, transcode ALAC tracks whose AAC
 *    cache entry is missing or stale. Foreground, 4 parallel workers,
 *    progress bar, cancellable.
 *  - 'prune':   delete cache entries whose source path no longer
 *    exists in the library. One-shot, fast.
 *
 * Same import-convert visual vocabulary as LibraryMaintenanceModal so
 * the app doesn't sprout a new look for every admin action.
 */
type Mode = 'prepare' | 'prune'

interface Props {
  mode: Mode
  onClose: () => void
}

interface Progress {
  processed: number
  transcoded: number
  total: number
  title: string
  artist: string
}

export default function PlayCacheModal({ mode, onClose }: Props) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState<string>('')

  // Subscribe to per-track progress events from main during a prepare run.
  useEffect(() => {
    if (mode !== 'prepare') return
    const off = window.electronAPI.onPrepareAlacCacheProgress((p) => setProgress(p))
    return off
  }, [mode])

  const handlePrepare = async () => {
    setRunning(true); setError(''); setResult(''); setProgress(null)
    try {
      const r = await window.electronAPI.prepareAlacCache()
      if (r.ok) {
        const msg = r.cancelled
          ? `Cancelled. ${r.transcoded ?? 0} tracks transcoded so far (${r.processed ?? 0} of ${r.total ?? 0} scanned).`
          : `Done. ${r.transcoded ?? 0} ALAC tracks transcoded; ${(r.total ?? 0) - (r.transcoded ?? 0)} were already cached or non-ALAC.`
        setResult(msg)
      } else {
        setError(r.error || 'Prepare failed')
      }
    } catch (err) {
      setError(String(err))
    }
    setRunning(false)
  }

  const handlePrune = async () => {
    setRunning(true); setError(''); setResult('')
    try {
      const r = await window.electronAPI.pruneAlacCache()
      if (r.ok) {
        const mb = ((r.bytesFreed ?? 0) / 1024 / 1024).toFixed(1)
        setResult(`Pruned ${r.pruned ?? 0} orphaned cache entries. Freed ${mb} MB.`)
      } else {
        setError(r.error || 'Prune failed')
      }
    } catch (err) {
      setError(String(err))
    }
    setRunning(false)
  }

  const handleCancel = () => {
    if (running && mode === 'prepare') {
      window.electronAPI.cancelAlacCache()
    } else {
      onClose()
    }
  }

  const title = mode === 'prepare' ? 'Prepare ALAC Tracks for Instant Play' : 'Prune Play-Cache'
  const description = mode === 'prepare' ? (
    <>JakeTunes converts ALAC files to AAC the first time you play them so Chromium can decode them. Without a cached AAC mirror, first-play takes ~5 seconds while ffmpeg runs. This action transcodes every ALAC track in your library now so first-play is instant going forward. AAC tracks (the majority of your library) are skipped — they play raw and need no cache.</>
  ) : (
    <>Cache entries pile up after re-imports, dedups, and deletions. This removes any cached AAC transcode whose source file is no longer in your library. Safe — the source ALAC files aren&apos;t touched.</>
  )

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>{title}</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body">
          <p className="imp-help">{description}</p>

          {running && progress && mode === 'prepare' && (
            <div className="imp-progress">
              <div className="imp-progress-bar">
                <div
                  className="imp-progress-fill"
                  style={{ width: `${(progress.processed / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
              <div className="imp-progress-text">
                Scanning {progress.processed}/{progress.total} — {progress.transcoded} transcoded so far<br />
                <span style={{ color: '#666', fontSize: 11 }}>{progress.title} — {progress.artist}</span>
              </div>
            </div>
          )}
          {running && mode === 'prune' && (
            <p className="imp-help">Pruning…</p>
          )}

          {result && (
            <div className="imp-result imp-result--done">✓ {result}</div>
          )}
          {error && (
            <div className="imp-result imp-result--error">{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={handleCancel} disabled={false}>
            {running && mode === 'prepare' ? 'Cancel' : (result ? 'Close' : 'Cancel')}
          </button>
          <button
            className="imp-btn imp-btn--start"
            onClick={mode === 'prepare' ? handlePrepare : handlePrune}
            disabled={running || !!result}
          >
            {running
              ? (mode === 'prepare' ? 'Working…' : 'Pruning…')
              : (mode === 'prepare' ? 'Start' : 'Prune')}
          </button>
        </div>
      </div>
    </div>
  )
}
