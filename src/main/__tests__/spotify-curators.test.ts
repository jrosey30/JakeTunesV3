/** Curator lane — id discovery, embed parsing, and the supply harvest gates. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPlaylistIds, parseEmbedTrackList } from '../spotify-curators.ts'
import { harvestCuratorSongs } from '../discover-supply.ts'

describe('extractPlaylistIds', () => {
  test('dedupes and caps ids from page html', () => {
    const html = 'x /playlist/AAAAAAAAAAAAAAAAAAAAAA y spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB /playlist/AAAAAAAAAAAAAAAAAAAAAA'
    assert.deepEqual(extractPlaylistIds(html), ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB'])
  })
})

describe('parseEmbedTrackList', () => {
  test('reads artist+title from __NEXT_DATA__', () => {
    const payload = { props: { pageProps: { state: { data: { entity: { trackList: [
      { title: 'Sometimes Always', subtitle: 'The Jesus and Mary Chain' },
      { title: '', subtitle: 'Nobody' },
    ] } } } } } }
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`
    assert.deepEqual(parseEmbedTrackList(html), [{ artist: 'The Jesus and Mary Chain', title: 'Sometimes Always' }])
  })
  test('no payload → empty, never a throw', () => {
    assert.deepEqual(parseEmbedTrackList('<html>nope</html>'), [])
  })
})

describe('harvestCuratorSongs', () => {
  const pool = [
    { artist: 'Cranes', title: 'Everywhere', curator: 'Agus Arcolia', playlist: 'If you like Mazzy Star' },
    { artist: 'Owned Band', title: 'Have It', curator: 'Agus Arcolia', playlist: 'P' },
    { artist: 'Junk Band', title: 'Hit (Live at Wembley)', curator: 'Agus Arcolia', playlist: 'P' },
  ]
  const deezerRow = (artist: string, title: string) => ({
    title, preview: 'https://cdnt-preview.dzcdn.net/p', id: 7,
    artist: { name: artist }, album: { cover_big: 'https://art' },
  })
  const deps = (rows: unknown[]) => ({
    fetchJson: async () => ({ data: rows }),
    ownsAlbum: () => false,
    ownsSong: (a: string) => a === 'Owned Band',
    ownsArtist: () => false,
  })
  test('resolves via strict Deezer match, attributes the curator + playlist', async () => {
    const out = await harvestCuratorSongs(pool, 5, deps([deezerRow('Cranes', 'Everywhere')]), 1)
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'Cranes')
    assert.equal(out[0].curated, 'Agus Arcolia · If you like Mazzy Star')
    assert.ok(out[0].previewUrl)
  })
  test('owned songs and live-junk titles never seat', async () => {
    const out = await harvestCuratorSongs(pool.slice(1), 5, deps([deezerRow('Junk Band', 'Hit (Live at Wembley)')]), 1)
    assert.equal(out.length, 0)
  })
  test('wrong-artist Deezer result never resolves', async () => {
    const out = await harvestCuratorSongs(pool.slice(0, 1), 5, deps([deezerRow('Some Cover Band', 'Everywhere')]), 1)
    assert.equal(out.length, 0)
  })
})
