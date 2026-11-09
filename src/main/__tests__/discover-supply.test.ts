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
  resolveDeezerArtist, rotateKeepingNewFirst,
  type SupplyDeps,
} from '../discover-supply.ts'
import { isJunkArtistName } from '../../common/junk-artist.ts'
import { knownTitleIndex } from '../discover-feed.ts'

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

describe('relatedArtistPool — cover factories never enter the pool (2026-09-21)', () => {
  // The fixture's related entries can carry Deezer's numbers.
  function fakeWithNumbers(related: Record<string, Array<{ name: string; nb_fan?: number; nb_album?: number }>>) {
    const ids = new Map<string, number>(); let next = 1
    const idFor = (n: string): number => { if (!ids.has(n)) ids.set(n, next++); return ids.get(n)! }
    const byId = new Map<number, string>()
    for (const k of Object.keys(related)) byId.set(idFor(k), k)
    for (const list of Object.values(related)) for (const r of list) byId.set(idFor(r.name), r.name)
    const fetchJson = async (url: string): Promise<unknown> => {
      const s = url.match(/search\/artist\?q=([^&]+)/)
      if (s) { const n = decodeURIComponent(s[1]); return { data: [{ id: idFor(n), name: n }] } }
      const rel = url.match(/artist\/(\d+)\/related/)
      if (rel) { const who = byId.get(Number(rel[1])) ?? ''; return { data: (related[who] ?? []).map((r) => ({ id: idFor(r.name), ...r })) } }
      return { data: [] }
    }
    return { fetchJson }
  }

  test('Yoyo International Orchestra is refused by name AND by numbers; a small real band is kept', async () => {
    const dz = fakeWithNumbers({ Nirvana: [
      { name: 'Yoyo International Orchestra', nb_fan: 72, nb_album: 37 },
      { name: 'Everyone Asked About You', nb_fan: 1017, nb_album: 6 },
      { name: 'Vitamin String Quartet', nb_fan: 37937, nb_album: 499 },
      { name: 'muddymamba', nb_fan: 25, nb_album: 31 },
      { name: 'Mannequin Pussy', nb_fan: 9666, nb_album: 4 },
    ] })
    const pool = await relatedArtistPool(['Nirvana'], deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(pool.map((p) => p.name), ['Everyone Asked About You', 'Mannequin Pussy'])
  })

  test('unknown numbers are not evidence — a plain related row still enters', async () => {
    const dz = fakeDeezer({ related: { Anchor: ['Real Band'] } })
    const pool = await relatedArtistPool(['Anchor'], deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(pool.map((p) => p.name), ['Real Band'])
  })
})

describe('harvestAlbums — instrumental / performed-by records are not records (2026-09-21)', () => {
  test('the Beatles instrumentals volume is refused even though the title never says tribute', async () => {
    const dz = fakeDeezer({
      related: { A: ['Band'] },
      albums: { Band: [
        { title: 'The Love Songs of the Beatles - Instrumentals Volume 1' },
        { title: 'Classic Rock Instrumentals Vol. 28' },
        { title: 'Songs of Innocence' },            // U2 — "songs of" alone is a real title
        { title: 'Hits Performed by the Studio Players' },
        { title: 'A Real Record' },
      ] },
    })
    const pool = await relatedArtistPool(['A'], deps({ fetchJson: dz.fetchJson }))
    const albums = await harvestAlbums(pool, 10, deps({ fetchJson: dz.fetchJson }))
    assert.deepEqual(albums.map((a) => a.title), ['Songs of Innocence', 'A Real Record'])
  })
})

// ── 2026-11-08: "the record store recommendations have gotten really bad" ──
// Jake: "Not my taste", "Already own them", "Weird/random picks". Every
// fixture below is a real card or a real Deezer answer from that day.

/** Deezer's search answers as recorded on 2026-11-08 (name, fans), first hit first. */
const DEEZER_SEARCH_20261108: Record<string, Array<[string, number]>> = {
  'JOSIE.': [['Jessie J', 5097401], ['Joseph Kamel', 146033], ['Josie Charles', 357]],
  Eminem: [["Emine'm", 920], ['Eminem', 19175056], ['TI feat. Eminem', 795]],
  Nirvana: [['Nirvana (UK)', 272], ['Nirvana', 10105660], ['Approaching Nirvana', 10029]],
  Sublime: [['SuBlime ', 17], ['Sublime', 43], ['Sublime', 315449], ['Sublime with Rome', 21924]],
  Underworld: [['Underworld', 40], ['Underworld', 110212], ['The Hickey Underworld', 2758]],
  'Crown Lands': [['CROWNLANDS', 4], ['Crown Lands', 2268]],
  Echowave: [['EchoWave', 74]],
}

function recordedSearch(): { fetchJson: SupplyDeps['fetchJson']; idOf: (name: string, fans: number) => number } {
  const ids = new Map<string, number>()
  const idOf = (name: string, fans: number): number => {
    const k = `${name}#${fans}`
    if (!ids.has(k)) ids.set(k, 500 + ids.size)
    return ids.get(k)!
  }
  const fetchJson = async (url: string): Promise<unknown> => {
    const m = url.match(/search\/artist\?q=([^&]+)/)
    if (!m) return { data: [] }
    const rows = DEEZER_SEARCH_20261108[decodeURIComponent(m[1])] ?? []
    return { data: rows.map(([name, nb_fan]) => ({ id: idOf(name, nb_fan), name, nb_fan })) }
  }
  return { fetchJson, idOf }
}

describe('resolveDeezerArtist — the anchor is the band Jake means, never a namesake (2026-11-08)', () => {
  test('JOSIE. is not Jessie J: no artist of that name means no anchor', async () => {
    const dz = recordedSearch()
    assert.equal(await resolveDeezerArtist('JOSIE.', dz), null)
  })

  test('Eminem, Nirvana, Sublime, Underworld: the same-named act with the most fans wins', async () => {
    const dz = recordedSearch()
    assert.equal((await resolveDeezerArtist('Eminem', dz))?.id, dz.idOf('Eminem', 19175056))
    assert.equal((await resolveDeezerArtist('Nirvana', dz))?.id, dz.idOf('Nirvana', 10105660))
    assert.equal((await resolveDeezerArtist('Sublime', dz))?.id, dz.idOf('Sublime', 315449))
    assert.equal((await resolveDeezerArtist('Underworld', dz))?.id, dz.idOf('Underworld', 110212))
    assert.equal((await resolveDeezerArtist('Crown Lands', dz))?.id, dz.idOf('Crown Lands', 2268))
  })

  test('case and punctuation are not a different name', async () => {
    const dz = recordedSearch()
    assert.equal((await resolveDeezerArtist('Echowave', dz))?.name, 'EchoWave')
  })

  test("a wrong anchor's neighbours never reach the pool", async () => {
    const dz = recordedSearch()
    const fetchJson = async (url: string): Promise<unknown> => {
      const rel = url.match(/artist\/(\d+)\/related/)
      if (rel && Number(rel[1]) === dz.idOf('Jessie J', 5097401)) return { data: [{ id: 9001, name: 'Nick Jonas', nb_fan: 3000000, nb_album: 20 }] }
      if (rel && Number(rel[1]) === dz.idOf('Nirvana', 10105660)) return { data: [{ id: 9002, name: 'Mudhoney', nb_fan: 90000, nb_album: 30 }] }
      return dz.fetchJson(url)
    }
    const pool = await relatedArtistPool(['JOSIE.', 'Nirvana'], deps({ fetchJson }))
    assert.deepEqual(pool.map((p) => p.name), ['Mudhoney'])
  })
})

describe('resolveDeezerArtist — a same-named stranger is not the band (2026-11-08)', () => {
  // Deezer's only "josie" (100 fans) sings "Submarine Queen" and "keep on";
  // Jake's JOSIE. is "did i stutter?" on his Spotify. Two Underworlds: the
  // one with "Born Slippy" is the one he plays.
  const fetchJson = async (url: string): Promise<unknown> => {
    if (url.includes('search/artist?q=JOSIE.')) return { data: [{ id: 1, name: 'Jessie J', nb_fan: 5097401 }, { id: 2, name: 'josie', nb_fan: 100 }] }
    if (url.includes('search/artist?q=Underworld')) return { data: [{ id: 3, name: 'Underworld', nb_fan: 40 }, { id: 4, name: 'Underworld', nb_fan: 110212 }] }
    if (url.includes('artist/2/top')) return { data: [{ title: 'Submarine Queen' }, { title: 'keep on' }] }
    if (url.includes('artist/4/top')) return { data: [{ title: 'Born Slippy (Nuxx)' }, { title: 'Rez' }] }
    if (url.includes('artist/3/top')) return { data: [{ title: 'Grave Dust' }] }
    return { data: [] }
  }
  const known: Record<string, string[]> = { 'JOSIE.': ['did i stutter? - Radio Edit'], Underworld: ['Born Slippy .NUXX', 'Born Slippy (Nuxx)'] }

  test('JOSIE. with known songs and no Deezer act that has them: no anchor', async () => {
    assert.equal(await resolveDeezerArtist('JOSIE.', { fetchJson, knownTitles: (a) => known[a] ?? [] }), null)
  })

  test('the Underworld that has his songs is the anchor', async () => {
    assert.equal((await resolveDeezerArtist('Underworld', { fetchJson, knownTitles: (a) => known[a] ?? [] }))?.id, 4)
  })

  test('knownTitleIndex: library titles and albums, Spotify songs, under every credited name', () => {
    const idx = knownTitleIndex(
      [{ artist: 'Underworld', album: 'Second Toughest in the Infants', title: 'Born Slippy .NUXX' }, { artist: 'Rihanna, Kanye West, and Paul McCartney', title: 'FourFiveSeconds' }],
      [{ artist: 'JOSIE.', song: 'did i stutter? - Radio Edit', album: 'did i stutter?' }],
    )
    assert.deepEqual(idx.get('underworld'), ['Born Slippy .NUXX', 'Second Toughest in the Infants'])
    assert.ok(idx.get('paulmccartney')?.includes('FourFiveSeconds'))
    assert.ok(idx.get('josie')?.includes('did i stutter? - Radio Edit'))
  })
})

describe('rotateKeepingNewFirst — the daily rotation keeps new artists ahead of owned ones (2026-11-08)', () => {
  test('owned artists never jump ahead, whatever the day', () => {
    const pool = [
      { name: 'Sorry', owned: false }, { name: 'Ray Bull', owned: false }, { name: 'Rampa', owned: false },
      { name: 'Lou Reed', owned: true }, { name: 'Bob Dylan', owned: true }, { name: 'Foo Fighters', owned: true },
    ]
    for (const day of [20400, 20401, 20402, 20765]) {
      const out = rotateKeepingNewFirst(pool, day)
      assert.equal(out.length, pool.length)
      assert.deepEqual(out.slice(0, 3).map((a) => a.owned), [false, false, false], `day ${day}`)
      assert.deepEqual(new Set(out.map((a) => a.name)), new Set(pool.map((a) => a.name)))
    }
  })

  test('the shelf fills from new artists first and only reaches owned ones when they run dry', async () => {
    const related = { Anchor: ['Lou Reed', 'Bob Dylan', 'Sorry', 'Ray Bull', 'Rampa', 'Kiwi jr.'] }
    const albums: Record<string, Array<{ title: string }>> = {}
    for (const n of related.Anchor) albums[n] = [{ title: `${n} LP1` }, { title: `${n} LP2` }]
    const dz = fakeDeezer({ related, albums })
    const owned = new Set(['Lou Reed', 'Bob Dylan', 'Kiwi jr.'])
    for (const day of [20400, 20401, 20402]) {
      const r = await buildDailyDiscovery(['Anchor'], deps({ fetchJson: dz.fetchJson, ownsArtist: (a) => owned.has(a) }), { want: 6, dayNumber: day, maxPasses: 1 })
      assert.ok(r.albums.every((a) => !owned.has(a.artist)), `day ${day}: ${r.albums.map((a) => a.artist).join(', ')}`)
    }
  })
})

describe('edition gate — compilations, soundtracks and dated tapes (2026-11-08 shelf)', () => {
  test('the real cards are refused; canonical records beside them are kept', async () => {
    const titles = [
      'The Essential Foo Fighters',
      'The Sire Years: Complete Albums Box',
      'Collected Recordings 1983-1989',
      'Power Ballad (Music From The Motion Picture)',
      'Tout va bien (Original Soundtrack)',
      'La hija de todas las rabias (Original Score)',
      'The Rolling Thunder Revue 1976: Fort Collins Colorado, May 23rd',
      'The Rolling Thunder Revue 1976: Fort Worth Texas, May 16th',
      'Power To The People (Home Jam)',
    ]
    for (const t of titles) {
      const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [{ title: t }] } })
      const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
      assert.deepEqual(out, [], t)
    }
    const keep = ['Anywhere But Here', 'Spatial, No Problem.', 'Chopper', 'Lulu', 'Five Dice, All Threes', 'Milk And Honey']
    for (const t of keep) {
      const dz = fakeDeezer({ related: { A: ['Band'] }, albums: { Band: [{ title: t }] } })
      const out = await harvestAlbums([{ id: dz.idFor('Band'), name: 'Band', anchor: 'A' }], 10, deps({ fetchJson: dz.fetchJson }))
      assert.equal(out.length, 1, t)
    }
  })

  test('a revival band is a tribute act', () => {
    assert.equal(isJunkArtistName('The Beatles Revival Band'), true)
    assert.equal(isJunkArtistName('Creedence Clearwater Revival'), false)
  })
})
