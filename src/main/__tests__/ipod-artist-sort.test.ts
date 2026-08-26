import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  artistSortName,
  compareIpodArtistNames,
  ipodArtistSortKey,
  ipodArtistSortLabel,
  orderTracksForIpodArtistIndex,
  stampIpodSortArtist,
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
