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
  applyQualityFloor, assembleLanes, supplyLanes, QUOTA_LANES, BRAIN_FLOOR, foldKey,
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

  test('QUOTA_LANES names exactly the two fresh lanes', () => {
    assert.deepEqual([...QUOTA_LANES].sort(), ['fresh-albums', 'fresh-songs'])
  })
})

describe('assembleLanes', () => {
  test('quota lanes seat 25; narrative lanes seat 24', () => {
    const cards: FeedCard[] = []
    for (let i = 0; i < 40; i++) cards.push(card('fresh-albums', i, i))
    for (let i = 0; i < 40; i++) cards.push(card('fresh-songs', i, i))
    for (let i = 0; i < 40; i++) cards.push(card('time-machine', i, i))
    const lanes = assembleLanes(cards)
    const by = new Map(lanes.map((l) => [l.id, l.cards]))
    assert.equal(by.get('fresh-albums')?.length, 25, 'Jake: 25, NO LESS')
    assert.equal(by.get('fresh-songs')?.length, 25)
    assert.equal(by.get('time-machine')?.length, 24)
  })

  test('empty lanes are dropped, best brainPct leads', () => {
    const lanes = assembleLanes([card('fresh-albums', 1, 30), card('fresh-albums', 2, 90)])
    assert.equal(lanes.length, 1)
    assert.equal(lanes[0].cards[0].title, 'Title 2')
  })
})

describe('supplyLanes — harvest dressed as feed cards', () => {
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

  test('produces both lanes, 40 each for headroom, with because + preview', async () => {
    const cards = await supplyLanes(['Anchor'], 1, { artists: new Set(), albumKeys: new Set(), baseKeys: new Set() }, fakeFetch, 0)
    const albums = cards.filter((c) => c.lane === 'fresh-albums')
    const songs = cards.filter((c) => c.lane === 'fresh-songs')
    assert.equal(albums.length, 40)
    assert.equal(songs.length, 40)
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
