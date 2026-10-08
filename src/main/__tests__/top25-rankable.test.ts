/** Top 25 Most Played refuses sub-minute tracks a slot (Jake 9/2) — plays
 *  still count; the ranking just won't seat them. Unknown duration ranks. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isTop25Rankable, TOP_25_MIN_DURATION_MS } from '../../common/top25-rankable.ts'

describe('Top 25 rankable', () => {
  test('under a minute is never rankable; a minute or more is; unknown stays rankable', () => {
    assert.equal(isTop25Rankable({ duration: 37_000 }), false)
    assert.equal(isTop25Rankable({ duration: 59_999 }), false)
    assert.equal(isTop25Rankable({ duration: TOP_25_MIN_DURATION_MS }), true)
    assert.equal(isTop25Rankable({ duration: 0 }), true)
    assert.equal(isTop25Rankable({}), true)
  })
  test('a ranking pass with the predicate drops the 48-second track no matter its plays', () => {
    const tracks = [{ id: 1, playCount: 99, duration: 48_000 }, { id: 2, playCount: 5, duration: 200_000 }, { id: 3, playCount: 3, duration: 0 }]
    const top = tracks.filter((t) => t.playCount > 0 && isTop25Rankable(t)).sort((a, b) => b.playCount - a.playCount)
    assert.deepEqual(top.map((t) => t.id), [2, 3])
  })
})
