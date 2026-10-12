import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCandidates, rankCandidates, listenListPredicate } from '../radar-core.ts'
import { computeTasteFingerprint, getTasteAnchors } from '../taste-model.ts'

const rep = (n: number, t: Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ ...t, title: `t${i}` }))
const fp = computeTasteFingerprint([
  ...rep(10, { artist: 'Daft Punk', genre: 'House', year: 2013, playCount: 8 }),
  ...rep(12, { artist: 'Nirvana', genre: 'Grunge', year: 1991, playCount: 3 }),
])

describe('radar-core — parseCandidates', () => {
  it('parses a code-fenced JSON array', () => {
    const out = parseCandidates('```json\n[{"artist":"X","title":"Y"}]\n```')
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'X')
  })
  it('parses a bare array embedded in prose', () => {
    assert.equal(parseCandidates('Sure! [{"artist":"A","title":"B"}] enjoy').length, 1)
  })
  it('returns [] on garbage or empty', () => {
    assert.deepEqual(parseCandidates('no json here'), [])
    assert.deepEqual(parseCandidates(''), [])
  })
})

describe('radar-core — rankCandidates', () => {
  it('drops owned artists (discovery only)', () => {
    const out = rankCandidates(fp, [
      { artist: 'Daft Punk', title: 'Something New', genre: 'House', year: 2024 }, // owned
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // new
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'Overmono')
  })

  it('dedupes by artist+title and drops entries missing fields', () => {
    const out = rankCandidates(fp, [
      { artist: 'A', title: 'Song', genre: 'Electronic', year: 2024 },
      { artist: 'A', title: 'Song', genre: 'Electronic', year: 2024 }, // dupe
      { artist: '', title: 'No Artist' },                              // invalid
      { artist: 'B' },                                                 // no title
    ])
    assert.equal(out.length, 1)
  })

  it('sorts by score desc and respects the limit', () => {
    const out = rankCandidates(fp, [
      { artist: 'P', title: '1', genre: 'Polka', year: 1955 },     // off-taste
      { artist: 'R', title: '2', genre: 'Grunge', year: 2024 },    // rock match
      { artist: 'E', title: '3', genre: 'Electronic', year: 2024 }, // electronic match
    ], 2)
    assert.equal(out.length, 2)
    assert.ok(out[0].score >= out[1].score)
    assert.ok(out.every((c) => c.genre !== 'Polka'), 'weakest dropped by the limit')
  })

  it('drops candidates already on the list via isOnList (no re-suggesting jots)', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const onList = new Set(['overmono|goodlies'])
    const isOnList = (a: string, t: string) => onList.has(`${norm(a)}|${norm(t)}`)
    const out = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // on list → drop
      { artist: 'Jamie xx', title: 'Gosh', genre: 'Electronic', year: 2024 },      // new → keep
    ], 12, isOnList)
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'Jamie xx')
  })

  it('boosts candidates with a taste anchor', () => {
    const anchors = getTasteAnchors([
      ...rep(10, { artist: 'Daft Punk', genre: 'House', playCount: 8 }),
    ])
    const withAnchor = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023, anchor: 'Daft Punk', why: 'Same dancefloor energy as Daft Punk' },
    ], 12, undefined, anchors)
    const noAnchor = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 },
    ], 12, undefined, anchors)
    assert.ok(withAnchor[0].score > noAnchor[0].score)
    assert.ok(withAnchor[0].reasons.some((r) => /daft punk/i.test(r)))
  })
})

// The real Listen List guard (2026-10-11): index.ts looked the radar's
// (artist, title) up under a song|artist key, so it never matched and the
// radar kept re-suggesting songs already on the list.
describe('radar-core — listenListPredicate (the real Listen List key)', () => {
  const list = [
    { song: 'Good Lies', artist: 'Overmono' },
    { matchedTitle: 'Chamber of Reflection', matchedArtist: 'Mac DeMarco' }, // iTunes-matched only
  ]

  it('drops a radar candidate whose artist + title is already on the list', () => {
    const out = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // on list → drop
      { artist: 'Jamie xx', title: 'Gosh', genre: 'Electronic', year: 2024 },      // new → keep
    ], 12, listenListPredicate(list))
    assert.deepEqual(out.map((c) => c.artist), ['Jamie xx'])
  })

  it('matches through case, punctuation, and the iTunes-matched fields', () => {
    const isOnList = listenListPredicate(list)
    assert.equal(isOnList('OVERMONO', 'good lies!'), true)
    assert.equal(isOnList('Mac DeMarco', 'Chamber of Reflection'), true)
  })

  it('keys song first — the swapped pair is a different song', () => {
    assert.equal(listenListPredicate(list)('Good Lies', 'Overmono'), false)
    // The old lookup matched exactly this backwards row and nothing else.
    assert.equal(listenListPredicate([{ song: 'Overmono', artist: 'Good Lies' }])('Overmono', 'Good Lies'), false)
  })

  it('drops nothing when the list is empty or a row is missing a side', () => {
    assert.equal(listenListPredicate([])('Overmono', 'Good Lies'), false)
    assert.equal(listenListPredicate([{ song: 'Good Lies' }, { artist: 'Overmono' }])('Overmono', 'Good Lies'), false)
  })

  it('is what the radar IPC in index.ts hands rankCandidates (checked at the source)', () => {
    const index = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf-8')
    assert.match(index, /isOnList = listenListPredicate\(await readRecommendationsFile\(\)\)/)
    assert.match(index, /rankCandidates\(fp, parseCandidates\(text\), 24, isOnList, anchors\)/)
    assert.doesNotMatch(index, /recoIdentityKey\(/)
  })
})

it('pseudo-artists can never become taste anchors', () => {
  const tracks = [
    ...Array.from({ length: 60 }, (_, i) => ({ artist: `A${i}`, albumArtist: 'Various Artists', playCount: 9, genre: 'Rock' })),
    ...Array.from({ length: 8 }, () => ({ artist: 'Sublime', albumArtist: 'Sublime', playCount: 5, genre: 'Ska' })),
    { artist: 'X', albumArtist: 'Original Motion Picture Soundtrack', playCount: 40, genre: 'Score' },
  ]
  const anchors = getTasteAnchors(tracks, 8)
  const names = anchors.map((a) => a.artist.toLowerCase())
  assert.ok(names.includes('sublime'))
  assert.ok(!names.some((n) => n.includes('various') || n.includes('soundtrack')))
})
