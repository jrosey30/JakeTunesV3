// The library indexed by artist (2026-11-10). The artist page used to walk
// every track four times before its first frame (90–130 ms on 13,498 tracks);
// the index answers the same questions from maps built once per library. These
// tests hold it to the exact answers the old walks gave, and to being rebuilt
// when — and only when — the library or the alias map changes.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { artistLibraryIndex, tracksOfArtist, libraryAlbumFacts, trackIdSet, albumTitleForKey, prewarmArtistLibraryIndex } from '../../renderer/artistLibraryIndex.ts'
import { canonicalArtist, isSameArtist, artistIdentityKey, setUserAliases } from '../../renderer/utils/artistAlias.ts'
import { albumKeyFromStrings } from '../../renderer/utils/albumKey.ts'
import { collectAlbumFacts } from '../../common/release-sections.ts'
import { nameKey } from '../../common/fold-text.ts'
import type { Track } from '../../renderer/types.ts'
import { waitFor } from './wait-for.ts'

let nextId = 1
const T = (artist: string, album: string, title: string, extra: Partial<Track> = {}): Track => ({
  id: nextId++, title, path: `/m/${nextId}.m4a`, album, artist, albumArtist: artist, genre: 'Rock', year: 2020, duration: 200_000,
  dateAdded: '2024-01-01', playCount: 0, trackNumber: 1, trackCount: 10, discNumber: 1, discCount: 1, fileSize: 1, rating: 0, ...extra,
} as Track)

const library = (): Track[] => [
  T('Paul McCartney', 'RAM', 'Too Many People'),
  T('Wings', 'Band on the Run', 'Jet'),
  T('Paul McCartney & Wings', 'Venus and Mars', 'Listen to What the Man Said'),
  T('The Beatles', 'Abbey Road', 'Something'),
  T('Baby Rose feat. Elmiene', 'Slow Burn', 'One Last Dance'),
  T('Baby Rose', 'Through and Through', 'Water'),
  T('JAY-Z & Linkin Park', 'Collision Course', 'Numb/Encore', { contributingArtists: ['JAY-Z', 'Linkin Park'] }),
  T('Linkin Park', 'Meteora', 'Numb', { contributingArtists: ['Linkin Park'] }),
  T('geese', '3D Country', 'Cowboy Nudes'),
  T('Geese', 'Getting Killed', 'Taxes'),
  T('', 'Untitled', 'No Artist'),
  T('  ', 'Untitled', 'Blank Artist'),
]

/** The walks the page ran on every mount, verbatim from ArtistDetailView before 2026-11-10. */
const oldTracksOf = (tracks: Track[], artist: string): Track[] => {
  const canonicalActive = canonicalArtist(artist)
  return tracks.filter((t) => isSameArtist(t.artist || '', canonicalActive) || (t.contributingArtists || []).some((x) => isSameArtist(x || '', canonicalActive)))
}
const oldOwnedKeys = (tracks: Track[]): Set<string> => {
  const s = new Set<string>()
  for (const t of tracks) { const a = (t.artist || '').trim(); if (a) s.add(artistIdentityKey(canonicalArtist(a))) }
  return s
}

describe('the artist index answers exactly what the walks answered', () => {
  it('every track of an artist — aliases, feat. credits, contributors, case — in library order', () => {
    setUserAliases({})
    const lib = library()
    for (const artist of ['Paul McCartney', 'Wings', 'The Beatles', 'Baby Rose', 'JAY-Z', 'Linkin Park', 'Geese', 'GEESE', 'Nobody Here', 'Baby Rose feat. Elmiene']) {
      assert.deepEqual(tracksOfArtist(lib, canonicalArtist(artist)).map((t) => t.id), oldTracksOf(lib, artist).map((t) => t.id), artist)
    }
    assert.equal(tracksOfArtist(lib, 'Paul McCartney').length, 3, 'Wings and Paul McCartney & Wings are his')
    assert.equal(tracksOfArtist(lib, 'Linkin Park').length, 2, 'a collab counts once for each contributor')
    assert.deepEqual(tracksOfArtist(lib, ''), [])
  })
  it('which artists the library owns', () => {
    setUserAliases({})
    const lib = library()
    assert.deepEqual([...artistLibraryIndex(lib).ownedArtistKeys].sort(), [...oldOwnedKeys(lib)].sort())
  })
  it('a track by id, the album facts, an album title by its key', () => {
    const lib = library()
    assert.equal(artistLibraryIndex(lib).trackById.get(lib[3].id), lib[3])
    assert.deepEqual([...libraryAlbumFacts(lib, nameKey)], [...collectAlbumFacts(lib, nameKey)])
    assert.equal(albumTitleForKey(lib, albumKeyFromStrings('The Beatles', 'Abbey Road')), 'Abbey Road')
    assert.equal(albumTitleForKey(lib, 'nobody|||nothing'), null)
    assert.deepEqual([...trackIdSet(lib)], lib.map((t) => t.id))
  })
})

describe('built once per library, rebuilt when it changes', () => {
  it('the same library is answered from the same index (no walk)', () => {
    const lib = library()
    const first = artistLibraryIndex(lib)
    assert.equal(artistLibraryIndex(lib), first)
    assert.equal(libraryAlbumFacts(lib, nameKey), libraryAlbumFacts(lib, nameKey))
    assert.equal(tracksOfArtist(lib, 'Geese'), tracksOfArtist(lib, 'Geese'), 'even the list is the same object: memos downstream hold')
  })
  it('a changed library (the reducer hands out a new array) is never answered from the old index', () => {
    const lib = library()
    const before = tracksOfArtist(lib, 'Geese').length
    const grown = [...lib, T('Geese', 'Projector', 'Low Era')]
    assert.equal(tracksOfArtist(grown, 'Geese').length, before + 1)
    assert.equal(tracksOfArtist(lib, 'Geese').length, before, 'and the old array still answers for itself')
  })
  it('album facts are rebuilt for a changed library too', () => {
    const lib = library()
    const before = libraryAlbumFacts(lib, nameKey)
    const grown = [...lib, T('Geese', 'Projector', 'Low Era')]
    const after = libraryAlbumFacts(grown, nameKey)
    assert.notEqual(after, before)
    assert.equal(after.size, before.size + 1, 'the new album has its facts')
    assert.deepEqual([...after], [...collectAlbumFacts(grown, nameKey)])
    assert.equal(albumTitleForKey(grown, albumKeyFromStrings('Geese', 'Projector')), 'Projector')
    assert.equal(albumTitleForKey(lib, albumKeyFromStrings('Geese', 'Projector')), null)
    assert.equal(trackIdSet(grown).size, lib.length + 1)
  })
  it('a change to the alias map rebuilds it: the same library regroups', () => {
    setUserAliases({})
    const lib = library()
    assert.equal(tracksOfArtist(lib, 'The Beatles').length, 1)
    const stale = artistLibraryIndex(lib)
    setUserAliases({ geese: 'The Beatles' })
    try {
      assert.notEqual(artistLibraryIndex(lib), stale)
      assert.deepEqual(tracksOfArtist(lib, canonicalArtist('The Beatles')).map((t) => t.id), oldTracksOf(lib, 'The Beatles').map((t) => t.id))
      assert.equal(tracksOfArtist(lib, 'The Beatles').length, 3)
    } finally { setUserAliases({}) }
  })
  it('it is warmed off the click: prewarm builds it in idle time and can be cancelled', async () => {
    const lib = library()
    let ready = 0
    const cancel = prewarmArtistLibraryIndex(lib, nameKey, () => { ready++ })
    cancel()
    await new Promise((r) => setTimeout(r, 260))
    assert.equal(ready, 0, 'cancelled: the effect that scheduled it was torn down')
    let built: unknown
    prewarmArtistLibraryIndex(lib, nameKey, (index) => { ready++; built = index })
    await waitFor(() => ready === 1, 'the idle build')
    assert.equal(built, artistLibraryIndex(lib), 'the page then reads that same index')
    assert.equal(prewarmArtistLibraryIndex([], nameKey, () => { ready++ })(), undefined, 'an empty library schedules nothing')
  })
})

describe('WIRING: the page reads the index instead of walking the library', () => {
  const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
  it('no walk of every track is left in the page', () => {
    assert.match(view, /return tracksOfArtist\(lib\.tracks, canonicalArtist\(artist\)\)/)
    assert.match(view, /for \(const t of artistAllTracks\) \{\s+if \(regular && !regular\.has\(t\.id\)\) continue/)
    assert.match(view, /const ownedArtistKeys = libIndex\.ownedArtistKeys/)
    assert.match(view, /libraryAlbumFacts\(lib\.tracks, foldName\)/)
    assert.doesNotMatch(view, /lib\.tracks\.filter\(/)
    assert.doesNotMatch(view, /for \(const t of lib\.tracks\)/)
    assert.doesNotMatch(view, /for \(const t of regularTracks\)/)
    assert.doesNotMatch(view, /collectAlbumFacts\(lib\.tracks/)
  })
  it('the back label reads the album title from the same per-library map', () => {
    assert.match(readFileSync(join(import.meta.dirname, '../../renderer/hooks/useBackLabel.ts'), 'utf-8'), /albumTitleForKey\(lib\.tracks, albumKey\)/)
  })
})
