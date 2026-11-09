import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bestKnownAlbum, buildWantedShelves, lookupWanted, wantedWhy, type WantedHit } from '../ipod-wanted-shelf.ts'
import { createWantedShelfSource, ownershipFromTracks, WANTED_LOOKUPS_FILE } from '../ipod-wanted-shelf-source.ts'
import { parseIpodList, type IpodList } from '../../common/ipod-list-doc.ts'

// "For your iPods" (2026-11-09, Jake: "the songs i dont have for y2k, 80's and
// indie sleaze....thats the type of stuff that should go in the record shop").

const AT = '2026-11-09T15:00:00.000Z'
const DEV = '2a2f2e5c-a5b6-48fe-934c-a7c38b744132'
const raw = (extra: Record<string, unknown> = {}) => ({
  id: DEV, name: 'Indie Sleeze', purpose: 'Indie Sleeze', cap: 1000, ids: [1], adds: [], removed: [], updatedAt: AT,
  brain: { enabled: true, perDay: 3 }, ...extra,
})

// A tiny Deezer: Uffie (+ a 12-fan namesake "Uffie (FR)"), Cut Copy, a song search.
const DEEZER: Record<string, unknown> = {
  'search/artist?q=Uffie': { data: [{ id: 9, name: 'Uffie (FR)', nb_fan: 12 }, { id: 2, name: 'uffie', nb_fan: 10 }, { id: 1, name: 'Uffie', nb_fan: 90000 }] },
  'artist/1/albums': { data: [
    { id: 10, title: 'Sex Dreams and Denim Jeans', record_type: 'album', release_date: '2010-06-01', fans: 500, cover_big: 'u1.jpg' },
    { id: 11, title: 'The Best of Uffie', record_type: 'album', fans: 9000 },
    { id: 12, title: 'Pop the Glock', record_type: 'single', fans: 9999 },
    { id: 13, title: 'Live at Coachella', record_type: 'album', fans: 9999 },
  ] },
  'artist/1/top': { data: [{ title: 'Pop the Glock', album: { id: 12 } }, { title: 'MCs Can Kiss', album: { id: 10 } }] },
  'search/artist?q=Cut%20Copy': { data: [{ id: 3, name: 'Cut Copy', nb_fan: 50000 }] },
  'artist/3/albums': { data: [
    { id: 30, title: 'Bright Like Neon Love', record_type: 'album', release_date: '2004', fans: 10 },
    { id: 31, title: 'In Ghost Colours', record_type: 'album', release_date: '2008', fans: 20, cover_big: 'c.jpg' },
    { id: 32, title: 'Zonoscope', record_type: 'album', release_date: '2011', fans: 99 },
  ] },
  'artist/3/top': { data: [{ title: 'Lights & Music', album: { id: 31 } }, { title: 'Hearts on Fire', album: { id: 31 } }, { title: 'Need You Now', album: { id: 32 } }] },
  'search?q=Klaxons%20Golden%20Skans': { data: [
    { title: 'Golden Skans (Erol Alkan Remix)', artist: { name: 'Klaxons' }, album: { cover_big: 'x.jpg' } },
    { title: 'Golden Skans', artist: { name: 'Klaxons Tribute Band' } },
    { title: 'Golden Skans', artist: { name: 'Klaxons' }, preview: 'p.mp3', album: { cover_big: 'k.jpg' } },
  ] },
}
const calls: string[] = []
const fetchJson = async (url: string): Promise<unknown> => {
  const path = url.replace('https://api.deezer.com/', '').replace(/&limit=\d+$/, '').replace(/\?limit=\d+$/, '')
  calls.push(path)
  return DEEZER[path] ?? { data: [] }
}

test('the list contract carries `wanted`; a bad item is dropped, never the list', () => {
  const l = parseIpodList(raw({ wanted: [{ artist: 'Uffie', why: 'blog house', addedAt: AT }, { artist: '', addedAt: AT }, { title: 'x' }] }))!
  assert.deepEqual(l.wanted, [{ artist: 'Uffie', why: 'blog house', addedAt: AT }])
  assert.equal('wanted' in parseIpodList(raw())!, false)
})

test('best-known record: the album the top tracks come from; never a single, best-of or live record', () => {
  const pick = bestKnownAlbum(DEEZER['artist/3/albums'] ? (DEEZER['artist/3/albums'] as { data: Array<Record<string, unknown>> }).data : [], (DEEZER['artist/3/top'] as { data: Array<Record<string, unknown>> }).data)
  assert.equal(pick?.title, 'In Ghost Colours')
  const uffie = bestKnownAlbum((DEEZER['artist/1/albums'] as { data: Array<Record<string, unknown>> }).data, (DEEZER['artist/1/top'] as { data: Array<Record<string, unknown>> }).data)
  assert.equal(uffie?.title, 'Sex Dreams and Denim Jeans')
  // no top-track evidence: most fans
  assert.equal(bestKnownAlbum((DEEZER['artist/3/albums'] as { data: Array<Record<string, unknown>> }).data, [])?.title, 'Zonoscope')
  assert.equal(bestKnownAlbum([{ title: 'Greatest Hits', record_type: 'album' }, { title: 'X', record_type: 'compile' }], []), null)
})

test('lookup: the act of exactly that name, most fans first; a song by exact artist and title only', async () => {
  const a = await lookupWanted({ artist: 'Uffie' }, { fetchJson })
  assert.deepEqual(a, { type: 'album', artist: 'Uffie', title: 'Sex Dreams and Denim Jeans', year: '2010', artUrl: 'u1.jpg' })
  const s = await lookupWanted({ artist: 'Klaxons', title: 'Golden Skans' }, { fetchJson })
  assert.deepEqual(s, { type: 'song', artist: 'Klaxons', title: 'Golden Skans', artUrl: 'k.jpg', previewUrl: 'p.mp3' })
  assert.equal(await lookupWanted({ artist: 'Nobody Here' }, { fetchJson }), null)
})

test('shelves: one per list, owned artists and songs never appear, every card says why', async () => {
  const lists: IpodList[] = [
    parseIpodList(raw({ wanted: [
      { artist: 'Uffie', addedAt: AT }, { artist: 'Cut Copy', addedAt: AT }, { artist: 'Bloc Party', addedAt: AT },
      { artist: 'Klaxons', title: 'Golden Skans', addedAt: AT },
    ] }))!,
    parseIpodList({ ...raw(), id: '5e7f7a64-f770-48bd-a3dc-58bca2a6b716', name: 'Totally 80s' })!,
  ]
  const owns = await ownershipFromTracks([
    { artist: 'Bloc Party', title: 'Banquet', album: 'Silent Alarm' },
    { artist: 'Klaxons', title: 'Atlantis to Interzone' },
  ])
  const looked: string[] = []
  const shelves = await buildWantedShelves(lists, { fetchJson, ...owns }, async (w) => { looked.push(w.artist); return lookupWanted(w, { fetchJson }) })
  assert.equal(shelves.length, 1)
  assert.equal(shelves[0]!.title, 'Wanted for Indie Sleeze')
  assert.deepEqual(shelves[0]!.cards.map((c) => `${c.artist}: ${c.title}`), ['Uffie: Sex Dreams and Denim Jeans', 'Cut Copy: In Ghost Colours', 'Klaxons: Golden Skans'])
  assert.ok(!looked.includes('Bloc Party'), 'an owned artist is never even looked up')
  assert.equal(shelves[0]!.cards[0]!.why, 'Indie Sleeze is missing Uffie')
  assert.equal(shelves[0]!.cards[2]!.why, wantedWhy('Indie Sleeze', { artist: 'Klaxons', title: 'Golden Skans' }))
  assert.ok(shelves[0]!.cards.every((c) => c.lane === 'ipod-wanted'))
  // owning the song drops it
  const owns2 = await ownershipFromTracks([{ artist: 'Klaxons', title: 'Golden Skans' }])
  const again = await buildWantedShelves(lists, { fetchJson, ...owns2 }, (w) => lookupWanted(w, { fetchJson }))
  assert.ok(!again[0]!.cards.some((c) => c.title === 'Golden Skans'))
})

test('source: homemini down = no section; lookups are cached on disk and reused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jt-ipod-wanted-'))
  try {
    let lists: IpodList[] | null = null
    let fetches = 0
    const fetchImpl = (async (url: string) => { fetches++; return { json: async () => fetchJson(String(url)) } }) as unknown as typeof fetch
    const src = createWantedShelfSource({ stateDir: dir, lists: async () => lists, libraryTracks: async () => [], fetchImpl, sleepMs: 0 })
    const down = await src.get(true)
    assert.equal(down.ok, false)
    assert.deepEqual(down.shelves, [])
    lists = [parseIpodList(raw({ wanted: [{ artist: 'Uffie', addedAt: AT }] }))!]
    const up = await src.get(true)
    assert.equal(up.shelves[0]!.cards[0]!.title, 'Sex Dreams and Denim Jeans')
    const n = fetches
    assert.ok(n > 0)
    const cached = JSON.parse(await readFile(join(dir, WANTED_LOOKUPS_FILE), 'utf8')) as Record<string, { hit: WantedHit }>
    assert.equal(Object.values(cached)[0]!.hit?.title, 'Sex Dreams and Denim Jeans')
    const src2 = createWantedShelfSource({ stateDir: dir, lists: async () => lists, libraryTracks: async () => [], fetchImpl, sleepMs: 0 })
    await src2.get(true)
    assert.equal(fetches, n, 'a fresh process answers from the cache')
    lists = null
    assert.equal((await src.get(true)).shelves.length, 1, 'homemini going away keeps the last good shelves')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a named record: that one, in whatever edition Deezer has it; never a live record or best-of by that name', async () => {
  const albums = [
    { id: 1, title: 'Hysteria (Deluxe Edition)', record_type: 'album', fans: 50, cover_big: 'h-deluxe.jpg' },
    { id: 2, title: 'Hysteria - Live at the Whisky', record_type: 'album', fans: 900 },
    { id: 3, title: 'Hysteria (Remastered 2017)', record_type: 'album', fans: 80, cover_big: 'h-rem.jpg' },
    { id: 4, title: 'Pyromania', record_type: 'album', fans: 99 },
  ]
  const { namedAlbum } = await import('../ipod-wanted-shelf.ts')
  assert.equal(namedAlbum(albums, 'Hysteria')?.cover_big, 'h-rem.jpg')
  assert.equal(namedAlbum([...albums, { id: 5, title: 'Hysteria', fans: 1, cover_big: 'h.jpg' }], 'Hysteria')?.cover_big, 'h.jpg')
  assert.equal(namedAlbum([{ title: 'Hysteria (Live)', fans: 5 }], 'Hysteria'), null)
  assert.equal(namedAlbum(albums, 'Adrenalize'), null)
  // lookup shows the named record, with art when Deezer has it
  const hit = await lookupWanted({ artist: 'Uffie', album: 'Sex Dreams and Denim Jeans' }, { fetchJson })
  assert.deepEqual(hit, { type: 'album', artist: 'Uffie', title: 'Sex Dreams and Denim Jeans', artUrl: 'u1.jpg' })
  const none = await lookupWanted({ artist: 'Uffie', album: 'A Record Deezer Lacks' }, { fetchJson })
  assert.deepEqual(none, { type: 'album', artist: 'Uffie', title: 'A Record Deezer Lacks' })
})

// 2026-11-09, after #393 shipped (Jake: "record shop is still weird"): the
// section must show from the list doc as homemini writes it, and from this
// Mac's kept copy of it when homemini doesn't answer.
test('For Your iPods renders from the list doc: the rows lead the page, one per list that wants something', async () => {
  const { buildShopPage } = await import('../../common/record-shop-page.ts')
  const dir = await mkdtemp(join(tmpdir(), 'jt-ipod-wanted-page-'))
  try {
    const fetchImpl = (async (url: string) => ({ json: async () => fetchJson(String(url)) })) as unknown as typeof fetch
    const lists = [
      parseIpodList(raw({ wanted: [{ artist: 'Uffie', addedAt: AT }, { artist: 'Cut Copy', album: 'In Ghost Colours', addedAt: AT }] }))!,
      parseIpodList({ ...raw(), id: 'b0b0b0b0-0000-4000-8000-000000000000', name: 'punkPod', purpose: 'punk' })!,   // wants nothing: no row
    ]
    const src = createWantedShelfSource({ stateDir: dir, lists: async () => lists, libraryTracks: async () => [], fetchImpl, sleepMs: 0 })
    const r = await src.get(true)
    assert.equal(r.ok, true)
    const page = buildShopPage({
      lanes: [{ id: 'fresh-albums', cards: [{ lane: 'fresh-albums', type: 'album', artist: 'Cut Copy', title: 'In Ghost Colours', genre: 'Electronic' }] }],
      wanted: r.shelves, year: '2026',
    })
    assert.deepEqual(page.ipods.map((row) => [row.title, row.cards.map((s) => s.card.title)]), [['Wanted for Indie Sleeze', ['Sex Dreams and Denim Jeans', 'In Ghost Colours']]])
    assert.equal(page.crates.length, 0, 'the record the iPod row shows is not shown again in a crate')
    assert.equal(page.counts.ipods, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("homemini away: the shop reads this Mac's kept copy of the lists (ipod-lists-cache.json); an empty shelf is asked again within minutes", async () => {
  const { readFileSync } = await import('node:fs')
  const ipc = readFileSync(join(import.meta.dirname, '../ipc/ipod-lists-ipc.ts'), 'utf8')
  assert.match(ipc, /lists: async \(\) => \(await source\.all\(\)\.catch\(\(\) => null\)\) \?\? readListsCache\(ipodListsCachePath\(host\.stateDir\)\)/)
  const dir = await mkdtemp(join(tmpdir(), 'jt-ipod-wanted-ttl-'))
  try {
    let clock = 0
    let lists: IpodList[] = [parseIpodList(raw())!]   // no `wanted` yet
    const fetchImpl = (async (url: string) => ({ json: async () => fetchJson(String(url)) })) as unknown as typeof fetch
    const src = createWantedShelfSource({ stateDir: dir, lists: async () => lists, libraryTracks: async () => [], fetchImpl, sleepMs: 0, now: () => clock })
    assert.deepEqual((await src.get()).shelves, [])
    lists = [parseIpodList(raw({ wanted: [{ artist: 'Uffie', addedAt: AT }] }))!]   // homemini writes `wanted`
    clock = 60_000
    assert.deepEqual((await src.get()).shelves, [], 'held for a minute')
    clock = 6 * 60_000
    assert.equal((await src.get()).shelves.length, 1, 'after five minutes the empty shelf is asked again')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
