import { useSyncExternalStore, useState, useEffect, useMemo } from 'react'
import {
  subscribe, getSnapshot, getQueueState, getActiveItem,
  getPendingCount, getDoneCount, getFailedCount, getDupeCount,
  retryFailed, retryAllFailed, removeItem, clearFinished, clearAll,
} from '../importQueue'
import '../styles/import-queue.css'

/**
 * Floating import-queue dock. Always visible in the bottom-right
 * corner whenever the queue has items. Collapsed by default — shows a
 * compact summary pill ("Importing 3/27") with a click-to-expand
 * full panel underneath.
 *
 * The pattern mirrors macOS download managers: out of the way until
 * the user wants detail, retry-friendly when something fails, and
 * never silently drops files (which was the whole problem with the
 * single-IPC batch design).
 */
export default function ImportQueuePanel() {
  useSyncExternalStore(subscribe, getSnapshot)
  const queue = getQueueState()
  const [expanded, setExpanded] = useState(false)

  // When something fails, expand automatically so the user notices.
  useEffect(() => {
    if (getFailedCount() > 0) setExpanded(true)
    // Re-run when version bumps (fail count changes).
  }, [getSnapshot()])

  if (queue.items.length === 0) return null

  const active = getActiveItem()
  const pending = getPendingCount()
  const done = getDoneCount()
  const failed = getFailedCount()
  const dupes = getDupeCount()
  const total = queue.items.length

  return (
    <div className={`iq-dock ${expanded ? 'iq-dock--expanded' : ''}`}>
      <button
        className="iq-summary"
        onClick={() => setExpanded(e => !e)}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        <span className="iq-summary-icon">{pending > 0 ? '↓' : (failed > 0 ? '!' : '✓')}</span>
        <span className="iq-summary-text">
          {pending > 0
            ? `Importing ${done}/${total - dupes}${failed > 0 ? ` · ${failed} failed` : ''}`
            : failed > 0
              ? `${done} imported · ${failed} failed`
              : `Imported ${done}${dupes > 0 ? ` · ${dupes} duplicates skipped` : ''}`}
        </span>
        <span className="iq-summary-toggle">{expanded ? '▾' : '▴'}</span>
      </button>

      {expanded && (
        <div className="iq-body">
          {active && pending > 0 && (
            <div className="iq-current">
              <div className="iq-current-label">Now importing</div>
              <div className="iq-current-name" title={active.srcPath}>
                {basename(active.srcPath)}
              </div>
              <div className="iq-current-bar">
                <div
                  className="iq-current-bar-fill"
                  style={{ width: `${(done / Math.max(1, total - dupes)) * 100}%` }}
                />
              </div>
            </div>
          )}

          <QueueList />

          <div className="iq-actions">
            {failed > 0 && (
              <button className="iq-action iq-action--retry" onClick={retryAllFailed}>
                Retry {failed} failed
              </button>
            )}
            {(done > 0 || dupes > 0) && (
              <button className="iq-action" onClick={clearFinished}>
                Clear finished
              </button>
            )}
            {pending === 0 && (
              <button className="iq-action iq-action--close" onClick={clearAll}>
                Close
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function QueueList() {
  useSyncExternalStore(subscribe, getSnapshot)
  const queue = getQueueState()

  // Chunked render: showing 600 items in the DOM at once is slow, and
  // most of the time the user only cares about the top of the list.
  const ordered = useMemo(() => {
    // Active items first (running > pending), then failed, then dupes,
    // then done. Within each group, preserve insertion order.
    const rank: Record<string, number> = { running: 0, pending: 1, failed: 2, dupe: 3, done: 4 }
    return [...queue.items].sort((a, b) => {
      const r = rank[a.status] - rank[b.status]
      return r !== 0 ? r : a.addedAt - b.addedAt
    })
  }, [queue.items])

  const [showAll, setShowAll] = useState(false)
  const VISIBLE = 50
  const visible = showAll ? ordered : ordered.slice(0, VISIBLE)

  return (
    <div className="iq-list">
      {visible.map(it => (
        <div key={it.uid} className={`iq-item iq-item--${it.status}`}>
          <span className="iq-item-status" title={it.status}>
            {it.status === 'running' && <span className="iq-spinner" />}
            {it.status === 'pending' && '·'}
            {it.status === 'done' && '✓'}
            {it.status === 'dupe' && '⊝'}
            {it.status === 'failed' && '✕'}
          </span>
          <span className="iq-item-name" title={it.srcPath}>{basename(it.srcPath)}</span>
          {it.status === 'failed' && (
            <>
              <span className="iq-item-error" title={it.error}>{(it.error || '').slice(0, 60)}</span>
              <button className="iq-item-btn" onClick={() => retryFailed(it.uid)}>Retry</button>
            </>
          )}
          {it.status === 'dupe' && it.dupe && (
            <span className="iq-item-dupe">already in library</span>
          )}
          {(it.status === 'done' || it.status === 'failed' || it.status === 'dupe') && (
            <button className="iq-item-btn iq-item-btn--remove" onClick={() => removeItem(it.uid)} title="Remove">×</button>
          )}
        </div>
      ))}
      {!showAll && ordered.length > VISIBLE && (
        <button className="iq-show-all" onClick={() => setShowAll(true)}>
          Show all {ordered.length}
        </button>
      )}
    </div>
  )
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
