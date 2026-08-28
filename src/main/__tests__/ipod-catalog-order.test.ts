/** Mini 1.4.1 lists artists in mhit PHYSICAL order — this ordering IS the
 *  Artists menu. Pins: articles, accents, numeric track order, stability. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { orderForIpodCatalog, ipodArtistSortKey } from '../ipod-catalog-order.ts'

const t = (artist: string, album = '', trackNumber = 0, title = '') => ({ artist, album, trackNumber, title })

describe('ipodArtistSortKey', () => {
  test('leading articles fold away — The Beatles files under B', () => {
    assert.equal(ipodArtistSortKey('The Beatles'), 'beatles')
    assert.equal(ipodArtistSortKey('A Tribe Called Quest'), 'tribe called quest')
  })

  test('accents fold BEFORE the strip — Motorhead with umlaut under m', () => {
    assert.equal(ipodArtistSortKey('Motörhead'), 'motorhead')
    assert.equal(ipodArtistSortKey('Beyoncé'), 'beyonce')
  })

  test('"There" and "Anberlin" keep their letters — only whole articles fold', () => {
    assert.equal(ipodArtistSortKey('Therapy?'), 'therapy')
    assert.equal(ipodArtistSortKey('Anberlin'), 'anberlin')
  })
})

describe('orderForIpodCatalog', () => {
  test('artists come out alphabetical regardless of input order', () => {
    const out = orderForIpodCatalog([t('Weezer'), t('The Beatles'), t('blink-182'), t('Motörhead')])
    assert.deepEqual(out.map((x) => x.artist), ['The Beatles', 'blink-182', 'Motörhead', 'Weezer'])
  })

  test('within an artist: album, then NUMERIC track number', () => {
    const out = orderForIpodCatalog([
      t('Weezer', 'Blue Album', 10, 'Only in Dreams'),
      t('Weezer', 'Blue Album', 2, 'No One Else'),
      t('Weezer', 'Pinkerton', 1, 'Tired of Sex'),
      t('Weezer', 'Blue Album', 1, 'My Name Is Jonas'),
    ])
    assert.deepEqual(out.map((x) => `${x.album} ${x.trackNumber}`),
      ['Blue Album 1', 'Blue Album 2', 'Blue Album 10', 'Pinkerton 1'])
  })

  test('stable for full ties — equal keys keep input order', () => {
    const a = { artist: 'X', album: '', trackNumber: 0, title: '', tag: 1 }
    const b = { artist: 'X', album: '', trackNumber: 0, title: '', tag: 2 }
    assert.deepEqual(orderForIpodCatalog([a, b]).map((x) => x.tag), [1, 2])
  })

  test('missing artist falls to albumArtist, then Unknown Artist', () => {
    const out = orderForIpodCatalog([
      { artist: '', albumArtist: 'Zeta', album: '', trackNumber: 0, title: '' },
      { artist: 'Alpha', album: '', trackNumber: 0, title: '' },
    ])
    assert.deepEqual(out.map((x) => x.albumArtist || x.artist), ['Alpha', 'Zeta'])
  })
})
