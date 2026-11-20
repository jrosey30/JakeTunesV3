/**
 * Brief 256 — the Record Shop's search that finds things.
 *
 *  - Grouped answer: the artist named exactly first, then albums (their own
 *    records first, albums before EPs before singles), clean twins collapsed.
 *  - The artist page: own records only, Albums / EPs / Singles, newest first.
 *  - "In your library" / "On your list" marks, and the library strip above.
 *  - The lossless dot: parsed from one Qobuz answer, exact titles only,
 *    never a "no".
 *  - The answer cache's rules (fresh, shared in flight, failures quiet, LRU)
 *    and the concurrency limit.
 *  - main's grouped search: one answer per query kept, a throttled half not.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  rankShop, artistReleases, collapseCleanTwins, libraryMarks, ownedAlbum, ownsSong, ownsArtist, listMarks, listedAlbum, listedSong, listedArtist,
  markLine, pickLibraryHits, albumVariantTag, isArtistQuery, artistArtwork, releaseKind, displayAlbumTitle, baseAlbumTitle, appleAlbumRows, appleArtistRows,
  type ShopAlbum, type ShopArtist,
} from '../../common/shop-search.ts'
import { qobuzHitsOf, losslessIndex, losslessOf, losslessScope } from '../../common/shop-lossless.ts'
import { createAnswerCache, createLimiter } from '../../common/answer-cache.ts'
import { createShopFunnel } from '../../common/shop-funnel.ts'
import { scrubEvent } from '../../common/usage-log.ts'
import { editionsWithCard } from '../../renderer/views/DownloadStore/albumEditions.ts'
import { searchShopCatalog, shopArtistReleases, resetShopSearchCachesForTests } from '../shop-search.ts'
import { searchItunesSuggestions } from '../download-search.ts'

const album = (o: Partial<ShopAlbum> & { name: string }): ShopAlbum => ({ collectionId: Math.floor(Math.random() * 1e9), artist: 'Pink Floyd', artistId: 1, ...o })
const FLOYD: ShopArtist = { artistId: 1, name: 'Pink Floyd', genre: 'Rock' }

describe('grouped ranking (rankShop)', () => {
  it('puts the artist named exactly first, ahead of a better-ordered near name', () => {
    const r = rankShop('pink floyd', [{ artistId: 9, name: 'Pink Floyd Tribute Band' }, FLOYD, { artistId: 7, name: 'Pink' }], [])
    assert.equal(r.artists[0].name, 'Pink Floyd')
    // A karaoke / tribute act is no artist to show at all.
    assert.ok(!r.artists.some((a) => /tribute/i.test(a.name)) || r.artists[0].artistId === 1)
  })
  it('drops artists that do not match the words', () => {
    const r = rankShop('pink floyd', [FLOYD, { artistId: 3, name: 'Roger Waters' }], [])
    assert.deepEqual(r.artists.map((a) => a.name), ['Pink Floyd'])
  })
  it("ranks the named artist's own records first, albums before EPs before singles, Apple's order breaking ties", () => {
    const albums = [
      album({ name: 'Another Brick in the Wall - Single', trackCount: 1 }),
      album({ name: 'Wish You Were Here', trackCount: 5 }),
      album({ name: 'Arnold Layne - EP', trackCount: 4 }),
      album({ name: 'Pink Floyd Classics Played By Strings', artist: 'Studio Orchestra', artistId: 77 }),
      album({ name: 'The Dark Side of the Moon', trackCount: 10 }),
      album({ name: 'Animals', trackCount: 5 }),
      album({ name: 'The Wall', trackCount: 26 }),
    ]
    const r = rankShop('Pink Floyd', [FLOYD], albums)
    const names = r.albums.map((a) => a.name)
    assert.deepEqual(names.slice(0, 4), ['Wish You Were Here', 'The Dark Side of the Moon', 'Animals', 'The Wall'])
    assert.ok(names.indexOf('Wish You Were Here') < names.indexOf('Arnold Layne - EP'))
    assert.ok(names.indexOf('Arnold Layne - EP') < names.indexOf('Another Brick in the Wall - Single'))
    // Someone else's record that only names the band in its title comes after every own record.
    const other = names.indexOf('Pink Floyd Classics Played By Strings')
    assert.ok(other === -1 || other === names.length - 1)
  })
  it('finds an album by its title when no artist is named', () => {
    const r = rankShop('dark side of the moon', [], [album({ name: 'Animals' }), album({ name: 'The Dark Side of the Moon' })])
    assert.deepEqual(r.albums.map((a) => a.name), ['The Dark Side of the Moon'])
  })
  it('keeps the explicit edition of a clean twin, in the clean one’s place', () => {
    const rows = [
      album({ name: 'Culture', artist: 'Migos', artistId: 5, collectionId: 1, explicitness: 'cleaned' }),
      album({ name: 'Culture II', artist: 'Migos', artistId: 5, collectionId: 2, explicitness: 'explicit' }),
      album({ name: 'Culture', artist: 'Migos', artistId: 5, collectionId: 3, explicitness: 'explicit' }),
    ]
    const out = collapseCleanTwins(rows)
    assert.deepEqual(out.map((a) => a.collectionId), [3, 2])
  })
  it('never lets anything replace a record with nothing to censor', () => {
    const out = collapseCleanTwins([album({ name: 'X', collectionId: 1, explicitness: 'notExplicit' }), album({ name: 'X', collectionId: 2, explicitness: 'explicit' })])
    assert.deepEqual(out.map((a) => a.collectionId), [1])
  })
  it('reads an artist query with or without "the"', () => {
    assert.ok(isArtistQuery('beatles', 'The Beatles'))
    assert.ok(isArtistQuery('JAY Z', 'JAŸ-Z'))
    assert.ok(!isArtistQuery('when you die mgmt', 'MGMT'))
  })
  it('gives an artist the cover of one of their albums', () => {
    assert.equal(artistArtwork(FLOYD, [album({ name: 'A', artist: 'Other', artistId: 2, artworkUrl: 'x' }), album({ name: 'B', artworkUrl: 'y' })]), 'y')
  })
})

describe("Apple's rows", () => {
  it('maps album and artist rows, dropping junk acts', () => {
    const albums = appleAlbumRows([
      { wrapperType: 'collection', collectionId: 1, collectionName: 'Meddle', artistName: 'Pink Floyd', artistId: 1, releaseDate: '1971-10-30T07:00:00Z', trackCount: 6, collectionExplicitness: 'notExplicit', artworkUrl100: 'https://a/100x100bb.jpg' },
      { wrapperType: 'collection', collectionId: 2, collectionName: 'Pink Floyd Karaoke Hits', artistName: 'Karaoke Kings' },
      { wrapperType: 'track', trackName: 'x' },
    ])
    assert.equal(albums.length, 1)
    assert.equal(albums[0].releaseYear, 1971)
    assert.equal(albums[0].artworkUrl, 'https://a/200x200bb.jpg')
    const artists = appleArtistRows([{ wrapperType: 'artist', artistId: 1, artistName: 'Pink Floyd', primaryGenreName: 'Rock' }, { wrapperType: 'artist', artistId: 2, artistName: 'The Karaoke Channel' }])
    assert.deepEqual(artists, [{ artistId: 1, name: 'Pink Floyd', genre: 'Rock' }])
  })
  it('names release kinds and display titles as the Search tab always has', () => {
    assert.equal(releaseKind('Sundowning - EP', 7), 'EP')
    assert.equal(releaseKind('Bags - Single'), 'SINGLE')
    assert.equal(releaseKind('Lonely Song', 1), 'SINGLE')
    // A short record with no stamp is an album (Meddle has six songs).
    assert.equal(releaseKind('Meddle', 6), 'ALBUM')
    assert.equal(releaseKind('Big Record', 12), 'ALBUM')
    assert.equal(displayAlbumTitle("It's Nearly Over - Single"), "It's Nearly Over")
    assert.equal(baseAlbumTitle('Wish You Were Here (2011 Remaster)'), 'Wish You Were Here')
  })
})

describe('the artist page (artistReleases)', () => {
  it('groups own records Albums / EPs / Singles, newest first, guest spots out', () => {
    const rows = [
      album({ name: 'Meddle', releaseDate: '1971-10-30T07:00:00Z', trackCount: 6 }),
      album({ name: 'The Endless River', releaseDate: '2014-11-10T08:00:00Z', trackCount: 18 }),
      album({ name: 'Hey Hey Rise Up (feat. Andriy Khlyvnyuk) - Single', releaseDate: '2022-04-08T07:00:00Z', trackCount: 1 }),
      album({ name: 'Some Comp', artist: 'Various Artists', artistId: 99, releaseDate: '2020-01-01T00:00:00Z' }),
      album({ name: 'Arnold Layne - EP', releaseDate: '1967-03-10T08:00:00Z', trackCount: 4 }),
      album({ name: 'The Dark Side of the Moon', releaseDate: '1973-03-01T08:00:00Z', trackCount: 10 }),
    ]
    const r = artistReleases(rows, FLOYD)
    assert.deepEqual(r.albums.map((a) => a.name), ['The Endless River', 'The Dark Side of the Moon', 'Meddle'])
    assert.deepEqual(r.eps.map((a) => a.name), ['Arnold Layne - EP'])
    assert.deepEqual(r.singles.map((a) => a.name), ['Hey Hey Rise Up (feat. Andriy Khlyvnyuk) - Single'])
  })
})

describe('marks: in your library, on your list', () => {
  const lib = libraryMarks([
    { title: 'Money', artist: 'Pink Floyd', album: 'The Dark Side of the Moon' },
    { title: 'Time', artist: 'Pink Floyd', album: 'The Dark Side of the Moon' },
    { title: 'Shine On You Crazy Diamond', artist: 'Pink Floyd', album: 'Wish You Were Here' },
    { title: 'Ruby', artist: 'Kaiser Chiefs', album: 'Yours Truly, Angry Mob', albumArtist: 'Kaiser Chiefs' },
  ])
  it('says all of a record when Jake has as many songs as it holds, or the size is unknown', () => {
    assert.deepEqual(ownedAlbum(lib, 'Pink Floyd', 'The Dark Side of the Moon'), { state: 'all', have: 2 })
    assert.deepEqual(ownedAlbum(lib, 'Pink Floyd', 'The Dark Side of the Moon', 2), { state: 'all', have: 2 })
  })
  it('says some of it when he has fewer songs than the record holds', () => {
    assert.deepEqual(ownedAlbum(lib, 'Pink Floyd', 'The Dark Side of the Moon', 10), { state: 'some', have: 2 })
    assert.equal(markLine({ owned: ownedAlbum(lib, 'Pink Floyd', 'The Dark Side of the Moon', 10) }), '2 songs in your library')
  })
  it("finds his plain record under Apple's remaster name, and Apple's \" - Single\" under its name", () => {
    assert.ok(ownedAlbum(lib, 'Pink Floyd', 'Wish You Were Here (2011 Remaster)'))
    assert.equal(ownedAlbum(lib, 'Pink Floyd', 'Animals'), null)
  })
  it('marks songs and artists, folding accents and case', () => {
    assert.ok(ownsSong(lib, 'PINK FLOYD', 'money'))
    assert.ok(!ownsSong(lib, 'Pink Floyd', 'Us and Them'))
    assert.ok(ownsArtist(lib, 'pink floyd'))
    assert.ok(!ownsArtist(lib, 'Roger Waters'))
  })
  const list = listMarks([
    { kind: 'track', song: 'Us and Them', artist: 'Pink Floyd' },
    { kind: 'album', album: 'Animals (2018 Remix)', artist: 'Pink Floyd' },
    { kind: 'artist', artist: 'Wet Leg' },
    { kind: 'track', song: 'Done Already', artist: 'X', owned: true },
    { kind: 'playlist', album: 'Summer', artist: 'Avery' },
  ])
  it('marks what is jotted and not yet had', () => {
    assert.ok(listedSong(list, 'Pink Floyd', 'us and them'))
    assert.ok(listedAlbum(list, 'Pink Floyd', 'Animals'))
    assert.ok(listedArtist(list, 'Wet Leg'))
    assert.ok(!listedSong(list, 'X', 'Done Already'))
    assert.ok(!listedArtist(list, 'Avery'))
  })
  it('says the library first, then the list', () => {
    assert.equal(markLine({ owned: true, listed: true }), 'In your library')
    assert.equal(markLine({ owned: null, listed: true }), 'On your list')
    assert.equal(markLine({ owned: false, listed: false }), null)
    assert.equal(markLine({ owned: { state: 'some', have: 1 } }), '1 song in your library')
  })
})

describe('the library above the catalogue (pickLibraryHits)', () => {
  it('artists, then albums, then songs, only whole-word matches or better, at most six', () => {
    const hits = pickLibraryHits({
      artists: [{ row: 'Pink Floyd', score: 108 }, { row: 'Pinkerton Fan', score: 30 }],
      albums: [{ row: 'Meddle', score: 60 }, { row: 'Animals', score: 50 }, { row: 'Wall', score: 46 }, { row: 'More', score: 46 }],
      tracks: [{ row: 'Money', score: 90 }, { row: 'Time', score: 80 }, { row: 'Us', score: 20 }],
    })
    assert.deepEqual(hits.map((h) => `${h.kind}:${h.row}`), ['artist:Pink Floyd', 'album:Meddle', 'album:Animals', 'album:Wall', 'song:Money', 'song:Time'])
  })
  it('shows nothing for a weak match', () => {
    assert.deepEqual(pickLibraryHits({ artists: [{ row: 'a', score: 30 }], albums: [], tracks: [{ row: 'b', score: 20 }] }), [])
  })
})

describe('the lossless dot', () => {
  const body = {
    albums: { items: [
      { title: 'The Dark Side of the Moon', version: null, artist: { name: 'Pink Floyd' }, streamable: true, hires_streamable: true, maximum_bit_depth: 24 },
      { title: 'Animals', version: '2018 Remix', artist: { name: 'Pink Floyd' }, streamable: true, hires: false, maximum_bit_depth: 16 },
      { title: 'Meddle', artist: { name: 'Pink Floyd' }, streamable: false },
      { title: 'Abbey Road', artist: { name: 'Beatles' }, streamable: true },
    ] },
    tracks: { items: [
      { title: 'Money', performer: { name: 'Pink Floyd' }, streamable: true, maximum_bit_depth: 16 },
      { title: 'Time', performer: { name: 'Pink Floyd' }, streamable: false },
    ] },
  }
  const idx = losslessIndex(qobuzHitsOf(body))
  it('reads streamable items only', () => {
    assert.equal(qobuzHitsOf(body).length, 4)
    assert.deepEqual(qobuzHitsOf(null), [])
    assert.deepEqual(qobuzHitsOf({ albums: { items: [null, { title: 'x' }] } }), [])
  })
  it('says hi-res or lossless for an exact title by the same artist', () => {
    assert.equal(losslessOf(idx, 'album', 'Pink Floyd', 'The Dark Side of the Moon'), 'hires')
    assert.equal(losslessOf(idx, 'album', 'pink floyd', 'Animals'), 'lossless')
    assert.equal(losslessOf(idx, 'album', 'Pink Floyd', 'Animals (2018 Remix)'), 'lossless')
    assert.equal(losslessOf(idx, 'song', 'Pink Floyd', 'Money'), 'lossless')
    assert.equal(losslessOf(idx, 'album', 'The Beatles', 'Abbey Road'), 'lossless')
  })
  it("reads Apple's \" - Single\" stamp off an album title", () => {
    const i2 = losslessIndex([{ kind: 'album', artist: 'Bags', title: 'Hello' }])
    assert.equal(losslessOf(i2, 'album', 'Bags', 'Hello - Single'), 'lossless')
  })
  it('never says anything about a row the answer does not name (unknown is no dot, never "no")', () => {
    assert.equal(losslessOf(idx, 'album', 'Pink Floyd', 'Meddle'), null)
    assert.equal(losslessOf(idx, 'song', 'Pink Floyd', 'Time'), null)
    assert.equal(losslessOf(idx, 'album', 'Pink Floyd', 'The Dark Side of the Moon (50th Anniversary)'), null)
    assert.equal(losslessOf(idx, 'album', 'Roger Waters', 'The Dark Side of the Moon'), null)
    assert.equal(losslessOf(undefined, 'album', 'Pink Floyd', 'Animals'), null)
  })
  it('asks once for words written differently', () => {
    assert.equal(losslessScope('Pink Floyd '), losslessScope('pink  floyd'))
  })
})

describe('answer cache and limiter', () => {
  let t = 0
  const now = () => t
  beforeEach(() => { t = 1000 })
  it('keeps a fresh answer and asks again after it expires', async () => {
    const c = createAnswerCache<number>({ ttlMs: 100, failQuietMs: 50, maxEntries: 10, now })
    let asked = 0
    const f = async () => ++asked
    assert.equal(await c.ask('a', f), 1)
    assert.equal(await c.ask('a', f), 1)
    t += 100
    assert.equal(await c.ask('a', f), 2)
  })
  it('shares one request between callers asking at once', async () => {
    const c = createAnswerCache<number>({ ttlMs: 100, failQuietMs: 50, maxEntries: 10, now })
    let asked = 0
    const f = async () => { asked++; await new Promise((r) => setTimeout(r, 5)); return 7 }
    const [x, y] = await Promise.all([c.ask('a', f), c.ask('a', f)])
    assert.deepEqual([x, y, asked], [7, 7, 1])
  })
  it('stores no answer for a failure, and leaves it alone for a while unless forced', async () => {
    const c = createAnswerCache<number>({ ttlMs: 100, failQuietMs: 50, maxEntries: 10, now })
    let asked = 0
    const fail = async () => { asked++; return null }
    assert.equal(await c.ask('a', fail), null)
    assert.equal(c.get('a'), undefined)
    assert.equal(await c.ask('a', fail), null)
    assert.equal(asked, 1)
    assert.ok(c.quiet('a'))
    assert.equal(await c.ask('a', async () => 3, { force: true }), 3)
    const thrower = async (): Promise<number | null> => { throw new Error('x') }
    assert.equal(await c.ask('b', thrower), null)
    t += 50
    assert.equal(await c.ask('b', async () => 4), 4)
  })
  it('drops the oldest answer past its size', async () => {
    const c = createAnswerCache<number>({ ttlMs: 1000, failQuietMs: 50, maxEntries: 2, now })
    await c.ask('a', async () => 1); await c.ask('b', async () => 2); c.put('c', 3)
    assert.equal(c.size(), 2)
    assert.equal(c.get('a'), undefined)
    assert.equal(c.get('c'), 3)
  })
  it('runs at most n tasks at once, in order', async () => {
    const turn = createLimiter(2)
    let active = 0, peak = 0
    const order: number[] = []
    await Promise.all([1, 2, 3, 4, 5].map((n) => turn(async () => {
      active++; peak = Math.max(peak, active); order.push(n)
      await new Promise((r) => setTimeout(r, 3))
      active--
    })))
    assert.equal(peak, 2)
    assert.deepEqual(order, [1, 2, 3, 4, 5])
  })
})

describe('the album page’s editions (editionsWithCard)', () => {
  const ed = (id: number) => ({ collectionId: id, name: `E${id}`, label: 'Standard', trackCount: 9 })
  it('keeps the clicked edition among them, first when Apple’s list lacks it', () => {
    assert.deepEqual(editionsWithCard([ed(1), ed(2)], ed(2)).map((e) => e.collectionId), [1, 2])
    assert.deepEqual(editionsWithCard([ed(1)], ed(3)).map((e) => e.collectionId), [3, 1])
    assert.deepEqual(editionsWithCard([ed(1)], null).map((e) => e.collectionId), [1])
  })
})

describe('usage log: artists shown, no words', () => {
  it('adds the artist count to shop.search and loses nothing to the scrubber', () => {
    let t = 0
    const f = createShopFunnel(() => t)
    f.searched({ len: 10, hits: 25, songs: 10, albums: 12, artists: 1, answerMs: 300, how: 'typed' })
    f.saved('album')
    t = 5000
    const ev = f.left()!
    assert.equal(ev.detail.artists, 1)
    const clean = scrubEvent({ t: new Date(0).toISOString(), ...ev }, 0)!
    assert.deepEqual(clean.detail, ev.detail)
  })
})

describe("main's grouped search", () => {
  const realFetch = globalThis.fetch
  let calls: string[] = []
  let throttleAlbums = false
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
  beforeEach(() => {
    resetShopSearchCachesForTests()
    calls = []
    throttleAlbums = false
    globalThis.fetch = (async (u: string | URL) => {
      const url = String(u)
      calls.push(url)
      if (url.includes('entity=musicArtist')) return json({ results: [{ wrapperType: 'artist', artistId: 1, artistName: 'Pink Floyd', primaryGenreName: 'Rock' }] })
      if (url.includes('entity=album&limit=50')) {
        if (throttleAlbums) return new Response('', { status: 403 })
        return json({ results: [
          { wrapperType: 'collection', collectionId: 11, collectionName: 'The Wall', artistName: 'Pink Floyd', artistId: 1, trackCount: 26, collectionExplicitness: 'notExplicit' },
          { wrapperType: 'collection', collectionId: 12, collectionName: 'The Dark Side of the Moon', artistName: 'Pink Floyd', artistId: 1, trackCount: 10, collectionExplicitness: 'notExplicit' },
        ] })
      }
      if (url.includes('lookup?id=1&entity=album')) return json({ results: [
        { wrapperType: 'artist', artistId: 1, artistName: 'Pink Floyd', primaryGenreName: 'Rock' },
        { wrapperType: 'collection', collectionId: 12, collectionName: 'The Dark Side of the Moon', artistName: 'Pink Floyd', artistId: 1, trackCount: 10, releaseDate: '1973-03-01T08:00:00Z' },
        { wrapperType: 'collection', collectionId: 13, collectionName: 'Arnold Layne - Single', artistName: 'Pink Floyd', artistId: 1, trackCount: 1, releaseDate: '1967-03-10T08:00:00Z' },
      ] })
      if (url.includes('lookup?id=1&entity=song')) return json({ results: [] })
      if (url.includes('entity=song')) return json({ results: [
        { wrapperType: 'track', trackName: 'Money', artistName: 'Pink Floyd', artistId: 1, collectionName: 'The Dark Side of the Moon', collectionId: 12, trackTimeMillis: 382000, trackExplicitness: 'notExplicit' },
      ] })
      return json({ results: [] })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('answers artists, albums and songs, and asks Apple nothing the second time', async () => {
    const a = await searchShopCatalog('Pink Floyd')
    assert.equal(a.ok, true)
    assert.equal(a.albumsOk, true)
    assert.deepEqual(a.artists.map((x) => x.name), ['Pink Floyd'])
    assert.deepEqual(a.albums.map((x) => x.collectionId).sort(), [11, 12])
    assert.equal(a.songs[0].song, 'Money')
    const n = calls.length
    const b = await searchShopCatalog('pink floyd ')
    assert.equal(calls.length, n)
    assert.deepEqual(b, a)
  })
  it('keeps no half answer, and does not hammer a throttled album search', async () => {
    throttleAlbums = true
    const a = await searchShopCatalog('Pink Floyd')
    assert.equal(a.albumsOk, false)   // the screen builds albums from the songs, as before
    assert.deepEqual(a.albums, [])
    const albumAsks = calls.filter((u) => u.includes('entity=album&limit=50')).length
    assert.equal(albumAsks, 2)   // one try and one retry
    throttleAlbums = false
    // Asked again at once: the half answer was not kept, but the questions that
    // did answer are not asked twice (each Apple question is kept on its own)…
    const songAsks = calls.filter((u) => u.includes('entity=song&limit=60')).length
    const b = await searchShopCatalog('Pink Floyd')
    assert.equal(calls.filter((u) => u.includes('entity=song&limit=60')).length, songAsks)
    // …and the album search that just failed is left alone for a few seconds.
    assert.equal(calls.filter((u) => u.includes('entity=album&limit=50')).length, albumAsks)
    assert.equal(b.albumsOk, false)
  })
  it('lists an artist’s records for the artist page, once per ten minutes', async () => {
    const r = await shopArtistReleases(1, 'Pink Floyd')
    assert.equal(r.ok, true)
    assert.deepEqual(r.releases.albums.map((a) => a.name), ['The Dark Side of the Moon'])
    assert.deepEqual(r.releases.singles.map((a) => a.name), ['Arnold Layne - Single'])
    const n = calls.length
    await shopArtistReleases(1, 'Pink Floyd')
    assert.equal(calls.length, n)
    assert.equal((await shopArtistReleases(0, '')).ok, false)
  })
})

describe('a plain title never owns a live or remixed record', () => {
  const lib = libraryMarks([
    { title: 'Overture', artist: 'The Who', album: 'Tommy' },
    { title: 'Pinball Wizard', artist: 'The Who', album: 'Tommy' },
    { title: 'Young Man Blues', artist: 'The Who', album: 'Live at Leeds (Deluxe Edition)' },
    { title: 'Shine On', artist: 'Pink Floyd', album: 'Wish You Were Here' },
  ])
  it('reads the variant words in brackets and after a dash', () => {
    assert.equal(albumVariantTag('Tommy (Live)'), 'live')
    assert.equal(albumVariantTag('Tommy - Live at the Royal Albert Hall'), 'live')
    assert.equal(albumVariantTag('Bags [Remixes]'), 'remixes')
    assert.equal(albumVariantTag('Wish You Were Here (2011 Remaster)'), '')
    assert.equal(albumVariantTag('Live at Leeds'), '')   // the title itself, not a variant of it
    assert.equal(albumVariantTag('Animals (2018 Remix)'), '')   // a dated remix is the record mixed again
  })
  it('"Tommy" does not mark "Tommy (Live)", a demo, a remix or an acoustic edition', () => {
    for (const n of ['Tommy (Live)', 'Tommy [Demos]', 'Tommy (Remix)', 'Tommy (Acoustic Version)', 'Tommy (Instrumental)', 'Tommy - Live'])
      assert.equal(ownedAlbum(lib, 'The Who', n), null, n)
    assert.notEqual(ownedAlbum(lib, 'The Who', 'Tommy (Remastered 2013)'), null)
    assert.notEqual(ownedAlbum(lib, 'Pink Floyd', 'Wish You Were Here (2011 Remaster)'), null)
    assert.notEqual(ownedAlbum(lib, 'The Who', 'Live at Leeds'), null)
  })
  it('a live record in the library does not mark the studio one', () => {
    const m = libraryMarks([{ title: 'Pinball Wizard', artist: 'The Who', album: 'Tommy (Live)' }])
    assert.equal(ownedAlbum(m, 'The Who', 'Tommy'), null)
    assert.notEqual(ownedAlbum(m, 'The Who', 'Tommy (Live) [Remastered]'), null)
  })
  it('a record live by nature still matches Apple\'s "(Live)" name', () => {
    const m = libraryMarks([
      { title: 'Show Me the Way', artist: 'Peter Frampton', album: 'Frampton Comes Alive!' },
      { title: 'Folsom Prison Blues', artist: 'Johnny Cash', album: 'At Folsom Prison' },
      { title: 'Aces High', artist: 'Iron Maiden', album: 'Live After Death (2015 Remaster)' },
    ])
    assert.notEqual(ownedAlbum(m, 'Peter Frampton', 'Frampton Comes Alive! (Live)'), null)
    assert.notEqual(ownedAlbum(m, 'Johnny Cash', 'At Folsom Prison (Live)'), null)
    assert.notEqual(ownedAlbum(m, 'Iron Maiden', 'Live After Death (Live; 2015 Remaster)'), null)
    assert.equal(ownedAlbum(m, 'Johnny Cash', 'At Folsom Prison (Live) [Demos]'), null)
    assert.equal(ownedAlbum(lib, 'The Who', 'Tommy (Live)'), null)
    const l = listMarks([{ kind: 'album', artist: 'Johnny Cash', album: 'At Folsom Prison' }])
    assert.equal(listedAlbum(l, 'Johnny Cash', 'At Folsom Prison (Live)'), true)
  })
  it('the list follows the same rule', () => {
    const l = listMarks([{ kind: 'album', artist: 'The Who', album: 'Tommy' }])
    assert.equal(listedAlbum(l, 'The Who', 'Tommy (Live)'), false)
    assert.equal(listedAlbum(l, 'The Who', 'Tommy (2013 Remaster)'), true)
  })
})

describe('Apple requests per shop query', () => {
  const realFetch = globalThis.fetch
  let calls: string[] = []
  let appleSongs: 'ok' | 'refuse' = 'ok'
  let deezer: 'ok' | 'fail' = 'ok'
  let explicitTrackCount: number | undefined = 25
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
  beforeEach(() => {
    resetShopSearchCachesForTests()
    calls = []
    appleSongs = 'ok'
    deezer = 'ok'
    explicitTrackCount = 25
    globalThis.fetch = (async (u: string | URL) => {
      const url = String(u)
      calls.push(url)
      if (url.includes('api.deezer.com')) {
        if (deezer === 'fail') return new Response('', { status: 500 })
        return json({ data: [{ title: 'Walk It Talk It', artist: { name: 'Migos' }, album: { title: 'Culture II' } }] })
      }
      if (url.includes('entity=musicArtist')) return json({ results: [{ wrapperType: 'artist', artistId: 5, artistName: 'Migos' }] })
      if (url.includes('entity=album&limit=50')) return json({ results: [
        { wrapperType: 'collection', collectionId: 200, collectionName: 'Culture II', artistName: 'Migos', artistId: 5, trackCount: 24, collectionExplicitness: 'cleaned', artworkUrl100: 'https://clean/100x100.jpg' },
      ] })
      if (url.includes('lookup?id=5&entity=album')) return json({ results: [
        { wrapperType: 'collection', collectionId: 201, collectionName: 'Culture II', artistName: 'Migos', artistId: 5, trackCount: explicitTrackCount, collectionExplicitness: 'explicit', artworkUrl100: 'https://explicit/100x100.jpg' },
      ] })
      if (url.includes('lookup?id=5&entity=song')) return json({ results: [] })
      if (url.includes('entity=song')) {
        if (appleSongs === 'refuse') return new Response('', { status: 403 })
        return json({ results: [
          { wrapperType: 'track', trackName: 'Walk It Talk It', artistName: 'Migos', artistId: 5, collectionName: 'Culture II', collectionId: 200, trackCount: 24, trackTimeMillis: 276000, trackExplicitness: 'cleaned', collectionExplicitness: 'cleaned' },
        ] })
      }
      return json({ results: [] })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })
  const apple = () => calls.filter((u) => u.includes('itunes.apple.com'))

  it('costs what the song search alone cost, plus the one album search, and asks the artist once', async () => {
    await searchItunesSuggestions('Migos')
    const before = apple().length
    resetShopSearchCachesForTests()
    calls = []
    const a = await searchShopCatalog('Migos')
    assert.equal(a.songsOk, true)
    // Never more than the song search alone plus the album search (sharing can make it fewer).
    assert.ok(apple().length <= before + 1, `${apple().length} > ${before} + 1`)
    assert.equal(apple().filter((u) => u.includes('entity=musicArtist')).length, 1)
    // The album rescue and the song search share the artist's explicit lookup.
    assert.equal(apple().filter((u) => u.includes('lookup?id=5&entity=album')).length, 1)
    calls = []
    await searchShopCatalog('migos')
    assert.equal(calls.length, 0)
  })
  it("a rescued album wears the explicit edition's own size and cover", async () => {
    const a = await searchShopCatalog('Migos')
    const c = a.albums.find((x) => x.name === 'Culture II')!
    assert.equal(c.collectionId, 201)
    assert.equal(c.explicitness, 'explicit')
    assert.equal(c.trackCount, 25)
    assert.equal(c.artworkUrl, 'https://explicit/200x200.jpg')
  })
  it('leaves the size unset when the explicit lookup gave none', async () => {
    explicitTrackCount = undefined
    const a = await searchShopCatalog('Migos')
    const c = a.albums.find((x) => x.name === 'Culture II')!
    assert.equal(c.collectionId, 201)
    assert.equal(c.trackCount, undefined)
  })
  it('never keeps an answer whose songs came from Deezer', async () => {
    appleSongs = 'refuse'
    const a = await searchShopCatalog('Migos')
    assert.equal(a.songsOk, true)
    assert.equal(a.songs[0].song, 'Walk It Talk It')
    assert.equal(calls.filter((u) => u.includes('api.deezer.com')).length, 1)
    appleSongs = 'ok'
    await searchShopCatalog('Migos')
    // Asked again: the Deezer answer was not kept as the shop's answer.
    assert.equal(calls.filter((u) => u.includes('api.deezer.com')).length, 2)
  })
  it('says the songs failed when Apple and Deezer both did, even with albums and artists answering', async () => {
    appleSongs = 'refuse'
    deezer = 'fail'
    const a = await searchShopCatalog('Migos')
    assert.equal(a.ok, true)
    assert.equal(a.albumsOk, true)
    assert.equal(a.songsOk, false)
    assert.deepEqual(a.songs, [])
  })
})
