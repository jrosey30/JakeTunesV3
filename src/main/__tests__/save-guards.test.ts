import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefuseSave, mayUnlinkDeletions, UNLINK_CAP } from '../save-guards.ts'

describe('save-guards (the 2026-05-29 data-loss protection)', () => {
  it('allows a normal save (same or grown count)', () => {
    assert.equal(shouldRefuseSave(7000, 7000), null)
    assert.equal(shouldRefuseSave(7000, 7050), null)
  })

  it('allows small/deliberate shrinks above the 50% floor', () => {
    assert.equal(shouldRefuseSave(7000, 6900), null) // ~1.4% loss
    assert.equal(shouldRefuseSave(100, 60), null)    // 40% loss — still allowed
  })

  it('refuses overwriting a non-empty library with an empty list', () => {
    assert.equal(shouldRefuseSave(7000, 0)?.error, 'refused-empty-overwrite')
  })

  it('refuses a catastrophic (>50%) shrink', () => {
    assert.equal(shouldRefuseSave(7000, 3000)?.error, 'refused-suspicious-shrink')
  })

  it('treats exactly the floor as allowed, just below as refused', () => {
    assert.equal(shouldRefuseSave(100, 50), null) // exactly 50% — not < floor
    assert.equal(shouldRefuseSave(100, 49)?.error, 'refused-suspicious-shrink')
  })

  it('force bypasses all refusals (explicit recovery)', () => {
    assert.equal(shouldRefuseSave(7000, 0, true), null)
    assert.equal(shouldRefuseSave(7000, 1, true), null)
  })

  it('always allows a genuine first save (no prior tracks)', () => {
    assert.equal(shouldRefuseSave(0, 0), null)
    assert.equal(shouldRefuseSave(0, 5000), null)
  })

  it('unlink cap: small batches delete, large batches preserve, force overrides', () => {
    assert.equal(mayUnlinkDeletions(5), true)
    assert.equal(mayUnlinkDeletions(UNLINK_CAP), true)      // exactly the cap
    assert.equal(mayUnlinkDeletions(UNLINK_CAP + 1), false) // over → preserve as orphans
    assert.equal(mayUnlinkDeletions(10000, true), true)     // force overrides
  })
})
