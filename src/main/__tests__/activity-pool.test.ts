import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeIntoPool, removeFromPool, POOL_MAX } from '../activity-pool.ts'

const never = () => false

describe('mergeIntoPool', () => {
  it('dedupes by id and keeps drop order', () => {
    const r = mergeIntoPool([1, 2], [{ id: 2 }, { id: 3 }, { id: 1 }, { id: 4 }], never)
    assert.deepEqual(r.ids, [1, 2, 3, 4])
    assert.equal(r.added, 2)
    assert.equal(r.dupes, 2)
  })

  it('skips skits on drop and REPORTS the count', () => {
    const r = mergeIntoPool([], [{ id: 1, title: 'Intro' }, { id: 2, title: 'Song' }], (c) => /intro/i.test(c.title || ''))
    assert.deepEqual(r.ids, [2])
    assert.equal(r.skits, 1)
  })

  it('refuses overflow past the cap instead of trimming', () => {
    const r = mergeIntoPool([1, 2], [{ id: 3 }, { id: 4 }, { id: 5 }], never, 3)
    assert.deepEqual(r.ids, [1, 2, 3])
    assert.equal(r.overflow, 2)
    assert.equal(POOL_MAX, 1000)
  })

  it('ignores garbage ids', () => {
    const r = mergeIntoPool([], [{ id: Number.NaN }, { id: 7 }], never)
    assert.deepEqual(r.ids, [7])
  })
})

describe('removeFromPool', () => {
  it('removes only the named ids', () => {
    assert.deepEqual(removeFromPool([1, 2, 3, 4], [2, 4, 9]), [1, 3])
  })
})
