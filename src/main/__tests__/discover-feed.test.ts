/**
 * Discovery pick-quality doctrine (2026-08-21, "its really the brain picking
 * music for the record shop that isnt very good"):
 *
 *  - baseTitleKey: owning a recording blocks its demo/live/deluxe variants
 *    (the Kitchen Tape Demo reject), without collapsing legit titles.
 *  - filterFeed: base-identity owned-drop, guarded against self-titled
 *    albums (Weezer's five self-titled records all reduce to "weezer").
 *  - applyQualityFloor: no lane ships a card the brain doesn't believe in;
 *    thin lanes back-fill to a minimum but the 40 "no signal" sentinel
 *    never ships.
 *  - buildCandidateText: candidate embeds speak the library voice (genre +
 *    sonic desc), not a bare name-and-year stub.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseTitleKey, filterFeed, applyQualityFloor,
  BRAIN_FLOOR, BRAIN_HARD_FLOOR, BRAIN_LANE_MIN,
  type FeedCard,
} from '../discover-feed.ts'
import {
  buildCandidateText, adjustedCosine, cosineToPct,
  REJECT_MARGIN, REJECT_WEIGHT,
} from '../discovery-brain.ts'
import { discoverVerdicts, type LedgerRow } from '../discovery-learned.ts'

describe('baseTitleKey — recording identity', () => {
  test('demo variant collapses onto the owned base title', () => {
    assert.equal(
      baseTitleKey('Undone -- The Sweater Song (Kitchen Tape Demo)'),
      baseTitleKey('Undone - The Sweater Song'),
    )
  })
  test('live dash-suffix collapses; plain subtitles survive', () => {
    assert.equal(baseTitleKey('Song 2 - Live at Wembley'), baseTitleKey('Song 2'))
    assert.equal(baseTitleKey('Demolition - Part 1'), 'demolition part 1')
  })
  test('a song NAMED with a marker word never self-destructs', () => {
    assert.equal(baseTitleKey('Live and Let Die'), 'live and let die')
  })
  test('subtitle brackets collapse to the bare title (Lady / Hear Me Tonight)', () => {
    assert.equal(baseTitleKey('Lady (Hear Me Tonight)'), 'lady')
  })
  test('deluxe/expanded album editions collapse onto the base album', () => {
    assert.equal(
      baseTitleKey('Emperor Tomato Ketchup (Expanded Edition)'),
      baseTitleKey('Emperor Tomato Ketchup'),
    )
  })
  test('never returns empty for a real string', () => {
    assert.ok(baseTitleKey('(Untitled)').length > 0)
  })
})

const card = (over: Partial<FeedCard>): FeedCard => ({
  lane: 'songs', type: 'song', artist: 'X', title: 'Y', why: '', ...over,
})
const baseOpts = () => ({
  ownedArtists: new Set<string>(),
  ownedAlbumKeys: new Set<string>(),
  notForMe: {},
  served: {},
  now: 0,
})

describe('filterFeed — base-identity owned drop', () => {
  test('owning the song blocks its decorated variants', () => {
    const owned = new Set([`weezer|${baseTitleKey('Undone - The Sweater Song')}`])
    const out = filterFeed(
      [card({ artist: 'Weezer', title: 'Undone -- The Sweater Song (Kitchen Tape Demo)' })],
      { ...baseOpts(), ownedBaseKeys: owned },
    )
    assert.equal(out.length, 0)
  })
  test('self-titled guard: owning the Blue Album does not block the Green Album', () => {
    // Both "Weezer (Blue Album)" and "Weezer (Green Album)" base-reduce to
    // "weezer" == the artist key, which proves nothing — only exact keys count.
    const owned = new Set<string>()   // builder skips base==artist entries
    const out = filterFeed(
      [card({ type: 'album', artist: 'Weezer', title: 'Weezer (Green Album)' })],
      { ...baseOpts(), ownedBaseKeys: owned },
    )
    assert.equal(out.length, 1)
  })
  test('without ownedBaseKeys behavior is unchanged (back-compat)', () => {
    const out = filterFeed([card({ artist: 'A', title: 'B (Demo)' })], baseOpts())
    assert.equal(out.length, 1)
  })
})

describe('applyQualityFloor', () => {
  const scored = (lane: string, pcts: number[]): FeedCard[] =>
    pcts.map((p, i) => card({ lane, title: `t${i}`, brainPct: p }))

  test(`cards below ${BRAIN_FLOOR} are dropped from a healthy lane`, () => {
    const out = applyQualityFloor(scored('a', [90, 85, 70, 61, 59, 40]))
    assert.deepEqual(out.map((c) => c.brainPct), [90, 85, 70, 61])
  })
  test(`a thin lane back-fills to ${BRAIN_LANE_MIN} with its best ≥${BRAIN_HARD_FLOOR}`, () => {
    const out = applyQualityFloor(scored('a', [88, 57, 55, 53, 40]))
    assert.deepEqual(out.map((c) => c.brainPct).sort((x, y) => (y ?? 0) - (x ?? 0)), [88, 57, 55])
  })
  test('the 40 "no signal" sentinel never ships, even into an empty lane', () => {
    const out = applyQualityFloor(scored('a', [40, 40, 40]))
    assert.equal(out.length, 0)
  })
  test('lanes are floored independently', () => {
    const out = applyQualityFloor([...scored('a', [90, 45]), ...scored('b', [65])])
    assert.deepEqual(out.map((c) => `${c.lane}:${c.brainPct}`), ['a:90', 'b:65'])
  })
})

describe('buildCandidateText — the library voice', () => {
  test('album card carries the album: line, genre, and the sonic desc', () => {
    const text = buildCandidateText({
      artist: 'Can', title: 'Ege Bamyasi', year: '1972', type: 'album',
      genre: 'Krautrock', desc: 'Motorik groove that built the whole genre',
    })
    assert.deepEqual(text.split('\n'), [
      'Can — Ege Bamyasi',
      'album: Ege Bamyasi (1972)',
      'genre: Krautrock',
      'Motorik groove that built the whole genre',
    ])
  })
  test('song card uses year: line; empty fields add no lines', () => {
    assert.deepEqual(
      buildCandidateText({ artist: 'A', title: 'T', year: '2001', type: 'song' }).split('\n'),
      ['A — T', 'year: 2001'],
    )
    assert.equal(buildCandidateText({ artist: 'A', title: 'T' }), 'A — T')
  })
})

describe('adjustedCosine — rejections push scores down', () => {
  test('a far rejection is a no-op', () => {
    assert.equal(adjustedCosine(0.5, REJECT_MARGIN - 0.01), 0.5)
    assert.equal(adjustedCosine(0.5, 0), 0.5)
  })
  test('penalty scales with proximity past the margin', () => {
    assert.ok(Math.abs(adjustedCosine(0.5, 0.40) - (0.5 - REJECT_WEIGHT * 0.05)) < 1e-9)
  })
  test('sounding like rejected music lands under the quality floor', () => {
    // topK 0.50 would read ~89%; a 0.50-close rejection drags it to ~45%.
    const pct = cosineToPct(adjustedCosine(0.50, 0.50))
    assert.ok(pct < 60, `expected sub-floor, got ${pct}`)
  })
})

describe('discoverVerdicts — the scorer’s view of the ledger', () => {
  const row = (verdict: string, artist: string, title: string, surface = 'discover'): LedgerRow =>
    ({ surface, verdict, key: { artist, title }, ctx: { lane: 'songs', type: 'song' } })

  test('splits accepts and rejects; other surfaces and passes ignored', () => {
    const v = discoverVerdicts([
      row('accept', 'Stereolab', 'Emperor Tomato Ketchup'),
      row('reject', 'Weezer', 'Undone (Kitchen Tape Demo)'),
      row('pass', 'X', 'Y'),
      row('accept', 'Z', 'W', 'strip'),
    ])
    assert.deepEqual(v.accepts.map((a) => a.artist), ['Stereolab'])
    assert.deepEqual(v.rejects.map((r) => r.artist), ['Weezer'])
  })
  test('latest verdict per card wins — a later accept forgives a reject', () => {
    const v = discoverVerdicts([row('reject', 'A', 'T'), row('accept', 'A', 'T')])
    assert.equal(v.rejects.length, 0)
    assert.equal(v.accepts.length, 1)
  })
  test('rows without an artist are dropped', () => {
    const v = discoverVerdicts([{ surface: 'discover', verdict: 'accept', key: { title: 'only' } }])
    assert.equal(v.accepts.length + v.rejects.length, 0)
  })
})
