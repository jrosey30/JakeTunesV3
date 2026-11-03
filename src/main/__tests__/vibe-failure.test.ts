// "Make me a vibe" waits long enough and says why it failed (2026-11-03).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VIBE_WAIT_MS, vibeFailureCode, vibeFailureLine } from '../../common/vibe-failure.ts'

test('the desktop waits longer than the hub can take (its AI deadline plus the fill is ~40 s)', () => {
  assert.ok(VIBE_WAIT_MS >= 45_000)
})

test('a timeout, an answer from the hub, and no answer at all are told apart', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  assert.equal(vibeFailureCode({ error: timeout }), 'timeout')
  assert.equal(vibeFailureCode({ status: 422 }), 'http-422')
  assert.equal(vibeFailureCode({ error: new TypeError('fetch failed') }), 'unreachable')
  assert.equal(vibeFailureCode({}), 'unreachable')
})

test('each reason is said in words, never silence', () => {
  assert.match(vibeFailureLine('timeout'), /took too long/)
  assert.match(vibeFailureLine('unreachable'), /reach the hub/)
  assert.match(vibeFailureLine('none-here'), /on this Mac/)
  assert.match(vibeFailureLine('http-401'), /recognize this Mac/)
  assert.match(vibeFailureLine('http-422'), /Nothing in your library/)
  assert.match(vibeFailureLine('http-500'), /answered 500/)
  for (const odd of [undefined, null, '', 'backend exploded']) assert.ok(vibeFailureLine(odd).length > 10)
})
