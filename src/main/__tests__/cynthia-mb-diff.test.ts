// Cynthia MB-diff — unit tests against fixture lookup results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffAgainstMusicBrainz, type MbLookupResult } from '../cynthia-mb-diff.ts'
import type { CynthiaScanTrack } from '../cynthia-scan.ts'

let nextId = 1
function mk(overrides: Partial<CynthiaScanTrack>): CynthiaScanTrack {
  return {
    id: nextId++,
    title: 'Song', artist: 'Pink Floyd', album: 'The Wall', albumArtist: 'Pink Floyd',
    trackNumber: 1, trackCount: '', discNumber: 1, discCount: '',
    year: 1979, genre: 'Rock', duration: 200000,
    ...overrides,
  }
}

function mbFixture(overrides?: Partial<MbLookupResult>): MbLookupResult {
  return {
    artist: 'Pink Floyd',
    album: 'The Wall',
    chosenRelease: { id: 'x', title: 'The Wall', artist: 'Pink Floyd', date: '1979-11-30', country: 'GB', type: 'Album' },
    canonicalTracks: [
      { disc: 1, position: 1, title: 'In the Flesh?', durationSec: 199 },
      { disc: 1, position: 2, title: 'The Thin Ice', durationSec: 147 },
      { disc: 2, position: 1, title: 'Hey You', durationSec: 280 },
    ],
    canonicalTrackCount: 3,
    otherCandidates: [],
    ...overrides,
  }
}

test('exact match fills blank discCount/trackCount as provable', () => {
  const local = [
    mk({ title: 'In the Flesh?', trackNumber: 1, discNumber: 1 }),
    mk({ title: 'The Thin Ice', trackNumber: 2, discNumber: 1 }),
    mk({ title: 'Hey You', trackNumber: 1, discNumber: 2 }),
  ]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  assert.equal(r.exactMatch, true)
  const dcFills = r.findings.filter(f => f.field === 'discCount' && f.provable)
  assert.equal(dcFills.length, 3)
  assert.equal(dcFills[0].newValue, '2')
  const tcFills = r.findings.filter(f => f.field === 'trackCount' && f.provable)
  assert.equal(tcFills.length, 3)
})

test('fuzzy release match downgrades fills to judgment', () => {
  const r = diffAgainstMusicBrainz(
    [mk({ title: 'In the Flesh?' })],
    mbFixture({ chosenRelease: { id: 'x', title: 'The Wall (Deluxe)', artist: 'Pink Floyd', date: '2012-01-01', country: 'GB', type: 'Album' } }),
    { artist: 'Pink Floyd', album: 'The Wall' },
  )
  // '(Deluxe)' strips in normalization → still exact… use a truly different title:
  const r2 = diffAgainstMusicBrainz(
    [mk({ title: 'In the Flesh?' })],
    mbFixture({ chosenRelease: { id: 'x', title: 'The Wall Live', artist: 'Pink Floyd', date: '2000-01-01', country: 'GB', type: 'Album' } }),
    { artist: 'Pink Floyd', album: 'The Wall' },
  )
  assert.equal(r2.exactMatch, false)
  assert.ok(r2.findings.filter(f => f.field === 'discCount').every(f => !f.provable))
  void r
})

test('edition ambiguity (same title, different track count) kills provable', () => {
  const r = diffAgainstMusicBrainz(
    [mk({ title: 'In the Flesh?' })],
    mbFixture({ otherCandidates: [{ id: 'y', title: 'The Wall', artist: 'Pink Floyd', date: '2012-02-27', country: 'XE', trackCount: 33 }] }),
    { artist: 'Pink Floyd', album: 'The Wall' },
  )
  assert.equal(r.ambiguous, true)
  assert.ok(r.findings.every(f => !f.provable))
})

test('contradicting count values are judgment, never provable', () => {
  const local = [mk({ title: 'In the Flesh?', discCount: 1, trackCount: 9, discNumber: 1 })]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  const dc = r.findings.find(f => f.field === 'discCount')
  assert.ok(dc)
  assert.equal(dc!.provable, false)
  assert.equal(dc!.newValue, '2')
})

test('missing canonical tracks are listed with position + release attribution', () => {
  const local = [
    mk({ title: 'In the Flesh?', trackNumber: 1, discNumber: 1 }),
  ]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  assert.equal(r.missingTracks.length, 2)
  const heyYou = r.missingTracks.find(m => m.title === 'Hey You')
  assert.ok(heyYou)
  assert.equal(heyYou!.discNumber, 2)
  assert.match(heyYou!.reason, /1979/)
})

test('year mismatch flags but never emits a year fix', () => {
  const local = [mk({ title: 'In the Flesh?', year: 1980 })]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  assert.equal(r.findings.filter(f => f.field === 'year').length, 0)
  assert.ok(r.flags.some(f => f.detail.includes('1980')))
})

test('blank year gets a judgment fill from release date', () => {
  const local = [mk({ title: 'In the Flesh?', year: '' })]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  const y = r.findings.find(f => f.field === 'year')
  assert.ok(y)
  assert.equal(y!.newValue, '1979')
  assert.equal(y!.provable, false)
})

test('track-number mismatch on title-matched pair is a judgment renumber', () => {
  const local = [mk({ title: 'Hey You', trackNumber: 5, discNumber: 1 })]
  const r = diffAgainstMusicBrainz(local, mbFixture(), { artist: 'Pink Floyd', album: 'The Wall' })
  const tn = r.findings.find(f => f.field === 'trackNumber')
  assert.ok(tn)
  assert.equal(tn!.newValue, '1')
  assert.equal(tn!.provable, false)
  const dn = r.findings.find(f => f.field === 'discNumber')
  assert.ok(dn)
  assert.equal(dn!.newValue, '2')
})

test('duplicate canonical titles are unusable for renumber matching', () => {
  const fixture = mbFixture({
    canonicalTracks: [
      { disc: 1, position: 1, title: 'Intro', durationSec: 30 },
      { disc: 1, position: 5, title: 'Intro', durationSec: 31 },
      { disc: 1, position: 2, title: 'Real Song', durationSec: 200 },
    ],
  })
  const local = [mk({ title: 'Intro', trackNumber: 9 })]
  const r = diffAgainstMusicBrainz(local, fixture, { artist: 'Pink Floyd', album: 'The Wall' })
  assert.equal(r.findings.filter(f => f.field === 'trackNumber').length, 0)
})

test('error / empty lookup results are a clean no-op', () => {
  const r1 = diffAgainstMusicBrainz([mk({})], { error: 'MusicBrainz search failed: 503' }, { artist: 'A', album: 'B' })
  assert.equal(r1.findings.length, 0)
  const r2 = diffAgainstMusicBrainz([mk({})], { candidates: [] } as unknown as MbLookupResult, { artist: 'A', album: 'B' })
  assert.equal(r2.findings.length, 0)
})
