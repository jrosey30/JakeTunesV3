/**
 * "Ready on this Mac" (2026-11-08): the Device page's line, the one confirm
 * before Sync touches the card, and what "Sync now" sends.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  idsLeavingOff, leaveOffQuestion, mustAskBeforeSync, readyOnMacLine, syncNowLeavingOffLabel, type ReadyOnMac,
} from '../../common/ipod-ready-on-mac.ts'

const ready = (over: Partial<ReadyOnMac>): ReadyOnMac => ({ total: 829, missing: [], onCard: 0, fill: [], downloading: false, stoppedBecause: null, ...over })

describe('the line under the iPod’s name', () => {
  it('all ready', () => {
    assert.equal(readyOnMacLine(ready({})), 'All 829 songs ready on this Mac')
    assert.equal(readyOnMacLine(ready({ total: 1 })), 'All 1 song ready on this Mac')
  })
  it('songs still coming', () => {
    assert.equal(readyOnMacLine(ready({ missing: [1, 2, 3], downloading: true })), '3 songs still downloading — Sync will wait / Sync now leaves them off')
  })
  it('the download can’t get them: says why', () => {
    assert.equal(
      readyOnMacLine(ready({ missing: [1], stoppedBecause: 'not enough room on this Mac: free disk would drop below 10.0 GB (12.0 GB free)' })),
      '1 song not on this Mac yet (not enough room on this Mac: free disk would drop below 10.0 GB (12.0 GB free)) — Sync now leaves them off',
    )
  })
})

describe('the confirm', () => {
  it('asks only when a song would have to be fetched', () => {
    assert.equal(mustAskBeforeSync(null, null), false, 'no check: the sync goes as before')
    assert.equal(mustAskBeforeSync(ready({}), null), false)
    assert.equal(mustAskBeforeSync(ready({ missing: [4] }), null), true)
  })
  it('“Sync now” goes ahead for the songs agreed to; more missing asks again', () => {
    const agreed = ready({ missing: [4, 5] })
    assert.equal(mustAskBeforeSync(ready({ missing: [4] }), agreed), false)
    assert.equal(mustAskBeforeSync(ready({ missing: [4, 5] }), agreed), false)
    assert.equal(mustAskBeforeSync(ready({ missing: [4, 5, 6] }), agreed), true)
  })
  it('plain words', () => {
    assert.equal(leaveOffQuestion(ready({ missing: [1, 2, 3] })), '3 songs aren’t on this Mac yet. Sync now and leave them off, or wait for the download?')
    assert.equal(syncNowLeavingOffLabel(3), 'Sync now (3 left off)')
  })
})

describe('what “Sync now” sends', () => {
  it('a list iPod: the plan without the missing songs, in order', () => {
    assert.deepEqual(idsLeavingOff([5, 1, 9, 2], { missing: [9, 1], fill: [] }), [5, 2])
  })
  it('the Original: songs on this Mac take the missing seats, so the count holds', () => {
    const out = idsLeavingOff([5, 1, 9, 2], { missing: [9, 1], fill: [70, 71, 72] })
    assert.deepEqual(out, [5, 2, 70, 71])
    assert.equal(out.length, 4)
  })
  it('never a fill song twice or a missing one back', () => {
    assert.deepEqual(idsLeavingOff([5, 1], { missing: [1], fill: [5, 1] }), [5])
  })
})
