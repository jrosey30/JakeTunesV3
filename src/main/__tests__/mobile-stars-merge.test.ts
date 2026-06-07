import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeStarIds } from '../mobile-stars-merge.ts'

describe('mobile-stars-merge — mergeStarIds', () => {
  it('unions both sides, dedupes, sorts', () => {
    assert.deepEqual(mergeStarIds(['3', '1'], ['2', '1']), ['1', '2', '3'])
  })

  it('keeps a star present on either side (additive — phone star reaches desktop)', () => {
    assert.deepEqual(mergeStarIds(['a'], []), ['a'])
    assert.deepEqual(mergeStarIds([], ['b']), ['b'])
    assert.deepEqual(mergeStarIds(['a'], ['b']), ['a', 'b'])
  })

  it('drops non-string / empty ids', () => {
    assert.deepEqual(mergeStarIds(['x', ''], ['y']), ['x', 'y'])
    assert.deepEqual(mergeStarIds(['1', '1'], ['1']), ['1'])
  })

  it('is order-independent on the result (sorted)', () => {
    assert.deepEqual(mergeStarIds(['10', '2'], ['1']), ['1', '10', '2']) // string sort
  })
})
