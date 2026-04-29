// Tests for mobile/src/utils/groupBy.ts.
//
// albumKey is local-only (NEVER crosses the wire — see comment in
// groupBy.ts). These tests pin its current behavior so a future
// edit doesn't accidentally widen its scope.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { albumKey, groupByAlbum, groupByArtist } from '../utils/groupBy.ts'
import type { Track } from '../types.ts'

function track(over: Partial<Track> = {}): Track {
  return {
    id: 1,
    title: 't',
    path: 'p',
    album: 'Album',
    artist: 'Artist',
    albumArtist: 'Artist',
    genre: '',
    year: 2020,
    duration: 240_000,
    dateAdded: '',
    playCount: 0,
    trackNumber: 1,
    trackCount: 10,
    discNumber: 1,
    discCount: 1,
    fileSize: 1234,
    rating: 0,
    ...over,
  }
}

describe('albumKey', () => {
  test('lowercases and joins albumArtist::album', () => {
    assert.equal(
      albumKey(track({ albumArtist: 'Pink Floyd', album: 'The Wall' })),
      'pink floyd::the wall',
    )
  })

  test('falls back to artist when albumArtist missing', () => {
    assert.equal(
      albumKey(track({ albumArtist: '', artist: 'Pink Floyd', album: 'The Wall' })),
      'pink floyd::the wall',
    )
  })

  test('uses Unknown sentinel when both are missing', () => {
    assert.equal(
      albumKey(track({ albumArtist: '', artist: '', album: '' })),
      'unknown::unknown',
    )
  })

  test('two tracks with same album text but different case land on same key', () => {
    const a = albumKey(track({ albumArtist: 'Pink Floyd', album: 'The Wall' }))
    const b = albumKey(track({ albumArtist: 'PINK FLOYD', album: 'THE WALL' }))
    assert.equal(a, b)
  })
})

describe('groupByAlbum', () => {
  test('collapses tracks sharing albumKey', () => {
    const tracks = [
      track({ id: 1, albumArtist: 'Pink Floyd', album: 'The Wall', trackNumber: 1 }),
      track({ id: 2, albumArtist: 'Pink Floyd', album: 'The Wall', trackNumber: 2 }),
      track({ id: 3, albumArtist: 'Beatles', album: 'Abbey Road', trackNumber: 1 }),
    ]
    const groups = groupByAlbum(tracks)
    assert.equal(groups.length, 2)
    const wall = groups.find((g) => g.album === 'The Wall')
    assert.ok(wall)
    assert.equal(wall!.tracks.length, 2)
  })

  test('result is sorted by albumArtist then album', () => {
    const tracks = [
      track({ id: 1, albumArtist: 'Zappa', album: 'Hot Rats' }),
      track({ id: 2, albumArtist: 'Beatles', album: 'Revolver' }),
      track({ id: 3, albumArtist: 'Beatles', album: 'Abbey Road' }),
    ]
    const groups = groupByAlbum(tracks)
    assert.deepEqual(
      groups.map((g) => g.album),
      ['Abbey Road', 'Revolver', 'Hot Rats'],
    )
  })
})

describe('groupByArtist', () => {
  test('counts unique albums per artist (not unique tracks)', () => {
    const tracks = [
      track({ id: 1, albumArtist: 'Pink Floyd', album: 'The Wall' }),
      track({ id: 2, albumArtist: 'Pink Floyd', album: 'The Wall' }),
      track({ id: 3, albumArtist: 'Pink Floyd', album: 'Animals' }),
    ]
    const artists = groupByArtist(tracks)
    assert.equal(artists.length, 1)
    assert.equal(artists[0].artist, 'Pink Floyd')
    assert.equal(artists[0].albumCount, 2)
    assert.equal(artists[0].trackCount, 3)
  })

  test('sorts artists alphabetically', () => {
    const tracks = [
      track({ id: 1, albumArtist: 'Zappa', album: 'X' }),
      track({ id: 2, albumArtist: 'Beatles', album: 'Y' }),
      track({ id: 3, albumArtist: 'Mingus', album: 'Z' }),
    ]
    const artists = groupByArtist(tracks)
    assert.deepEqual(
      artists.map((a) => a.artist),
      ['Beatles', 'Mingus', 'Zappa'],
    )
  })
})
