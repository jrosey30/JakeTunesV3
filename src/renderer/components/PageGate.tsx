/**
 * PageGate v2 — the loading treatment for whole pages (2026-08-07, Jake:
 * "can we make these loading pages way way way less boring and way better?").
 *
 * The old gate was a name and a lonely 3px bar on an empty cream void. This
 * one shows the SHAPE of the page that's coming — a shimmering skeleton of
 * the hero + card row + text lines — under the title and a small live
 * equalizer in brand orange. The page reads as "assembling", not "stalled".
 *
 * Layouts: 'grid' (artist/discover — card row leads), 'hero' (album — big
 * cover + lines lead), 'list' (list-shaped pages). All-SVG/CSS, no emoji,
 * warm register only — same rules as everything else in the shell.
 */

import { useEffect, useState } from 'react'

interface PageGateProps {
  title?: string
  note?: string
  layout?: 'grid' | 'hero' | 'list'
}

/** Render NOTHING for the first 280ms — a warm load resolves inside that
 *  window and the user never sees a loading page at all (2026-08-07, Jake:
 *  "doesnt need to be on every click. its annoying. only when absolutely
 *  necessary"). Only a genuinely cold load earns the skeleton. */
const GATE_DELAY_MS = 280

export default function PageGate({ title, note, layout = 'grid' }: PageGateProps) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), GATE_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return null
  return (
    <div className="page-gate page-gate--v2" role="status" aria-label="Loading">
      {title && <div className="page-gate-name">{title}</div>}
      <div className="page-gate-eq" aria-hidden="true">
        <span /><span /><span /><span /><span />
      </div>
      {note && <div className="page-gate-note">{note}</div>}
      <div className={`page-gate-skeleton page-gate-skeleton--${layout}`} aria-hidden="true">
        {layout === 'hero' && (
          <div className="pg-hero">
            <div className="pg-cover pg-shimmer" />
            <div className="pg-hero-lines">
              <div className="pg-line pg-shimmer" style={{ width: '56%' }} />
              <div className="pg-line pg-shimmer" style={{ width: '34%' }} />
              <div className="pg-line pg-line--thin pg-shimmer" style={{ width: '44%' }} />
            </div>
          </div>
        )}
        {layout !== 'list' && (
          <div className="pg-row">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="pg-card" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="pg-card-art pg-shimmer" />
                <div className="pg-line pg-line--thin pg-shimmer" style={{ width: '80%' }} />
                <div className="pg-line pg-line--thin pg-shimmer" style={{ width: '55%' }} />
              </div>
            ))}
          </div>
        )}
        <div className="pg-list">
          {Array.from({ length: layout === 'list' ? 6 : 3 }, (_, i) => (
            <div key={i} className="pg-listrow" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="pg-dot pg-shimmer" />
              <div className="pg-line pg-shimmer" style={{ width: `${76 - i * 7}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
