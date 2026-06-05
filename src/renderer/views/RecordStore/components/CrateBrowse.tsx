// CrateBrowse — tactile crate-digging. The shelf's real covers fan out
// like records leaned in a bin; flip through with ‹ ›, the arrow keys, or
// by clicking a leaning cover. The front (centered) cover is clickable to
// play — which also makes Music Man pop in with his take.

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Shelf, ShelfItem } from '../types'

const MAX_VISIBLE = 4 // covers fanned to each side before they fade out

export function CrateBrowse({
  shelf,
  coverSrc,
  onPlay,
  onBack,
  selectedId,
}: {
  shelf: Shelf
  coverSrc: (item: ShelfItem) => string | null
  onPlay: (item: ShelfItem) => void
  onBack: () => void
  selectedId: string | null
}) {
  const items = shelf.items
  const [idx, setIdx] = useState(0)

  // Reset to the front of the crate when you switch shelves.
  useEffect(() => { setIdx(0) }, [shelf.id])

  const go = useCallback(
    (delta: number) => setIdx((i) => Math.max(0, Math.min(items.length - 1, i + delta))),
    [items.length],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onBack])

  const current: ShelfItem | undefined = items[idx]

  return (
    <div className="crate">
      <div className="crate__head">
        <button className="crate__back" onClick={onBack}>← back to the shop</button>
        <div className="crate__heading">
          <h2 className="crate__title">{shelf.title}</h2>
          <p className="crate__tagline">{shelf.tagline}</p>
        </div>
      </div>

      <div className="crate__stage">
        <button className="crate__nav" onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous record">‹</button>

        <div className="crate__fan">
          {items.map((item, i) => {
            const off = i - idx
            const depth = Math.min(Math.abs(off), MAX_VISIBLE + 1)
            const cover = coverSrc(item)
            const active = i === idx
            const style: CSSProperties = {
              transform: `translateX(${off * 66}px) translateZ(${-depth * 52}px) rotateY(${off * -7}deg) scale(${1 - depth * 0.07})`,
              zIndex: 100 - depth,
              opacity: depth > MAX_VISIBLE ? 0 : 1 - depth * 0.14,
              pointerEvents: depth > MAX_VISIBLE ? 'none' : 'auto',
            }
            return (
              <button
                key={item.id}
                type="button"
                className={`crate__card${active ? ' crate__card--active' : ''}${selectedId === item.id ? ' crate__card--playing' : ''}`}
                style={style}
                onClick={() => (active ? onPlay(item) : setIdx(i))}
                title={active ? `Play ${item.title}` : item.title}
              >
                {cover ? (
                  <img src={cover} alt={item.title} className="crate__cover" />
                ) : (
                  <span className="crate__blank">{item.title}</span>
                )}
              </button>
            )
          })}
        </div>

        <button className="crate__nav" onClick={() => go(1)} disabled={idx === items.length - 1} aria-label="Next record">›</button>
      </div>

      {current && (
        <div className="crate__plate">
          <p className="crate__plate-title">{current.title}</p>
          <p className="crate__plate-sub">{current.subtitle}</p>
          <p className="crate__plate-placement">{current.placement}</p>
          <span className="crate__counter">{idx + 1} / {items.length}</span>
        </div>
      )}
    </div>
  )
}
