/**
 * Downloads panel — the persistent activity drawer for the ONE download
 * scheduler (Record Shop plan, step 5 slice 3). Reachable from any view via
 * the sidebar Download badge; rows are the queue's own entries projected by
 * `downloads-panel-model` so provenance, edition identity and completion
 * details are exactly what the Download view shows. The Download view's own
 * queue bar stays until this replacement is verified.
 */
import { useState, useCallback, useEffect, useImperativeHandle, forwardRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { openBrowse } from '../listen-to-the-list/ltlDownload'
import CompareEditionsSheet, { type CompareEditionsSubject } from './CompareEditionsSheet'
import { subscribeQueue, getQueue, cancel, retry, clearFinished } from '../views/DownloadStore/downloadQueue'
import { downloadsPanelRows, panelSummary, type PanelRow } from '../../common/downloads-panel-model'
import '../styles/downloads-panel.css'

export interface DownloadsPanelHandle { requestClose: () => void }

/** Anyone may toggle the panel from anywhere (sidebar badge, future Get buttons). */
export const DOWNLOADS_PANEL_EVENT = 'jaketunes-downloads-panel'
export function toggleDownloadsPanel(action: 'toggle' | 'open' | 'close' = 'toggle'): void {
  window.dispatchEvent(new CustomEvent(DOWNLOADS_PANEL_EVENT, { detail: action }))
}

// Is the panel open? App owns the state; the sidebar's Downloads row reads it
// to light up like a selected view.
let panelOpen = false
const openSubs = new Set<() => void>()
export function setDownloadsPanelOpen(open: boolean): void { if (panelOpen !== open) { panelOpen = open; for (const f of openSubs) f() } }
export function subscribeDownloadsPanelOpen(fn: () => void): () => void { openSubs.add(fn); return () => { openSubs.delete(fn) } }
export function getDownloadsPanelOpen(): boolean { return panelOpen }

const STATUS_LABEL: Record<PanelRow['status'], string> = {
  downloading: 'Downloading', queued: 'Queued', done: 'Done', failed: 'Failed', refused: 'Needs a choice', canceled: 'Canceled',
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return active ? now : Date.now()
}

const DownloadsPanel = forwardRef<DownloadsPanelHandle, { onClose: () => void }>(function DownloadsPanel({ onClose }, ref) {
  const { dispatch } = useLibrary()
  const queue = useSyncExternalStore(subscribeQueue, getQueue)
  const [exiting, setExiting] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [compare, setCompare] = useState<{ row: PanelRow; subject: CompareEditionsSubject } | null>(null)
  const anyActive = queue.some((q) => q.status === 'downloading')
  const now = useNow(anyActive)
  const rows = downloadsPanelRows(queue, now)
  const summary = panelSummary(rows)
  const settled = summary.done + summary.failed + summary.canceled

  const requestClose = useCallback(() => {
    setExiting(true)
    setTimeout(onClose, 220)
  }, [onClose])
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose])

  const toggleDetails = (key: string) => setOpen((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  // A refused verdict re-opens Record Shop → Browse on the same request so
  // Jake picks a DIFFERENT edition or version — the job's provenance rides along.
  const chooseAgain = (row: PanelRow) => {
    if (!row.choose) return
    const origin = queue.find((q) => q.key === row.key)?.result.origin
    window.dispatchEvent(new CustomEvent('jaketunes-download-prefill', { detail: { ...row.choose, origin, target: 'browse' } }))
    openBrowse(dispatch)
    requestClose()
  }

  // Compare editions (read-only): the refused album beside its nearest edition.
  const openCompare = (row: PanelRow) => {
    const q = queue.find((x) => x.key === row.key)
    if (!q || !row.nearEdition || !row.artist) return
    const r = q.result
    setCompare({ row, subject: { artist: row.artist, album: r.album || row.title, collectionId: r.collectionId, trackCount: r.trackCount, releaseYear: r.releaseYear, candidate: { provider: row.nearEdition.provider, desc: row.nearEdition.desc, url: row.nearEdition.url, tracks: row.nearEdition.tracks } } })
  }
  const pasteLinkFor = (row: PanelRow) => {
    setCompare(null)
    if (row.choose) window.dispatchEvent(new CustomEvent('jaketunes-download-prefill', { detail: { ...row.choose, target: 'browse' } }))
    openBrowse(dispatch)
    requestClose()
  }
  const summaryLine = [
    summary.active ? `${summary.active} downloading` : null,
    summary.queued ? `${summary.queued} queued` : null,
    summary.done ? `${summary.done} done` : null,
    summary.failed ? `${summary.failed} need attention` : null,
    summary.canceled ? `${summary.canceled} canceled` : null,
  ].filter(Boolean).join(' · ') || 'Nothing in the queue'

  return (
    <div className={`dlp-panel${exiting ? ' dlp-panel--exiting' : ''}`} role="dialog" aria-label="Downloads">
      <div className="dlp-header">
        <span className="dlp-title">Downloads</span>
        <button className="dlp-clear" onClick={clearFinished} disabled={settled === 0} title="Remove finished, failed and canceled jobs from the list">Clear finished</button>
        <button className="dlp-close" onClick={requestClose} aria-label="Close Downloads">×</button>
      </div>
      <div className="dlp-summary">{summaryLine}</div>
      <ul className="dlp-list">
        {rows.length === 0 && (
          <li className="dlp-empty">Get something from the Record Shop or the Download view and it shows up here.</li>
        )}
        {rows.map((row) => {
          const showDetails = open.has(row.key)
          const hasDetails = !!(row.detail || row.alternatives.length || row.completion)
          return (
            <li key={row.key} className={`dlp-row dlp-row--${row.status}`}>
              <div className="dlp-row-head">
                <span className={`dlp-status dlp-status--${row.status}`}>{STATUS_LABEL[row.status]}{row.elapsedSec != null ? ` · ${row.elapsedSec}s` : ''}</span>
                {row.from && <span className="dlp-from">{row.from}</span>}
              </div>
              <div className="dlp-row-title" title={row.title}>{row.title}</div>
              {row.artist && <div className="dlp-row-artist">{row.artist}</div>}
              {row.edition && <div className="dlp-row-edition">{row.edition}</div>}
              {row.counts && <div className="dlp-row-counts">{row.counts}</div>}
              {row.primary && <div className="dlp-row-primary">{row.primary}</div>}
              <div className="dlp-row-actions">
                {row.actions.includes('cancel') && <button onClick={() => void cancel(row.key)}>Cancel</button>}
                {row.actions.includes('retry') && <button onClick={() => retry(row.key)}>Retry</button>}
                {row.actions.includes('chooseEdition') && <button className="dlp-primary-action" onClick={() => chooseAgain(row)} disabled={!row.choose}>Choose edition</button>}
                {row.actions.includes('chooseVersion') && <button className="dlp-primary-action" onClick={() => chooseAgain(row)} disabled={!row.choose}>Choose version</button>}
                {row.actions.includes('compareEditions') && <button onClick={() => openCompare(row)} title="Lay the edition you picked beside the nearest one found — acquires nothing">Compare editions…</button>}
                {hasDetails && <button className="dlp-details-toggle" onClick={() => toggleDetails(row.key)} aria-expanded={showDetails}>{showDetails ? 'Hide details' : 'Details'}</button>}
              </div>
              {showDetails && (
                <div className="dlp-row-details">
                  {row.completion && <p>{row.completion}</p>}
                  {row.detail && <p>{row.detail}</p>}
                  {row.alternatives.length > 0 && (
                    <div className="dlp-alternatives">
                      <div className="dlp-alternatives-title">Refused candidates</div>
                      <ul>
                        {row.alternatives.map((a, i) => (
                          <li key={i}><span className="dlp-alt-desc">{a.desc}</span> <span className="dlp-alt-reason">{a.reason}</span> <span className="dlp-alt-provider">{a.provider}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {compare && <CompareEditionsSheet subject={compare.subject} onClose={() => setCompare(null)} onPasteLink={() => pasteLinkFor(compare.row)} />}
    </div>
  )
})

export default DownloadsPanel
