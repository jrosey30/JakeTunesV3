/**
 * The origin backfill (2026-10-18). From 10/12 it asked nobody: the first 10
 * artists of the walk were remembered "unknown", every remembered answer was
 * charged to the 10-per-sweep budget, and 123 other artists (The Avalanches,
 * Thursday, zebrahead…) were never asked. No network here — MusicBrainz is a
 * fake that answers from fixtures and records every URL.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillOrigins, planOrigins, runFilerSweep, originArtist, originCacheKey, originCacheFromV2, ORIGIN_RETRY_MS, type FilerTrack, type FilerDeps, type OriginCache } from '../genre-filer.ts'
import { lookupArtistOrigin, cleanAlbumTitle, originNames, ORIGIN_MAX_ALBUM_QUERIES, type OriginLookup } from '../origin-lookup.ts'
import { normName } from '../taste-profile.ts'

const NOW = new Date('2026-10-18T12:00:00Z')
const T = (id: number, artist: string, album: string, extra: Partial<FilerTrack> = {}): FilerTrack =>
  ({ id, title: `t${id}`, artist, album, genre: 'Indie Rock', genreApproved: true, duration: 1000 + id, ...extra })
const found = (origin: string): OriginLookup => ({ kind: 'found', origin, source: 'mb', mbid: `mbid-${origin}`, evidence: 'test' })
const unknown: OriginLookup = { kind: 'unknown', note: 'no MusicBrainz artist of that name' }
const busy: OriginLookup = { kind: 'busy', note: 'musicbrainz.org 503' }

function harness(tracks: FilerTrack[], answer: (artist: string, albums: string[]) => OriginLookup, cache: OriginCache = {}, extra: Partial<FilerDeps> = {}) {
  const asked: Array<[string, string[]]> = []
  const persisted: Array<[number, Record<string, string>]> = []
  const logs: string[] = []
  const state = { cache, saves: 0 }
  const deps: FilerDeps = {
    tracks: async () => tracks,
    persist: async (t, f) => { persisted.push([t.id, f]) },
    applied: () => {},
    evidence: async () => ({ artistTags: [], albumTags: [], press: '' }),
    classify: async () => '[]',
    loadCheck: async () => [],
    saveCheck: async () => {},
    log: (m) => logs.push(m),
    now: () => NOW,
    lookupOrigin: async (a, albums) => { asked.push([a, albums]); return answer(a, albums) },
    loadOriginCache: async () => JSON.parse(JSON.stringify(state.cache)) as OriginCache,
    saveOriginCache: async (c) => { state.cache = JSON.parse(JSON.stringify(c)) as OriginCache; state.saves++ },
    ...extra,
  }
  const originOf = (id: number): string | undefined => persisted.find(([tid, f]) => tid === id && f.origin)?.[1].origin
  return { deps, asked, persisted, logs, state, originOf, sweep: () => fillOrigins(deps, tracks, new Map(), new Set()) }
}

const remembered = (origin: string | null, ageMs = 0): { origin: string | null; at: number } => ({ origin, at: NOW.getTime() - ageMs })

describe('the per-sweep budget pays for lookups only', () => {
  it('remembered answers — known or unknown — cost nothing', async () => {
    const lib = Array.from({ length: 14 }, (_, i) => T(i + 1, `Artist ${String(i + 1).padStart(2, '0')}`, `Album ${i + 1}`))
    const cache: OriginCache = {}
    for (let i = 1; i <= 6; i++) cache[originCacheKey(`Artist ${String(i).padStart(2, '0')}`)] = remembered(null)            // nobody knows, recently
    for (let i = 7; i <= 10; i++) cache[originCacheKey(`Artist ${String(i).padStart(2, '0')}`)] = remembered('Canada')       // known
    const h = harness(lib, () => found('Japan'), cache, { maxOriginLookups: 3 })
    await h.sweep()
    assert.equal(h.asked.length, 3, 'three real lookups — the budget')
    assert.ok(h.asked.every(([a]) => Number(a.slice(-2)) > 10), 'never a remembered artist')
    for (let id = 7; id <= 10; id++) assert.equal(h.originOf(id), 'Canada', 'remembered origins are written for free')
    for (let id = 1; id <= 6; id++) assert.equal(h.originOf(id), undefined, 'remembered unknowns stay blank, unasked')
  })

  it("the live 10/12 shape: ten remembered unknowns at the head of the walk don't starve the 123 behind them", async () => {
    // The 10 keys origin-lookups-v2.json held, in the walk's order, then everyone else.
    const head = ['Charlie', "Gary's Garage", 'Adri Block & Paul Parsons', 'Blende & Gustaph', 'Block & Crown, Paul Parsons', 'Dubdisko', 'Eric Faria & Mr Kris', 'Lola Palmer', 'Mr. Kris & Eric Faria', 'Nicolas Caprile & Jorhav']
    const rest = ['The Avalanches', 'Thursday', 'zebrahead', 'Grimes', 'Q Lazzarus']
    const lib = [...head, ...rest].map((a, i) => T(i + 1, a, `Album ${i}`))
    const cache = Object.fromEntries(head.map((a) => [originCacheKey(a), remembered(null, 6 * 24 * 3600_000)]))
    const h = harness(lib, () => unknown, cache)
    await h.sweep()
    assert.deepEqual(h.asked.map(([a]) => a).sort(), [...rest].sort(), 'every never-asked artist asked in ONE sweep')
    const again = harness(lib, () => unknown, h.state.cache)
    await again.sweep()
    assert.deepEqual(again.asked, [], 'and nobody asked twice inside the retry window')
  })

  it('an unknown is asked again once its retry time has passed', async () => {
    const lib = [T(1, 'Old Unknown', 'A'), T(2, 'Fresh Unknown', 'B')]
    const h = harness(lib, () => found('France'), {
      [originCacheKey('Old Unknown')]: remembered(null, ORIGIN_RETRY_MS + 1),
      [originCacheKey('Fresh Unknown')]: remembered(null, ORIGIN_RETRY_MS - 60_000),
    })
    await h.sweep()
    assert.deepEqual(h.asked.map(([a]) => a), ['Old Unknown'])
    assert.equal(h.originOf(1), 'France')
  })

  it('answers are remembered with their source, unknowns with the reason', async () => {
    const h = harness([T(1, 'Sap', 'Lard Baby'), T(2, 'Diary', 'Spiral Bound')], (a) => a === 'Sap' ? found('United States') : unknown)
    await h.sweep()
    assert.deepEqual(h.state.cache[originCacheKey('Sap')], { origin: 'United States', at: NOW.getTime(), source: 'mb', mbid: 'mbid-United States', note: 'test' })
    assert.deepEqual(h.state.cache[originCacheKey('Diary')], { origin: null, at: NOW.getTime(), note: 'no MusicBrainz artist of that name' })
  })
})

describe('MusicBrainz busy is never an answer', () => {
  it('a 503 is not remembered; the artist is asked again next sweep — behind the never-failed', async () => {
    const lib = [T(1, 'Busy Band', 'A'), T(2, 'Busy Band', 'A2'), T(3, 'Second', 'B'), T(4, 'Third', 'C')]
    const h = harness(lib, (a) => a === 'Busy Band' ? busy : found('Chile'))
    await h.sweep()
    assert.deepEqual(h.asked.map(([a]) => a), ['Busy Band', 'Second', 'Third'], 'one busy answer skips that artist, not the sweep')
    const entry = h.state.cache[originCacheKey('Busy Band')]
    assert.equal(entry.origin, undefined, 'not cached as unknown')
    assert.equal(entry.failedAt, NOW.getTime())
    assert.equal(h.originOf(1), undefined)
    assert.ok(h.logs.some((l) => /^\[genre-filer\] origin: Busy Band — lookup busy/.test(l)))
    const more = [...lib, T(5, 'Fourth', 'D')]
    const next = harness(more, () => found('Chile'), h.state.cache)
    await next.sweep()
    assert.deepEqual(next.asked.map(([a]) => a), ['Fourth', 'Busy Band'], 'asked again — after the artists that never failed')
    assert.equal(next.originOf(1), 'Chile')
  })

  it('a second busy answer stops the sweep (no hammering a struggling MusicBrainz)', async () => {
    const lib = [T(1, 'B1', 'A'), T(2, 'B1', 'A'), T(3, 'B1', 'A'), T(4, 'B2', 'B'), T(5, 'B2', 'B'), T(6, 'C', 'C')]
    const h = harness(lib, (a) => a === 'C' ? found('Chile') : busy)
    await h.sweep()
    assert.deepEqual(h.asked.map(([a]) => a), ['B1', 'B2'])
    assert.ok(h.logs.includes('[genre-filer] origins: asked 2 of 10, 2 busy (stopped), 3 artists still to ask'))
    assert.deepEqual(Object.values(h.state.cache).map((e) => e.origin), [undefined, undefined], 'nothing remembered as unknown')
  })

  it('the lookup reports 503 / 429 / timeouts as busy, and a 400 as a plain miss', async () => {
    const net = (status: number | 'timeout') => ({
      throttle: async () => {}, userAgent: 'test',
      fetchFn: (async () => {
        if (status === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        return new Response('x', { status })
      }) as unknown as typeof fetch,
    })
    for (const s of [503, 429, 502, 'timeout'] as const) assert.equal((await lookupArtistOrigin('The Avalanches', ['No Bad Memories'], net(s))).kind, 'busy', String(s))
    assert.equal((await lookupArtistOrigin('The Avalanches', ['No Bad Memories'], net(400))).kind, 'unknown', 'a malformed query is not worth asking forever')
  })

  it('busy halfway through an artist (album search 503) is still busy, not unknown', async () => {
    const mb = fakeMb({ artists: { 'The Creem': [{ id: 'creem', name: 'The Creem', score: 100 }] }, failReleaseGroups: 503 })
    assert.equal((await lookupArtistOrigin('The Creem', ['A Taste Of Cherry'], mb.net)).kind, 'busy')
  })
})

// ── a fake MusicBrainz ──────────────────────────────────────────────────
type FakeArtist = { id: string; name: string; score: number; country?: string; aliases?: Array<{ name: string }> }
type FakeRg = { title: string; credit: string; ids: string[] }
function fakeMb(fx: { artists?: Record<string, FakeArtist[]>; releaseGroups?: FakeRg[]; details?: Record<string, unknown>; failReleaseGroups?: number }) {
  const urls: string[] = []
  const unq = (s: string): string => s.replace(/\\(.)/g, '$1')
  const fetchFn = (async (input: string) => {
    const url = String(input)
    urls.push(url)
    const u = new URL(url)
    const q = u.searchParams.get('query') ?? ''
    if (u.pathname === '/ws/2/artist') {
      const name = unq(q.match(/^artist:"((?:[^"\\]|\\.)*)"/)![1])
      return Response.json({ artists: fx.artists?.[name] ?? [] })
    }
    if (u.pathname === '/ws/2/release-group') {
      if (fx.failReleaseGroups) return new Response('busy', { status: fx.failReleaseGroups })
      const m = q.match(/^releasegroup:"((?:[^"\\]|\\.)*)" AND artist:"((?:[^"\\]|\\.)*)"$/)!
      const [title, artist] = [normName(unq(m[1])), normName(unq(m[2]))]
      const hits = (fx.releaseGroups ?? []).filter((r) => normName(r.title).includes(title) && normName(r.credit).includes(artist))
      return Response.json({ 'release-groups': hits.map((r) => ({ title: r.title, 'artist-credit': r.ids.map((id) => ({ artist: { id } })) })) })
    }
    const detail = u.pathname.match(/^\/ws\/2\/artist\/([^/]+)$/)
    if (detail) return Response.json(fx.details?.[decodeURIComponent(detail[1])] ?? {})
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  const searched = (): string[] => urls.filter((x) => x.includes('/ws/2/artist?')).map((x) => unq(new URL(x).searchParams.get('query')!.match(/^artist:"((?:[^"\\]|\\.)*)"/)![1]))
  const rgQueries = (): Array<[string, string]> => urls.filter((x) => x.includes('/release-group?')).map((x) => { const m = new URL(x).searchParams.get('query')!.match(/^releasegroup:"((?:[^"\\]|\\.)*)" AND artist:"((?:[^"\\]|\\.)*)"$/)!; return [unq(m[1]), unq(m[2])] })
  return { urls, searched, rgQueries, net: { throttle: async () => {}, userAgent: 'test', fetchFn } }
}

describe('same identity rule, better matching', () => {
  it('store suffixes come off the title before the search', () => {
    assert.equal(cleanAlbumTitle('Not Enough Garys - EP'), 'Not Enough Garys')
    assert.equal(cleanAlbumTitle('Frozen Gary - Single'), 'Frozen Gary')
    assert.equal(cleanAlbumTitle('The Nervous Track - EP'), 'The Nervous Track')
    assert.equal(cleanAlbumTitle('HAUSDOGS02 [HD002]'), 'HAUSDOGS02')
    assert.equal(cleanAlbumTitle('Sunrise - Single [CAT001]'), 'Sunrise')
    assert.equal(cleanAlbumTitle('BONJOUR (BIS)'), 'BONJOUR (BIS)', 'parentheses are part of a title')
    assert.equal(cleanAlbumTitle('The Early Years - Revisited'), 'The Early Years - Revisited', 'only EP / Single are store suffixes')
    assert.equal(cleanAlbumTitle('[Untitled]'), '[Untitled]', 'never down to nothing')
  })

  it("Gary's Garage: the EP is found once \" - EP\" is gone, and quotes in a title can't break the query", async () => {
    const mb = fakeMb({
      artists: { "Gary's Garage": [{ id: 'gg', name: "Gary's Garage", score: 100, country: 'US' }] },
      releaseGroups: [{ title: 'Not Enough Garys', credit: "Gary's Garage", ids: ['gg'] }],
    })
    const r = await lookupArtistOrigin("Gary's Garage", ['Not Enough Garys - EP', 'Frozen Gary - Single'], mb.net)
    assert.deepEqual(r, { kind: 'found', origin: 'United States', source: 'mb', mbid: 'gg', evidence: 'credited on "Not Enough Garys"' })
    assert.deepEqual(mb.rgQueries(), [['Not Enough Garys', "Gary's Garage"]])
    const q = fakeMb({ artists: { 'A "Q" B': [{ id: 'q', name: 'A "Q" B', score: 100, country: 'FR' }] }, releaseGroups: [{ title: 'Say "Hi"', credit: 'A Q B', ids: ['q'] }] })
    assert.equal((await lookupArtistOrigin('A "Q" B', ['Say "Hi"'], q.net)).kind, 'found')
    assert.ok(q.urls.every((u) => decodeURIComponent(u).includes('\\"')), 'quotes escaped in every Lucene phrase')
  })

  it('tries every album, not just the first two — within a bounded number of requests', async () => {
    const albums = Array.from({ length: 6 }, (_, i) => `Record ${i + 1}`)
    const mb = fakeMb({ artists: { Vulfmon: [{ id: 'vm', name: 'Vulfmon', score: 100, country: 'US' }] }, releaseGroups: [{ title: 'Record 6', credit: 'Vulfmon', ids: ['vm'] }] })
    assert.equal((await lookupArtistOrigin('Vulfmon', albums, mb.net)).kind, 'found', 'the sixth album proves it')
    const many = Array.from({ length: 20 }, (_, i) => `LP ${i + 1}`)
    const capped = fakeMb({ artists: { Vulfmon: [{ id: 'vm', name: 'Vulfmon', score: 100, country: 'US' }] }, releaseGroups: [{ title: 'LP 20', credit: 'Vulfmon', ids: ['vm'] }] })
    const r = await lookupArtistOrigin('Vulfmon', many, capped.net)
    assert.equal(capped.rgQueries().length, ORIGIN_MAX_ALBUM_QUERIES, 'the 20th album is never reached')
    assert.ok(r.kind !== 'found' || r.source !== 'mb', 'so no album proved it')
  })

  it('the identity rule itself is unchanged: a same-name artist not credited on his album is never his origin', async () => {
    const mb = fakeMb({
      artists: { 'Scarlet Rose': [{ id: 'sr-de', name: 'Scarlet Rose', score: 100 }, { id: 'sr-nl', name: 'Scarlet Rose', score: 98, country: 'NL' }] },
      releaseGroups: [{ title: 'Pangea', credit: 'Scarlet Rose', ids: ['someone-else'] }],
    })
    assert.equal((await lookupArtistOrigin('Scarlet Rose', ['Pangea'], mb.net)).kind, 'unknown')
  })
})

describe('a multi-artist credit is its FIRST artist', () => {
  it('the names asked, most specific first', () => {
    assert.deepEqual(originNames('Block & Crown, Paul Parsons').names, ['Block & Crown, Paul Parsons', 'Block & Crown', 'Block'])
    assert.deepEqual(originNames('Dreamer G & Kerri Chandler').names, ['Dreamer G & Kerri Chandler', 'Dreamer G'])
    assert.deepEqual(originNames('EQ, Estratosfera, Qiri').names, ['EQ, Estratosfera, Qiri', 'EQ'])
    assert.deepEqual(originNames('Gorillaz feat. Little Simz').names, ['Gorillaz'])
    assert.deepEqual(originNames('Kaytranada (feat. Kali Uchis)').names, ['Kaytranada'])
    assert.deepEqual(originNames('Little Feat').names, ['Little Feat'], 'a band named Feat is not a featuring credit')
    assert.deepEqual(originNames('Thursday').names, ['Thursday'])
  })

  it('"Block & Crown, Paul Parsons" → Block & Crown, proven by the album; Paul Parsons is never asked', async () => {
    const mb = fakeMb({
      artists: {
        'Block & Crown': [{ id: 'bc', name: 'Block & Crown', score: 100, country: 'GB' }],
        'Paul Parsons': [{ id: 'pp', name: 'Paul Parsons', score: 100, country: 'US' }],
      },
      releaseGroups: [{ title: 'Keep On Going', credit: 'Block & Crown, Paul Parsons', ids: ['bc', 'pp'] }],
    })
    const r = await lookupArtistOrigin('Block & Crown, Paul Parsons', ['Keep On Going'], mb.net)
    assert.equal(r.kind === 'found' && r.origin, 'United Kingdom')
    assert.ok(!mb.searched().includes('Paul Parsons'))
    assert.ok(!mb.searched().includes('Block'), 'found before the shortest name was needed')
  })

  it('"Love, DEAN" is one artist when MusicBrainz says so — the whole credit is asked first', async () => {
    const mb = fakeMb({
      artists: { 'Love, DEAN': [{ id: 'ld', name: 'Love, DEAN', score: 100, country: 'GB' }], Love: [{ id: 'love', name: 'Love', score: 100, country: 'US' }] },
      releaseGroups: [{ title: 'Love, DEAN', credit: 'Love, DEAN', ids: ['ld'] }],
    })
    const r = await lookupArtistOrigin('Love, DEAN', ['Love, DEAN'], mb.net)
    assert.equal(r.kind === 'found' && r.origin, 'United Kingdom')
    assert.deepEqual(mb.searched(), ['Love, DEAN'])
  })

  it("a shorter name never takes a namesake's origin: Love is not credited on Love, DEAN", async () => {
    const mb = fakeMb({
      artists: { Love: [{ id: 'love', name: 'Love', score: 100, country: 'US' }] },
      releaseGroups: [{ title: 'Love, DEAN', credit: 'Love, DEAN', ids: ['ld-unknown-to-search'] }],
    })
    assert.equal((await lookupArtistOrigin('Love, DEAN', ['Love, DEAN'], mb.net)).kind, 'unknown')
  })

  it('a featured guest is dropped before anything is asked', async () => {
    const mb = fakeMb({ artists: { Gorillaz: [{ id: 'gz', name: 'Gorillaz', score: 100, country: 'GB' }] }, releaseGroups: [{ title: 'Cracker Island', credit: 'Gorillaz', ids: ['gz'] }] })
    const r = await lookupArtistOrigin('Gorillaz feat. Thundercat', ['Cracker Island'], mb.net)
    assert.equal(r.kind === 'found' && r.origin, 'United Kingdom')
    assert.deepEqual(mb.rgQueries(), [['Cracker Island', 'Gorillaz']])
  })
})

describe('who is asked', () => {
  it('songs whose genre is not settled yet get their origin too (origin is the artist\'s, not the genre\'s)', async () => {
    const lib = [T(1, 'Gramme', 'Fascination', { genre: 'Alternatif et Indé, Rock, Pop', genreApproved: false })]
    const h = harness(lib, () => found('United Kingdom'), {}, { maxUnits: 0 })   // the genre pass defers it
    await runFilerSweep(h.deps)
    assert.deepEqual(h.asked.map(([a]) => a), ['Gramme'])
    assert.equal(h.originOf(1), 'United Kingdom')
  })

  it("Various Artists: each song's own artist, first-artist rule inside the lookup; a known artist is copied free", async () => {
    const va = { albumArtist: 'Various Artists', compilation: true }
    const lib = [
      T(1, 'Lou Reed', 'Transformer', { origin: 'United States' }),
      T(2, 'Lou Reed', 'Pulp Fiction OST', va),
      T(3, 'Dick Dale & His Del-Tones', 'Pulp Fiction OST', va),
      T(4, 'Urge Overkill', 'Pulp Fiction OST', va),
      T(5, 'Various Artists', 'Pulp Fiction OST', va),
    ]
    assert.equal(originArtist(lib[2]), 'Dick Dale & His Del-Tones')
    const h = harness(lib, (a) => found(a.startsWith('Dick Dale') ? 'United States' : 'Canada'))
    await h.sweep()
    assert.deepEqual(h.asked.map(([a, al]) => [a, al]).sort(), [['Dick Dale & His Del-Tones', ['Pulp Fiction OST']], ['Urge Overkill', ['Pulp Fiction OST']]])
    assert.equal(h.originOf(2), 'United States', 'Lou Reed from his own albums — no lookup')
    assert.equal(h.originOf(5), undefined, '"Various Artists" is nobody')
  })

  it('albums go to the lookup most songs first', () => {
    const lib = [T(1, 'Sap', 'Erasure'), T(2, 'Sap', 'Lard Baby'), T(3, 'Sap', 'Lard Baby')]
    assert.deepEqual(planOrigins(lib, {}, NOW.getTime())[0].albums, ['Lard Baby', 'Erasure'])
  })
})

describe('logs and writes', () => {
  it('one warn-level line per artist answered; nothing for a remembered unknown', async () => {
    const lib = [T(1, 'Thursday', 'No Devolución'), T(2, 'Blessy', 'Ovnia Podcast 004'), T(3, 'Charlie', 'X')]
    const h = harness(lib, (a) => a === 'Thursday' ? found('United States') : unknown, { [originCacheKey('Charlie')]: remembered(null) })
    await h.sweep()
    assert.deepEqual(h.logs, [
      '[genre-filer] origin: Blessy — unknown (no MusicBrainz artist of that name)',
      '[genre-filer] origin: Thursday → United States (mb, test; 1 song)',
      '[genre-filer] origins: asked 2 of 10, 0 artists still to ask',
    ])
    const quiet = harness(lib, () => unknown, h.state.cache)
    await quiet.sweep()
    assert.deepEqual(quiet.logs.filter((l) => !l.includes('Thursday')), [], 'remembered answers are silent')
  })

  it('wired: warn-level logs, the override writer, the v3 cache; never library.json', () => {
    const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
    const ipc = src('main/ipc/genre-filer-ipc.ts')
    assert.match(ipc, /log: \(m\) => console\.warn\(m\)/)
    assert.match(ipc, /console\.warn\(`\[genre-filer\] sweep:/)
    assert.match(ipc, /origin-lookups-v3\.json/)
    assert.match(src('main/index.ts'), /registerGenreFilerIpc\(ipc, \{[^\n]*persist: \(id, fields, fp\) => persistOverrideFields\(id, fields, fp\)/)
    for (const f of ['main/genre-filer.ts', 'main/ipc/genre-filer-ipc.ts', 'main/origin-lookup.ts']) assert.ok(!/library\.json/.test(src(f)), f)
  })

  it('v2 → v3: known answers carry over; the old matcher\'s unknowns are asked once more', () => {
    assert.deepEqual(originCacheFromV2({ 'gary s garage': { origin: null, at: 1 }, mesh: { origin: 'United States', at: 2 } }),
      { mesh: { origin: 'United States', at: 2, source: 'mb', note: 'v2' } })
    assert.deepEqual(originCacheFromV2('junk'), {})
  })
})
