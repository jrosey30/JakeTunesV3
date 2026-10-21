/**
 * The album-tile wall, windowed (2026-10-21) — shared by AlbumsView and
 * TrackGridView (Grid mode in Songs / playlists), one visual language as before
 * (same albums.css classes, same card markup).
 *
 * Why (measured on the installed app, Jake's 2,579 albums):
 *  - All 2,579 cards were mounted: every scrolled frame paid for all of them
 *    (lazy-load intersection checks, pre-paint, commit, hover hit-tests, a grid
 *    relayout per arriving cover) — 55–82 fps on a 120 Hz screen.
 *  - The view re-rendered every card on every playback-position tick (10 Hz
 *    while music plays): 33 ms median per tick, a 3–6-frame hitch ten times a
 *    second under the scroll.
 * Now only the rows near the viewport are mounted (utils/gridWindow.ts has the
 * math + tests), and cards are memoized on stable props, so a tick re-renders
 * nothing here.
 *
 * Invariants kept from the virtualizer lessons (2026-07-08):
 *  - the first render already windows at the restored position (geometry is
 *    cached per grid for the session; `initialScrollTop` seeds the position);
 *  - every scroll event — real or the restore's synthetic one — recomputes from
 *    the LIVE scrollTop, never from a cached value;
 *  - the ResizeObserver follows the CURRENT scroller element across remounts;
 *  - a scroll that would paint an unrendered row updates the window
 *    synchronously (flushSync), so no frame ever shows a hole.
 */
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import AlbumArtImage from './AlbumArtImage'
import type { Album } from '../utils/albumGroups'
import type { Track } from '../types'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { computeGridWindow, windowCovers, sameWindow, sameGeometry, scrollTopForIndex, type GridGeometry } from '../utils/gridWindow'

export interface AlbumGridItem {
  key: string
  album: Album
  artHash?: string
  /** Running order — the drag payload and what ▶ Album plays. */
  ordered: Track[]
  /** Album Mode gate: a verifiably complete record shows the ▶ Album button. */
  fullAlbum?: boolean
}

export interface AlbumGridHandle {
  /** Bring item `index` into view; `onCard` gets its card once it is rendered. */
  reveal: (index: number, block: 'center' | 'nearest' | 'start', onCard?: (el: HTMLElement) => void) => void
}

interface CardHandlers {
  onOpen: (key: string) => void
  onContextMenu: (e: React.MouseEvent, album: Album) => void
  /** Albums only: the ▶ Album button on complete records. */
  onPlayAlbum?: (ordered: Track[]) => void
  /** Grid mode: double-click plays the album. */
  onDoubleClick?: (album: Album) => void
  /** Albums: drag a whole album onto a playlist. */
  draggable?: boolean
}

interface AlbumGridProps extends CardHandlers {
  items: AlbumGridItem[]
  /** The element that scrolls (the view root). */
  scrollRef: React.RefObject<HTMLElement>
  /** Names this grid's cached geometry (one per view). */
  geometryKey: string
  /** The position useScrollPersistence will restore — the first render windows there. */
  initialScrollTop?: number
}

const DiscGlyph = (): JSX.Element => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="#bbb">
    <circle cx="16" cy="16" r="14" fill="none" stroke="#bbb" strokeWidth="1" />
    <circle cx="16" cy="16" r="5" fill="none" stroke="#bbb" strokeWidth="1" />
    <circle cx="16" cy="16" r="1.5" fill="#bbb" />
  </svg>
)

const AlbumGridCard = memo(function AlbumGridCard({ item, onOpen, onContextMenu, onPlayAlbum, onDoubleClick, draggable }: CardHandlers & { item: AlbumGridItem }) {
  const { key, album, artHash, ordered, fullAlbum } = item
  return (
    <div
      className="album-card"
      data-album-key={key}
      onClick={() => onOpen(key)}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(album) : undefined}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, album) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(key) } }}
      role="button"
      tabIndex={0}
      draggable={draggable || undefined}
      // In running order, not the grouping order, so a playlist reads the way the record does.
      onDragStart={draggable ? (e) => setAlbumDragPayload(e, ordered.map((t) => t.id)) : undefined}
    >
      <div className="album-card-art">
        {fullAlbum && onPlayAlbum && (
          <button
            type="button"
            className="album-play-full"
            title={`Play ${album.name} — front to back, in order, gapless`}
            onClick={(e) => { e.stopPropagation(); onPlayAlbum(ordered) }}
          >▶ Album</button>
        )}
        {artHash ? <AlbumArtImage hash={artHash} alt={album.name} className="album-card-img" size={320} /> : <DiscGlyph />}
      </div>
      <div className="album-card-title">{album.name}</div>
      <div className="album-card-artist">{album.artist}</div>
    </div>
  )
})

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if (oy === 'auto' || oy === 'scroll') return n
  }
  return null
}

/** Geometry per grid for the session: a remount windows correctly on its first render. */
const geometryCache = new Map<string, GridGeometry>()

interface ViewState { geo: GridGeometry | null; st: number }

const AlbumGrid = forwardRef<AlbumGridHandle, AlbumGridProps>(function AlbumGrid(
  { items, scrollRef, geometryKey, initialScrollTop = 0, onOpen, onContextMenu, onPlayAlbum, onDoubleClick, draggable },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<ViewState>(() => ({ geo: geometryCache.get(geometryKey) ?? null, st: initialScrollTop }))
  const win = computeGridWindow(items.length, view.geo, view.st)

  // Live mirrors for the native listeners.
  const viewRef = useRef(view); viewRef.current = view
  const winRef = useRef(win); winRef.current = win
  const itemsRef = useRef(items); itemsRef.current = items
  // True from this grid's layout effects until its passive effects: a parent's
  // layout effect (useScrollPersistence's restore) dispatches 'scroll' in that
  // gap, inside React's commit, where flushSync can't run — a plain update is
  // flushed before paint there anyway.
  const committingRef = useRef(false)

  // The scroller, resolved from the DOM when the caller's ref isn't attached
  // yet: React runs this grid's layout effects BEFORE it attaches an
  // ancestor's ref, so on mount scrollRef.current is still null — binding to it
  // silently bound nothing, and the window never followed the scroll until
  // some unrelated re-render (caught in the harness: 0 of 35 cards visible at
  // 48,000 px). The wrapper is ours, so it is attached by then.
  const getScroller = useCallback((): HTMLElement | null => scrollRef.current ?? scrollParent(wrapRef.current), [scrollRef])

  const readGeometry = useCallback((): GridGeometry | null => {
    const sc = getScroller(), grid = gridRef.current, wrap = wrapRef.current
    if (!sc || !grid || !wrap) return null
    const first = grid.firstElementChild as HTMLElement | null
    if (!first) return viewRef.current.geo
    const cs = getComputedStyle(grid)
    const cols = Math.max(1, cs.gridTemplateColumns.split(' ').filter((t) => t && t !== 'none').length)
    const below = grid.children[cols] as HTMLElement | undefined
    const rowStride = below ? below.offsetTop - first.offsetTop : first.offsetHeight + (parseFloat(cs.rowGap) || 0)
    if (!(rowStride > 0)) return viewRef.current.geo
    const scTop = sc.getBoundingClientRect().top + sc.clientTop
    const gridTop = wrap.getBoundingClientRect().top - scTop + sc.scrollTop + (parseFloat(cs.paddingTop) || 0)
    return { cols, rowStride, gridTop, viewportH: sc.clientHeight }
  }, [getScroller])

  /** Recompute from the live DOM; update (synchronously if a hole would paint). */
  const sync = useCallback((allowFlush: boolean) => {
    const sc = getScroller()
    if (!sc) return
    const prev = viewRef.current
    const measured = readGeometry()
    const geo = measured && !sameGeometry(measured, prev.geo) ? measured : prev.geo
    const st = sc.scrollTop
    const next = computeGridWindow(itemsRef.current.length, geo, st)
    if (geo === prev.geo && sameWindow(next, winRef.current)) return
    if (geo) geometryCache.set(geometryKey, geo)
    const apply = (): void => setView({ geo, st })
    const hole = !!geo && !windowCovers(winRef.current, geo, st)
    if (hole && allowFlush && !committingRef.current) flushSync(apply)
    else apply()
  }, [getScroller, readGeometry, geometryKey])

  // After every render of this grid: measure what was just laid out (the first
  // render's slice, a new column count, content above the grid that moved).
  useLayoutEffect(() => {
    committingRef.current = true
    sync(false)
  })
  useEffect(() => { committingRef.current = false })

  // Scroll + resize, bound to the CURRENT scroller (identity-checked every
  // render — an observer bound once is a latent half-blank, 2026-07-08).
  const boundRef = useRef<HTMLElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const onScrollRef = useRef<() => void>(() => {})
  onScrollRef.current = () => sync(true)
  const handlerRef = useRef<(() => void) | null>(null)
  if (!handlerRef.current) handlerRef.current = () => onScrollRef.current()
  useLayoutEffect(() => {
    const sc = getScroller()
    if (sc === boundRef.current) return
    const handler = handlerRef.current!
    if (boundRef.current) {
      boundRef.current.removeEventListener('scroll', handler)
      roRef.current?.unobserve(boundRef.current)
    }
    boundRef.current = sc
    if (!sc) return
    sc.addEventListener('scroll', handler, { passive: true })
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        if (entries.some((e) => e.target === boundRef.current)) onScrollRef.current()
      })
    }
    roRef.current.observe(sc)
  }) // no dep array: the identity check makes re-runs free and catches scroller swaps
  useEffect(() => () => {
    if (boundRef.current && handlerRef.current) boundRef.current.removeEventListener('scroll', handlerRef.current)
    roRef.current?.disconnect()
    boundRef.current = null
  }, [])

  // reveal(): index-based, because the card may not be mounted yet.
  const pendingRevealRef = useRef<{ key: string; cb: (el: HTMLElement) => void } | null>(null)
  useLayoutEffect(() => {
    const p = pendingRevealRef.current
    if (!p) return
    const el = gridRef.current?.querySelector(`[data-album-key="${CSS.escape(p.key)}"]`) as HTMLElement | null
    if (el) { pendingRevealRef.current = null; p.cb(el) }
  })
  useImperativeHandle(ref, () => ({
    reveal(index, block, onCard) {
      const sc = getScroller()
      const item = itemsRef.current[index]
      const geo = readGeometry() ?? viewRef.current.geo
      if (!sc || !item || !geo) return
      const target = scrollTopForIndex(geo, index, block, sc.scrollTop)
      if (target !== null) sc.scrollTop = target
      // Let every scroll listener (persistence, this grid) see the move.
      sc.dispatchEvent(new Event('scroll'))
      if (!onCard) return
      const el = gridRef.current?.querySelector(`[data-album-key="${CSS.escape(item.key)}"]`) as HTMLElement | null
      if (el) onCard(el)
      else pendingRevealRef.current = { key: item.key, cb: onCard }
    },
  }), [getScroller, readGeometry])

  return (
    <div ref={wrapRef} className="album-grid-window" style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
      <div ref={gridRef} className="albums-grid">
        {items.slice(win.startIndex, win.endIndex).map((item) => (
          <AlbumGridCard
            key={item.key}
            item={item}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            onPlayAlbum={onPlayAlbum}
            onDoubleClick={onDoubleClick}
            draggable={draggable}
          />
        ))}
      </div>
    </div>
  )
})

export default memo(AlbumGrid)
