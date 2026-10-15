import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeStarIds,
  normalizeStarSidecar,
  mergeStarStates,
  applyStarChange,
  starSidecarForWrite,
} from '../mobile-stars-merge.ts'

describe('mobile-stars-merge — mergeStarIds (v1 behaviour, unchanged)', () => {
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

describe('mobile-stars-merge — Brief 172 tombstones', () => {
  it('v1 shapes normalize with empty maps (bare array and {trackIds})', () => {
    assert.deepEqual(normalizeStarSidecar(['2', '1']), { trackIds: ['1', '2'], removed: {}, added: {} })
    assert.deepEqual(normalizeStarSidecar({ trackIds: ['7'] }), { trackIds: ['7'], removed: {}, added: {} })
    assert.deepEqual(normalizeStarSidecar(null), { trackIds: [], removed: {}, added: {} })
    assert.deepEqual(normalizeStarSidecar('junk'), { trackIds: [], removed: {}, added: {} })
  })

  it('v1 + v1 still unions', () => {
    const m = mergeStarStates(normalizeStarSidecar({ trackIds: ['1'] }), normalizeStarSidecar(['2']))
    assert.deepEqual(m.trackIds, ['1', '2'])
  })

  it('v1 + v2: a tombstone beats a legacy star of unknown age', () => {
    const v1 = normalizeStarSidecar({ trackIds: ['5', '6'] })
    const v2 = normalizeStarSidecar({ v: 2, trackIds: ['6'], removed: { '5': 2000 }, added: {} })
    assert.deepEqual(mergeStarStates(v1, v2).trackIds, ['6'])
  })

  it('v2 + v2 with a removal: the un-starred id stays out, tombstone is kept', () => {
    const a = normalizeStarSidecar({ v: 2, trackIds: ['1', '2'], removed: {}, added: { '1': 100, '2': 100 } })
    const b = normalizeStarSidecar({ v: 2, trackIds: ['1'], removed: { '2': 500 }, added: { '1': 100 } })
    const m = mergeStarStates(a, b)
    assert.deepEqual(m.trackIds, ['1'])
    assert.equal(m.removed['2'], 500)
  })

  it('removal-then-readd: a newer explicit star beats the tombstone', () => {
    const removedSide = normalizeStarSidecar({ v: 2, trackIds: [], removed: { '9': 500 }, added: {} })
    const readdedSide = normalizeStarSidecar({ v: 2, trackIds: ['9'], removed: { '9': 500 }, added: { '9': 900 } })
    assert.deepEqual(mergeStarStates(removedSide, readdedSide).trackIds, ['9'])
  })

  it('desktop un-star does not resurrect after a phone sync round-trip', () => {
    // Desktop stars 1+2 (legacy file), phone still holds the same set.
    let desktop = normalizeStarSidecar({ trackIds: ['1', '2'] })
    const phoneStale = normalizeStarSidecar({ trackIds: ['1', '2'] })
    // Desktop un-stars 2 at t=1000 and writes v2.
    desktop = applyStarChange(desktop, '2', false, 1000)
    assert.deepEqual(starSidecarForWrite(desktop), {
      v: 2, trackIds: ['1'], removed: { '2': 1000 }, added: {},
    })
    // The stale phone set merges in — 2 must NOT come back.
    const afterRoundTrip = mergeStarStates(desktop, phoneStale)
    assert.deepEqual(afterRoundTrip.trackIds, ['1'])
    // And the merged write still carries the tombstone for the next cycle.
    assert.equal(starSidecarForWrite(afterRoundTrip).removed['2'], 1000)
  })

  it('applyStarChange: star after un-star revives; un-star after star removes', () => {
    let s = normalizeStarSidecar({ trackIds: [] })
    s = applyStarChange(s, '3', true, 100)
    assert.deepEqual(s.trackIds, ['3'])
    s = applyStarChange(s, '3', false, 200)
    assert.deepEqual(s.trackIds, [])
    s = applyStarChange(s, '3', true, 300)
    assert.deepEqual(s.trackIds, ['3'])
  })

  it('merge is commutative on the resolved set', () => {
    const a = normalizeStarSidecar({ v: 2, trackIds: ['1'], removed: { '2': 50 }, added: { '1': 10 } })
    const b = normalizeStarSidecar({ v: 2, trackIds: ['2', '3'], removed: {}, added: { '3': 10 } })
    assert.deepEqual(mergeStarStates(a, b).trackIds, mergeStarStates(b, a).trackIds)
    assert.deepEqual(mergeStarStates(a, b).trackIds, ['1', '3'])
  })
})
