/**
 * Record Shop Phase 3, as Jake approved the picture (2026-11-24): results in
 * three groups, each saying what you own.
 *
 *  - Artists are rows: picture, name, "You own 6 albums", Open ›.
 *  - Albums are cards: "1973 · 10 songs", the lossless dot on the cover's
 *    corner, "In your library" when owned, else Save album and its edition.
 *  - Songs are rows: the song — its artist, its length, Save.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryMarks, listMarks, ownedAlbumCount, artistLine, albumFactsLine } from '../../common/shop-search.ts'
import { LIST_MARK } from '../../common/shop-names.ts'

const SRC = join(import.meta.dirname, '..', '..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const lib = libraryMarks([
  { title: 'Time', artist: 'Pink Floyd', album: 'The Dark Side of the Moon' },
  { title: 'Money', artist: 'Pink Floyd', album: 'The Dark Side of the Moon' },
  { title: 'Wish You Were Here', artist: 'Pink Floyd', album: 'Wish You Were Here' },
  { title: 'Have a Cigar', artist: 'Pink Floyd', album: 'Wish You Were Here (2011 Remaster)' },
  { title: 'Dogs', artist: 'Pink Floyd', album: 'Animals' },
  { title: 'Comfortably Numb', artist: 'Various', albumArtist: 'Pink Floyd', album: 'The Wall' },
  { title: 'Loose Song', artist: 'Syd Barrett' },
  { title: 'Song', artist: 'X', album: '' },
])

describe('how many records you own by an artist', () => {
  it('each record once, however many editions or songs of it', () => {
    assert.equal(ownedAlbumCount(lib, 'Pink Floyd'), 4, 'Dark Side, Wish You Were Here (two editions = one), Animals, The Wall by album artist')
    assert.equal(ownedAlbumCount(lib, 'pink floyd'), 4, 'by the shop’s name key, not the case')
    assert.equal(ownedAlbumCount(lib, 'Syd Barrett'), 0, 'a song with no album is no record')
    assert.equal(ownedAlbumCount(lib, 'Nobody'), 0)
  })
})

describe('the line under an artist', () => {
  const list = listMarks([{ kind: 'artist', artist: 'Wednesday' }])
  it('"You own N albums" first', () => {
    assert.equal(artistLine(lib, list, 'Pink Floyd'), 'You own 4 albums')
    const one = libraryMarks([{ title: 'a', artist: 'Low', album: 'Things We Lost in the Fire' }])
    assert.equal(artistLine(one, list, 'Low'), 'You own 1 album')
  })
  it('songs but no record: in your library; on the list: the list; else nothing', () => {
    assert.equal(artistLine(lib, list, 'Syd Barrett'), 'In your library')
    assert.equal(artistLine(lib, list, 'Wednesday'), LIST_MARK)
    assert.equal(artistLine(lib, list, 'Nobody'), null)
  })
})

describe('the facts under an album card', () => {
  it('year · songs, and EP or Single when it is one', () => {
    assert.equal(albumFactsLine({ year: 1973, count: 10, kind: 'ALBUM' }), '1973 · 10 songs')
    assert.equal(albumFactsLine({ year: 2019, count: 4, kind: 'EP' }), '2019 · EP · 4 songs')
    assert.equal(albumFactsLine({ year: 2020, count: 1, kind: 'SINGLE' }), '2020 · Single · 1 song')
  })
  it('only what Apple said', () => {
    assert.equal(albumFactsLine({ count: 5 }), '5 songs')
    assert.equal(albumFactsLine({ year: 1977 }), '1977')
    assert.equal(albumFactsLine({}), '')
  })
})

describe('the Search tab draws the picture', () => {
  const view = src('renderer/views/DownloadStore/DownloadView.tsx')
  const between = (a: string, b: string): string => view.slice(view.indexOf(a), view.indexOf(b, view.indexOf(a)))
  it('an artist is a row with its line and Open ›', () => {
    const artist = between('const renderArtist', '/** One of Jake')
    assert.match(artist, /const line = artistLine\(marks\.lib, marks\.list, a\.name\)/)
    assert.match(artist, />Open ›</)
    assert.match(view, /<div className="shop-artist-rows">\{ranked\.artists\.map/)
  })
  it('an album card: facts line, the dot on the cover, the artist only when not the one searched', () => {
    const card = between('const renderRelease', 'const renderArtist')
    assert.match(card, /<span className="dl-rel-facts">\{albumFactsLine\(\{ year, count, kind \}\)\}<\/span>/)
    const frame = card.slice(card.indexOf('<span className="dl-rel-frame">'), card.indexOf('</span>\n        <span className="dl-rel-title"'))
    assert.match(frame, /dotFor\('album'/, 'the lossless dot is on the cover')
    assert.doesNotMatch(card.slice(card.indexOf('dl-rel-title')), /dotFor\(/, 'and only there')
    assert.match(card, /byNamedArtist \? null : <span className="dl-rel-sub"/)
  })
  it('a song row: the song — its artist, length, Save; no index or cover', () => {
    const song = between('const renderSong', '// "Save album"')
    assert.match(song, /<span className="dl-song-name">\{s\.title\} <span className="dl-song-by">— \{s\.artist\}<\/span><\/span>/, 'the title gives way before the list mark')
    assert.match(song, /dl-song-dur/)
    assert.doesNotMatch(song, /dl-song-idx|dl-song-art/)
    assert.match(song, /renderAction\(qres, item\)/)
  })
})
