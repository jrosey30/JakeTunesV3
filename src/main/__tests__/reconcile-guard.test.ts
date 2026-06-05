import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessDeadTrackRemoval,
  MAX_SAFE_ONE_SHOT_REMOVAL,
} from '../reconcile-guard.ts'

describe('assessDeadTrackRemoval (twin of scripts/remove-dead-tracks.mjs guard)', () => {
  // A plausibly-healthy environment: full mirror present, a couple of genuinely
  // dead entries the user wants cleaned up.
  const healthy = { totalTracks: 7447, deadCount: 3, mountsChecked: 2, diskAudioCount: 8542 }

  it('allows a small cleanup on a healthy, complete mirror', () => {
    const r = assessDeadTrackRemoval(healthy)
    assert.equal(r.safe, true)
    assert.equal(r.reason, 'ok')
  })

  it('is a no-op when there is nothing to remove', () => {
    const r = assessDeadTrackRemoval({ ...healthy, deadCount: 0 })
    assert.equal(r.safe, true)
    assert.equal(r.reason, 'nothing-to-remove')
  })

  it('refuses when no music root is mounted (drive/NAS disconnected)', () => {
    const r = assessDeadTrackRemoval({ totalTracks: 7447, deadCount: 7447, mountsChecked: 0, diskAudioCount: 0 })
    assert.equal(r.safe, false)
    assert.equal(r.reason, 'no-music-root')
  })

  it('refuses when the root is present but empty (mid-sync / wrong path)', () => {
    const r = assessDeadTrackRemoval({ totalTracks: 7447, deadCount: 7447, mountsChecked: 1, diskAudioCount: 0 })
    assert.equal(r.safe, false)
    assert.equal(r.reason, 'music-root-empty')
  })

  it('refuses when the mirror is grossly incomplete (fewer than half the files)', () => {
    const r = assessDeadTrackRemoval({ totalTracks: 7447, deadCount: 4000, mountsChecked: 1, diskAudioCount: 3000 })
    assert.equal(r.safe, false)
    assert.equal(r.reason, 'music-root-incomplete')
  })

  it('refuses a catastrophic-fraction removal (>50% of the library)', () => {
    // Root present and reasonably full, but the removal would still wipe >half.
    const r = assessDeadTrackRemoval({ totalTracks: 100, deadCount: 60, mountsChecked: 1, diskAudioCount: 100 })
    assert.equal(r.safe, false)
    assert.equal(r.reason, 'catastrophic-fraction')
  })

  it('THE WORKMINI INCIDENT: refuses the 265-track silent prune', () => {
    // 7,447 → 7,182 means 265 flagged dead. The resolved root held only the
    // ~7,182 matching files (incomplete relative to the true 8,542 on disk).
    const r = assessDeadTrackRemoval({ totalTracks: 7447, deadCount: 265, mountsChecked: 1, diskAudioCount: 7182 })
    assert.equal(r.safe, false)
    // Over the one-shot cap; would have been blocked regardless of which root.
    assert.equal(r.reason, 'over-cap')
  })

  it('refuses just over the one-shot cap', () => {
    const r = assessDeadTrackRemoval({
      totalTracks: 100000,
      deadCount: MAX_SAFE_ONE_SHOT_REMOVAL + 1,
      mountsChecked: 1,
      diskAudioCount: 100000,
    })
    assert.equal(r.safe, false)
    assert.equal(r.reason, 'over-cap')
  })

  it('allows right at the one-shot cap on a complete mirror', () => {
    const r = assessDeadTrackRemoval({
      totalTracks: 100000,
      deadCount: MAX_SAFE_ONE_SHOT_REMOVAL,
      mountsChecked: 1,
      diskAudioCount: 100000,
    })
    assert.equal(r.safe, true)
    assert.equal(r.reason, 'ok')
  })
})
