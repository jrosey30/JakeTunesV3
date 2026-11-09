import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideStreamConvertAttempt, decideStreamConvertMiss, streamConvertWaitMs, STREAM_CONVERT_MAX_WAIT_MS } from '../stream-convert-retry.ts'

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

  // 2026-11-09: a flat 30 minutes re-downloaded 105 songs all day, 80 to 107 GB a day.
  it('each miss doubles the wait, up to a day', () => {
    let item: { ipodPath: string; enqueuedAt: number; retryAfter?: number; tries?: number } = { ipodPath: ':a', enqueuedAt: 0 }
    let now = PERIOD + 1
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      const miss = decideStreamConvertMiss(item, now, PERIOD)
      assert.equal(miss.rescheduled, true)
      waits.push(miss.item.retryAfter! - now)
      item = miss.item
      now = miss.item.retryAfter!
    }
    assert.deepEqual(waits.slice(0, 6), [1, 2, 4, 8, 16, 32].map((n) => n * PERIOD))
    assert.deepEqual(waits.slice(6), [STREAM_CONVERT_MAX_WAIT_MS, STREAM_CONVERT_MAX_WAIT_MS, STREAM_CONVERT_MAX_WAIT_MS])
    assert.equal(item.tries, 9)
    assert.equal(item.ipodPath, ':a')
  })
  it('an item queued before tries existed starts at one period; a bad count is zero', () => {
    assert.equal(decideStreamConvertMiss({ enqueuedAt: 0, retryAfter: 5 }, 5, PERIOD).item.retryAfter, 5 + PERIOD)
    assert.equal(streamConvertWaitMs(Number.NaN, PERIOD), PERIOD)
    assert.equal(streamConvertWaitMs(-3, PERIOD), PERIOD)
    assert.equal(streamConvertWaitMs(1e9, PERIOD), STREAM_CONVERT_MAX_WAIT_MS)
  })
})
