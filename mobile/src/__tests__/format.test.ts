// Tests for mobile/src/utils/format.ts.
//
// formatDuration takes MILLISECONDS — see CLAUDE.md "Unit contracts".
// This test exists specifically to catch regressions where someone
// "fixes" the helper to take seconds (the bug we shipped and fixed
// in commit 48ea92e).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatFileSize } from '../utils/format.ts'

describe('formatDuration — unit contract is MS not seconds', () => {
  test('60_000 ms → 1:00 (one minute)', () => {
    assert.equal(formatDuration(60_000), '1:00')
  })

  test('240_000 ms → 4:00 (four minutes — typical track)', () => {
    assert.equal(formatDuration(240_000), '4:00')
  })

  test('three-minute-forty-two-second track lands as 3:42', () => {
    assert.equal(formatDuration(3 * 60_000 + 42_000), '3:42')
  })

  test('zero/negative/NaN values clamp to 0:00', () => {
    assert.equal(formatDuration(0), '0:00')
    assert.equal(formatDuration(-1), '0:00')
    assert.equal(formatDuration(NaN), '0:00')
    assert.equal(formatDuration(Infinity), '0:00')
  })

  test('seconds remainder pads to two digits', () => {
    assert.equal(formatDuration(65_000), '1:05')
    assert.equal(formatDuration(125_000), '2:05')
  })
})

describe('formatFileSize', () => {
  test('handles bytes', () => {
    assert.equal(formatFileSize(0), '0 B')
    assert.equal(formatFileSize(512), '512 B')
  })

  test('crosses unit boundaries cleanly', () => {
    // 1024 → '1.0 KB' (one decimal because n=1.0 < 10 and i > 0).
    // The "no decimal under 1024 B" rule only applies in the bytes
    // unit (i === 0 branch).
    assert.equal(formatFileSize(1024), '1.0 KB')
    assert.equal(formatFileSize(1024 * 1024), '1.0 MB')
    assert.equal(formatFileSize(1024 * 1024 * 1024), '1.0 GB')
  })

  test('uses one decimal under 10 of the unit, none at >= 10', () => {
    assert.equal(formatFileSize(1.5 * 1024 * 1024), '1.5 MB')
    assert.equal(formatFileSize(15 * 1024 * 1024), '15 MB')
  })
})
