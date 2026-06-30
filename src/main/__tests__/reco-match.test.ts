import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  recoTitleMatches,
  recoArtistMatches,
  distinctArtistsForRecoTitle,
  shouldRejectRecoArtistCorrection,
  evaluateMusicManVerification,
} from '../reco-match.ts'

describe('recoTitleMatches', () => {
  it('matches Bonafide vs Bonafied spelling', () => {
    assert.ok(recoTitleMatches('Bonafide Lovin\'', 'Bonafied Lovin\''))
  })

  it('does not match unrelated titles', () => {
    assert.ok(!recoTitleMatches('Around the World', 'Red Alert (The Cube Guys Remix) [Mixed]'))
  })
})

describe('recoArtistMatches', () => {
  it('matches artist names differing only in article/preposition casing', () => {
    assert.ok(recoArtistMatches(
      'The Presidents of The United States Of America',
      'The Presidents Of the United States of America',
    ))
    assert.ok(recoArtistMatches('Florence and The Machine', 'Florence And the Machine'))
  })

  it('matches substring artist names', () => {
    assert.ok(recoArtistMatches('Daft Punk', 'Daft Punk'))
  })

  it('does not match unrelated artists', () => {
    assert.ok(!recoArtistMatches('Basement Jaxx', 'Daft Punk'))
    assert.ok(!recoArtistMatches('Modjo', 'Daft Punk'))
  })
})

describe('shouldRejectRecoArtistCorrection', () => {
  const aroundTheWorldRows = [
    { song: 'Around the World', artist: 'Daft Punk' },
    { song: 'Around the World', artist: 'Kings of Leon' },
    { song: 'Around the World (feat. Fetty Wap)', artist: 'Natalie La Rose' },
  ]

  const bonafideRows = [
    { song: 'Bonafied Lovin\'', artist: 'Chromeo' },
    { song: 'Bonafied Lovin\' (Yuksek Remix)', artist: 'Chromeo' },
  ]

  it('rejects famous-title wrong-artist hallucinations', () => {
    assert.ok(
      shouldRejectRecoArtistCorrection(
        'Around the World',
        'Basement Jaxx',
        'Daft Punk',
        aroundTheWorldRows,
      ),
    )
    assert.ok(
      shouldRejectRecoArtistCorrection('Around the World', 'Modjo', 'Daft Punk', aroundTheWorldRows),
    )
  })

  it('allows unambiguous title correction', () => {
    assert.ok(
      !shouldRejectRecoArtistCorrection(
        'Bonafide Lovin\'',
        'Röyksopp',
        'Chromeo',
        bonafideRows,
      ),
    )
  })
})

describe('distinctArtistsForRecoTitle', () => {
  it('counts multiple artists for ambiguous titles', () => {
    const artists = distinctArtistsForRecoTitle('Around the World', [
      { song: 'Around the World', artist: 'Daft Punk' },
      { song: 'Around the World', artist: 'Kings of Leon' },
    ])
    assert.equal(artists.length, 2)
  })
})

describe('evaluateMusicManVerification', () => {
  it('accepts strict MM credit when iTunes confirms artist+title', () => {
    const v = evaluateMusicManVerification({
      mm: { song: 'Lady (Hear Me Tonight)', artist: 'Modjo' },
      strictCredit: { matchedTitle: 'Lady (Hear Me Tonight)', matchedArtist: 'Modjo' },
      canonical: { matchedTitle: 'Lady (Hear Me Tonight)', matchedArtist: 'Modjo' },
      titleOnlyRows: [],
    })
    assert.equal(v.ok && v.mode, 'strict')
  })

  it('rejects Around the World + wrong artist', () => {
    const v = evaluateMusicManVerification({
      mm: { song: 'Around the World', artist: 'Basement Jaxx' },
      strictCredit: {},
      canonical: { matchedTitle: 'Around the World', matchedArtist: 'Daft Punk' },
      titleOnlyRows: [
        { song: 'Around the World', artist: 'Daft Punk' },
        { song: 'Around the World', artist: 'Kings of Leon' },
      ],
    })
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.reason, 'artist_hallucination')
  })

  it('corrects Bonafide Lovin when title is unambiguous', () => {
    const v = evaluateMusicManVerification({
      mm: { song: 'Bonafide Lovin\'', artist: 'Röyksopp' },
      strictCredit: {},
      canonical: { matchedTitle: 'Bonafied Lovin\'', matchedArtist: 'Chromeo' },
      titleOnlyRows: [{ song: 'Bonafied Lovin\'', artist: 'Chromeo' }],
    })
    assert.equal(v.ok && v.mode, 'corrected')
    if (v.ok) {
      assert.equal(v.artist, 'Chromeo')
    }
  })

  it('rejects Territorial Pissings credited to Smashing Pumpkins', () => {
    const territorialRows = [
      { song: 'Territorial Pissings', artist: 'Nirvana' },
      { song: 'Territorial Pissings', artist: 'Cherry Glazerr' },
      { song: 'Territorial Pissings', artist: 'Otep' },
      { song: 'Territorial Pissings', artist: 'White Reaper' },
    ]
    const v = evaluateMusicManVerification({
      mm: { song: 'Territorial Pissings', artist: 'Smashing Pumpkins' },
      strictCredit: {},
      canonical: { matchedTitle: 'Territorial Pissings', matchedArtist: 'Nirvana' },
      titleOnlyRows: territorialRows,
    })
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.reason, 'artist_hallucination')
  })
})
