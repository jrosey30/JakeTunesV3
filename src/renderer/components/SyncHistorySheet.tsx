/**
 * Sync History (6.0 Phase 2b) — the ledgers, readable. Every Activity
 * Sync (what went on, what came off, what landed) and every Round Trip
 * (what the iPod brought home) in one newest-first timeline. Pure
 * presentation over get-sync-history; the ledgers stay the truth.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import '../styles/activity-sheet.css'

type Entry = Awaited<ReturnType<typeof window.electronAPI.getSyncHistory>>['entries'][number]

function whenLabel(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function SyncHistorySheet({ onClose }: { onClose: () => void }) {
  const { state } = useLibrary()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getSyncHistory()
      .then((r) => setEntries(r.ok ? r.entries : []))
      .catch(() => setEntries([]))
  }, [])

  const byId = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks])
  const nameOf = (x: { id: number; t?: string; a?: string }): string => {
    if (x.a || x.t) return `${x.a || '?'} — ${x.t || '?'}`
    const t = byId.get(x.id)
    return t ? `${t.artist || '?'} — ${t.title || '?'}` : `track ${x.id}`
  }

  return (
    <div className="activity-sheet-overlay" onClick={onClose}>
      <div className="activity-sheet sync-history-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="activity-sheet-title">Sync History</h2>
        <p className="activity-sheet-sub">
          Every sync&apos;s cargo — and every play the iPod brought home.
        </p>
        {entries === null && <div className="sh-empty">Reading the ledgers…</div>}
        {entries !== null && entries.length === 0 && (
          <div className="sh-empty">No syncs recorded yet.</div>
        )}
        <div className="sh-rows">
          {(entries || []).map((e) => {
            const key = `${e.kind}-${e.when}`
            const expanded = open === key
            if (e.kind === 'roundtrip') {
              const total = (e.plays || []).reduce((n, p) => n + p.delta, 0)
              return (
                <div key={key} className={`sh-row sh-row--trip${expanded ? ' is-open' : ''}`}>
                  <button type="button" className="sh-row-head" onClick={() => setOpen(expanded ? null : key)}>
                    <span className="sh-when">{whenLabel(e.when)}</span>
                    <span className="sh-what">Round Trip</span>
                    <span className="sh-badge sh-badge--trip">
                      {total} play{total === 1 ? '' : 's'} home
                    </span>
                  </button>
                  {expanded && (
                    <div className="sh-detail">
                      {(e.plays || []).map((p) => (
                        <div key={p.id} className="sh-line">
                          {nameOf({ id: p.id })}{p.delta > 1 ? ` ×${p.delta}` : ''}
                        </div>
                      ))}
                      {(e.otgLists ?? 0) > 0 && <div className="sh-line sh-line--dim">{e.otgLists} On-The-Go list(s)</div>}
                      {(e.unmatched ?? 0) > 0 && <div className="sh-line sh-line--dim">{e.unmatched} unmatched record(s)</div>}
                    </div>
                  )}
                </div>
              )
            }
            const good = !e.aborted && e.sealedOk && e.landed === e.target
            const badge = e.aborted
              ? 'did not finish'
              : good ? `${e.landed} of ${e.target} sealed` : `${e.landed ?? '?'} of ${e.target} landed`
            return (
              <div key={key} className={`sh-row${expanded ? ' is-open' : ''}`}>
                <button type="button" className="sh-row-head" onClick={() => setOpen(expanded ? null : key)}>
                  <span className="sh-when">{whenLabel(e.when)}</span>
                  <span className="sh-what">Activity Sync · {e.target ?? '?'} songs</span>
                  <span className={`sh-badge ${e.aborted ? 'sh-badge--bad' : good ? 'sh-badge--good' : 'sh-badge--warn'}`}>
                    {badge}
                  </span>
                </button>
                {expanded && (
                  <div className="sh-detail">
                    {(e.added || []).length > 0 && (
                      <>
                        <div className="sh-detail-head">Went on ({e.added!.length})</div>
                        {e.added!.slice(0, 40).map((x) => <div key={`a${x.id}`} className="sh-line">{nameOf(x)}</div>)}
                        {e.added!.length > 40 && <div className="sh-line sh-line--dim">…and {e.added!.length - 40} more</div>}
                      </>
                    )}
                    {(e.removed || []).length > 0 && (
                      <>
                        <div className="sh-detail-head">Came off ({e.removed!.length})</div>
                        {e.removed!.slice(0, 40).map((x) => <div key={`r${x.id}`} className="sh-line sh-line--off">{nameOf(x)}</div>)}
                        {e.removed!.length > 40 && <div className="sh-line sh-line--dim">…and {e.removed!.length - 40} more</div>}
                      </>
                    )}
                    {(e.added || []).length === 0 && (e.removed || []).length === 0 && (
                      <div className="sh-line sh-line--dim">Same set as the sync before.</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
