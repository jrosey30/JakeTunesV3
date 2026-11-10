// Jake, 2026-11-10: "this is a common mistake, someone sends me a song, and
// they never enter the standings." Avery Allen texted a Spotify artist page
// and a playlist on 11/08. This Mac's capture knew only tracks and albums, so
// both became "texted song link" rows that homemini refused, and nothing a
// credit could ever be earned on existed. The links below are the real ones.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMusicLink } from '../imessage-capture-core.ts'
import {
  friendOfReco, withFriendInNote, computeImportCredits, computeAttributionCredits,
  sendsOfLinkRows, computeArtistSendCredits, artistSendRecoId, artistSendKey,
} from '../friend-imports-core.ts'
import { creditKindOf, computeStandings, computeAlbumCredits, type CreditRecord } from '../friend-standings-core.ts'
import { isHubNamedLink } from '../reco-kind-core.ts'
import { friendOf, linkOf, isLinkKind } from '../../renderer/listen-to-the-list/friend.ts'
import { recoKind, recoToQueueResult } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import { shopEntryFromLegacy } from '../../common/record-shop-adapters.ts'

const AVERY_ARTIST = 'https://open.spotify.com/artist/3WUUtA45g7X0jbeywZz888?si=0W4s7qXZSBG8O_G7NZVjjQ&utm_source=copy-link'
const AVERY_PLAYLIST = 'https://open.spotify.com/playlist/5zvaJt38Zq9FjP619wFrAx?si=CXv7v0FcRsKDw3m9YPAYWw&utm_source=copy-link&pi=e57sDZNORricG'
const SENT = '2026-11-08T15:12:26.405Z'

// The rows homemini makes of those two links.
const artistRow = { id: 'a1', kind: 'artist', artist: 'Anders Osborne', from: 'Avery Allen', link: AVERY_ARTIST, createdAt: SENT, artworkUrl: 'https://i.scdn.co/image/x' }
const playlistRow = {
  id: 'p1', kind: 'playlist', album: '7.11.2026', note: 'Playlist by sydneyallen_, 18 songs', from: 'Avery Allen', link: AVERY_PLAYLIST, createdAt: SENT,
  tracks: [{ title: "Picasso's Villa", artist: 'Anders Osborne' }, { title: 'Meet Me In New Mexico', artist: 'Anders Osborne' }, { title: 'Gone', artist: 'Jackie Greene' }],
}
const lib = (title: string, artist: string, dateAdded: string, album = '') => ({ title, artist, albumArtist: artist, album, dateAdded })

describe('the capture knows a link that is not one song', () => {
  it("Avery's artist page and playlist are pages for homemini, not unknown", () => {
    assert.deepEqual(classifyMusicLink(AVERY_ARTIST), { service: 'spotify', kind: 'page' })
    assert.deepEqual(classifyMusicLink(AVERY_PLAYLIST), { service: 'spotify', kind: 'page' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/episode/3cYB7rajViNsx8x02tibpC?si=x'), { service: 'spotify', kind: 'page' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/intl-de/artist/3WUUtA45g7X0jbeywZz888'), { service: 'spotify', kind: 'page' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/user/agusarcolia-ar'), { service: 'spotify', kind: 'page' })
    assert.deepEqual(classifyMusicLink('https://music.apple.com/us/artist/anders-osborne/761408'), { service: 'apple', kind: 'page' })
    assert.deepEqual(classifyMusicLink('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb'), { service: 'apple', kind: 'page' })
  })

  it('a song and an album are still read here', () => {
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/track/4f0xBbWvKWmuB17yebh24a?si=x'), { service: 'spotify', kind: 'track' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv'), { service: 'spotify', kind: 'album' })
    assert.deepEqual(classifyMusicLink('https://music.apple.com/us/album/graceland/1440833098?i=1440833102'), { service: 'apple', kind: 'track', id: '1440833102' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/'), { service: 'unknown' })
    assert.deepEqual(classifyMusicLink('https://open.spotify.com/artist/'), { service: 'unknown' })
  })

  it("a row homemini named from a link is kept as written, never run through the song enrichment", () => {
    assert.equal(isHubNamedLink(artistRow), true)
    assert.equal(isHubNamedLink(playlistRow), true)
    assert.equal(isHubNamedLink({ song: 'Sam Harris on X (The Prof G Pod)', note: 'https://open.spotify.com/episode/1', link: 'https://open.spotify.com/episode/1' }), true)
    assert.equal(isHubNamedLink({ kind: 'album', note: 'via Spotify', link: 'https://open.spotify.com/album/1' }), false)
    assert.equal(isHubNamedLink({ kind: 'track' }), false)
  })
})

describe("who sent a row: homemini's field first, the packed note second", () => {
  it('main and the renderer read the same sender', () => {
    for (const row of [
      { from: 'Avery Allen' },
      { note: 'texted song link · from Avery Allen · https://x.co' },
      { from: 'Avery Allen', note: 'Playlist by sydneyallen_, 18 songs' },
      { from: '  ', note: 'great tune · from Lorin Bloom' },
    ]) {
      assert.equal(friendOfReco(row), friendOf(row))
      assert.ok(friendOfReco(row))
    }
    assert.equal(friendOfReco({ note: 'sounds like something from the 80s' }), null)
    assert.equal(friendOf({}), null)
  })

  it('the link comes from the field, else the note; only http(s)', () => {
    assert.equal(linkOf(artistRow), AVERY_ARTIST)
    assert.equal(linkOf({ note: `texted song link · from Avery Allen · ${AVERY_ARTIST}` }), AVERY_ARTIST)
    assert.equal(linkOf({ link: 'javascript:alert(1)' }), null)
    assert.equal(linkOf({ note: 'no link here' }), null)
  })

  it('a song the phone added with "who sent it" earns its sender the point (it had no packed note)', () => {
    const row = { id: 'r1', song: 'Gone', artist: 'Jackie Greene', from: 'Lorin Bloom', createdAt: SENT }
    const tracks = [lib('Gone', 'Jackie Greene', '2026-11-09T10:00:00Z')]
    assert.deepEqual(computeImportCredits([row], tracks, new Set()), [], 'as it was: no sender, no credit')
    assert.deepEqual(computeImportCredits([withFriendInNote(row)], tracks, new Set()), [{ recoId: 'r1', friend: 'Lorin Bloom' }])
  })

  it('the note keeps its words, and a note that already names the sender is left alone', () => {
    assert.equal(withFriendInNote({ from: 'Avery Allen', note: 'so good' }).note, 'so good · from Avery Allen')
    const packed = { note: 'from Avery Allen · https://x.co' }
    assert.equal(withFriendInNote(packed), packed)
    const none = { song: 'x' }
    assert.equal(withFriendInNote(none), none)
  })

  it('an album the phone added from a friend earns the 5', () => {
    const row = { id: 'al1', kind: 'album', album: 'Above', artist: 'Mad Season', from: 'Jack Orlan', createdAt: SENT }
    const tracks = [lib('Wake Up', 'Mad Season', '2026-11-09T10:00:00Z', 'Above')]
    const friend = (note: string | undefined) => friendOfReco({ note })
    assert.equal(computeAlbumCredits([row], tracks, new Set(), friend).length, 0)
    assert.equal(computeAlbumCredits([withFriendInNote(row)], tracks, new Set(), friend).length, 1)
  })
})

describe('an artist or a playlist a friend sent can earn its point', () => {
  it('is not an album or a song to the old matchers', () => {
    assert.equal(creditKindOf(artistRow), null)
    assert.equal(creditKindOf(playlistRow), null, "a playlist's name sits where an album's does")
    assert.equal(creditKindOf({ kind: 'album', album: 'Above' }), 'album')
    assert.equal(creditKindOf({ song: 'x' }), 'song')
  })

  it('the rows stand for sends: one for the artist, one per song of the playlist', () => {
    const sends = sendsOfLinkRows([artistRow, playlistRow, { id: 's', song: 'x', artist: 'y', from: 'Avery Allen', createdAt: SENT }, { ...artistRow, from: undefined }])
    assert.deepEqual(sends, [
      { artist: 'Anders Osborne', friend: 'Avery Allen', at: SENT, url: AVERY_ARTIST },
      { song: "Picasso's Villa", artist: 'Anders Osborne', friend: 'Avery Allen', at: SENT, url: AVERY_PLAYLIST },
      { song: 'Meet Me In New Mexico', artist: 'Anders Osborne', friend: 'Avery Allen', at: SENT, url: AVERY_PLAYLIST },
      { song: 'Gone', artist: 'Jackie Greene', friend: 'Avery Allen', at: SENT, url: AVERY_PLAYLIST },
    ])
    assert.equal(artistSendKey(sends[0]), 'artist:andersosborne')
    assert.equal(artistSendKey(sends[1]), null, 'a song send is the song ledger\'s')
    assert.equal(artistSendRecoId(sends[0]), 'attr-artist:andersosborne:avery allen')
  })

  it('nothing imported, nothing earned: a send alone is not a point', () => {
    const sends = sendsOfLinkRows([artistRow, playlistRow])
    const before = [lib('Marmalade', 'Anders Osborne', '2026-10-01T00:00:00Z')]   // owned before the send
    assert.deepEqual(computeArtistSendCredits(sends, before, new Set(), new Set()), [])
    assert.deepEqual(computeAttributionCredits(sends, before, new Set(), new Set()), [])
  })

  it('a song from the playlist, imported after the send, is 1 point each', () => {
    const sends = sendsOfLinkRows([playlistRow])
    const tracks = [lib("Picasso's Villa", 'Anders Osborne', '2026-11-09T10:00:00Z'), lib('Gone', 'Jackie Greene', '2026-11-09T10:05:00Z'), lib('Other', 'Jackie Greene', '2026-11-09T10:05:00Z')]
    const hits = computeAttributionCredits(sends, tracks, new Set(), new Set())
    assert.deepEqual(hits.map((h) => [h.friend, h.label]), [['Avery Allen', "Picasso's Villa — Anders Osborne"], ['Avery Allen', 'Gone — Jackie Greene']])
  })

  it('an artist send is 1 point, once: the first song by them after the send', () => {
    const sends = sendsOfLinkRows([artistRow])
    const tracks = [
      lib('Marmalade', 'Anders Osborne', '2026-10-01T00:00:00Z'),
      lib('Got Your Heart', 'Anders Osborne', '2026-11-12T00:00:00Z'),
      lib('Life Don\'t Last That Long', 'Anders Osborne', '2026-11-11T00:00:00Z'),
      lib('Someone Else', 'Another Band', '2026-11-11T00:00:00Z'),
    ]
    const hits = computeArtistSendCredits(sends, tracks, new Set(), new Set())
    assert.deepEqual(hits, [{ recoId: 'attr-artist:andersosborne:avery allen', friend: 'Avery Allen', key: 'lifedontlastthatlong|andersosborne', label: "Life Don't Last That Long — Anders Osborne" }])
    assert.deepEqual(computeArtistSendCredits(sends, tracks, new Set([hits[0].recoId]), new Set()), [], 'never twice')
  })

  it('one import never pays twice: a playlist song by the sent artist counts for the playlist only', () => {
    const sends = sendsOfLinkRows([artistRow, playlistRow])
    const tracks = [lib("Picasso's Villa", 'Anders Osborne', '2026-11-09T10:00:00Z')]
    const songHits = computeAttributionCredits(sends, tracks, new Set(), new Set())
    assert.equal(songHits.length, 1)
    const covered = new Set(songHits.map((h) => `${h.friend.toLowerCase()}|${h.key}`))
    assert.deepEqual(computeArtistSendCredits(sends, tracks, new Set(), covered), [])
    // A second Anders Osborne song, not on the playlist, is the artist send's point.
    const more = [...tracks, lib('Marmalade', 'Anders Osborne', '2026-11-10T00:00:00Z')]
    assert.deepEqual(computeArtistSendCredits(sends, more, new Set(), covered).map((h) => h.label), ['Marmalade — Anders Osborne'])
  })

  it('a send with no readable date proves nothing', () => {
    assert.deepEqual(computeArtistSendCredits([{ artist: 'Anders Osborne', friend: 'Avery Allen', at: '' }], [lib('Marmalade', 'Anders Osborne', '2026-11-12T00:00:00Z')], new Set(), new Set()), [])
  })
})

describe("the standings keep Jake's rule: a point is an import", () => {
  const ledger = { 'avery allen': { name: 'Avery Allen', adds: 2, tossed: 0 } }

  it('two sends and no import: Avery is remembered, not seated', () => {
    assert.deepEqual(computeStandings([], ledger, []), [])
  })

  it('the artist credit seats Avery at 1, and deleting the song takes it back', () => {
    const record: CreditRecord = { recoId: 'attr-artist:andersosborne:avery allen', friend: 'Avery Allen', kind: 'song', label: 'Marmalade — Anders Osborne', keys: ['marmalade|andersosborne'], creditedAt: '2026-11-12T00:00:00Z' }
    const kept = computeStandings([record], ledger, [{ title: 'Marmalade', artist: 'Anders Osborne' }])
    assert.deepEqual(kept.map((r) => [r.name, r.points, r.adds]), [['Avery Allen', 1, 2]])
    assert.equal(computeStandings([record], ledger, [])[0].points, -1)
  })
})

describe('the list draws them as things to open', () => {
  it('an artist, a playlist and a page under its link are opened, not downloaded', () => {
    assert.equal(isLinkKind(artistRow), true)
    assert.equal(isLinkKind(playlistRow), true)
    assert.equal(isLinkKind({ note: 'https://www.tiktok.com/@a/video/1', link: 'https://www.tiktok.com/@a/video/1' }), true)
    assert.equal(isLinkKind({ kind: 'album', link: 'https://open.spotify.com/album/1', note: 'via Spotify' }), false)
    assert.equal(isLinkKind({ note: 'from Avery Allen' }), false)
  })

  it('a playlist is never an album to pick an edition of, nor a song to queue', () => {
    const row = { ...playlistRow, kind: 'playlist' as const }
    assert.equal(recoKind(row), 'artist')
    assert.equal(recoToQueueResult(row).kind, 'browse-only')
    assert.equal(recoToQueueResult({ ...artistRow, kind: 'artist' as const }).kind, 'browse-only')
    assert.equal(shopEntryFromLegacy(row).item.kind, 'note')
    assert.equal(shopEntryFromLegacy({ ...artistRow, kind: 'artist' as const }).item.kind, 'artist')
  })
})
