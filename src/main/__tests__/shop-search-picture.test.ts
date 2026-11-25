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
import { libraryMarks, listMarks, ownedAlbumCount, ownedRecord, artistLine, albumFactsLine } from '../../common/shop-search.ts'
import { LIST_MARK } from '../../common/shop-names.ts'

const SRC = join(import.meta.dirname, '..', '..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const pf = (title: string, album: string, trackCount?: number, o: Record<string, unknown> = {}) => ({ title, artist: 'Pink Floyd', album, ...(trackCount ? { trackCount } : {}), ...o })
const lib = libraryMarks([
  // Dark Side, whole (10 of 10).
  ...['Speak to Me', 'Breathe', 'On the Run', 'Time', 'The Great Gig in the Sky', 'Money', 'Us and Them', 'Any Colour You Like', 'Brain Damage', 'Eclipse'].map((t) => pf(t, 'The Dark Side of the Moon', 10)),
  // Wish You Were Here, whole across two editions of it (5 of 5): one record.
  ...['Shine On You Crazy Diamond (Parts I-V)', 'Welcome to the Machine', 'Have a Cigar'].map((t) => pf(t, 'Wish You Were Here', 5)),
  ...['Wish You Were Here', 'Shine On You Crazy Diamond (Parts VI-IX)'].map((t) => pf(t, 'Wish You Were Here (2011 Remaster)', 5)),
  // The Wall by album artist, whole (tags say 2 on this test copy).
  { title: 'Comfortably Numb', artist: 'Various', albumArtist: 'Pink Floyd', album: 'The Wall', trackCount: 2 },
  { title: 'Hey You', artist: 'Pink Floyd', albumArtist: 'Pink Floyd', album: 'The Wall', trackCount: 2 },
  // One song from an album is a song, not the album.
  pf('Dogs', 'Animals', 5),
  // No size in the tags: one song isn't the album; two or more count.
  pf('One of These Days', 'Meddle'),
  // Radiohead: five single songs, each from another album.
  ...['Creep', 'Karma Police', 'No Surprises', 'Idioteque', 'Reckoner'].map((t, i) => ({ title: t, artist: 'Radiohead', album: ['Pablo Honey', 'OK Computer', 'OK Computer', 'Kid A', 'In Rainbows'][i], trackCount: 12 })),
  // Elton John on a various-artists record, whole: The Lion King is never his.
  ...['Circle of Life', 'Can You Feel the Love Tonight'].map((t) => ({ title: t, artist: 'Elton John', albumArtist: 'Various Artists', album: 'The Lion King', trackCount: 2 })),
  // A compilation flagged in its tags, whole: not an album of his either.
  { title: 'Your Song', artist: 'Elton John', album: 'Now 1970', trackCount: 1, compilation: true },
  { title: 'Loose Song', artist: 'Syd Barrett' },
])

describe('how many records you own by an artist (review of #492)', () => {
  it('only records you have whole, each once however many editions of it', () => {
    assert.equal(ownedAlbumCount(lib, 'Pink Floyd'), 3, 'Dark Side, Wish You Were Here (two editions = one), The Wall by album artist; not Animals (1 of 5), not Meddle (1 song, no size)')
    assert.equal(ownedAlbumCount(lib, 'pink floyd'), 3, 'by the shop’s name key, not the case')
  })
  it('single songs are songs, not albums', () => {
    assert.equal(ownedAlbumCount(lib, 'Radiohead'), 0)
    assert.equal(artistLine(lib, listMarks([]), 'Radiohead'), '5 songs in your library')
  })
  it('a various-artists record or a compilation is never the artist’s album', () => {
    assert.equal(ownedAlbumCount(lib, 'Elton John'), 0, 'The Lion King (Various Artists) and a flagged compilation')
    assert.equal(artistLine(lib, listMarks([]), 'Elton John'), '3 songs in your library')
  })
  it('the rule, alone', () => {
    const base = { albumArtist: '', artist: 'A' }
    assert.equal(ownedRecord({ ...base, have: 10, size: 10 }), true)
    assert.equal(ownedRecord({ ...base, have: 9, size: 10 }), false)
    assert.equal(ownedRecord({ ...base, have: 1, size: 0 }), false)
    assert.equal(ownedRecord({ ...base, have: 2, size: 0 }), true)
    assert.equal(ownedRecord({ have: 2, size: 2, albumArtist: 'Various Artists', artist: 'Various Artists' }), false)
    assert.equal(ownedRecord({ have: 2, size: 2, albumArtist: 'Someone Else', artist: 'A' }), false)
    assert.equal(ownedRecord({ ...base, have: 3, size: 3, compilation: true }), false)
  })
})

describe('the line under an artist', () => {
  const list = listMarks([{ kind: 'artist', artist: 'Wednesday' }])
  it('"You own N albums" first', () => {
    assert.equal(artistLine(lib, list, 'Pink Floyd'), 'You own 3 albums')
    const one = libraryMarks([{ title: 'a', artist: 'Low', album: 'Things We Lost in the Fire', trackCount: 1 }])
    assert.equal(artistLine(one, list, 'Low'), 'You own 1 album')
  })
  it('songs and no whole record: how many songs; on the list: the list; else nothing', () => {
    assert.equal(artistLine(lib, list, 'Syd Barrett'), '1 song in your library')
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

describe('the words and styles left behind (review of #492)', () => {
  it('a song you own says "In your library" on the album page too, never "In library"', () => {
    const page = src('renderer/views/DownloadStore/ShopAlbumPage.tsx')
    assert.doesNotMatch(page, />In library</)
    assert.match(page, /<span className="shop-own">In your library<\/span>/)
  })
  it('the facts line can end in an ellipsis (a block, not a flex row), and hi-res keeps its gold ring on the cover', () => {
    const css = src('renderer/views/DownloadStore/download-store.css')
    assert.match(css, /\.dl-rel-facts \{ display: block;[^}]*text-overflow: ellipsis;/)
    assert.match(src('renderer/views/DownloadStore/shop-search.css'), /\.dl-rel-frame \.shop-dot--hires \{ box-shadow: [^}]*rgba\(201, 162, 39/)
  })
  it('no rule left for a class nothing draws', () => {
    const css = src('renderer/views/DownloadStore/download-store.css')
    for (const gone of ['dl-rel-owned', 'dl-rel-count', 'dl-rel-panel-head', 'dl-track-num', 'dl-song-idx', 'dl-song-art', 'dl-song-year', 'dl-inlib']) assert.doesNotMatch(css, new RegExp(`\\.${gone}\\b`), gone)
  })
})
