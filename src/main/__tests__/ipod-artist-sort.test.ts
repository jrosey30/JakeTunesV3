import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  artistSortName,
  compareIpodArtistNames,
  ipodArtistSortKey,
  ipodArtistSortLabel,
  ipodFirmwareFold,
  orderAlbumsForIpodIndex,
  orderTracksForIpodArtistIndex,
  orderTracksForIpodTitleIndex,
  stampIpodSortArtist,
  uniqueGenresAz,
} from '../ipod-artist-sort.ts'

describe('ipod artist sort — Mini Music > Artists A–Z', () => {
  it('ignores a leading The / A / An and leading punctuation', () => {
    assert.equal(ipodArtistSortKey('The Beatles'), 'beatles')
    assert.equal(ipodArtistSortKey('A Tribe Called Quest'), 'tribe called quest')
    assert.equal(ipodArtistSortKey('Anberlin'), 'anberlin')
    assert.ok(artistSortName('“Weird Al” Yankovic').startsWith('weird al'))
    assert.equal(ipodArtistSortKey('...And You Will Know Us by the Trail of Dead'), 'and you will know us by the trail of dead')
  })

  it('prefers sortArtist when present', () => {
    assert.equal(ipodArtistSortKey('The Beatles', 'Beatles'), 'beatles')
    assert.equal(ipodArtistSortLabel('The Beatles', 'Beatles, The'), 'Beatles, The')
    assert.equal(ipodArtistSortLabel('The Beatles'), 'Beatles')
  })

  it('orders The-prefixed artists under the following letter, not T', () => {
    const names = ['The xx', 'Drake', 'The Beatles', '2Pac', 'A Tribe Called Quest', 'Daft Punk']
    const ordered = [...names].sort((a, b) => compareIpodArtistNames(a, b))
    assert.deepEqual(ordered, [
      '2Pac',
      'The Beatles',
      'Daft Punk',
      'Drake',
      'A Tribe Called Quest',
      'The xx',
    ])
  })

  it('orders a mixed activity set A–Z by artist, then album, then track', () => {
    const tracks = [
      { id: 1, artist: 'The Strokes', album: 'Is This It', trackNumber: 2, title: 'Soma' },
      { id: 2, artist: 'Daft Punk', album: 'Discovery', trackNumber: 1, title: 'One More Time' },
      { id: 3, artist: 'The Beatles', album: 'Abbey Road', trackNumber: 7, title: 'Here Comes The Sun' },
      { id: 4, artist: 'The Beatles', album: 'Abbey Road', trackNumber: 2, title: 'Something' },
      { id: 5, artist: 'A Tribe Called Quest', album: 'The Low End Theory', trackNumber: 1, title: 'Excursions' },
    ]
    const ordered = orderTracksForIpodArtistIndex(tracks)
    assert.deepEqual(ordered.map((t) => t.id), [4, 3, 2, 1, 5])
  })

  it('stamps sortArtist so the iTunesDB mhod 22 is the A–Z key', () => {
    const t = { artist: 'The Beatles', sortArtist: '' }
    stampIpodSortArtist(t)
    assert.equal(t.sortArtist, 'Beatles')
  })
})

describe('ipod firmware fold — type-52 Songs / Albums / Genres', () => {
  it('keeps leading The and folds ë→e like db_reader._fold', () => {
    assert.ok(ipodFirmwareFold('The End').startsWith('the '))
    assert.equal(ipodFirmwareFold('Tiësto'), 'tiesto')
    assert.equal(ipodFirmwareFold('Entrañas'), 'entranas')
    assert.ok(ipodFirmwareFold('The Dark Side of the Moon').startsWith('the '))
  })

  it('orders Songs A–Z by firmware-fold title (The End under T, not E)', () => {
    const tracks = [
      { id: 1, title: 'The End' },
      { id: 2, title: 'Taste' },
      { id: 3, title: 'Come Together' },
      { id: 4, title: 'One More Time' },
      { id: 5, title: 'Excursions' },
      { id: 6, title: 'Time' },
      { id: 7, title: 'Tiësto' },
    ]
    const ordered = orderTracksForIpodTitleIndex(tracks)
    assert.deepEqual(ordered.map((t) => t.title), [
      'Come Together',
      'Excursions',
      'One More Time',
      'Taste',
      'The End',
      'Tiësto',
      'Time',
    ])
  })

  it('prefers sortTitle as the fold input for Songs', () => {
    const ordered = orderTracksForIpodTitleIndex([
      { id: 1, title: 'Zebra', sortTitle: 'Apple' },
      { id: 2, title: 'Banana' },
    ])
    assert.deepEqual(ordered.map((t) => t.id), [1, 2])
  })

  it('orders Albums A–Z by title with The/A/An stripped (mhia, not type-52)', () => {
    const albums = orderAlbumsForIpodIndex([
      { artist: 'The Strokes', album: 'Is This It', albumArtist: 'The Strokes' },
      { artist: 'Daft Punk', album: 'Discovery', albumArtist: 'Daft Punk' },
      { artist: 'The Beatles', album: 'Abbey Road', albumArtist: 'The Beatles' },
      { artist: 'Pink Floyd', album: 'The Dark Side of the Moon', albumArtist: 'Pink Floyd' },
      { artist: 'A Tribe Called Quest', album: 'The Low End Theory', albumArtist: 'A Tribe Called Quest' },
    ])
    assert.deepEqual(albums.map((a) => a.album), [
      'Abbey Road',
      'The Dark Side of the Moon',
      'Discovery',
      'Is This It',
      'The Low End Theory',
    ])
  })

  it('prefers sortAlbum for the Albums mhia key', () => {
    const albums = orderAlbumsForIpodIndex([
      { artist: 'Z', album: 'Zebra', albumArtist: 'Z', sortAlbum: 'Apple' },
      { artist: 'A', album: 'Banana', albumArtist: 'A' },
    ])
    assert.equal(albums[0].album, 'Zebra')
  })

  it('orders Genres A–Z by firmware-fold genre name', () => {
    assert.deepEqual(uniqueGenresAz([
      { genre: 'Rock' },
      { genre: 'Electronic' },
      { genre: 'Hip-Hop' },
      { genre: 'Rock' },
      { genre: 'Pop' },
      { genre: 'electronic' },
    ]), ['Electronic', 'Hip-Hop', 'Pop', 'Rock'])
  })
})
