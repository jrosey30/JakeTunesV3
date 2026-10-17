import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { splitHalfAndHalf } from '../../common/activity-split.ts'

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i)

describe('iPod Activity Sync: always half pool, half Music Man', () => {
  it('a full 1,000 pool at the 1,000 size: newest 500 drops + 500 Music Man picks', () => {
    const pool = range(1, 1000) // drop order: 1 oldest … 1000 newest
    const s = splitHalfAndHalf(pool, 1000)
    assert.equal(s.manualIds.length, 500)
    assert.deepEqual(s.manualIds, range(501, 1000))
    assert.equal(s.brainTarget, 500)
    assert.deepEqual(s.waitingIds, range(1, 500))
  })
  it('every size splits down the middle', () => {
    const pool = range(1, 1000)
    for (const n of [100, 250, 500, 1000]) {
      const s = splitHalfAndHalf(pool, n)
      assert.equal(s.manualIds.length, n / 2, `size ${n}`)
      assert.equal(s.brainTarget, n / 2, `size ${n}`)
      assert.equal(s.manualIds.at(-1), 1000, 'newest drop is always on')
    }
  })
  it('a pool smaller than half goes on whole; Music Man covers the shortfall so the sync is still N', () => {
    const s = splitHalfAndHalf(range(1, 120), 1000)
    assert.deepEqual(s.manualIds, range(1, 120))
    assert.equal(s.brainTarget, 880)
    assert.deepEqual(s.waitingIds, [])
  })
  it('an empty pool: Music Man picks the whole set', () => {
    const s = splitHalfAndHalf([], 250)
    assert.deepEqual(s.manualIds, [])
    assert.equal(s.brainTarget, 250)
  })
  it('keeps drop order within the manual half', () => {
    const s = splitHalfAndHalf([30, 10, 20, 40], 4)
    assert.deepEqual(s.manualIds, [20, 40])
    assert.deepEqual(s.waitingIds, [30, 10])
  })
})

describe('pinned lists (Recently Added, Bops, Rocksurgence) are always in your half', () => {
  it('pinned go on first; newest drops fill the rest of the half', () => {
    const pinned = [9001, 9002, 9003]
    const s = splitHalfAndHalf(range(1, 1000), 10, pinned)
    assert.deepEqual(s.manualIds, [9001, 9002, 9003, 999, 1000])
    assert.equal(s.pinnedCount, 3)
    assert.equal(s.brainTarget, 5)
  })
  it('a song both pinned and dropped counts once (as pinned)', () => {
    const s = splitHalfAndHalf([1, 2, 3, 4], 6, [4, 4, 2])
    assert.deepEqual(s.manualIds, [4, 2, 3])
    assert.equal(s.pinnedCount, 2)
    assert.equal(s.brainTarget, 3)
  })
  it('at a small size the pinned lists can fill the whole half; earlier pinned win; drops wait', () => {
    const s = splitHalfAndHalf(range(1, 50), 4, [101, 102, 103])
    assert.deepEqual(s.manualIds, [101, 102])
    assert.equal(s.brainTarget, 2)
    assert.deepEqual(s.waitingIds.slice(0, 1), [103])
    assert.equal(s.waitingIds.length, 1 + 50)
  })
  it('real sizes: 272 pinned at the 1,000 size leave 228 for your newest drops', () => {
    const pinned = range(20001, 20272)
    const s = splitHalfAndHalf(range(1, 1000), 1000, pinned)
    assert.equal(s.pinnedCount, 272)
    assert.equal(s.manualIds.length, 500)
    assert.deepEqual(s.manualIds.slice(272), range(773, 1000))
    assert.equal(s.brainTarget, 500)
  })
})
