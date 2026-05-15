import { useEffect, useState } from 'react'
import '../styles/import-convert.css'

// Single-mode now (was 'verify' | 'alac' — the verify-and-repair flow
// got pulled because its tag matcher had false-negative cases that
// could silently delete real library entries; iTunes never had a verify
// step, so we don't either). The 'mode' prop stays so existing callers
// keep working and so we can re-add other admin actions cleanly later.
type Mode = 'alac'

interface AlacResult {
  ok: boolean
  count?: number
  samples?: Array<{ path: string; bit_depth: number; sample_rate: number; title?: string; artist?: string }>
  error?: string
}

interface Props {
  mode: Mode
  onClose: () => void
}

/**
 * iPod Classic ALAC compatibility fix. Re-encodes high-bit-depth ALAC
 * (32-bit / high-sample-rate) down to 16-bit / 44.1 kHz so the iPod
 * Classic hardware can actually decode them. Without this, those tracks
 * silently skip on the device.
 *
 * Same look/feel as ImportConvertModal (reuses its stylesheet) so the
 * app doesn't sprout a new visual vocabulary for every admin action.
 */
export default function LibraryMaintenanceModal({ mode, onClose }: Props) {
  const [scanning, setScanning] = useState(true)
  const [alac, setAlac] = useState<AlacResult | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<{ current: number; total: number; file: string } | null>(null)

  // Initial dry-run scan.
  useEffect(() => {
    window.electronAPI.alacCompatScan().then((r) => {
      // The IPC contract returns `samples: unknown[]` for forward-compat
      // (the Python helper may add fields). Coerce to the modal's
      // narrower shape — extra properties are discarded by the
      // structural cast and the row renderer pulls only the fields it
      // needs (path/bit_depth/sample_rate/title/artist).
      const result: AlacResult = {
        ok: r.ok,
        count: r.count,
        error: r.error,
        samples: r.samples as AlacResult['samples'],
      }
      setAlac(result)
      setScanning(false)
      if (!r.ok) setError(r.error || 'Scan failed')
    })
  }, [mode])

  // Progress stream for the ALAC fix.
  useEffect(() => {
    const off = window.electronAPI.onAlacCompatProgress((p) => setProgress(p))
    return off
  }, [])

  const handleApply = async () => {
    setRunning(true); setError('')
    setProgress(null)
    try {
      const r = await window.electronAPI.alacCompatFix()
      if (r.ok) setResult(`All files re-encoded. Your iPod should now play every track without skipping.`)
      else setError(r.error || 'Fix failed')
    } catch (err) {
      setError(String(err))
    }
    setRunning(false)
  }

  const title = 'Fix iPod Compatibility'
  const description = <>This re-encodes high-bit-depth ALAC files (32-bit / high-sample-rate) to 16-bit / 44.1 kHz ALAC. The iPod Classic can&apos;t decode the high-res variant, so these tracks silently skip on the hardware.</>

  // Build summary
  let summary: React.ReactNode = null
  if (scanning) {
    summary = <p className="imp-help">Scanning…</p>
  } else if (alac?.ok) {
    summary = (
      <div className="imp-help">
        <div><strong>{alac.count ?? 0}</strong> files need re-encoding for iPod Classic compatibility.</div>
        {alac.samples && alac.samples.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#555', maxHeight: 120, overflow: 'auto' }}>
            {(alac.samples as Array<{ artist?: string; title?: string; bit_depth: number; sample_rate: number }>).slice(0, 8).map((s, i) => (
              <div key={i}>{s.bit_depth}-bit / {s.sample_rate} Hz — {s.artist || '?'} · {s.title || '?'}</div>
            ))}
            {alac.samples.length > 8 && <div>…and {alac.samples.length - 8} more</div>}
          </div>
        )}
      </div>
    )
  }

  const count = alac?.count ?? 0
  const actionDisabled = scanning || running || !count

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>{title}</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body">
          <p className="imp-help">{description}</p>

          {summary}

          {running && progress && (
            <div className="imp-progress">
              <div className="imp-progress-bar">
                <div
                  className="imp-progress-fill"
                  style={{ width: `${(progress.current / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
              <div className="imp-progress-text">
                Re-encoding {progress.current}/{progress.total} — {progress.file}
              </div>
            </div>
          )}

          {result && (
            <div className="imp-result imp-result--done">
              ✓ {result.split('\n')[0]}
            </div>
          )}
          {error && (
            <div className="imp-result imp-result--error">{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={onClose} disabled={running}>
            {result ? 'Close' : 'Cancel'}
          </button>
          <button
            className="imp-btn imp-btn--start"
            onClick={handleApply}
            disabled={actionDisabled || !!result}
          >
            {running ? 'Re-encoding…' : `Fix ${count || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  )
}
