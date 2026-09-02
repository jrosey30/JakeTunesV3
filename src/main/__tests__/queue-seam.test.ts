/** Queue honesty at the seam — every way the queue can change after the
 *  next track was primed must still be honored when the song ends. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { locateTrackIndex, resolveSeamAdvance } from '../../renderer/queue-seam.ts'

const q = (...ids: number[]) => ids.map((id) => ({ id }))

describe('locateTrackIndex', () => {
  test('hint wins when it still points at the track', () => {
    assert.equal(locateTrackIndex(q(1, 2, 3), 2, 1), 1)
  })
  test('falls back to a search when the hint is stale; nearest duplicate to the hint', () => {
    assert.equal(locateTrackIndex(q(9, 1, 2, 3), 2, 1), 2)          // shifted by an insert before
    assert.equal(locateTrackIndex(q(7, 7, 1, 7), 7, 2), 1)          // nearest 7 to hint 2
    assert.equal(locateTrackIndex(q(1, 2, 3), 4, 0), -1)
  })
})

describe('resolveSeamAdvance — the seam reads the LIVE queue', () => {
  test('Play Next inserted after priming plays next', () => {
    // primed next was 3; then the listener inserted 9 at current+1
    assert.equal(resolveSeamAdvance(q(1, 2, 9, 3), 2, 1, 'off').nextIndex, 2)
  })
  test('removing the primed next skips it', () => {
    assert.equal(resolveSeamAdvance(q(1, 2, 4), 2, 1, 'off').nextIndex, 2)
  })
  test('reorder after priming is honored', () => {
    assert.equal(resolveSeamAdvance(q(1, 2, 5, 3, 4), 2, 1, 'off').nextIndex, 2)
  })
  test('insert BEFORE the current track shifts the index — still correct', () => {
    // hint says index 1 but 2 now sits at index 2 because 8 was inserted at 0
    const r = resolveSeamAdvance(q(8, 1, 2, 3), 2, 1, 'off')
    assert.equal(r.currentIndex, 2); assert.equal(r.nextIndex, 3)
  })
  test('the playing track was removed mid-play: continue from its old slot', () => {
    const r = resolveSeamAdvance(q(1, 3, 4), 2, 1, 'off')
    assert.equal(r.currentIndex, -1); assert.equal(r.nextIndex, 1)
  })
  test('end of queue: stop, or wrap on repeat all', () => {
    assert.equal(resolveSeamAdvance(q(1, 2), 2, 1, 'off').nextIndex, -1)
    assert.equal(resolveSeamAdvance(q(1, 2), 2, 1, 'all').nextIndex, 0)
  })
  test('queue replaced wholesale (fresh play elsewhere): follow the live one', () => {
    assert.equal(resolveSeamAdvance(q(20, 21, 22), 2, 1, 'off').nextIndex, 1)
  })
  test('empty queue stops', () => {
    assert.equal(resolveSeamAdvance([], 2, 0, 'all').nextIndex, -1)
  })
})
