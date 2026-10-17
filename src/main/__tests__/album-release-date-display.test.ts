/**
 * Album page credit line: release dates read like a person wrote them
 * (Jake, 2026-10-14: "Released 2025-03-14" — "terrible").
 * Both twins (common + renderer) must format identically.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatReleaseDateDisplay as fromCommon } from '../../common/albumReleaseDate.ts'
import { formatReleaseDateDisplay as fromRenderer } from '../../renderer/utils/albumReleaseDate.ts'

const CASES: Array<[string, string]> = [
  ['2025-03-14', 'March 14, 2025'],
  ['1991-12-01', 'December 1, 1991'],
  ['2004-01-31', 'January 31, 2004'],
  ['2025-03', 'March 2025'],
  ['2025', '2025'],
  [' 2025-03-14 ', 'March 14, 2025'],
  ['2025-13-01', '2025-13-01'],   // not a month — left as-is
  ['2025-03-00', '2025-03-00'],   // not a day — left as-is
  ['March 14, 2025', 'March 14, 2025'],
]

describe('formatReleaseDateDisplay', () => {
  for (const [twin, fn] of [['common', fromCommon], ['renderer', fromRenderer]] as const) {
    it(`${twin}: ISO dates read as "Month D, YYYY"`, () => {
      for (const [input, want] of CASES) assert.equal(fn(input), want, input)
    })
  }
  it('never shifts the day (no Date/UTC parsing)', () => {
    // new Date('2025-03-14') is UTC midnight = March 13 in New York.
    assert.equal(fromCommon('2025-03-14'), 'March 14, 2025')
  })
})
