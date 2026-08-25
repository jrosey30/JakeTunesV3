/** The merged-work seam test: same album, same disc, consecutive tracks. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { albumAdjacent } from '../../common/album-adjacent.ts'

const t = (album: string, n: number, disc = 1, artist = 'Pink Floyd') => ({ album, artist, trackNumber: n, discNumber: disc })

describe('albumAdjacent', () => {
  test('consecutive same-disc tracks are adjacent', () => {
    assert.ok(albumAdjacent(t('The Wall', 3), t('The Wall', 4)))
  })
  test('non-consecutive, cross-album, cross-disc are not', () => {
    assert.ok(!albumAdjacent(t('The Wall', 3), t('The Wall', 5)))
    assert.ok(!albumAdjacent(t('The Wall', 3), t('Animals', 4)))
    assert.ok(!albumAdjacent(t('The Wall', 13, 1), t('The Wall', 1, 2)))   // disc break = physical gap
  })
  test('albumArtist beats artist for identity; missing numbers refuse', () => {
    const a = { album: 'Discovery', artist: 'Daft Punk feat. Todd', albumArtist: 'Daft Punk', trackNumber: 1 }
    const b = { album: 'Discovery', artist: 'Daft Punk', albumArtist: 'Daft Punk', trackNumber: 2 }
    assert.ok(albumAdjacent(a, b))
    assert.ok(!albumAdjacent({ album: 'X', artist: 'Y' }, { album: 'X', artist: 'Y', trackNumber: 2 }))
  })
})
