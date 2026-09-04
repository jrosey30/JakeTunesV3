/**
 * P1C3 — the download-search module's pure logic, testable for the first
 * time. Each case is a doctrine that was paid for: the timezone-proof year
 * (a Jan-1 release must not become last December), the junk-artist filter,
 * and the explicit-edition resolver whose track-count gate refused to
 * repoint an 8-track Booklet Version at the 28-track record (measured live,
 * 2026-08-15 — a name-only bridge would have shipped the wrong album).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { itunesYear, ITUNES_JUNK_ARTIST, resolveExplicitEdition, explicitMapKey } from '../download-search.ts'

describe('itunesYear — a year is not a timestamp', () => {
  test('parses off the string so timezones cannot shift the year', () => {
    assert.equal(itunesYear('1994-09-13T07:00:00Z'), 1994)
    assert.equal(itunesYear('2001-01-01T00:00:00Z'), 2001)
  })
  test('garbage and out-of-range years return undefined — blank is honest', () => {
    assert.equal(itunesYear('n/a'), undefined)
    assert.equal(itunesYear(19940913), undefined)
    assert.equal(itunesYear('1234-01-01'), undefined)
  })
})

describe('the junk-artist filter', () => {
  test('karaoke factories and tribute mills are junk', () => {
    for (const junk of ['Ameritz Karaoke Planet', 'Tribute to Nirvana Band', 'Piano Tribute Players', '8-Bit Arcade', 'Rockabye Baby!']) {
      assert.ok(ITUNES_JUNK_ARTIST.test(junk), `${junk} should be filtered`)
    }
  })
  test('real artists survive', () => {
    for (const real of ['Nirvana', 'The-Dream', 'Charli XCX', 'Coverdale-Page']) {
      assert.ok(!ITUNES_JUNK_ARTIST.test(real), `${real} must NOT be filtered`)
    }
  })
})

describe('resolveExplicitEdition — the rescue and its gate', () => {
  const map = new Map([
    ['culture', { id: 111, trackCount: 13 }],
    ['thereup', { id: 222, trackCount: 28 }],
  ])
  test('exact folded-name match rescues regardless of counts', () => {
    assert.deepEqual(resolveExplicitEdition('Culture', undefined, map), { id: 111, trackCount: 13 })
  })
  test('the parenthetical bridge fires when track counts MATCH', () => {
    assert.deepEqual(resolveExplicitEdition('The Re-Up (Bonus Track Version)', 28, map), { id: 222, trackCount: 28 })
  })
  test('the gate: mismatched counts refuse the bridge — the 8-vs-28 rule', () => {
    assert.equal(resolveExplicitEdition('The Re-Up (Booklet Version)', 8, map), undefined)
  })
  test('unknown counts refuse the bridge — no evidence, no repoint', () => {
    assert.equal(resolveExplicitEdition('The Re-Up (Bonus Track Version)', undefined, map), undefined)
  })
  test('no parenthetical, no bridge', () => {
    assert.equal(resolveExplicitEdition('Different Album', 28, map), undefined)
  })
})

test('explicitMapKey: "(Deluxe Version)" and "(Deluxe)" file under one key; the resolver bridges them (Watch the Throne, 2026-09-04)', () => {
  assert.equal(explicitMapKey('Watch the Throne (Deluxe Version)'), explicitMapKey('Watch the Throne (Deluxe)'))
  const map = new Map<string, { id: number; trackCount?: number }>([
    [explicitMapKey('Watch the Throne (Deluxe)'), { id: 1440845249, trackCount: 17 }],
    [explicitMapKey('Watch the Throne'), { id: 1440848092, trackCount: 13 }],
  ])
  assert.deepEqual(resolveExplicitEdition('Watch the Throne (Deluxe Version)', 17, map), { id: 1440845249, trackCount: 17 })
  assert.deepEqual(resolveExplicitEdition('Watch the Throne', 13, map), { id: 1440848092, trackCount: 13 })
})
