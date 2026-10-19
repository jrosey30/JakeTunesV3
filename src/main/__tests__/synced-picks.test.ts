// Synced picks — the pure half (src/common/synced-picks.ts): validation the
// desktop applies before it PUTs, the tolerant read of whatever homemini
// serves, and the slot edits the shelf/row make (move / replace / dedupe).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ISLAND_ALBUMS_SPEC, FAVORITE_ARTISTS_SPEC, ISLAND_SLOT_COUNT, FAVORITE_ARTIST_SLOT_COUNT,
  validateIslandSlots, validateFavoriteArtists, parsePicksDoc, emptyPicksDoc, toWireDoc,
  placeInSlot, clearSlot, moveSlot, slotOf, firstEmptySlot, sameValues,
  islandAlbumKey, favoriteArtistKey, isPicksKind,
  type IslandSlot, type FavoriteSlot, type IslandAlbum,
} from '../../common/synced-picks.ts'

const nulls = <V,>(n: number): V[] => Array.from({ length: n }, () => null as V)
const islands = (...picks: Array<[number, string, string]>): IslandSlot[] => {
  const v = nulls<IslandSlot>(ISLAND_SLOT_COUNT)
  for (const [i, artist, album] of picks) v[i] = { artist, album }
  return v
}

describe('validateIslandSlots', () => {
  it('accepts exactly 10 slots of picks and nulls', () => {
    const r = validateIslandSlots(islands([0, 'Radiohead', 'OK Computer'], [9, 'Björk', 'Homogenic']))
    assert.equal(r.ok, true)
    if (r.ok) { assert.equal(r.values.length, 10); assert.deepEqual(r.values[0], { artist: 'Radiohead', album: 'OK Computer' }) }
  })

  it('refuses the wrong length and non-arrays', () => {
    assert.match((validateIslandSlots(nulls(9)) as { error: string }).error, /exactly 10 entries \(got 9\)/)
    assert.match((validateIslandSlots(nulls(11)) as { error: string }).error, /got 11/)
    assert.equal(validateIslandSlots({ slots: [] }).ok, false)
    assert.equal(validateIslandSlots(null).ok, false)
  })

  it('refuses empty / whitespace / missing artist or album', () => {
    for (const bad of [{ artist: '', album: 'X' }, { artist: 'A', album: '' }, { artist: '   ', album: 'X' }, { album: 'X' }, { artist: 'A' }, 'OK Computer', 7]) {
      const v = nulls<unknown>(10); v[3] = bad
      const r = validateIslandSlots(v)
      assert.equal(r.ok, false, JSON.stringify(bad))
      if (!r.ok) assert.match(r.error, /slot 4/)
    }
  })

  it('refuses the same album twice by nameKey(artist)|nameKey(album) — case, accents, punctuation', () => {
    const r = validateIslandSlots(islands([1, 'Beyoncé', 'Lemonade'], [6, 'BEYONCE', 'lemonade!']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /slots 2 and 7/)
  })

  it('the same title by different artists is two albums', () => {
    assert.equal(validateIslandSlots(islands([0, 'Weezer', 'Weezer'], [1, 'Peter Gabriel', 'Weezer'])).ok, true)
  })

  it('strips extra fields — only {artist, album} goes on the wire', () => {
    const v = nulls<unknown>(10); v[0] = { artist: 'A', album: 'B', trackIds: [1, 2], key: 'x' }
    const r = validateIslandSlots(v)
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.values[0], { artist: 'A', album: 'B' })
  })
})

describe('validateFavoriteArtists', () => {
  it('accepts exactly 5 of names and nulls', () => {
    assert.equal(validateFavoriteArtists(['Radiohead', null, 'Björk', null, null]).ok, true)
  })
  it('refuses wrong length, empty strings, non-strings', () => {
    assert.equal(validateFavoriteArtists(['a', 'b', 'c', 'd']).ok, false)
    assert.equal(validateFavoriteArtists(['a', '', null, null, null]).ok, false)
    assert.equal(validateFavoriteArtists(['a', '  ', null, null, null]).ok, false)
    assert.equal(validateFavoriteArtists(['a', 3, null, null, null]).ok, false)
  })
  it('refuses an artist twice by nameKey', () => {
    const r = validateFavoriteArtists(['Sigur Rós', null, 'sigur ros', null, null])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /slots 1 and 3/)
  })
})

describe('parsePicksDoc (tolerant read of what homemini serves)', () => {
  it('reads the contract shape', () => {
    const doc = parsePicksDoc(ISLAND_ALBUMS_SPEC, {
      version: 1, slots: islands([0, 'A', 'B']), updatedAt: '2026-10-18T12:00:00.000Z', updatedBy: 'phone',
    })
    assert.ok(doc)
    assert.equal(doc!.values.length, 10)
    assert.deepEqual(doc!.values[0], { artist: 'A', album: 'B' })
    assert.equal(doc!.updatedBy, 'phone')
    assert.equal(doc!.updatedAt, '2026-10-18T12:00:00.000Z')
  })
  it('forces the slot count: pads short, drops the overflow', () => {
    assert.equal(parsePicksDoc(ISLAND_ALBUMS_SPEC, { slots: [{ artist: 'A', album: 'B' }] })!.values.length, 10)
    assert.equal(parsePicksDoc(FAVORITE_ARTISTS_SPEC, { artists: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })!.values.length, 5)
  })
  it('a malformed entry is an empty slot; a duplicate keeps its FIRST slot', () => {
    const doc = parsePicksDoc(ISLAND_ALBUMS_SPEC, { slots: [{ artist: 'A', album: 'B' }, { artist: '' }, 'junk', { artist: 'a', album: 'b' }] })!
    assert.deepEqual(doc.values.slice(0, 4), [{ artist: 'A', album: 'B' }, null, null, null])
    assert.equal(validateIslandSlots(doc.values).ok, true, 'whatever we hold is valid to PUT back')
  })
  it('unknown updatedBy / missing timestamps read as null', () => {
    const doc = parsePicksDoc(FAVORITE_ARTISTS_SPEC, { artists: [], updatedBy: 'robot', updatedAt: '' })!
    assert.equal(doc.updatedBy, null)
    assert.equal(doc.updatedAt, null)
  })
  it('not a document → null', () => {
    assert.equal(parsePicksDoc(ISLAND_ALBUMS_SPEC, null), null)
    assert.equal(parsePicksDoc(ISLAND_ALBUMS_SPEC, { artists: [] }), null, 'wrong field for the kind')
    assert.equal(parsePicksDoc(ISLAND_ALBUMS_SPEC, '[]'), null)
  })
  it('toWireDoc round-trips', () => {
    const doc = { ...emptyPicksDoc(FAVORITE_ARTISTS_SPEC), values: ['X', null, null, null, null] as FavoriteSlot[] }
    const wire = toWireDoc(FAVORITE_ARTISTS_SPEC, doc)
    assert.deepEqual(Object.keys(wire).sort(), ['artists', 'updatedAt', 'updatedBy', 'version'])
    assert.deepEqual(parsePicksDoc(FAVORITE_ARTISTS_SPEC, wire), doc)
  })
})

describe('slot editing', () => {
  const k = (v: IslandAlbum) => islandAlbumKey(v)
  const ok = { artist: 'Radiohead', album: 'OK Computer' }
  const kid = { artist: 'Radiohead', album: 'Kid A' }

  it('placeInSlot fills a slot without touching the input', () => {
    const before = islands()
    const after = placeInSlot(before, 2, ok, k)
    assert.deepEqual(after[2], ok)
    assert.equal(before[2], null)
  })
  it('placeInSlot replaces what was there', () => {
    const after = placeInSlot(islands([4, 'Radiohead', 'OK Computer']), 4, kid, k)
    assert.deepEqual(after[4], kid)
    assert.equal(slotOf(after, k(ok), k), -1)
  })
  it('placeInSlot dedupes: the album leaves its old slot (phone IslandAlbumsPrefs.set)', () => {
    const after = placeInSlot(islands([1, 'radiohead', 'ok computer']), 7, ok, k)
    assert.equal(after[1], null)
    assert.deepEqual(after[7], ok)
    assert.equal(after.filter(Boolean).length, 1)
  })
  it('placeInSlot ignores an out-of-range slot', () => {
    assert.deepEqual(placeInSlot(islands(), 10, ok, k), islands())
    assert.deepEqual(placeInSlot(islands(), -1, ok, k), islands())
  })
  it('clearSlot empties one slot', () => {
    const after = clearSlot(islands([0, 'A', 'B'], [1, 'C', 'D']), 0)
    assert.equal(after[0], null)
    assert.deepEqual(after[1], { artist: 'C', album: 'D' })
  })
  it('moveSlot swaps with the neighbour, into an empty one too, and no-ops at the edges', () => {
    const v = islands([0, 'A', 'B'], [1, 'C', 'D'])
    const right = moveSlot(v, 0, 1)
    assert.deepEqual(right.slice(0, 2), [{ artist: 'C', album: 'D' }, { artist: 'A', album: 'B' }])
    const intoEmpty = moveSlot(v, 1, 1)
    assert.equal(intoEmpty[1], null)
    assert.deepEqual(intoEmpty[2], { artist: 'C', album: 'D' })
    assert.deepEqual(moveSlot(v, 0, -1), v)
    assert.deepEqual(moveSlot(islands([9, 'A', 'B']), 9, 1), islands([9, 'A', 'B']))
  })
  it('favorites: placeInSlot dedupes by nameKey', () => {
    const v: FavoriteSlot[] = ['Björk', null, null, null, null]
    const after = placeInSlot(v, 3, 'BJORK', favoriteArtistKey)
    assert.deepEqual(after, [null, null, null, 'BJORK', null])
  })
  it('firstEmptySlot / slotOf / sameValues', () => {
    assert.equal(firstEmptySlot(islands([0, 'A', 'B'])), 1)
    assert.equal(firstEmptySlot(Array.from({ length: 10 }, (_, i) => ({ artist: 'A', album: String(i) }))), -1)
    assert.equal(slotOf(islands([5, 'Beyoncé', 'Lemonade']), islandAlbumKey({ artist: 'beyonce', album: 'LEMONADE' }), k), 5)
    assert.equal(sameValues(islands([0, 'A', 'B']), islands([0, 'a', 'b!']), k), true)
    assert.equal(sameValues(islands([0, 'A', 'B']), islands([1, 'A', 'B']), k), false)
  })
  it('isPicksKind', () => {
    assert.equal(isPicksKind('island-albums'), true)
    assert.equal(isPicksKind('favorite-artists'), true)
    assert.equal(isPicksKind('recommendations'), false)
  })
  it('slot counts are the contract', () => {
    assert.equal(ISLAND_SLOT_COUNT, 10)
    assert.equal(FAVORITE_ARTIST_SLOT_COUNT, 5)
  })
})
