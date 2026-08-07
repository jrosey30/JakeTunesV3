/**
 * PageGate v3 — the loading treatment for whole pages.
 *
 * v2 lesson (Jake, 2026-08-07: "THIS JUST looks so awkward"): a CENTERED
 * title block floating above LEFT-aligned skeleton blobs reads as two
 * layouts fighting. The gate must be a ghost of the INCOMING page — the
 * real title sitting exactly where the page will put it (left, in the
 * hero, beside the photo/cover placeholder), every block on the page's
 * own grid — so the content replaces it in place instead of the whole
 * screen rearranging.
 *
 * Renders NOTHING for the first 280ms: warm loads never show a loading
 * page at all ("only when absolutely necessary").
 *
 * Layouts: 'grid' (artist — round photo + album card row), 'hero'
 * (album — square cover + tracklist rows), 'list' (list pages).
 */
import { useEffect, useState } from 'react'

interface PageGateProps {
  title?: string
  note?: string
  layout?: 'grid' | 'hero' | 'list'
}

const GATE_DELAY_MS = 280

export default function PageGate({ title, note, layout = 'grid' }: PageGateProps) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), GATE_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return null
  return (
    <div className={`page-gate page-gate--v3 page-gate--${layout}`} role="status" aria-label="Loading">
      {layout !== 'list' && (
        <div className="pg-hero">
          <div className={`pg-photo pg-shimmer${layout === 'grid' ? ' pg-photo--round' : ''}`} />
          <div className="pg-hero-text">
            {title && <div className="page-gate-name">{title}</div>}
            <div className="pg-sub">
              <span className="page-gate-eq" aria-hidden="true"><span /><span /><span /><span /><span /></span>
              {note && <span className="page-gate-note">{note}</span>}
            </div>
            <div className="pg-line pg-line--thin pg-shimmer" style={{ width: 180 }} />
          </div>
        </div>
      )}
      {layout === 'list' && (
        <div className="pg-list-head">
          {title && <div className="page-gate-name">{title}</div>}
          <div className="pg-sub">
            <span className="page-gate-eq" aria-hidden="true"><span /><span /><span /><span /><span /></span>
            {note && <span className="page-gate-note">{note}</span>}
          </div>
        </div>
      )}
      <div className="pg-section pg-shimmer" aria-hidden="true" />
      {layout === 'grid' && (
        <div className="pg-row" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="pg-card" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="pg-card-art pg-shimmer" />
              <div className="pg-line pg-line--thin pg-shimmer" style={{ width: '78%' }} />
              <div className="pg-line pg-line--thin pg-shimmer" style={{ width: '46%' }} />
            </div>
          ))}
        </div>
      )}
      {layout !== 'grid' && (
        <div className="pg-list" aria-hidden="true">
          {Array.from({ length: layout === 'list' ? 6 : 5 }, (_, i) => (
            <div key={i} className="pg-listrow" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="pg-dot pg-shimmer" />
              <div className="pg-line pg-shimmer" style={{ width: `${72 - i * 6}%` }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
