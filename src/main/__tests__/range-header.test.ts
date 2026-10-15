/**
 * Brief 164 — range-header parsing (RFC 9110 §14.2) for the local
 * ipod-audio:// serve. These are the Brief 154 mobile cases, ported
 * with the twin (see range-header.ts ⚠️ TWIN note): the two suites
 * must agree case-for-case.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseRangeHeader } from '../range-header.ts'

const SIZE = 1000

describe('parseRangeHeader (twin of JakeTunesMobile Brief 154)', () => {
  test('explicit in-bounds range passes through', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99', SIZE), { start: 0, end: 99 })
    assert.deepEqual(parseRangeHeader('bytes=500-599', SIZE), { start: 500, end: 599 })
  })

  test('open-ended range runs to EOF', () => {
    assert.deepEqual(parseRangeHeader('bytes=990-', SIZE), { start: 990, end: 999 })
  })

  test('oversize end is CLAMPED to the file, not rejected', () => {
    // The pre-164 serve answered 416 here.
    assert.deepEqual(parseRangeHeader('bytes=0-999999', SIZE), { start: 0, end: 999 })
    assert.deepEqual(parseRangeHeader('bytes=900-5000', SIZE), { start: 900, end: 999 })
  })

  test('suffix range returns the LAST bytes', () => {
    // The pre-164 serve returned bytes from the START of the file here.
    assert.deepEqual(parseRangeHeader('bytes=-500', SIZE), { start: 500, end: 999 })
    assert.deepEqual(parseRangeHeader('bytes=-1', SIZE), { start: 999, end: 999 })
  })

  test('suffix larger than the file returns the whole file', () => {
    assert.deepEqual(parseRangeHeader('bytes=-5000', SIZE), { start: 0, end: 999 })
  })

  test('unsatisfiable: start at or past EOF', () => {
    assert.equal(parseRangeHeader('bytes=1000-', SIZE), 'unsatisfiable')
    assert.equal(parseRangeHeader('bytes=1500-1600', SIZE), 'unsatisfiable')
  })

  test('unsatisfiable: start after end, and zero-length suffix', () => {
    assert.equal(parseRangeHeader('bytes=600-500', SIZE), 'unsatisfiable')
    assert.equal(parseRangeHeader('bytes=-0', SIZE), 'unsatisfiable')
  })

  test('not a single range: garbage and multi-range return null', () => {
    assert.equal(parseRangeHeader('bytes=0-99,200-299', SIZE), null)
    assert.equal(parseRangeHeader('items=0-99', SIZE), null)
    assert.equal(parseRangeHeader('bytes=-', SIZE), null)
    assert.equal(parseRangeHeader('', SIZE), null)
  })

  test('empty file: any range is unsatisfiable', () => {
    assert.equal(parseRangeHeader('bytes=0-', 0), 'unsatisfiable')
    assert.equal(parseRangeHeader('bytes=-5', 0), 'unsatisfiable')
  })
})
