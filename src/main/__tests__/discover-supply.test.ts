/**
 * Daily discovery supply (2026-08-27).
 *
 * Jake: "the record shop is a waste of my time....it shows an insane amount of
 * minimal music. i need a huge amount of new music suggestions in here. 25 new
 * songs each day as well as 25 new albums that I DO NOT HAVE IN MY LIBRARY.
 * NO LESS"
 *
 * Two rules carry the whole feature and are pinned hardest here:
 *   • THE QUOTA — 25 and 25, and a shortfall must be REPORTED, never padded
 *     over with owned music or singles. A quiet 19 is how the old shop stayed
 *     thin for weeks without anyone noticing.
 *   • NOT IN THE LIBRARY — the one thing Jake asked for in capitals.
 *
 * Everything runs off fixtures. No network, no Deezer, no clock.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dayStride, relatedArtistPool, harvestAlbums, harvestSongs, buildDailyDiscovery,
  type SupplyDeps,
} from '../discover-supply.ts'

/** A fake Deezer: artists -> related -> albums/top-tracks, all in memory. */
function fakeDeezer(opts: {
  related: Record<string, string[]>
  albums?: Record<string, Array<{ title: string; record_type?: string; release_date?: string }>>
  top?: Record<string, string[]>
} ) {
  const ids = new Map<string, number>()
  const nameOf = new Map<number, string>()
  let next = 1
  const idFor = (name: string): number => {
    const k = name.toLowerCase()
    if (!ids.has(k)) { ids.set(k, next); nameOf.set(next, name); next++ }
    return ids.get(k)!
  }
  for (const a of Object.keys(opts.related)) idFor(a)
  for (const list of Object.values(opts.related)) for (const r of list) idFor(r)

  const calls: string[] = []
  const fetchJson = async (url: string): Promise<unknown> => {
    calls.push(url)
    const search = url.match(/search\/artist\?q=([^&]+)/)
    if (search) {
      const name = decodeURIComponent(search[1])
      return { data: [{ id: idFor(name), name }] }
    }
    const rel = url.match(/artist\/(\d+)\/related/)
    if (rel) {
      const who = nameOf.get(Number(rel[1])) ?? ''
      return { data: (opts.related[who] ?? []).map((n) => ({ id: idFor(n), name: n })) }
    }
    const alb = url.match(/artist\/(\d+)\/albums/)
    if (alb) {
      const who = nameOf.get(Number(alb[1])) ?? ''
      return {
        data: (opts.albums?.[who] ?? []).map((a, i) => ({
          id: 1000 + i, title: a.title, record_type: a.record_type ?? 'album',
          release_date: a.release_date ?? '2025-01-01', cover_big: 'https://art/x.jpg',
        })),
      }
    }
    const top = url.match(/artist\/(\d+)\/top/)
    if (top) {
      const who = nameOf.get(Number(top[1])) ?? ''
      return {
        data: (opts.top?.[who] ?? []).map((t, i) => ({
          id: 2000 + i, title: t, preview: 'https://cdn/p.mp3',
          album: { cover_big: 'https://art/y.jpg' },
        })),
      }
    }
    return { data: [] }
  }
  return { fetchJson, calls, idFor }
}

const deps = (over: Partial<SupplyDeps> & { fetchJson: SupplyDeps['fetchJson'] }): SupplyDeps => ({
  ownsAlbum: () => false,
  ownsSong: () => false,
  ownsArtist: () => false,
  ...over,
})

describe('dayStride — stable within a day, different tomorrow', () => {
  test('same day gives the same order', () => {
    assert.deepEqual(dayStride(100, 10, 10), dayStride(100, 10, 10))
  })

  test('a different day walks a different part of the pool', () => {
    assert.notDeepEqual(dayStride(100, 40, 10), dayStride(101, 40, 10))
  })

  test('never repeats an index and never exceeds the pool', () => {
    const out = dayStride(7, 12, 50)
    assert.equal(new Set(out).size, out.length)
    assert.equal(out.length, 12)
    assert.ok(out.every((i) => i >= 0 && i < 12))
  })

  test('an empty pool is not a crash', () => {
    assert.deepEqual(dayStride(3, 0, 5), [])
  })
})

describe('relatedArtistPool', () => {
  test('artists Jake does NOT own come first — that is what new music means', async () => {
    const dz = fakeDeezer({ related: { Anchor: ['Owned Band', 'Fresh Band'] } })
    const pool = await relatedArtistPool(['Anchor'], deps({
      fetchJson: dz.fetchJson,
      ownsArtist: (a) => a === 'Owned Band',
    }))
    assert.deepEqual(pool.map((p) => p.name), ['Fresh Band', 'Owned Band'])
    assert.equal(pool[0].owned, false)
  })

  test('de-duplicates artists reached from two different anchors', async () => {
    const dz = fakeDeezer({ related: { A: ['Shared', 'OnlyA'], B: ['Shared', 'OnlyB'] } })
    const pool = await relatedArtistPool(['A', 'B'], deps({ fetchJson: dz.fetchJson }))
    assert.equal(pool.filter((p) => p.name === 'Shared').length, 1)
  })

  test('each card remembers the anchor it came from', async () => {
    const dz = fakeDeezer({ related: { LCD: ['Hot Chip'] } })
    const pool = await relatedArtistPool(['LCD'], deps({ fetchJson: dz.fetchJson }))
    assert.equal(pool[0].because ?? pool[0].anchor, 'LCD')
  })

  test('a dead anchor does not sink the pass', async () => {
    const dz = fakeDeezer({ related: { Good: ['Neighbour'] } })
    const pool = await relatedArtistPool(['Missing Artist', 'Good'], deps({ fetchJson: dz.fetchJson }))
    assert.ok(pool.some((p) => p.name === 'Neighbour'))
  })
})

describe('harvestAlbums — THE hard rule is "not in my library"', () => {
  const dz = fakeDeezer({
    related: { A: ['Band'] },
    albums: { Band: [
      { title: 'Owned Record' },
      { title: 'New Record' },
      { title: 'Another New One' },
    ] },
  })

  test('never returns an album already in the library', async () => {
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({
      fetchJson: dz.fetchJson,
      ownsAlbum: (_artist, album) => album === 'Owned Record',
    }))
    assert.ok(out.length > 0)
    assert.ok(!out.some((a) => a.title === 'Owned Record'))
  })

  test('refuses singles and EPs — they are not records', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'A Single', record_type: 'single' },
      { title: 'An EP', record_type: 'ep' },
      { title: 'A Real Album', record_type: 'album' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(out.map((a) => a.title), ['A Real Album'])
  })

  test('drops karaoke and tribute junk', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'Karaoke Hits' },
      { title: 'A Tribute To Someone' },
      { title: 'Honest Record' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(out.map((a) => a.title), ['Honest Record'])
  })

  test('caps one artist at two so nobody owns the shelf', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'One' }, { title: 'Two' }, { title: 'Three' }, { title: 'Four' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    assert.equal(out.length, 2)
  })

  test('carries year and artwork through', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [{ title: 'Rec', release_date: '2026-04-01' }] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 5, deps({ fetchJson: dz.fetchJson }))
    assert.equal(out[0].year, '2026')
    assert.ok(out[0].artUrl)
  })
})

describe('harvestSongs', () => {
  test('never returns a song already in the library', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, top: { Band: ['Known One', 'Unknown One'] } })
    const out = await harvestSongs([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({
      fetchJson: dz.fetchJson,
      ownsSong: (_a, t) => t === 'Known One',
    }))
    assert.deepEqual(out.map((s) => s.title), ['Unknown One'])
  })

  test('brings the 30s preview along', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, top: { Band: ['Track'] } })
    const out = await harvestSongs([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 5, deps({ fetchJson: dz.fetchJson }))
    assert.equal(out[0].previewUrl, 'https://cdn/p.mp3')
  })
})

describe('buildDailyDiscovery — the quota is the feature', () => {
  /** A catalogue deep enough to fill 25/25 without help. */
  function deepCatalogue() {
    const related: Record<string, string[]> = { Anchor: [] }
    const albums: Record<string, Array<{ title: string }>> = {}
    const top: Record<string, string[]> = {}
    for (let i = 0; i < 40; i++) {
      const name = `Band ${i}`
      related.Anchor.push(name)
      albums[name] = [{ title: `Album ${i}A` }, { title: `Album ${i}B` }]
      top[name] = [`Song ${i}A`, `Song ${i}B`]
    }
    return fakeDeezer({ related, albums, top })
  }

  test('delivers exactly 25 and 25 with no shortfall', async () => {
    const dz = deepCatalogue()
    const out = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: dz.fetchJson }), { dayNumber: 1 })
    assert.equal(out.albums.length, 25)
    assert.equal(out.songs.length, 25)
    assert.deepEqual(out.report.shortfall, [])
  })

  test('NOTHING it returns is already in the library', async () => {
    const dz = deepCatalogue()
    // Pretend half the catalogue is already owned.
    const owned = (s: string): boolean => /[02468]A$/.test(s)
    const out = await buildDailyDiscovery(['Anchor'], deps({
      fetchJson: dz.fetchJson,
      ownsAlbum: (_a, t) => owned(t),
      ownsSong: (_a, t) => owned(t),
    }), { dayNumber: 1 })
    assert.ok(!out.albums.some((a) => owned(a.title)), 'an owned album reached the shelf')
    assert.ok(!out.songs.some((s) => owned(s.title)), 'an owned song reached the shelf')
  })

  test('a thin catalogue REPORTS the shortfall instead of padding it', async () => {
    const dz = fakeDeezer({
      related: { Anchor: ['Only Band'] },
      albums: { 'Only Band': [{ title: 'Just One' }] },
      top: { 'Only Band': ['Just A Song'] },
    })
    const out = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: dz.fetchJson }), { dayNumber: 1 })
    assert.ok(out.albums.length < 25)
    assert.ok(out.report.shortfall.some((s) => s.startsWith('albums')), 'shortfall must be reported')
    // and it must NOT have invented filler to reach the number
    assert.equal(new Set(out.albums.map((a) => a.title)).size, out.albums.length)
  })

  test('never returns the same album or song twice', async () => {
    const dz = deepCatalogue()
    const out = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: dz.fetchJson }), { dayNumber: 4 })
    assert.equal(new Set(out.albums.map((a) => `${a.artist}|${a.title}`)).size, out.albums.length)
    assert.equal(new Set(out.songs.map((s) => `${s.artist}|${s.title}`)).size, out.songs.length)
  })

  test('today is stable, tomorrow is different', async () => {
    const a = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: deepCatalogue().fetchJson }), { dayNumber: 10 })
    const b = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: deepCatalogue().fetchJson }), { dayNumber: 10 })
    const c = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: deepCatalogue().fetchJson }), { dayNumber: 11 })
    assert.deepEqual(a.albums.map((x) => x.title), b.albums.map((x) => x.title), 'same day must be stable')
    assert.notDeepEqual(a.albums.map((x) => x.title), c.albums.map((x) => x.title), 'a new day must rotate')
  })

  test('a totally dead catalogue returns empty and says so — it does not throw', async () => {
    const dz = fakeDeezer({ related: {} })
    const out = await buildDailyDiscovery(['Nobody'], deps({ fetchJson: dz.fetchJson }), { dayNumber: 1 })
    assert.equal(out.albums.length, 0)
    assert.equal(out.songs.length, 0)
    assert.equal(out.report.shortfall.length, 2)
  })

  test('a failing network degrades to empty rather than exploding', async () => {
    const out = await buildDailyDiscovery(['Anchor'], deps({
      fetchJson: async () => { throw new Error('network down') },
    }), { dayNumber: 1 })
    assert.equal(out.albums.length, 0)
    assert.ok(out.report.shortfall.length > 0)
  })
})

describe('edition gate — canonical studio records only', () => {
  // Both refusals below were REAL cards seated by the first live harvest
  // (2026-08-27) before this gate existed. They stay pinned by name.
  test('refuses deluxe, live, and best-of editions', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'Culture III (Deluxe)' },
      { title: 'The Best of Sid Vicious (Live)' },
      { title: 'Nevermind (30th Anniversary Remaster)' },
      { title: 'Greatest Hits' },
      { title: 'An Honest Record' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(out.map((a) => a.title), ['An Honest Record'])
  })

  test('does NOT refuse canonical titles that merely contain hot words', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'Live Through This' },   // Hole — "live" is the lyric, not the edition
      { title: 'Demon Days' },          // Gorillaz — "demo" must not match inside a word
      { title: 'Alive' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    // 2-per-artist cap keeps two of the three; the point is none were junked.
    assert.equal(out.length, 2)
  })
})

describe('edition gate — live markers ANYWHERE in the parens', () => {
  // "Next to You (Audiotree Live Version)" reached the shelf 2026-08-28:
  // the old pattern only matched parens STARTING with the marker.
  test('(Audiotree Live Version) is junk; titles merely containing Live-ish words are not', async () => {
    const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [
      { title: 'Next to You (Audiotree Live Version)' },
      { title: 'Set It Off (MTV Unplugged)' },
      { title: 'Alive' },
      { title: 'An Honest Record' },
    ] } })
    const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(out.map((a) => a.title), ['Alive', 'An Honest Record'])
  })
})
