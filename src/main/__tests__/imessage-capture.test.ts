import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMusicLinks, decodeAttributedBodyHex, classifyMusicLink,
  parseSpotifyTitle, parseAppleLookup, prettyHandle, normalizeMusicUrl,
  buildContactsIndex, senderName, appleDateToMs,
} from '../imessage-capture-core.ts'

describe('imessage-capture — extractMusicLinks', () => {
  it('finds spotify + apple music links in chatty text', () => {
    const text = 'yo listen to this https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123 so good'
    assert.deepEqual(extractMusicLinks(text), ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123'])
  })

  it('strips trailing punctuation the sender typed after the link', () => {
    assert.deepEqual(
      extractMusicLinks('check it: https://music.apple.com/us/album/graceland/1440833098?i=1440833102!!'),
      ['https://music.apple.com/us/album/graceland/1440833098?i=1440833102'],
    )
  })

  it('ignores non-music links, keeps multiple music links, dedupes repeats', () => {
    const text = 'https://nytimes.com/article https://open.spotify.com/track/abc https://spotify.link/xYz https://open.spotify.com/track/abc'
    assert.deepEqual(extractMusicLinks(text), ['https://open.spotify.com/track/abc', 'https://spotify.link/xYz'])
  })

  it('returns [] for linkless text', () => {
    assert.deepEqual(extractMusicLinks('just saying hi'), [])
  })
})

describe('imessage-capture — decodeAttributedBodyHex', () => {
  it('recovers a URL embedded in typedstream binary', () => {
    const url = 'https://open.spotify.com/track/xyz'
    const blob = Buffer.concat([Buffer.from([0x04, 0x0b, 0x81]), Buffer.from(url, 'ascii'), Buffer.from([0x86, 0x84])])
    const decoded = decodeAttributedBodyHex(blob.toString('hex'))
    assert.deepEqual(extractMusicLinks(decoded), [url])
  })

  it('rejects non-hex input', () => {
    assert.equal(decodeAttributedBodyHex('not hex!'), '')
  })
})

describe('imessage-capture — classifyMusicLink', () => {
  it('apple track via ?i= param', () => {
    assert.deepEqual(
      classifyMusicLink('https://music.apple.com/us/album/graceland/1440833098?i=1440833102'),
      { service: 'apple', kind: 'track', id: '1440833102' },
    )
  })

  it('apple song path', () => {
    assert.deepEqual(
      classifyMusicLink('https://music.apple.com/us/song/you-can-call-me-al/1440833102'),
      { service: 'apple', kind: 'track', id: '1440833102' },
    )
  })

  it('apple album without ?i=', () => {
    assert.deepEqual(
      classifyMusicLink('https://music.apple.com/us/album/graceland/1440833098'),
      { service: 'apple', kind: 'album', id: '1440833098' },
    )
  })

  it('spotify track / album / short link / intl path', () => {
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/track/abc'), { service: 'spotify', kind: 'track' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/album/def'), { service: 'spotify', kind: 'album' })
    assert.deepEqual(classifyMusicLink('https://spotify.link/xYz'), { service: 'spotify', kind: 'short' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/intl-de/track/abc'), { service: 'spotify', kind: 'track' })
  })

  it('playlists and artist pages are unknown (not one addable song)', () => {
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/playlist/abc'), { service: 'unknown' })
    assert.deepEqual(classifyMusicLink('https://music.apple.com/us/artist/paul-simon/78349'), { service: 'unknown' })
  })
})

describe('imessage-capture — parseSpotifyTitle', () => {
  it('track page', () => {
    assert.deepEqual(
      parseSpotifyTitle('You Can Call Me Al - song and lyrics by Paul Simon | Spotify'),
      { song: 'You Can Call Me Al', artist: 'Paul Simon' },
    )
  })

  it('album page', () => {
    assert.deepEqual(
      parseSpotifyTitle('Graceland - Album by Paul Simon | Spotify'),
      { album: 'Graceland', artist: 'Paul Simon' },
    )
  })

  it('rejects a homepage title', () => {
    assert.equal(parseSpotifyTitle('Spotify - Web Player'), null)
  })
})

describe('imessage-capture — parseAppleLookup', () => {
  it('track lookup', () => {
    const json = { results: [{ wrapperType: 'track', trackName: 'You Can Call Me Al', artistName: 'Paul Simon' }] }
    assert.deepEqual(parseAppleLookup(json), { song: 'You Can Call Me Al', artist: 'Paul Simon' })
  })

  it('album lookup (collection)', () => {
    const json = { results: [{ wrapperType: 'collection', collectionName: 'Graceland', artistName: 'Paul Simon' }] }
    assert.deepEqual(parseAppleLookup(json), { album: 'Graceland', artist: 'Paul Simon' })
  })

  it('empty results → null', () => {
    assert.equal(parseAppleLookup({ results: [] }), null)
    assert.equal(parseAppleLookup(null), null)
  })
})

describe('imessage-capture — sender naming', () => {
  it('maps phone handles to contact names (last-10-digit match)', () => {
    const idx = buildContactsIndex(['Brad Rosenbaum'], [['+1 (516) 555-1234']], [[]])
    assert.equal(senderName('+15165551234', idx), 'Brad Rosenbaum')
  })

  it('maps email handles case-insensitively', () => {
    const idx = buildContactsIndex(['Sarah'], [[]], [['Sarah@Example.com']])
    assert.equal(senderName('sarah@example.com', idx), 'Sarah')
  })

  it('unknown handle falls back to a readable number', () => {
    assert.equal(senderName('+15165551234', new Map()), '516-555-1234')
    assert.equal(prettyHandle('someone@example.com'), 'someone@example.com')
  })
})

describe('imessage-capture — url + date normalization', () => {
  it('same song with different tracking params is one capture', () => {
    assert.equal(
      normalizeMusicUrl('https://open.spotify.com/track/abc?si=one'),
      normalizeMusicUrl('https://open.spotify.com/track/abc?si=two'),
    )
  })

  it('apple ?i= track param survives normalization (album vs track differ)', () => {
    assert.notEqual(
      normalizeMusicUrl('https://music.apple.com/us/album/x/123?i=456'),
      normalizeMusicUrl('https://music.apple.com/us/album/x/123'),
    )
  })

  it('appleDateToMs handles ns and legacy seconds', () => {
    const APPLE_EPOCH_MS = 978307200000
    assert.equal(appleDateToMs(0), 0)
    assert.equal(appleDateToMs(86400), APPLE_EPOCH_MS + 86400_000)          // legacy seconds
    assert.equal(appleDateToMs(86400e9), APPLE_EPOCH_MS + 86400_000)       // modern nanoseconds
  })
})
