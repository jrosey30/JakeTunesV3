import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wipeListingMatchesKeep, keepStreak } from '../activity-keep.ts'
// The keep plan that lived here moved to ipod-swap-sync.ts (planSwap); its
// identity cases are in ipod-swap-sync.test.ts.

describe('targeted wipe proof', () => {
  it('is proven only when the listing IS the keep set', () => {
    const keep = new Set(['/V/a.m4a', '/V/b.m4a'])
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a', '/V/b.m4a'], keep), true)
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a'], keep), false)                 // one missing
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a', '/V/b.m4a', '/V/x.m4a'], keep), false) // one extra
    assert.equal(wipeListingMatchesKeep([], new Set()), true)                        // the old proven-empty
  })
  it('streaks like the empty-wipe proof', () => {
    assert.equal(keepStreak(true, 0), 1)
    assert.equal(keepStreak(true, 1), 2)
    assert.equal(keepStreak(false, 5), 0)
  })
})
