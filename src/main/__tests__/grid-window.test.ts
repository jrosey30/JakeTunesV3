import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeGridWindow, visibleRows, windowCovers, scrollTopForIndex, overscanRows, sameWindow, sameGeometry,
  type GridGeometry,
} from '../../renderer/utils/gridWindow.ts'

// Jake's Albums grid at his window size: 7 columns, ~214 px rows, the grid
// starting under the toolbar + Island shelf, a 660 px viewport, 2,579 albums.
const G: GridGeometry = { cols: 7, rowStride: 214, gridTop: 300, viewportH: 660 }
const N = 2579

describe('gridWindow — the rendered slice', () => {
  it('unmeasured: renders a first slice to measure, no spacers', () => {
    const w = computeGridWindow(N, null, 0, 60)
    assert.equal(w.startIndex, 0)
    assert.equal(w.endIndex, 60)
    assert.equal(w.padTop, 0)
    assert.equal(w.padBottom, 0)
    assert.equal(computeGridWindow(10, null, 0, 60).endIndex, 10)
  })

  it('spacers + rendered rows always add up to the full grid height (scroll height exact)', () => {
    const rows = Math.ceil(N / G.cols)
    for (const st of [0, 150, 299, 300, 5_000, 24_000, 54_000, rows * G.rowStride + 300, 999_999]) {
      const w = computeGridWindow(N, G, st)
      assert.equal(w.padTop + (w.endRow - w.startRow) * G.rowStride + w.padBottom, rows * G.rowStride, `at ${st}`)
      assert.equal(w.startIndex % G.cols, 0, 'a window starts on a row boundary (columns stay aligned)')
      assert.ok(w.endIndex <= N && w.startIndex <= w.endIndex)
    }
  })

  it('every visible row is rendered, at every scroll position (no blank hole)', () => {
    const rows = Math.ceil(N / G.cols)
    const max = G.gridTop + rows * G.rowStride - G.viewportH
    for (let st = 0; st <= max; st += 97) {
      const w = computeGridWindow(N, G, st)
      assert.ok(windowCovers(w, G, st), `hole at scrollTop ${st}`)
    }
  })

  it('renders about three screens of cards, not 2,579', () => {
    const w = computeGridWindow(N, G, 24_000)
    const cards = w.endIndex - w.startIndex
    assert.ok(cards > 0 && cards <= 13 * G.cols, `rendered ${cards}`)
  })

  it('overscan is exactly one screen of rows above AND below the visible rows', () => {
    const st = 24_000
    const w = computeGridWindow(N, G, st)
    const { first, last } = visibleRows(G, st, w.rows)
    assert.equal(first - w.startRow, overscanRows(G))
    assert.equal(w.endRow - (last + 1), overscanRows(G))
  })

  it('a flick of up to one screen stays inside the overscan', () => {
    const w = computeGridWindow(N, G, 24_000)
    assert.ok(windowCovers(w, G, 24_000 + G.viewportH))
    assert.ok(windowCovers(w, G, 24_000 - G.viewportH))
  })

  it('the grid below the fold: its first rows are ready', () => {
    const g = { ...G, gridTop: 2_000 }
    const w = computeGridWindow(N, g, 0)
    assert.equal(w.startRow, 0)
    assert.ok(w.endRow >= 1)
    assert.ok(windowCovers(w, g, 0))
  })

  it('past the end (content shrank under a filter): the last rows, not row 0', () => {
    const w = computeGridWindow(14, G, 50_000)
    assert.equal(w.endRow, 2)
    assert.equal(w.endIndex, 14)
  })

  it('a partial last row counts as a row', () => {
    const w = computeGridWindow(15, { ...G, gridTop: 0 }, 0)
    assert.equal(w.rows, 3)
    assert.equal(w.endIndex, 15)
  })

  it('empty grid', () => {
    const w = computeGridWindow(0, G, 0)
    assert.equal(w.startIndex, 0)
    assert.equal(w.endIndex, 0)
    assert.equal(w.padBottom, 0)
  })
})

describe('gridWindow — helpers', () => {
  it('visibleRows: the rows under the viewport', () => {
    assert.deepEqual(visibleRows(G, 300, 400), { first: 0, last: 3 })
    assert.deepEqual(visibleRows(G, 300 + 214 * 10 + 5, 400), { first: 10, last: 13 })
    assert.deepEqual(visibleRows(G, 0, 0), { first: 0, last: -1 })
  })

  it('overscan is a screen of rows, at least two', () => {
    assert.equal(overscanRows(G), 4)
    assert.equal(overscanRows({ ...G, viewportH: 100 }), 2)
  })

  it('windowCovers is false when the viewport has moved past the rendered rows', () => {
    const w = computeGridWindow(N, G, 0)
    assert.equal(windowCovers(w, G, 20_000), false)
  })

  it('scrollTopForIndex: centre / nearest / start', () => {
    const row = 100, idx = row * G.cols + 3
    const rowTop = G.gridTop + row * G.rowStride
    assert.equal(scrollTopForIndex(G, idx, 'start', 0), rowTop)
    assert.equal(scrollTopForIndex(G, idx, 'center', 0), rowTop - (G.viewportH - G.rowStride) / 2)
    assert.equal(scrollTopForIndex(G, idx, 'nearest', rowTop - 100), null, 'already fully visible → stay')
    assert.equal(scrollTopForIndex(G, idx, 'nearest', rowTop + 50), rowTop, 'row cut off above → align its top')
    assert.equal(scrollTopForIndex(G, idx, 'nearest', 0), rowTop + G.rowStride - G.viewportH, 'below → align its bottom')
  })

  it('sameWindow / sameGeometry', () => {
    const a = computeGridWindow(N, G, 1000)
    assert.ok(sameWindow(a, computeGridWindow(N, G, 1010)))
    assert.ok(!sameWindow(a, computeGridWindow(N, G, 9000)))
    assert.ok(sameGeometry(G, { ...G, rowStride: G.rowStride + 0.2 }))
    assert.ok(!sameGeometry(G, { ...G, cols: 6 }))
    assert.ok(sameGeometry(null, null))
    assert.ok(!sameGeometry(G, null))
  })
})
