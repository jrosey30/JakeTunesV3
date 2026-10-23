/**
 * Jake 2026-10-23: "lock in geese's getting killed and 3d country into the
 * ipod mini original. those 2 albums only" (was every studio album, 10-18).
 * Exact album titles, release order, live every sync.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCKED_IN_POOL, resolveLockedAlbumIds } from '../../common/pool-locked-albums.ts'

const T = (id: number, album: string, trackNumber: number, artist = 'Geese', discNumber = 1) =>
  ({ id, artist, album, trackNumber, discNumber })

test('3D Country and Getting Killed are the locked set — those two only', () => {
  const geese = LOCKED_IN_POOL.find((s) => s.artist === 'Geese')
  assert.deepEqual(geese?.albums, ['3D Country', 'Getting Killed'])
})

test('only those two ride — not the other albums, EP, live sets, singles or other artists', () => {
  const lib = [
    T(1, 'Getting Killed', 2), T(2, 'Getting Killed', 1),
    T(3, 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)', 1),
    T(4, '4D Country', 1), T(5, 'Alive & In Person', 1), T(6, 'Baby', 1),
    T(7, 'Projector', 1), T(8, '3D Country', 1), T(9, 'A Beautiful Memory', 1),
    T(10, 'Projector', 1, 'Cameron Winter'),
  ]
  const r = resolveLockedAlbumIds(lib)
  // release order, then track order
  assert.deepEqual(r.ids, [8, 2, 1])
  assert.deepEqual(r.sets, [{ label: 'Geese — 3D Country + Getting Killed', count: 3, albumsFound: 2, albumsWanted: 2 }])
})

test('folded matching: case, accents and album-artist rows still match', () => {
  const r = resolveLockedAlbumIds([
    { id: 1, artist: 'GEESE', album: '3d country', trackNumber: 1 },
    { id: 2, artist: 'Various', albumArtist: 'Geese', album: 'Getting Killed', trackNumber: 1 },
  ])
  assert.deepEqual(r.ids, [1, 2])
})

test('nothing locked in the library reports zero, never throws', () => {
  const r = resolveLockedAlbumIds([T(1, 'Something Else', 1, 'Someone')])
  assert.deepEqual(r.ids, [])
  assert.equal(r.sets[0].count, 0)
})
