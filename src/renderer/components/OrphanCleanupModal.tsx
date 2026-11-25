import { useEscape } from '../hooks/useKeyboard'
import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import '../styles/import-convert.css'
import CloseButton from './CloseButton'

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
  useEscape('orphan-cleanup', true, () => { if (!running) onClose() })

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
          setError('Couldn’t look through the folder.')
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
      } catch {
        setError('Something went wrong. Try again.')
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
        setError('Couldn’t delete them. Nothing was changed.')
        setRunning(false)
        return
      }
      // The play cache is tidied by the nightly check (main/self-care.ts).
      const n = r.deleted ?? 0
      setResult(`${n === 1 ? 'Deleted one file' : `Deleted ${n.toLocaleString()} files`}, ${formatBytes(r.bytesFreed ?? 0)} freed.`)
      setOrphanCount(0)
      setOrphanBytes(0)
      setSamples([])
      setDiskCount(trackCount)
    } catch {
      setError('Something went wrong. Try again.')
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
        setError('Couldn’t remove them.')
        setRunning(false)
        return
      }
      if ((r.removed ?? 0) === 0) {
        setDeadCount(0)
        setDeadTracks([])
        setRunning(false)
        return
      }
      setResult((r.removed ?? 0) === 1 ? 'Removed the song with no file.' : `Removed ${r.removed ?? 0} songs with no file.`)
      setDeadCount(0)
      setDeadTracks([])
      onLibraryChanged()
    } catch {
      setError('Something went wrong. Try again.')
    }
    setRunning(false)
  }

  return (
    <>
      <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose() }}>
        <div className="imp-modal" role="dialog" aria-modal="true">
          <div className="imp-header">
            <h2>Files Not in Your Library</h2>
            <CloseButton onClick={onClose} disabled={running} />
          </div>

          <div className="imp-body">
            <p className="imp-help">
              Song files in your music folder that no song in your library points at.
              Deleting them can’t be undone.
            </p>

            {scanning ? (
              <p className="imp-help">Looking…</p>
            ) : (
              <div className="imp-help">
                <div><strong>{trackCount.toLocaleString()}</strong> songs in your library</div>
                <div><strong>{diskCount.toLocaleString()}</strong> song files in the folder</div>
                <div>
                  <strong>{orphanCount.toLocaleString()}</strong> {orphanCount === 1 ? 'file isn’t' : 'files aren’t'} in your library
                  {orphanCount > 0 ? ` (${formatBytes(orphanBytes)})` : ''}
                </div>
                {deadCount > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>{deadCount}</strong> {deadCount === 1 ? 'song has' : 'songs have'} no file
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
                {deadCount === 1 ? 'Remove the Song With No File' : `Remove ${deadCount} Songs With No File`}
              </button>
            )}
            <button
              className="imp-btn imp-btn--start"
              onClick={() => setConfirmPurge(true)}
              disabled={scanning || running || orphanCount === 0 || !!result}
            >
              {running ? 'Deleting…' : orphanCount === 1 ? 'Delete the File' : `Delete ${orphanCount || ''} Files`.replace('  ', ' ')}
            </button>
          </div>
        </div>
      </div>

      {confirmPurge && (
        <ConfirmDialog
          message={orphanCount === 1 ? 'Delete this file for good?' : `Delete these ${orphanCount.toLocaleString()} files for good?`}
          detail={`${formatBytes(orphanBytes)} of song files no song in your library points at. This can’t be undone.`}
          confirmLabel="Delete Forever"
          onConfirm={handlePurge}
          onCancel={() => setConfirmPurge(false)}
        />
      )}

      {confirmDead && (
        <ConfirmDialog
          message={deadCount === 1 ? 'Remove the song that has no file?' : `Remove the ${deadCount} songs that have no file?`}
          detail="They can’t play: their file is gone. No file is touched."
          confirmLabel="Remove from Library"
          onConfirm={handleRemoveDead}
          onCancel={() => setConfirmDead(false)}
        />
      )}
    </>
  )
}
