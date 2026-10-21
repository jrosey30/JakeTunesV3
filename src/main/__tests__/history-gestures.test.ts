import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HistorySwipeTracker, mouseButtonNav, type SwipeSample } from '../../renderer/historySwipe.ts'
import { swipeDirectionToAction, appCommandToAction } from '../history-gestures.ts'

/** A trackpad-like run: `n` events every 8 ms, each (dx, dy), starting at t0. */
const run = (t0: number, n: number, dx: number, dy = 0, consumedAt = -1): SwipeSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * 8, dx, dy, consumed: i === consumedAt }))
const feed = (tr: HistorySwipeTracker, samples: SwipeSample[]): Array<'back' | 'forward'> =>
  samples.map((s) => tr.push(s)).filter((x): x is 'back' | 'forward' => x !== null)

describe('historySwipe — two-finger swipe → back / forward', () => {
  it('fingers right (deltaX < 0) = back; left = forward', () => {
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 12, -20)), ['back'])
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 12, 20)), ['forward'])
  })

  it('fires ONCE per gesture — the momentum tail never fires again', () => {
    const tr = new HistorySwipeTracker()
    assert.deepEqual(feed(tr, [...run(0, 12, -20), ...run(96, 40, -6)]), ['back'])
  })

  it('a new gesture after a pause can fire again', () => {
    const tr = new HistorySwipeTracker()
    assert.deepEqual(feed(tr, [...run(0, 12, -20), ...run(1000, 12, -20)]), ['back', 'back'])
  })

  it('vertical scrolling never navigates, even with sideways wobble', () => {
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 60, -6, 30)), [])
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 60, 9, -25)), [])
  })

  it('a gesture consumed by something under the pointer is dead for its whole run (Cover Flow, carousels)', () => {
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 20, -20, 0, 0)), [])
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 20, -20, 0, 2)), [])
  })

  it('a slow sideways drag is not a swipe', () => {
    const slow = Array.from({ length: 80 }, (_, i) => ({ t: i * 30, dx: -3, dy: 0, consumed: false }))
    assert.deepEqual(feed(new HistorySwipeTracker(), slow), [])
  })

  it('too short to count', () => {
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 3, -60)), [])
    assert.deepEqual(feed(new HistorySwipeTracker(), run(0, 10, -10)), [])
  })
})

describe('mouse side buttons + main relays', () => {
  it('DOM button 3 = back, 4 = forward, anything else = nothing', () => {
    assert.equal(mouseButtonNav(3), 'back')
    assert.equal(mouseButtonNav(4), 'forward')
    for (const b of [0, 1, 2, 5]) assert.equal(mouseButtonNav(b), null)
  })

  it('macOS swipe: right = back, left = forward, up/down ignored', () => {
    assert.equal(swipeDirectionToAction('right'), 'history-back')
    assert.equal(swipeDirectionToAction('left'), 'history-forward')
    assert.equal(swipeDirectionToAction('up'), null)
    assert.equal(swipeDirectionToAction('down'), null)
  })

  it('app-command browser-backward / browser-forward', () => {
    assert.equal(appCommandToAction('browser-backward'), 'history-back')
    assert.equal(appCommandToAction('browser-forward'), 'history-forward')
    assert.equal(appCommandToAction('media-play-pause'), null)
  })
})
