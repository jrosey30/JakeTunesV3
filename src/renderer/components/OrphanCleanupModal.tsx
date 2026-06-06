import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import '../styles/import-convert.css'

interface OrphanSample {
  basename: string
  mtimeMs: number
  size: number
}

interface DeadTrack {
  id: number
  title: string
  artist: string
  path: string
}

interface Props {
  onClose: () => void
  onLibraryChanged: () => void
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

export default function OrphanCleanupModal({ onClose, onLibraryChanged }: Props) {
  const [scanning, setScanning] = useState(true)
  const [trackCount, setTrackCount] = useState(0)
  const [diskCount, setDiskCount] = useState(0)
  const [orphanCount, setOrphanCount] = useState(0)
  const [orphanBytes, setOrphanBytes] = useState(0)
  const [samples, setSamples] = useState<OrphanSample[]>([])
  const [deadCount, setDeadCount] = useState(0)
  const [deadTracks, setDeadTracks] = useState<DeadTrack[]>([])
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [confirmDead, setConfirmDead] = useState(false)

  useEffect(() => {
    void (async () => {
      setScanning(true)
      setError('')
      try {
        const [orphanRes, deadRes] = await Promise.all([
          window.electronAPI.scanLibraryOrphans(),
          window.electronAPI.scanDeadTracks(),
        ])
        if (!orphanRes.ok) {
          setError(orphanRes.error || 'Orphan scan failed')
        } else {
          setTrackCount(orphanRes.trackCount ?? 0)
          setDiskCount(orphanRes.diskCount ?? 0)
          setOrphanCount(orphanRes.orphanCount ?? 0)
          setOrphanBytes(orphanRes.orphanBytes ?? 0)
          setSamples((orphanRes.samples ?? []) as OrphanSample[])
        }
        if (deadRes.ok) {
          setDeadCount(deadRes.count ?? 0)
          setDeadTracks((deadRes.tracks ?? []) as DeadTrack[])
        }
      } catch (err) {
        setError(String(err))
      }
      setScanning(false)
    })()
  }, [])

  const handlePurge = async () => {
    setConfirmPurge(false)
    setRunning(true)
    setError('')
    try {
      const r = await window.electronAPI.purgeLibraryOrphans()
      if (!r.ok) {
        setError(r.error || 'Purge failed')
        setRunning(false)
        return
      }
      const cache = await window.electronAPI.pruneAlacCache()
      const cacheMb = cache.ok ? ((cache.bytesFreed ?? 0) / 1024 / 1024).toFixed(1) : '0'
      let msg =
        `Deleted ${r.deleted ?? 0} orphan file(s), freed ${formatBytes(r.bytesFreed ?? 0)}.` +
        (cache.ok && (cache.pruned ?? 0) > 0 ? ` Pruned ${cache.pruned} play-cache entries (${cacheMb} MB).` : '')
      const ipod = await window.electronAPI.checkIpodMounted?.()
      if (ipod?.mounted) {
        msg += ' iPod is connected — sync from Device view to align device storage.'
      }
      setResult(msg)
      setOrphanCount(0)
      setOrphanBytes(0)
      setSamples([])
      setDiskCount(trackCount)
    } catch (err) {
      setError(String(err))
    }
    setRunning(false)
  }

  const handleRemoveDead = async () => {
    setConfirmDead(false)
    setRunning(true)
    setError('')
    try {
      const r = await window.electronAPI.removeDeadTracks()
      if (!r.ok) {
        setError(r.error || 'Remove failed')
        setRunning(false)
        return
      }
      if ((r.removed ?? 0) === 0) {
        setDeadCount(0)
        setDeadTracks([])
        setRunning(false)
        return
      }
      setResult(`Removed ${r.removed ?? 0} track(s) with missing audio from library.`)
      setDeadCount(0)
      setDeadTracks([])
      onLibraryChanged()
    } catch (err) {
      setError(String(err))
    }
    setRunning(false)
  }

  return (
    <>
      <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose() }}>
        <div className="imp-modal" role="dialog" aria-modal="true">
          <div className="imp-header">
            <h2>Clean Orphan Files</h2>
            <button className="imp-close" onClick={onClose} disabled={running} title="Close">×</button>
          </div>

          <div className="imp-body">
            <p className="imp-help">
              Orphan files are audio on disk not referenced by any track in your library.
              Deletion is permanent and uses filename identity only — no tag matching.
            </p>

            {scanning ? (
              <p className="imp-help">Scanning library mirror…</p>
            ) : (
              <div className="imp-help">
                <div><strong>{trackCount.toLocaleString()}</strong> tracks indexed</div>
                <div><strong>{diskCount.toLocaleString()}</strong> audio files on disk</div>
                <div>
                  <strong>{orphanCount.toLocaleString()}</strong> orphan file{orphanCount === 1 ? '' : 's'}
                  {orphanCount > 0 ? ` (${formatBytes(orphanBytes)})` : ''}
                </div>
                {deadCount > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>{deadCount}</strong> library track{deadCount === 1 ? '' : 's'} with missing audio
                  </div>
                )}
                {samples.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#555', maxHeight: 100, overflow: 'auto' }}>
                    {samples.map((s) => (
                      <div key={s.basename}>{s.basename} — {formatBytes(s.size)}</div>
                    ))}
                    {orphanCount > samples.length && <div>…and {orphanCount - samples.length} more</div>}
                  </div>
                )}
                {deadTracks.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#555', maxHeight: 80, overflow: 'auto' }}>
                    {deadTracks.slice(0, 5).map((t) => (
                      <div key={t.id}>{t.artist} — {t.title}</div>
                    ))}
                    {deadCount > 5 && <div>…and {deadCount - 5} more</div>}
                  </div>
                )}
              </div>
            )}

            {result && (
              <div className="imp-result imp-result--done">✓ {result}</div>
            )}
            {error && (
              <div className="imp-result imp-result--error">{error}</div>
            )}
          </div>

          <div className="imp-footer">
            <button className="imp-btn imp-btn--cancel" onClick={onClose} disabled={running}>
              {result ? 'Close' : 'Cancel'}
            </button>
            {deadCount > 0 && !result && (
              <button
                className="imp-btn imp-btn--cancel"
                onClick={() => setConfirmDead(true)}
                disabled={scanning || running}
                style={{ marginRight: 'auto' }}
              >
                Remove {deadCount} Dead Track{deadCount === 1 ? '' : 's'}
              </button>
            )}
            <button
              className="imp-btn imp-btn--start"
              onClick={() => setConfirmPurge(true)}
              disabled={scanning || running || orphanCount === 0 || !!result}
            >
              {running ? 'Deleting…' : `Delete ${orphanCount || ''} Orphan${orphanCount === 1 ? '' : 's'}`.trim()}
            </button>
          </div>
        </div>
      </div>

      {confirmPurge && (
        <ConfirmDialog
          message={`Permanently delete ${orphanCount} orphan file${orphanCount === 1 ? '' : 's'}?`}
          detail={`This removes ${formatBytes(orphanBytes)} of audio not referenced by your ${trackCount.toLocaleString()} library tracks. This cannot be undone.`}
          confirmLabel="Delete Forever"
          onConfirm={handlePurge}
          onCancel={() => setConfirmPurge(false)}
        />
      )}

      {confirmDead && (
        <ConfirmDialog
          message={`Remove ${deadCount} track${deadCount === 1 ? '' : 's'} with missing audio from library?`}
          detail="These entries have no playable file on disk. The library count will decrease. Audio files are not affected."
          confirmLabel="Remove from Library"
          onConfirm={handleRemoveDead}
          onCancel={() => setConfirmDead(false)}
        />
      )}
    </>
  )
}
