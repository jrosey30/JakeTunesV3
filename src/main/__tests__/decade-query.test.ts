import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDecadeConstraint,
  parseTrackYear,
  yearInDecade,
  DECADE_QUERY_RE,
} from '../ai/decade-query.ts'

describe('parseDecadeConstraint', () => {
  it('parses "1970s, Your Version" style titles', () => {
    const r = parseDecadeConstraint('1970s, Your Version')
    assert.deepEqual(r, { start: 1970, end: 1979, label: '1970s' })
  })

  it('parses "classic rock from the 1970s"', () => {
    const r = parseDecadeConstraint('classic rock from the 1970s')
    assert.deepEqual(r, { start: 1970, end: 1979, label: '1970s' })
  })

  it('parses spelled-out seventies / eighties', () => {
    assert.deepEqual(parseDecadeConstraint('the seventies corner of your library'), {
      start: 1970, end: 1979, label: '1970s',
    })
    assert.deepEqual(parseDecadeConstraint('eighties new wave'), {
      start: 1980, end: 1989, label: '1980s',
    })
  })

  it('parses shorthand 70s / \'80s', () => {
    assert.deepEqual(parseDecadeConstraint("deep cuts from the '70s"), {
      start: 1970, end: 1979, label: '1970s',
    })
    assert.deepEqual(parseDecadeConstraint('80s synth'), {
      start: 1980, end: 1989, label: '1980s',
    })
  })

  it('pins a bare year to that calendar year', () => {
    assert.deepEqual(parseDecadeConstraint('songs from 1975'), {
      start: 1975, end: 1975, label: '1975',
    })
  })

  it('returns null when no decade/year is claimed', () => {
    assert.equal(parseDecadeConstraint("In the orbit of 'Ginga'"), null)
    assert.equal(parseDecadeConstraint('Because You Played Robson Jorge'), null)
    assert.equal(parseDecadeConstraint('slow mellow late night'), null)
  })

  it('DECADE_QUERY_RE agrees with parseDecadeConstraint presence', () => {
    const positives = [
      '1970s, Your Version',
      'classic rock from the 1970s',
      'new wave 80s',
      'the seventies',
    ]
    for (const q of positives) {
      assert.ok(DECADE_QUERY_RE.test(q), q)
      assert.ok(parseDecadeConstraint(q), q)
    }
    assert.equal(DECADE_QUERY_RE.test('Because You Played Ginga'), false)
  })
})

describe('yearInDecade', () => {
  const seventies = { start: 1970, end: 1979, label: '1970s' }

  it('accepts in-range years and rejects out-of-range / missing', () => {
    assert.equal(yearInDecade(1973, seventies), true)
    assert.equal(yearInDecade('1979', seventies), true)
    assert.equal(yearInDecade(1969, seventies), false) // The Who "1921"
    assert.equal(yearInDecade(2018, seventies), false) // Turnstile
    assert.equal(yearInDecade(2003, seventies), false) // Postal Service
    assert.equal(yearInDecade(undefined, seventies), false)
    assert.equal(yearInDecade('', seventies), false)
  })

  it('parseTrackYear rejects garbage', () => {
    assert.equal(parseTrackYear('unknown'), null)
    assert.equal(parseTrackYear(0), null)
    assert.equal(parseTrackYear(1977), 1977)
  })
})
