/**
 * Wiring for the 25/25 supply lanes (2026-08-27) — the module half that
 * index.ts calls: supplyLanes (harvest -> FeedCards), assembleLanes (who
 * sits where), and the quality-floor exemption for quota lanes.
 *
 * The floor exemption is the load-bearing pin: Jake's quota is "NO LESS",
 * so the brain may ORDER the fresh lanes but may never starve them. A
 * regression here is invisible in tsc and only shows up as a thin shelf.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyQualityFloor, assembleLanes, supplyLanes, ownershipChecks, QUOTA_LANES, BRAIN_FLOOR, BRAIN_HARD_FLOOR, QUOTA_FLOOR, QUOTA_TARGET, TWO_HOP_PENALTY, foldKey,
  countView, crateSeeds, isResting, supplyWhy,
  type FeedCard,
} from '../discover-feed.ts'

const card = (lane: string, n: number, brainPct?: number): FeedCard => ({
  lane, type: 'album', artist: `Artist ${lane} ${n}`, title: `Title ${n}`, why: 'x', brainPct,
})

describe('applyQualityFloor — quota lanes are exempt from the cut', () => {
  test('a low-scoring fresh-albums card SURVIVES the floor', () => {
    const cards = [card('fresh-albums', 1, 10), card('fresh-songs', 2, 5)]
    const out = applyQualityFloor(cards)
    assert.equal(out.length, 2, 'quota lanes must pass through untouched')
  })

  test('narrative lanes still get the cut', () => {
    const junk = Array.from({ length: 10 }, (_, i) => card('time-machine', i, 10))
    const good = card('time-machine', 99, BRAIN_FLOOR + 10)
    const out = applyQualityFloor([...junk, good])
    assert.ok(out.length < 11, 'the floor must still bite on narrative lanes')
    assert.ok(out.some((c) => c.title === 'Title 99'))
  })

  test(`past the first ${QUOTA_FLOOR}, a quota lane's extra picks must clear ${BRAIN_HARD_FLOOR}`, () => {
    const cards = Array.from({ length: 40 }, (_, i) => card('fresh-albums', i, i < 30 ? 70 : 40))
    const out = applyQualityFloor(cards)
    assert.equal(out.length, 30, 'the 30 good ones stand, the 10 "no signal" ones go')
    const thin = applyQualityFloor(Array.from({ length: 20 }, (_, i) => card('fresh-songs', i, 10)))
    assert.equal(thin.length, 20, 'under the promise, nothing is cut')
  })

  test('QUOTA_LANES names exactly the two fresh lanes', () => {
    assert.deepEqual([...QUOTA_LANES].sort(), ['fresh-albums', 'fresh-songs'])
  })
})

describe('assembleLanes', () => {
  test(`quota lanes seat up to ${QUOTA_TARGET} (2026-11-09: "not enough recommendations"); narrative lanes seat 24`, () => {
    const cards: FeedCard[] = []
    for (let i = 0; i < 80; i++) cards.push(card('fresh-albums', i, i))
    for (let i = 0; i < 80; i++) cards.push(card('fresh-songs', i, i))
    for (let i = 0; i < 40; i++) cards.push(card('time-machine', i, i))
    const lanes = assembleLanes(cards)
    const by = new Map(lanes.map((l) => [l.id, l.cards]))
    assert.equal(QUOTA_TARGET, 60)
    assert.equal(by.get('fresh-albums')?.length, 60)
    assert.equal(by.get('fresh-songs')?.length, 60)
    assert.equal(by.get('time-machine')?.length, 24)
  })

  test('a two-hop pick sorts a little lower than a one-hop pick of the same score', () => {
    const near = card('fresh-albums', 1, 70)
    const far = { ...card('fresh-albums', 2, 72), via: 'Neighbour' }
    const lanes = assembleLanes([far, near])
    assert.deepEqual(lanes[0].cards.map((c) => c.title), ['Title 1', 'Title 2'], `72 - ${TWO_HOP_PENALTY} sorts under 70`)
    assert.equal(lanes[0].cards[1].brainPct, 72, 'the shown % is untouched')
  })

  test('empty lanes are dropped, best brainPct leads', () => {
    const lanes = assembleLanes([card('fresh-albums', 1, 30), card('fresh-albums', 2, 90)])
    assert.equal(lanes.length, 1)
    assert.equal(lanes[0].cards[0].title, 'Title 2')
  })
})

/** Fetch-level fake Deezer: one anchor, many neighbours, 2 albums + 2 songs each. */
const fakeFetch = ((url: string) => {
  const body = (data: unknown): { json: () => Promise<unknown> } => ({ json: async () => ({ data }) })
  const u = String(url)
  if (u.includes('/search/artist')) return Promise.resolve(body([{ id: 1, name: 'Anchor' }]))
  if (u.includes('/related')) {
    return Promise.resolve(body(Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, name: `Band ${i}` }))))
  }
  const m = u.match(/artist\/(\d+)\/albums/)
  if (m) {
    const i = Number(m[1]) - 100
    return Promise.resolve(body([
      { id: 9000 + i, title: `Récord ${i}A`, record_type: 'album', release_date: '2026-01-01', cover_big: 'https://art/a.jpg' },
      { id: 9500 + i, title: `Record ${i}B`, record_type: 'album', release_date: '2025-01-01', cover_big: 'https://art/b.jpg' },
    ]))
  }
  const t = u.match(/artist\/(\d+)\/top/)
  if (t) {
    const i = Number(t[1]) - 100
    return Promise.resolve(body([
      { id: 8000 + i, title: `Song ${i}A`, preview: 'https://cdn/p.mp3', album: { cover_big: 'https://art/c.jpg' } },
      { id: 8500 + i, title: `Song ${i}B`, preview: 'https://cdn/q.mp3', album: { cover_big: 'https://art/d.jpg' } },
    ]))
  }
  return Promise.resolve(body([]))
}) as unknown as typeof fetch

describe('supplyLanes — harvest dressed as feed cards', () => {

  test('produces both lanes with because + preview; one seed alone is held to the promise plus headroom', async () => {
    const cards = await supplyLanes(['Anchor'], 1, { artists: new Set(), albumKeys: new Set(), baseKeys: new Set() }, fakeFetch, 0)
    const albums = cards.filter((c) => c.lane === 'fresh-albums')
    const songs = cards.filter((c) => c.lane === 'fresh-songs')
    // One seed may not carry the whole day past the 25 promise (no seed over
    // 10% of the picks once supply allows): it fills QUOTA_FLOOR + 5 and stops.
    assert.equal(albums.length, QUOTA_FLOOR + 5)
    assert.equal(songs.length, QUOTA_FLOOR + 5)
    assert.ok(albums.every((c) => c.type === 'album' && c.artUrl && c.because === 'Anchor'))
    assert.ok(songs.every((c) => c.type === 'song' && c.previewUrl))
  })

  test('ownership gates use the SAME normalized keys as the filter — accents fold', async () => {
    // Jake owns "Record 0A" — stored the way index.ts builds the set (nk of
    // artist|title). The Deezer title arrives as "Récord 0A" with an accent;
    // normKey folds it, so the owned copy must be refused.
    const albumKeys = new Set(['band 0|record 0a'])
    const cards = await supplyLanes(['Anchor'], 1, { artists: new Set(), albumKeys, baseKeys: new Set() }, fakeFetch, 0)
    assert.ok(!cards.some((c) => c.lane === 'fresh-albums' && c.artist === 'Band 0' && /0A$/.test(c.title)),
      'an owned album crossed the gate because the keys diverged')
  })
})

describe('supplyLanes skips what the feed would rest (2026-11-09)', () => {
  test('a resting pick never takes a slot; the harvest walks on to the next', async () => {
    const restingTitles = new Set(['Record 0B', 'Song 0A', 'Song 0B'])
    const cards = await supplyLanes(['Anchor'], 1, { artists: new Set(), albumKeys: new Set(), baseKeys: new Set() }, fakeFetch, 0, (_a, t) => restingTitles.has(t))
    assert.ok(!cards.some((c) => restingTitles.has(c.title)))
    assert.equal(cards.filter((c) => c.lane === 'fresh-songs').length, QUOTA_FLOOR + 5)
  })
  test('isResting is the feed filter\'s rule: Not for me, or four days on the page within two weeks', () => {
    const fb = { notForMe: { nofx: true }, served: { 'mxpx|panic attack': { views: 4, last: 1000 }, 'mest|cadillac': { views: 3, last: 1000 } } }
    assert.equal(isResting({ lane: 'fresh-albums', artist: 'NOFX', title: 'Anything' }, fb, 2000), true)
    assert.equal(isResting({ lane: 'fresh-songs', artist: 'MxPx', title: 'Panic Attack' }, fb, 2000), true)
    assert.equal(isResting({ lane: 'fresh-songs', artist: 'Mest', title: 'Cadillac' }, fb, 2000), false)
    assert.equal(isResting({ lane: 'fresh-songs', artist: 'MxPx', title: 'Panic Attack' }, fb, 1000 + 15 * 86_400_000), false, 'back after two weeks')
  })
})

describe('countView — a card is seen once a day, not once a page open (2026-11-09)', () => {
  test('four opens in an afternoon are one view; the next day is the second', () => {
    const served: Record<string, { first: number; last: number; views: number }> = {}
    const h = 3600_000
    for (const t of [0, h, 2 * h, 3 * h]) countView(served, 'k', t)
    assert.equal(served.k.views, 1)
    countView(served, 'k', 20 * h)
    assert.equal(served.k.views, 2)
    assert.equal(served.k.last, 20 * h)
  })
})

describe('crateSeeds — a seed for every crate (2026-11-09)', () => {
  test('the most played library artists whose genre files in each crate, in crate order', () => {
    const ranked = [
      { artist: 'Sublime', primaryGenre: 'Ska-Punk' }, { artist: 'blink-182', primaryGenre: 'Pop Punk' }, { artist: 'Green Day', primaryGenre: 'Punk' },
      { artist: 'NOFX', primaryGenre: 'Punk' }, { artist: 'Pearl Jam', primaryGenre: 'Grunge' }, { artist: 'SAULT', primaryGenre: 'R&B' },
      { artist: 'Nobody', primaryGenre: null },
    ]
    assert.deepEqual(crateSeeds(ranked, 2), ['Sublime', 'blink-182', 'Pearl Jam', 'SAULT'])
  })
  test('a two-hop line names the band in between; a one-hop line stays the hidden "Neighbors with"', () => {
    assert.equal(supplyWhy({ because: 'Sublime' }), 'Neighbors with Sublime')
    assert.equal(supplyWhy({ because: 'Sublime', via: 'Slightly Stoopid' }), 'By way of Slightly Stoopid')
  })
})

describe('ownershipChecks — the one "already in the library" question (2026-10-18)', () => {
  const owned = {
    artists: new Set(['kanye west', 'the white stripes']),
    albumKeys: new Set(['kanye west|the college dropout', 'the white stripes|elephant', 'bjo rk|homogenic']),
    baseKeys: new Set<string>(),
  }
  test('a leading article on either side of the pair never makes an owned record new', () => {
    const { ownsAlbum, ownsSong } = ownershipChecks(owned)
    assert.equal(ownsAlbum('Kanye West', 'College Dropout'), true)
    assert.equal(ownsAlbum('White Stripes', 'Elephant'), true)
    assert.equal(ownsSong('White Stripes', 'Elephant'), true)
  })
  test('the accent bridge still holds; a different record is still new', () => {
    const { ownsAlbum, ownsArtist } = ownershipChecks(owned)
    assert.equal(ownsAlbum('Björk', 'Homogenic'), true, 'normKey stored the accent as a space')
    assert.equal(ownsAlbum('Kanye West', 'Graduation'), false)
    assert.equal(ownsAlbum('Kanye West', 'A College Dropout Tribute'), false)
    assert.equal(ownsArtist('Kanye West'), true)
  })
})

describe('foldKey — accents fold BEFORE the strip', () => {
  test('the JA\u0178-Z case: marks are removed, not turned into spaces', () => {
    assert.equal(foldKey('JA\u0178-Z'), 'jay z')
    assert.equal(foldKey('R\u00e9cord 0A'), 'record 0a')
    assert.equal(foldKey('Bj\u00f6rk'), 'bjork')
  })
})

describe('ownedPairKeys — multi-artist tags index every contributor', () => {
  test('the FourFiveSeconds case: collab tag blocks under any single credit', async () => {
    const { ownedPairKeys } = await import('../discover-feed.ts')
    const keys = new Set(ownedPairKeys([{ artist: 'Rihanna, Kanye West, and Paul McCartney', title: 'FourFiveSeconds', album: 'FourFiveSeconds' }]))
    assert.ok(keys.has('paul mccartney|fourfiveseconds'))
    assert.ok(keys.has('rihanna|fourfiveseconds'))
    assert.ok(keys.has('kanye west|fourfiveseconds'))
    assert.ok(keys.has('rihanna kanye west and paul mccartney|fourfiveseconds'), 'the full tag stays too')
  })

  test('splitting is additive — a band with "and" in its name keeps its identity', async () => {
    const { ownedPairKeys } = await import('../discover-feed.ts')
    const keys = new Set(ownedPairKeys([{ artist: 'Florence and the Machine', title: 'Dog Days Are Over' }]))
    assert.ok(keys.has('florence and the machine|dog days are over'))
  })
})
