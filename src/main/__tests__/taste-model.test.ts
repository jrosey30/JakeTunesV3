import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeTasteFingerprint, scoreCandidate } from '../taste-model.ts'

const rep = (n: number, t: Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ ...t, title: `t${i}` }))
const LIB = [
  ...rep(10, { artist: 'Daft Punk', genre: 'House', year: 2013, playCount: 8 }),
  ...rep(8, { artist: 'LCD Soundsystem', genre: 'Electronic', year: 2017, playCount: 5 }),
  ...rep(12, { artist: 'Nirvana', genre: 'Grunge', year: 1991, playCount: 3 }),
  ...rep(6, { artist: 'blink-182', genre: 'Punk', year: 1999, playCount: 2 }),
  ...rep(3, { artist: 'Some Pop', genre: 'Pop', year: 2008, playCount: 0 }),
]

describe('taste-model — fingerprint', () => {
  const fp = computeTasteFingerprint(LIB)

  it('counts the library and normalizes genre weights to 0..1', () => {
    assert.equal(fp.totalTracks, 39)
    assert.ok(fp.topGenres.length > 0)
    assert.equal(fp.topGenres[0].weight, 1, 'strongest genre is weight 1')
    assert.ok(fp.topGenres.every((g) => g.weight > 0 && g.weight <= 1))
  })

  it('groups genres into the right spines', () => {
    const names = fp.spines.map((s) => s.name)
    assert.ok(names.includes('Rock & Alternative'), 'grunge+punk → rock')
    assert.ok(names.includes('Electronic & Dance'), 'house+electronic → electronic')
  })

  it('ranks artists by plays and records owned artists (normalized)', () => {
    assert.equal(fp.topArtists[0].artist, 'Daft Punk') // most plays (10×8)
    assert.ok(fp.ownedArtists.includes('daftpunk'))
    assert.ok(fp.ownedArtists.includes('blink182'))
  })

  it('finds the peak decade and writes a prompt-ready summary', () => {
    assert.equal(typeof fp.peakDecade, 'number')
    assert.match(fp.summary, /tracks\./)
    assert.match(fp.summary, /Electronic|Rock/)
  })
})

describe('taste-model — scoreCandidate', () => {
  const fp = computeTasteFingerprint(LIB)

  it('scores a loved genre higher than an unknown one', () => {
    const loved = scoreCandidate(fp, { genre: 'House', year: 2014 })
    const unknown = scoreCandidate(fp, { genre: 'Polka', year: 1955 })
    assert.ok(loved.score > unknown.score, `${loved.score} > ${unknown.score}`)
    assert.ok(loved.reasons.length > 0)
  })

  it('flags artists already owned (skip in discovery)', () => {
    assert.equal(scoreCandidate(fp, { artist: 'Daft Punk', genre: 'House' }).owned, true)
    assert.equal(scoreCandidate(fp, { artist: 'Four Tet', genre: 'Electronic' }).owned, false)
  })

  it('credits a candidate in the peak era', () => {
    const peak = scoreCandidate(fp, { genre: 'House', year: String(fp.peakDecade) })
    assert.ok(peak.reasons.some((r) => /era/.test(r)))
  })
})
