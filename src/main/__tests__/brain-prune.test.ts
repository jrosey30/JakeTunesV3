import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planMoodPrune, PRUNE_MAX_ABSOLUTE } from '../../../scripts/brain-prune.mjs'

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i)

describe('planMoodPrune: identity-gated, refuses on a short read', () => {
  it('prunes exactly the ids that are not in the library', () => {
    const index = [...range(1, 1001), 5001, 5002, 5003]
    const plan = planMoodPrune(index, range(1, 1001))
    assert.deepEqual(plan.prune, [5001, 5002, 5003])
    assert.equal(plan.refused, undefined)
  })
  it('matches string ids from library.json against numeric index ids', () => {
    assert.deepEqual(planMoodPrune([1, 2, 3], ['1', '2']).prune, [3])
  })
  it('does nothing when every vector belongs to a track', () => {
    assert.deepEqual(planMoodPrune(range(1, 500), range(1, 600)).prune, [])
  })
  it('refuses when the library read is short (thousands look orphaned)', () => {
    const plan = planMoodPrune(range(1, 11001), range(1, 8500))
    assert.deepEqual(plan.prune, [])
    assert.match(plan.refused ?? '', /short library read/)
  })
  it('refuses against an empty library', () => {
    const plan = planMoodPrune(range(1, 100), [])
    assert.deepEqual(plan.prune, [])
    assert.match(plan.refused ?? '', /empty/)
  })
  it('caps a single night at a small slice of the index', () => {
    const index = range(1, 20001)
    const lib = range(1, 20001 - (PRUNE_MAX_ABSOLUTE + 1))
    assert.equal(planMoodPrune(index, lib).prune.length, 0)
    const lib2 = range(1, 20001 - PRUNE_MAX_ABSOLUTE)
    assert.equal(planMoodPrune(index, lib2).prune.length, PRUNE_MAX_ABSOLUTE)
  })
  it("tonight's real shape: 18 orphans in a 10,972-vector index are pruned", () => {
    const index = range(1, 10973)
    const plan = planMoodPrune(index, range(1, 10955))
    assert.equal(plan.prune.length, 18)
  })
})
