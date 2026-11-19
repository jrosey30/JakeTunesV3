/**
 * "Ready on this Mac" (2026-11-08): the Device page's line, the one confirm
 * before Sync touches the card, and what "Sync now" sends.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  idsLeavingOff, leaveOffQuestion, listFetchStep, mustAskBeforeSync, readyOnMacLine, syncNowLeavingOffLabel, type ReadyOnMac,
} from '../../common/ipod-ready-on-mac.ts'

const ready = (over: Partial<ReadyOnMac>): ReadyOnMac => ({ total: 829, missing: [], onCard: 0, fill: [], downloading: false, stoppedBecause: null, ...over })

describe('the line under the iPod’s name', () => {
  it('all ready', () => {
    // Nothing to say: the line beside the iPod's name already says the songs are ready.
    assert.equal(readyOnMacLine(ready({})), null)
    assert.equal(readyOnMacLine(ready({ total: 1 })), null)
  })
  it('songs still coming', () => {
    assert.equal(readyOnMacLine(ready({ missing: [1, 2, 3], downloading: true })), '3 songs still downloading.')
  })
  it('the download can’t get them: one plain line, no reason in brackets (2026-11-19)', () => {
    const line = readyOnMacLine(ready({ missing: [1], stoppedBecause: 'not enough room on this Mac: free disk would drop below 10.0 GB (12.0 GB free)' }))
    assert.equal(line, '1 song isn’t on this Mac yet.')
    assert.doesNotMatch(line ?? '', /\(|free disk/)
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
    assert.equal(leaveOffQuestion(ready({ missing: [1, 2, 3] })), '3 songs aren’t on this Mac yet.')
    assert.equal(leaveOffQuestion(ready({ missing: [1] })), '1 song isn’t on this Mac yet.')
    assert.equal(syncNowLeavingOffLabel(3), 'Sync without them')
    assert.equal(syncNowLeavingOffLabel(1), 'Sync without it')
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

describe('a list iPod waits for its songs instead of leaving any off (2026-11-17)', () => {
  const t0 = 1_000_000
  const at = (now: number, lastProgressAt = t0) => ({ startedAt: t0, lastProgressAt, now, ipodName: 'iBANDCAMP' })
  it('the line never offers to leave songs off', () => {
    assert.equal(readyOnMacLine(ready({ missing: [1, 2], downloading: true }), { list: true }), '2 songs aren’t on this Mac yet. Sync gets them first.')
    assert.equal(readyOnMacLine(ready({ missing: [1], stoppedBecause: 'away from home' }), { list: true }),
      '1 song isn’t on this Mac yet. Sync gets it first.')
    assert.equal(readyOnMacLine(ready({}), { list: true }), null)
    assert.doesNotMatch(readyOnMacLine(ready({ missing: [1], downloading: true }), { list: true }) ?? '', /without|left off/)
  })
  it('go when everything is here, or when the check could not run', () => {
    assert.deepEqual(listFetchStep(ready({}), at(t0)), { kind: 'go' })
    assert.deepEqual(listFetchStep(null, at(t0)), { kind: 'go' })
  })
  it('waits while downloading, and through the first moments even if the last pass had stopped', () => {
    const s = listFetchStep(ready({ missing: [1, 2, 3], downloading: true }), at(t0 + 60_000))
    assert.deepEqual(s, { kind: 'wait', line: 'Getting 3 songs from homemini…' })
    assert.equal(listFetchStep(ready({ missing: [1], stoppedBecause: 'old reason' }), at(t0 + 5_000)).kind, 'wait')
  })
  it('stuck when the download stopped and says why, or nothing arrived for 10 minutes: one error line, nothing changed', () => {
    const stopped = listFetchStep(ready({ missing: [1], stoppedBecause: 'homemini didn’t answer' }), at(t0 + 20_000))
    assert.equal(stopped.kind, 'stuck')
    assert.equal(stopped.kind === 'stuck' ? stopped.error : '', 'Can’t get 1 song right now. Try Sync again later.')
    const stalled = listFetchStep(ready({ missing: [1, 2], downloading: true }), at(t0 + 11 * 60_000))
    assert.equal(stalled.kind, 'stuck')
    assert.equal(stalled.kind === 'stuck' ? stalled.error : '', '2 songs stopped downloading. Press Sync to try again.')
    assert.equal(listFetchStep(ready({ missing: [1, 2], downloading: true }), at(t0 + 11 * 60_000, t0 + 10 * 60_000)).kind, 'wait', 'progress resets the stall clock')
  })
})
