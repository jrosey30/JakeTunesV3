/**
 * Row windowing for the album-tile grids (Albums, and Grid mode in Songs /
 * playlists) — the pure half, unit-tested; components/AlbumGrid.tsx measures
 * the DOM and renders the slice.
 *
 * 2026-10-21 (Jake: "scrolling in artists and albums on desktop sucks ass").
 * Measured on the installed app with his library: Albums kept all 2,579 cards
 * mounted, and every scrolled frame paid for all of them — native lazy-loading
 * intersection checks over 2,579 images, compositing-inputs/pre-paint walks,
 * commit, hover hit-tests, and a grid relayout every time a cover arrived. Main
 * frame ≈14 ms against an 8.3 ms (120 Hz) budget: 55–82 fps, 14–27 frames a
 * second over 16.7 ms. Songs, virtualized, holds 120. Only the rows near the
 * viewport are in the DOM now; spacers keep the scroll height exact.
 *
 * The grid's CSS stays the source of truth: the column count is read from the
 * resolved grid-template-columns and the row stride from two rendered rows, so
 * a window resize or a CSS change can't desync the math.
 */

export interface GridGeometry {
  cols: number
  /** Distance from one row's top to the next row's top (card height + row gap). */
  rowStride: number
  /** The first row's top, in the scroller's scroll coordinates (window padding excluded). */
  gridTop: number
  /** The scroller's visible height. */
  viewportH: number
}

export interface GridWindow {
  rows: number
  startRow: number
  /** Exclusive. */
  endRow: number
  startIndex: number
  /** Exclusive. */
  endIndex: number
  /** Spacer above the rendered rows (px). */
  padTop: number
  /** Spacer below the rendered rows (px). */
  padBottom: number
}

/** Rows that intersect the viewport at `scrollTop` (last inclusive). `first > last` = none. */
export function visibleRows(geo: GridGeometry, scrollTop: number, rows: number): { first: number; last: number } {
  if (rows <= 0) return { first: 0, last: -1 }
  const top = scrollTop - geo.gridTop
  const bottom = top + geo.viewportH
  if (bottom <= 0) return { first: 0, last: -1 }               // grid entirely below the viewport
  const first = Math.max(0, Math.floor(top / geo.rowStride))
  const last = Math.min(rows - 1, Math.floor((bottom - 1) / geo.rowStride))
  return { first, last }
}

/** Overscan: one viewport of rows each side (at least 2), so a fast flick lands on rendered rows. */
export function overscanRows(geo: GridGeometry): number {
  return Math.max(2, Math.ceil(geo.viewportH / geo.rowStride))
}

export function computeGridWindow(itemCount: number, geo: GridGeometry | null, scrollTop: number, unmeasuredCount = 60): GridWindow {
  const n = Math.max(0, itemCount)
  if (!geo || geo.cols < 1 || !(geo.rowStride > 0)) {
    // Not measured yet: render a first slice so there is something to measure.
    const endIndex = Math.min(n, unmeasuredCount)
    return { rows: 0, startRow: 0, endRow: 0, startIndex: 0, endIndex, padTop: 0, padBottom: 0 }
  }
  const rows = Math.ceil(n / geo.cols)
  const over = overscanRows(geo)
  const { first, last } = visibleRows(geo, scrollTop, rows)
  let startRow: number, endRow: number
  if (first > last) {
    // Nothing visible: the grid is below the fold (or past the end) — render its first rows.
    startRow = 0
    endRow = Math.min(rows, over + 1)
    if (scrollTop - geo.gridTop > 0 && rows > 0) {            // past the end: the last rows
      endRow = rows
      startRow = Math.max(0, rows - over - 1)
    }
  } else {
    startRow = Math.max(0, first - over)
    endRow = Math.min(rows, last + 1 + over)
  }
  return {
    rows,
    startRow,
    endRow,
    startIndex: startRow * geo.cols,
    endIndex: Math.min(n, endRow * geo.cols),
    padTop: startRow * geo.rowStride,
    padBottom: (rows - endRow) * geo.rowStride,
  }
}

/** True when every row visible at `scrollTop` is inside the rendered window — painting now shows no hole. */
export function windowCovers(win: GridWindow, geo: GridGeometry, scrollTop: number): boolean {
  const { first, last } = visibleRows(geo, scrollTop, win.rows)
  if (first > last) return true
  return first >= win.startRow && last < win.endRow
}

export function sameWindow(a: GridWindow, b: GridWindow): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.padTop === b.padTop && a.padBottom === b.padBottom
}

export function sameGeometry(a: GridGeometry | null, b: GridGeometry | null): boolean {
  if (!a || !b) return a === b
  return a.cols === b.cols && Math.abs(a.rowStride - b.rowStride) < 0.5 && Math.abs(a.gridTop - b.gridTop) < 0.5 && Math.abs(a.viewportH - b.viewportH) < 0.5
}

/**
 * The scrollTop that brings item `index` into view. 'center' centres its row;
 * 'nearest' moves only if the row isn't fully visible (null = already visible).
 */
export function scrollTopForIndex(geo: GridGeometry, index: number, block: 'center' | 'nearest' | 'start', scrollTop: number): number | null {
  const row = Math.floor(Math.max(0, index) / geo.cols)
  const rowTop = geo.gridTop + row * geo.rowStride
  const rowBottom = rowTop + geo.rowStride
  if (block === 'start') return Math.max(0, rowTop)
  if (block === 'center') return Math.max(0, rowTop - (geo.viewportH - geo.rowStride) / 2)
  if (rowTop < scrollTop) return Math.max(0, rowTop)
  if (rowBottom > scrollTop + geo.viewportH) return Math.max(0, rowBottom - geo.viewportH)
  return null
}
