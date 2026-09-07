/**
 * Compare editions — read-only (slice 1 of the near-edition recovery,
 * approved 2026-09-06). Lays the edition Jake picked beside the nearest
 * edition the judge refused, one row per track with the judge's own verdict,
 * exact counts, and the differing runtimes — and states, before any click,
 * exactly what each acquisition choice would take and how it would be
 * recorded. This sheet acquires NOTHING: it never imports the queue; the
 * two acquisition choices are shown but not wired until their own slice.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CompareEditionsResult } from '../../common/near-edition-types'
import { planMatchingTrackGets, type MatchingTrackPlan } from '../../common/near-edition-actions'
import '../styles/activity-sheet.css'
import '../styles/compare-editions.css'

export interface CompareEditionsSubject {
  /** The refused album job's queue key — the group the matching-track Gets hang off. */
  parentKey: string
  sourceKind?: string
  sourceLabel?: string
  artist: string
  album: string
  collectionId?: number
  trackCount?: number
  releaseYear?: number
  candidate: { provider: string; desc: string; url?: string; tracks?: Array<{ title: string; trackNumber?: number; discNumber?: number; durationSec?: number | null }>; releaseYear?: number }
}

const fmt = (s: number | null | undefined): string => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`

export default function CompareEditionsSheet({ subject, onClose, onPasteLink, onGetMatching }: { subject: CompareEditionsSubject; onClose: () => void; onPasteLink: () => void; onGetMatching?: (plan: MatchingTrackPlan) => void }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: CompareEditionsResult | null }>({ loading: true, error: null, data: null })
  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI.nearEdition
    if (!api) { setState({ loading: false, error: 'not-available', data: null }); return }
    api.compare({ artist: subject.artist, album: subject.album, collectionId: subject.collectionId, trackCount: subject.trackCount, releaseYear: subject.releaseYear, candidate: subject.candidate })
      .then((r) => { if (cancelled) return; if (r.ok) setState({ loading: false, error: null, data: r }); else setState({ loading: false, error: r.error, data: null }) })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: String(e), data: null }) })
    return () => { cancelled = true }
  }, [subject])
  const d = state.data
  // Action A: the plan is computed here (pure); the ENQUEUE happens in the
  // panel that owns the queue — this sheet stays free of it, so opening it
  // can never acquire anything.
  const plan = d ? planMatchingTrackGets(d, { parentKey: subject.parentKey, artist: subject.artist, album: subject.album, releaseYear: subject.releaseYear, sourceKind: subject.sourceKind, sourceLabel: subject.sourceLabel }) : null
  const [pressed, setPressed] = useState(false)
  // Portal to the body: the Downloads panel animates with a transform, which
  // would otherwise make this fixed overlay its captive.
  return createPortal(
    <div className="activity-sheet-overlay" onClick={onClose}>
      <div className="activity-sheet compare-sheet" role="dialog" aria-label="Compare editions" onClick={(e) => e.stopPropagation()}>
        <h2 className="activity-sheet-title">Compare editions</h2>
        <p className="activity-sheet-sub">{subject.album} — {subject.artist}</p>
        {state.loading && <div className="sh-empty">Reading both tracklists…</div>}
        {state.error && <div className="sh-empty">Couldn’t compare: {state.error === 'picked-tracklist-unavailable' ? 'the edition you picked has no tracklist to check against.' : state.error === 'found-tracklist-unavailable' ? 'the found edition has no tracklist to check against.' : state.error}</div>}
        {d && (
          <>
            <div className="cmp-editions">
              <div className="cmp-edition"><span className="cmp-edition-k">Edition you picked</span><span className="cmp-edition-v">{d.picked.label} · {d.picked.trackCount} tracks{d.picked.releaseYear ? ` · ${d.picked.releaseYear}` : ''}</span></div>
              <div className="cmp-edition"><span className="cmp-edition-k">Nearest found</span><span className="cmp-edition-v">{d.found.label} · {d.found.trackCount} tracks{d.found.releaseYear ? ` · ${d.found.releaseYear}` : ''}<span className="cmp-edition-src">{d.found.source}</span></span></div>
            </div>
            <table className="cmp-table">
              <thead><tr><th>#</th><th>Track</th><th className="num">Picked</th><th className="num">Found</th><th>Judge</th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.n} className={`cmp-row cmp-row--${r.verdict}`}>
                    <td>{r.n}</td>
                    <td className="cmp-title">{r.wantTitle}{r.gotTitle && r.gotTitle !== r.wantTitle ? <span className="cmp-alt-title">found as “{r.gotTitle}”</span> : null}</td>
                    <td className="num">{fmt(r.wantSec)}</td>
                    <td className="num">{fmt(r.gotSec)}</td>
                    <td className="cmp-verdict">{r.verdict === 'exact' ? '✓ exact' : r.verdict === 'mismatch' ? `✕ ${r.reason}` : `? ${r.reason}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cmp-counts">
              <strong>{d.summary.exact} of {d.summary.total}</strong> match the edition you picked to within {d.toleranceSec} s
              {d.summary.mismatch ? <> · <strong>{d.summary.mismatch}</strong> {d.summary.mismatch === 1 ? 'differs' : 'differ'}</> : null}
              {d.summary.unknown ? <> · <strong>{d.summary.unknown}</strong> unknown</> : null}
              {d.summary.differing.length > 0 && (
                <ul className="cmp-differing">
                  {d.summary.differing.map((x) => <li key={x.n}>Track {x.n} “{x.title}”: {x.reason}</li>)}
                </ul>
              )}
            </div>
            <div className="cmp-actions">
              <div className="cmp-action">
                <button
                  type="button"
                  className="activity-btn"
                  disabled={!plan || plan.jobs.length === 0 || !onGetMatching || pressed}
                  title={plan && plan.jobs.length === 0 ? 'Every matching track is already in your library' : 'Queue the matching tracks as song downloads'}
                  onClick={() => { if (!plan || !onGetMatching || pressed) return; setPressed(true); onGetMatching(plan) }}
                >{pressed ? 'Queued' : plan && plan.jobs.length === 0 ? 'Nothing to get — all matching tracks are yours' : `Get the ${plan ? plan.jobs.length : d.summary.exact} matching track${(plan ? plan.jobs.length : d.summary.exact) === 1 ? '' : 's'}`}</button>
                <p>{d.summary.matchingSentence}{plan && plan.skippedOwned.length ? ` Skipped as already yours: ${plan.skippedOwned.map((r) => `${r.n} “${r.wantTitle}”`).join(', ')}.` : ''}</p>
              </div>
              <div className="cmp-action">
                <button type="button" className="activity-btn" disabled title="Not wired yet — this slice is read-only">Get the {d.found.label}</button>
                <p>{d.summary.editionSentence}</p>
              </div>
              <div className="cmp-action cmp-action--quiet">
                <button type="button" className="activity-btn activity-btn--ghost" onClick={onPasteLink}>Paste a link to the exact edition</button>
                <p>Opens Record Shop → Browse with Add by link. Nothing is acquired until you paste one and press Download.</p>
              </div>
            </div>
            <p className="cmp-note">Opening this sheet acquired nothing. Only the button you press queues downloads; the Bandcamp edition button is not wired yet.</p>
          </>
        )}
        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
