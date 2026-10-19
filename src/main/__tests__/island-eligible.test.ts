// TOP 10 ISLAND ALBUMS picker eligibility (renderer/utils/islandEligible.ts):
// complete albums only, judged by the desktop completeness doctrine
// (verifyLiveSetCompleteness) plus the phone's 3-track floor.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { islandEligible, ISLAND_MIN_TRACKS } from '../../renderer/utils/islandEligible.ts'
import type { Track } from '../../renderer/types.ts'

describe('islandEligible — complete albums only (the desktop completeness doctrine)', () => {
  const mk = (n: number, o: Partial<Track> = {}): Track => ({
    id: n, title: `Song ${n}`, path: 'p', album: 'Al', artist: 'Ar', albumArtist: 'Ar', genre: 'g', year: 2000,
    duration: 1000, dateAdded: '', playCount: 0, trackNumber: n, trackCount: 10, discNumber: 1, discCount: 1,
    fileSize: 1, rating: 0, ...o,
  } as Track)
  const album = (n: number, o: Partial<Track> = {}) => Array.from({ length: n }, (_, i) => mk(i + 1, { trackCount: n, ...o }))

  it('a whole, numbered album is eligible', () => {
    assert.equal(islandEligible(album(10)), true)
  })
  it('a gap disqualifies', () => {
    assert.equal(islandEligible(album(10).filter((t) => t.trackNumber !== 4)), false)
  })
  it('a short tail disqualifies (files declare more tracks than the library has)', () => {
    assert.equal(islandEligible(album(7).map((t) => ({ ...t, trackCount: 12 }))), false)
  })
  it('an untagged total gets the benefit of the doubt, like the phone', () => {
    assert.equal(islandEligible(album(9).map((t) => ({ ...t, trackCount: '' }))), true)
  })
  it(`fewer than ${ISLAND_MIN_TRACKS} tracks is a single, not an island album (phone minTracks)`, () => {
    assert.equal(islandEligible(album(2)), false)
    assert.equal(islandEligible(album(3)), true)
  })
  it('order of the input does not matter', () => {
    assert.equal(islandEligible(album(10).reverse()), true)
  })
})

// ── Slot ↔ library album (renderer/utils/islandSlots.ts) ──────────────────
import { islandPickOf, islandKeysOf, indexAlbumsForIsland, slotOfAlbum } from '../../renderer/utils/islandSlots.ts'
import { islandAlbumKey, type IslandSlot } from '../../common/synced-picks.ts'
import type { Album } from '../../renderer/utils/albumGroups.ts'

describe('island slots ↔ library albums', () => {
  const t = (o: Partial<Track>): Track => ({ id: 1, title: 's', path: 'p', album: 'Watch the Throne', artist: 'JAY-Z & Kanye West', albumArtist: '', genre: 'g', year: 2011, duration: 1, dateAdded: '', playCount: 0, trackNumber: 1, trackCount: 1, discNumber: 1, discCount: 1, fileSize: 1, rating: 0, ...o } as Track)
  const albumOf = (tr: Track): Album => ({ name: tr.album, artist: tr.albumArtist || tr.artist, artists: [tr.artist], year: tr.year, tracks: [tr] })
  const collab = albumOf(t({}))
  const tagged = albumOf(t({ album: 'Abbey Road', artist: 'The Beatles', albumArtist: 'The Beatles' }))
  const slots = (...v: IslandSlot[]): IslandSlot[] => [...v, ...Array(10 - v.length).fill(null)]

  it('the desktop writes the PRIMARY artist (the phone/backend album identity)', () => {
    assert.deepEqual(islandPickOf(collab), { artist: 'JAY-Z', album: 'Watch the Throne' })
    assert.deepEqual(islandPickOf(tagged), { artist: 'The Beatles', album: 'Abbey Road' })
  })
  it('a slot matches under EITHER artist form — never missing because of the spelling', () => {
    const idx = indexAlbumsForIsland([collab, tagged])
    assert.equal(idx.get(islandAlbumKey({ artist: 'JAY-Z', album: 'Watch the Throne' })), collab, "the phone's primary form")
    assert.equal(idx.get(islandAlbumKey({ artist: 'Jay-Z & Kanye West', album: 'watch the throne' })), collab, 'the desktop grouping form')
    assert.equal(idx.get(islandAlbumKey({ artist: 'the beatles', album: 'ABBEY ROAD' })), tagged)
    assert.equal(islandKeysOf(tagged).length, 1, 'one form when they agree')
  })
  it('slotOfAlbum finds the album on the shelf under either form', () => {
    assert.equal(slotOfAlbum(slots(null, { artist: 'JAY-Z', album: 'Watch the Throne' }), collab), 1)
    assert.equal(slotOfAlbum(slots(null, null, { artist: 'JAY-Z & Kanye West', album: 'Watch the Throne' }), collab), 2)
    assert.equal(slotOfAlbum(slots({ artist: 'Somebody', album: 'Else' }), collab), -1)
  })
})
