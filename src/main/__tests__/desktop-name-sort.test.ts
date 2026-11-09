/**
 * Jake, 2026-11-09: "why are artists with 'the' in them categorized as T??"
 *
 * The desktop's lists file "The Strokes" under S and "The Wall" under W, the
 * same as the iPods (#369). One rule, src/renderer/utils/artistSort.ts; the
 * song lists' Artist / Album columns compared the raw text, so every
 * "The ..." sat under T. These tests hold the rule and hold the views to it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  albumSortName,
  artistSectionLetter,
  compareAlbumNames,
  compareNames,
  sortTracksByName,
  trackAlbumSortName,
  trackArtistSortName,
} from '../../renderer/utils/artistSort.ts'
import { filingKey, filingLetter } from '../../renderer/views/RecordStore/stepinside/shopPlan.ts'

const src = (rel: string): string => readFileSync(join(import.meta.dirname, '../../renderer', rel), 'utf-8')

describe('name sort — "The" files under the next word', () => {
  it('artists: The Strokes between Steely Dan and Talking Heads', () => {
    const names = ['Talking Heads', 'The Strokes', 'Steely Dan', 'The Beatles', 'A Tribe Called Quest', 'Radiohead']
    assert.deepEqual([...names].sort(compareNames), ['The Beatles', 'Radiohead', 'Steely Dan', 'The Strokes', 'Talking Heads', 'A Tribe Called Quest'])
  })

  it('the header letter is the next word', () => {
    assert.equal(artistSectionLetter('The Strokes'), 'S')
    assert.equal(artistSectionLetter('The 1975'), '#')
    assert.equal(artistSectionLetter('Theory of a Deadman'), 'T')
    assert.equal(artistSectionLetter('a-ha'), 'A')
  })

  it('albums: same rule', () => {
    assert.equal(albumSortName('The Wall'), 'wall')
    const albums = ['Wish You Were Here', 'The Wall', 'Animals', 'A Night at the Opera']
    assert.deepEqual([...albums].sort(compareAlbumNames), ['Animals', 'A Night at the Opera', 'The Wall', 'Wish You Were Here'])
  })

  it('a row\'s sortArtist / sortAlbum wins when present', () => {
    assert.equal(trackArtistSortName({ artist: 'The The', sortArtist: 'The The' }), 'the')
    assert.equal(trackArtistSortName({ artist: 'Prince', sortArtist: 'Artist Formerly Known' }), 'artist formerly known')
    assert.equal(trackArtistSortName({ artist: 'The Strokes', sortArtist: '  ' }), 'strokes')
    assert.equal(trackAlbumSortName({ album: 'The Wall', sortAlbum: null }), 'wall')
    assert.equal(trackAlbumSortName({ album: 'Zebra', sortAlbum: 'Aardvark' }), 'aardvark')
  })

  it('song rows sort by Artist and Album both ways, ties kept in order', () => {
    const rows = [
      { id: 1, artist: 'Talking Heads', album: 'Remain in Light' },
      { id: 2, artist: 'The Strokes', album: 'Is This It' },
      { id: 3, artist: 'Steely Dan', album: 'Aja' },
      { id: 4, artist: 'The Strokes', album: 'Room on Fire' },
      { id: 5, artist: 'Pink Floyd', album: 'The Wall' },
    ]
    assert.deepEqual(sortTracksByName(rows, 'artist', 'asc').map((r) => r.id), [5, 3, 2, 4, 1])
    assert.deepEqual(sortTracksByName(rows, 'artist', 'desc').map((r) => r.id), [1, 2, 4, 3, 5])
    assert.deepEqual(sortTracksByName(rows, 'album', 'asc').map((r) => r.id), [3, 2, 1, 4, 5])
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5], 'input untouched')
  })

  it('the record store files by the same rule', () => {
    assert.equal(filingKey('The Beatles'), 'beatles')
    assert.equal(filingKey('A Tribe Called Quest'), 'tribe called quest')
    assert.equal(filingKey('Édith Piaf'), 'edith piaf')
    assert.equal(filingLetter('The Strokes'), 'S')
    assert.equal(filingLetter('"Weird Al" Yankovic'), 'W')
  })
})

describe('name sort — the views use the one helper', () => {
  it('Songs view (and its Grid / Cover Flow modes) sort Artist and Album with it', () => {
    const hook = src('hooks/useSortedTracks.ts')
    assert.match(hook, /from '\.\.\/utils\/artistSort'/)
    assert.match(hook, /if \(sortColumn === 'artist' \|\| sortColumn === 'album'\) return sortTracksByName\(/)
  })

  it('playlists and smart playlists too', () => {
    for (const f of ['views/PlaylistView.tsx', 'views/SmartPlaylistView.tsx']) {
      assert.match(src(f), /if \(sortCol === 'artist' \|\| sortCol === 'album'\) return sortTracksByName\(/, f)
    }
  })

  it('Artists page: A–Z order and its letters', () => {
    const v = src('views/ArtistsView.tsx')
    assert.match(v, /\.sort\(\(a, b\) => compareNames\(a\.name, b\.name\)\)/)
    assert.match(v, /group\(\(a\) => artistSectionLetter\(a\.name\)\)/)
  })

  it('Albums page orders with it', () => {
    assert.match(src('utils/albumGroups.ts'), /\.sort\(\(a, b\) => compareNames\(a\.name, b\.name\)\)/)
  })

  it('concerts and the record store use it', () => {
    assert.match(src('views/ConcertsView.tsx'), /return artistSortName\(band\)/)
    assert.match(src('views/RecordStore/stepinside/shopPlan.ts'), /artistSortName\(artist\)/)
  })

  it('no renderer list strips "The" by hand any more', () => {
    for (const f of ['views/ConcertsView.tsx', 'views/RecordStore/stepinside/shopPlan.ts', 'hooks/useSortedTracks.ts']) {
      assert.doesNotMatch(src(f), /replace\(\/\^the\\s\+\//i, f)
    }
  })
})
