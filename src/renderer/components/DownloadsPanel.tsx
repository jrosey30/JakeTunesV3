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
import NearEditionTable from './NearEditionTable'
import { planMatchingTrackGets, omittedTrackLine, type MatchingTrackPlan } from '../../common/near-edition-actions'
import type { CompareEditionsResult } from '../../common/near-edition-types'
import { subscribeQueue, getQueue, cancel, retry, clearFinished, enqueue, type QResult } from '../views/DownloadStore/downloadQueue'
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
  // Near editions (a refused album whose nearest edition differs on the
  // tracklist): the read-only comparison is fetched once per row and drives
  // ONE inline action — "Get N matching tracks", N counting only recordings
  // still missing from the library — with the omitted track named. The
  // table itself sits under Details. Nothing here acquires until that click.
  const [compares, setCompares] = useState<Record<string, { loading: boolean; data: CompareEditionsResult | null; error: string | null }>>({})
  useEffect(() => {
    for (const q of queue) {
      const row = rows.find((r) => r.key === q.key)
      if (!row?.nearEdition || compares[row.key] || !row.artist) continue
      const api = window.electronAPI.nearEdition
      if (!api) continue
      const r = q.result
      setCompares((c) => ({ ...c, [row.key]: { loading: true, data: null, error: null } }))
      api.compare({ artist: row.artist, album: r.album || row.title, collectionId: r.collectionId, trackCount: r.trackCount, releaseYear: r.releaseYear, candidate: { provider: row.nearEdition.provider, desc: row.nearEdition.desc, url: row.nearEdition.url, tracks: row.nearEdition.tracks } })
        .then((res) => setCompares((c) => ({ ...c, [row.key]: res.ok ? { loading: false, data: res, error: null } : { loading: false, data: null, error: res.error } })))
        .catch((e) => setCompares((c) => ({ ...c, [row.key]: { loading: false, data: null, error: String(e) } })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue])
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

  // Action A — the ONE inline action: enqueue the plan's song jobs through the
  // scheduler (identity, runtime pin, verification unchanged).
  const getMatching = (plan: MatchingTrackPlan) => { for (const j of plan.jobs) enqueue(j as unknown as QResult) }
  const planFor = (row: PanelRow): MatchingTrackPlan | null => {
    const c = compares[row.key]
    if (!c?.data || !row.artist) return null
    const q = queue.find((x) => x.key === row.key)
    return planMatchingTrackGets(c.data, { parentKey: row.key, artist: row.artist, album: q?.result.album || row.title, releaseYear: q?.result.releaseYear, sourceKind: q?.result.origin?.sourceKind, sourceLabel: q?.result.origin?.sourceLabel })
  }
  const retryGroup = (row: PanelRow) => {
    for (const c of row.group?.children ?? []) if (c.status === 'failed' || c.status === 'refused' || c.status === 'canceled') retry(c.key)
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
          const hasDetails = !!(row.detail || row.alternatives.length || row.completion || row.nearEdition)
          return (
            <li key={row.key} className={`dlp-row dlp-row--${row.status}`}>
              <div className="dlp-row-head">
                <span className={`dlp-status dlp-status--${row.status}`}>{STATUS_LABEL[row.status]}{row.elapsedSec != null ? ` · ${row.elapsedSec}s` : ''}</span>
                {row.from && <span className="dlp-from">{row.from}</span>}
              </div>
              <div className="dlp-row-title" title={row.title}>{row.title}</div>
              {row.artist && <div className="dlp-row-artist">{row.artist}</div>}
              {row.edition && <div className="dlp-row-edition">{row.edition}</div>}
              {row.editionNote && <div className="dlp-row-edition dlp-row-edition--note">{row.editionNote}</div>}
              {row.counts && <div className="dlp-row-counts">{row.counts}</div>}
              {row.primary && <div className="dlp-row-primary">{row.primary}</div>}
              <div className="dlp-row-actions">
                {row.actions.includes('cancel') && <button onClick={() => void cancel(row.key)}>Cancel</button>}
                {row.actions.includes('retry') && <button onClick={() => retry(row.key)}>Retry</button>}
                {row.actions.includes('chooseEdition') && <button className="dlp-primary-action" onClick={() => chooseAgain(row)} disabled={!row.choose}>Choose edition</button>}
                {row.actions.includes('chooseVersion') && <button className="dlp-primary-action" onClick={() => chooseAgain(row)} disabled={!row.choose}>Choose version</button>}
                {row.actions.includes('retryGroup') && <button onClick={() => retryGroup(row)} title="Retry only the tracks that failed or were canceled">Retry the {row.group ? row.group.failed + row.group.canceled : 0} that failed</button>}
                {hasDetails && <button className="dlp-details-toggle" onClick={() => toggleDetails(row.key)} aria-expanded={showDetails}>{showDetails ? 'Hide details' : 'Details'}</button>}
              </div>
              {row.nearEdition && !row.group && (() => {
                const c = compares[row.key]
                const plan = planFor(row)
                const omitted = plan ? plan.notAcquired.map(omittedTrackLine).join('; ') : ''
                return (
                  <div className="dlp-near">
                    {(!c || c.loading) && <span className="dlp-near-text">Checking which tracks match…</span>}
                    {c?.error && <span className="dlp-near-text">Couldn’t compare the editions ({c.error}).</span>}
                    {plan && plan.jobs.length > 0 && (
                      <>
                        <button className="dlp-primary-action" onClick={() => getMatching(plan)} title={`Queues ${plan.jobs.length} song downloads pinned to the edition you picked; each is verified before import`}>Get {plan.jobs.length} matching track{plan.jobs.length === 1 ? '' : 's'}</button>
                        <span className="dlp-near-text">{plan.skippedOwned.length ? `${plan.skippedOwned.length} already yours. ` : ''}Not acquired: {omitted}.</span>
                      </>
                    )}
                    {plan && plan.jobs.length === 0 && (
                      <span className="dlp-near-text">{plan.skippedOwned.length ? `All ${plan.skippedOwned.length} matching tracks are yours.` : 'No track matches the edition you picked.'} {omitted ? `${omitted}.` : ''}</span>
                    )}
                  </div>
                )
              })()}
              {row.group && (
                <div className="dlp-group">
                  <div className="dlp-group-line">{row.group.line}</div>
                  <ul className="dlp-group-children">
                    {row.group.children.map((c) => (
                      <li key={c.key} className={`dlp-child dlp-child--${c.status}`}>
                        <span className="dlp-child-pos">{c.groupPosition ?? ''}</span>
                        <span className="dlp-child-title" title={c.title}>{c.title}</span>
                        <span className={`dlp-status dlp-status--${c.status}`}>{STATUS_LABEL[c.status]}{c.elapsedSec != null ? ` · ${c.elapsedSec}s` : ''}{c.status === 'failed' || c.status === 'refused' ? ` · ${c.primary ?? ''}` : ''}</span>
                        {c.actions.includes('cancel') && <button onClick={() => void cancel(c.key)}>Cancel</button>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {showDetails && (
                <div className="dlp-row-details">
                  {row.nearEdition && compares[row.key]?.data && <NearEditionTable d={compares[row.key].data!} />}
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
    </div>
  )
})

export default DownloadsPanel
