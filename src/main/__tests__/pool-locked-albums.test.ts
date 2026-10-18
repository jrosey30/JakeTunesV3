/**
 * Jake 2026-10-18: "all geese studio discography is to be locked in the
 * pool". Studio albums only (MusicBrainz: Album, no secondary type), exact
 * album titles, release order, live every sync.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCKED_IN_POOL, resolveLockedAlbumIds } from '../../common/pool-locked-albums.ts'

const T = (id: number, album: string, trackNumber: number, artist = 'Geese', discNumber = 1) =>
  ({ id, artist, album, trackNumber, discNumber })

test('Geese studio albums are the locked set', () => {
  const geese = LOCKED_IN_POOL.find((s) => s.artist === 'Geese')
  assert.deepEqual(geese?.albums, ['A Beautiful Memory', 'Projector', '3D Country', 'Getting Killed'])
})

test('only the studio albums ride — not the EP, live sets, singles or other artists', () => {
  const lib = [
    T(1, 'Getting Killed', 2), T(2, 'Getting Killed', 1),
    T(3, 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)', 1),
    T(4, '4D Country', 1), T(5, 'Alive & In Person', 1), T(6, 'Baby', 1),
    T(7, 'Projector', 1), T(8, '3D Country', 1), T(9, 'A Beautiful Memory', 1),
    T(10, 'Projector', 1, 'Cameron Winter'),
  ]
  const r = resolveLockedAlbumIds(lib)
  // release order, then track order
  assert.deepEqual(r.ids, [9, 7, 8, 2, 1])
  assert.deepEqual(r.sets, [{ label: 'Geese studio albums', count: 5, albumsFound: 4, albumsWanted: 4 }])
})

test('folded matching: case, accents and album-artist rows still match', () => {
  const r = resolveLockedAlbumIds([
    { id: 1, artist: 'GEESE', album: '3d country', trackNumber: 1 },
    { id: 2, artist: 'Various', albumArtist: 'Geese', album: 'Projector', trackNumber: 1 },
  ])
  assert.deepEqual(r.ids, [2, 1])
})

test('nothing locked in the library reports zero, never throws', () => {
  const r = resolveLockedAlbumIds([T(1, 'Something Else', 1, 'Someone')])
  assert.deepEqual(r.ids, [])
  assert.equal(r.sets[0].count, 0)
})
