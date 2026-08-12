/**
 * Artist album shelf — Migos must not collapse to two CLEAN hits.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickArtistAlbums,
  albumCollectionByName,
  isAlbumishCollection,
  albumNameKey,
} from '../../common/itunes-artist-albums.ts'

describe('pickArtistAlbums — artist catalogue shelf', () => {
  test('skips Apple Singles clutter', () => {
    assert.equal(isAlbumishCollection({ collectionType: 'Album', collectionName: 'Culture' }), true)
    assert.equal(isAlbumishCollection({ collectionType: 'Single', collectionName: 'Bad and Boujee' }), false)
    assert.equal(isAlbumishCollection({ collectionType: 'Album', collectionName: 'Bad and Boujee - Single' }), false)
  })

  test('explicit Culture II wins over cleaned when clean arrives first', () => {
    const rows = [
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Culture II',
        artistName: 'Migos',
        collectionId: 1440914594,
        collectionExplicitness: 'cleaned',
        releaseDate: '2018-01-26T08:00:00Z',
        trackCount: 24,
        artworkUrl100: 'https://example.com/100x100bb.jpg',
      },
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Culture II',
        artistName: 'Migos',
        collectionId: 1440907256,
        collectionExplicitness: 'explicit',
        releaseDate: '2018-01-26T08:00:00Z',
        trackCount: 24,
        artworkUrl100: 'https://example.com/100x100bb.jpg',
      },
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Culture',
        artistName: 'Migos',
        collectionId: 1615495955,
        collectionExplicitness: 'explicit',
        releaseDate: '2017-01-27T08:00:00Z',
        trackCount: 13,
      },
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Yung Rich Nation',
        artistName: 'Migos',
        collectionId: 999,
        collectionExplicitness: 'explicit',
        releaseDate: '2015-07-31T07:00:00Z',
        trackCount: 12,
      },
      {
        wrapperType: 'collection',
        collectionType: 'Single',
        collectionName: 'Bad and Boujee (feat. Lil Uzi Vert) - Single',
        artistName: 'Migos',
        collectionId: 111,
        collectionExplicitness: 'explicit',
      },
    ]
    const albums = pickArtistAlbums(rows)
    assert.equal(albums.length, 3, 'three albums, singles dropped')
    const culture2 = albums.find((a) => a.album === 'Culture II')
    assert.ok(culture2)
    assert.equal(culture2!.explicitness, 'explicit')
    assert.equal(culture2!.collectionId, 1440907256)
    assert.equal(albums[0].album, 'Culture II', 'newest first')
    const byName = albumCollectionByName(albums)
    assert.equal(byName.get(albumNameKey('Culture II'))?.id, 1440907256)
  })

  test('cleaned-only album stays cleaned (no silent drop)', () => {
    const albums = pickArtistAlbums([
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Only Clean Exists',
        artistName: 'Someone',
        collectionId: 42,
        collectionExplicitness: 'cleaned',
        releaseDate: '2020-01-01T00:00:00Z',
      },
    ])
    assert.equal(albums.length, 1)
    assert.equal(albums[0].explicitness, 'cleaned')
    assert.equal(albums[0].collectionId, 42)
  })

  test('notExplicit is not overwritten by cleaned', () => {
    const albums = pickArtistAlbums([
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Soft Record',
        artistName: 'Band',
        collectionId: 1,
        collectionExplicitness: 'notExplicit',
      },
      {
        wrapperType: 'collection',
        collectionType: 'Album',
        collectionName: 'Soft Record',
        artistName: 'Band',
        collectionId: 2,
        collectionExplicitness: 'cleaned',
      },
    ])
    assert.equal(albums.length, 1)
    assert.equal(albums[0].collectionId, 1)
    assert.equal(albums[0].explicitness, 'notExplicit')
  })
})
