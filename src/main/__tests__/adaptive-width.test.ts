import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptiveWidthFor, ADAPT_WIDE_CORR, ADAPT_NARROW_CORR } from '../../renderer/audio/adaptiveWidth.ts'

test('a narrow source gets the full ceiling, a wide one is left alone, between is proportional', () => {
  assert.equal(adaptiveWidthFor(1.6, 0.95), 1.6)
  assert.equal(adaptiveWidthFor(1.6, ADAPT_NARROW_CORR), 1.6)
  assert.equal(adaptiveWidthFor(1.6, ADAPT_WIDE_CORR), 1)
  assert.equal(adaptiveWidthFor(1.6, 0.1), 1)
  const mid = adaptiveWidthFor(1.6, (ADAPT_WIDE_CORR + ADAPT_NARROW_CORR) / 2)
  assert.ok(Math.abs(mid - 1.3) < 1e-9, `halfway → 1.3, got ${mid}`)
})

test('mono bass (ceiling < 1) is never adaptive, and silence counts as narrow', () => {
  assert.equal(adaptiveWidthFor(0, 0.2), 0)
  assert.equal(adaptiveWidthFor(1, 0.2), 1)
  assert.equal(adaptiveWidthFor(1.6, NaN), 1.6)
})
