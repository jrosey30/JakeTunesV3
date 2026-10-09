import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideStreamConvertAttempt, decideStreamConvertMiss } from '../stream-convert-retry.ts'

const PERIOD = 30 * 60 * 1000

describe('stream-convert retry', () => {
  it('tries on the short interval until the first period elapses', () => {
    const item = { ipodPath: ':a', enqueuedAt: 0 }
    assert.equal(decideStreamConvertAttempt(item, 90_000), 'try')
    const miss = decideStreamConvertMiss(item, 90_000, PERIOD)
    assert.equal(miss.rescheduled, false)
    assert.equal(miss.item.retryAfter, undefined)
    assert.equal(miss.item.ipodPath, ':a')
  })

  it('after 30 minutes with no match, schedules another try instead of dropping the file', () => {
    const item = { ipodPath: ':a', enqueuedAt: 1_000 }
    const now = 1_000 + PERIOD + 1
    assert.equal(decideStreamConvertAttempt(item, now), 'try')
    const miss = decideStreamConvertMiss(item, now, PERIOD)
    assert.equal(miss.rescheduled, true)
    assert.equal(miss.item.ipodPath, ':a')
    assert.equal(miss.item.enqueuedAt, 1_000)
    assert.equal(miss.item.retryAfter, now + PERIOD)
  })

  it('waits out retryAfter, then schedules the next period when that try also misses', () => {
    const waiting = { ipodPath: ':a', enqueuedAt: 0, retryAfter: 5_000 }
    assert.equal(decideStreamConvertAttempt(waiting, 4_999), 'wait')
    assert.equal(decideStreamConvertAttempt(waiting, 5_000), 'try')
    const miss = decideStreamConvertMiss(waiting, 5_000, PERIOD)
    assert.equal(miss.rescheduled, true)
    assert.equal(miss.item.retryAfter, 5_000 + PERIOD)
  })
})
