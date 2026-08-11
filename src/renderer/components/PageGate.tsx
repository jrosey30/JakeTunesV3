/**
 * PageGate v4 — what you see while a page is still fetching.
 *
 * Jake, 2026-08-09: the loading pages "are unacceptable right now. they
 * appear too often too."
 *
 * Both halves are fixed, in different places. TOO OFTEN was structural and
 * lives in homeCache.ts — Home threw away six fetch results every time you
 * navigated away, so it re-gated on every visit. With the cache, a return
 * visit never mounts this component at all.
 *
 * UNACCEPTABLE was this file. v2 and v3 drew a wireframe of the incoming
 * page: grey rounded blobs for a photo, five card placeholders, six list
 * rows, all shimmering. The theory was that a ghost of the layout makes
 * content "replace it in place". In practice a screen of grey rectangles
 * reads as a BROKEN page, not a loading one — and it lies, because the
 * ghost's shape rarely matches what actually arrives (five cards when three
 * come back, a round photo where there's no photo).
 *
 * v4 shows only what is TRUE while waiting: where you are, that something is
 * happening, and nothing else. The real title in its real position, a line of
 * status, and a hairline indeterminate bar. No fake cards, no fake artwork,
 * no shimmer. It can't mismatch the incoming page because it isn't pretending
 * to be it.
 *
 * Nothing at all renders for the first 450ms (was 280ms) — anything quicker
 * than that is better as a beat of stillness than as a flash of chrome.
 */
import { useEffect, useState } from 'react'

interface PageGateProps {
  title?: string
  note?: string
  /** Kept for call-site compatibility; v4 renders the same either way. */
  layout?: 'grid' | 'hero' | 'list'
}

/** Below this, a load is better felt than shown. */
const GATE_DELAY_MS = 450

export default function PageGate({ title, note }: PageGateProps) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), GATE_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return null
  return (
    <div className="page-gate page-gate--v4" role="status" aria-label="Loading">
      <div className="pg4-inner">
        {title && <div className="pg4-title">{title}</div>}
        {note && <div className="pg4-note">{note}</div>}
        <div className="pg4-bar" aria-hidden="true"><span /></div>
      </div>
    </div>
  )
}
