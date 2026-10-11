/**
 * Jake's taste profile in the Record Shop (2026-10-10, Rocksurgence step 1):
 * Rocksurgence's artists seed discovery; math rock stays out; Angine de
 * Poitrine is loved as an exception, never a template.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeProfile, genreBlocked, dropExceptionAnchors, exemplarPool, focusAnchors, isException, EMPTY_PROFILE, type TasteProfile,
} from '../taste-profile.ts'
import { ensureArtistTags, musicBrainzTags, cachedTags, TAG_TTL_MS, type TagCache } from '../artist-tags.ts'
import { loadDiscoveryFocus } from '../discovery-focus.ts'
import { filterFeed } from '../discover-feed.ts'

const P: TasteProfile = normalizeProfile({
  focusPlaylists: ['pl-rock'],
  lowGenres: ['math rock'],
  exceptions: [{ artist: 'Angine de Poitrine', genre: 'math rock', note: 'exceptional, not math rock' }],
})

describe('the genre gate', () => {
  it('math rock stays out; Angine passes as the exception', () => {
    assert.equal(genreBlocked(P, 'Covet', ['math rock', 'instrumental']), true)
    assert.equal(genreBlocked(P, 'Angine de Poitrine', ['math rock']), false)
    assert.equal(genreBlocked(P, 'ANGINE DE POITRINE', ['math rock']), false, 'case and spacing')
  })
  it('spelling-tolerant, but never by containment', () => {
    assert.equal(genreBlocked(P, 'X', ['Math-Rock']), true)
    assert.equal(genreBlocked(P, 'X', ['mathrock']), true)
    assert.equal(genreBlocked(P, 'X', ['math rock revival']), false)
    const pop = normalizeProfile({ lowGenres: ['pop'] })
    assert.equal(genreBlocked(pop, 'blink-182', ['pop punk']), false, 'a low "pop" must not block pop punk')
  })
  it('no profile, no gate', () => {
    assert.equal(genreBlocked(EMPTY_PROFILE, 'Covet', ['math rock']), false)
  })
})

describe('an exception is never a template', () => {
  it('Angine never anchors digging', () => {
    const out = dropExceptionAnchors([{ artist: 'Geese' }, { artist: 'Angine de Poitrine' }], P)
    assert.deepEqual(out.map((a) => a.artist), ['Geese'])
  })
  it("Angine's songs don't teach the brain what to look for", () => {
    const tracks = [{ id: 1, artist: 'Geese' }, { id: 2, artist: 'Angine de Poitrine' }, { id: 3, artist: 'Remixer', albumArtist: 'Angine de Poitrine' }]
    assert.deepEqual(exemplarPool(tracks, P).map((t) => t.id), [1])
  })
  it('a profile with no exceptions changes nothing', () => {
    const tracks = [{ artist: 'A' }]
    assert.equal(exemplarPool(tracks, EMPTY_PROFILE), tracks)
    assert.equal(isException(EMPTY_PROFILE, 'Angine de Poitrine'), false)
  })
})

describe('Rocksurgence seeds discovery', () => {
  const tracks = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: i + 1, artist: 'Geese', playCount: 5 })),
    { id: 20, artist: 'Fat Dog', playCount: 2 }, { id: 21, artist: 'Fat Dog' },
    { id: 30, artist: 'Angine de Poitrine', playCount: 9 },
    ...['Been Stellar', 'Yard Act', 'Wunderhorse', 'Sick Shooters', 'The Bug Club', 'Crown Lands', 'Bonny', 'Sap', 'Keo', 'Die Spitz'].map((a, i) => ({ id: 40 + i, artist: a })),
    { id: 99, artist: 'Drake', playCount: 50 },
  ]
  const playlists = [
    { id: 'pl-rock', name: 'Rocksurgence', trackIds: [...Array.from({ length: 8 }, (_, i) => i + 1), 20, 21, 30, ...Array.from({ length: 10 }, (_, i) => 40 + i)] },
    { id: 'pl-other', name: 'Rap', trackIds: [99] },
  ]
  it('the most present artists always speak; the exception never does', () => {
    const a = focusAnchors(P, playlists, tracks, 0)
    assert.equal(a.length, 8)
    assert.deepEqual(a.slice(0, 2), ['Geese', 'Fat Dog'])
    assert.ok(!a.includes('Angine de Poitrine'))
    assert.ok(!a.includes('Drake'), 'only the focus playlist')
  })
  it('the rest rotate so every artist on the playlist gets days', () => {
    const seen = new Set<string>()
    for (let d = 0; d < 4; d++) focusAnchors(P, playlists, tracks, d).forEach((x) => seen.add(x))
    assert.equal(seen.size, 12, 'Geese, Fat Dog and all ten others')
  })
  it('a playlist can be named instead of id', () => {
    assert.ok(focusAnchors(normalizeProfile({ focusPlaylists: ['Rocksurgence'] }), playlists, tracks, 0).includes('Geese'))
  })
})

describe('MusicBrainz tags, cached', () => {
  it('looks up only what it lacks, caps per run, never caches a failure', async () => {
    const cache: TagCache = {}
    const asked: string[] = []
    const fetchTags = async (a: string): Promise<string[] | null> => { asked.push(a); return a === 'Down' ? null : [`${a} tag`] }
    const n = await ensureArtistTags(['A', 'B', 'Down', 'C'], cache, { fetchTags, now: 1000, maxLookups: 3, sleepMs: 0 })
    assert.equal(n, 3)
    assert.deepEqual(asked, ['A', 'B', 'Down'])
    assert.deepEqual(cachedTags(cache, 'a', 1000), ['A tag'])
    assert.equal(cachedTags(cache, 'Down', 1000), undefined, 'failure not cached — retried next time')
    await ensureArtistTags(['A', 'C'], cache, { fetchTags, now: 2000, sleepMs: 0 })
    assert.deepEqual(asked.slice(3), ['C'], 'A came from the cache')
    assert.equal(cachedTags(cache, 'A', 1000 + TAG_TTL_MS), undefined, 'entries expire')
  })
  it('takes the exact-name match, most-voted tags first', async () => {
    const body = { artists: [
      { name: 'Geese Tribute', score: 100, tags: [{ name: 'covers', count: 9 }] },
      { name: 'Geese', score: 100, tags: [{ name: 'rock', count: 2 }, { name: 'post-punk', count: 7 }] },
    ] }
    const fake = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    assert.deepEqual(await musicBrainzTags('Geese', 'test', fake), ['post-punk', 'rock'])
    const none = (async () => new Response(JSON.stringify({ artists: [] }), { status: 200 })) as unknown as typeof fetch
    assert.deepEqual(await musicBrainzTags('Nobody', 'test', none), [], 'unknown artist is a real answer')
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    assert.equal(await musicBrainzTags('Geese', 'test', down), null, 'rate limit = try again later')
  })
})

describe('the Record Shop reads the profile', () => {
  it('no profile file: every answer is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-focus-'))
    try {
      const f = await loadDiscoveryFocus(dir, [], { fetchTags: async () => ['math rock'] })
      assert.deepEqual(f.anchors(0), [])
      await f.prefetchTags([{ artist: 'Covet' }])
      assert.equal(f.blocks({ artist: 'Covet' }), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('with the profile: math-rock cards leave the feed, Angine and everyone else stay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-focus-'))
    try {
      writeFileSync(join(dir, 'taste-profile.json'), JSON.stringify({ lowGenres: ['math rock'], exceptions: [{ artist: 'Angine de Poitrine', genre: 'math rock' }] }))
      const tags: Record<string, string[]> = { Covet: ['math rock', 'instrumental'], 'Angine de Poitrine': ['math rock'], Geese: ['indie rock', 'post-punk'] }
      const f = await loadDiscoveryFocus(dir, [], { fetchTags: async (a) => tags[a] ?? [], now: 5 })
      const cards = ['Covet', 'Angine de Poitrine', 'Geese'].map((artist) => ({ artist, title: `${artist} LP`, type: 'album' as const }))
      await f.prefetchTags(cards)
      const out = filterFeed(cards as never, { ownedArtists: new Set(), ownedAlbumKeys: new Set(), notForMe: {}, served: {}, now: 5, genreGate: f.blocks as never })
      assert.deepEqual(out.map((c: { artist: string }) => c.artist), ['Angine de Poitrine', 'Geese'])
      assert.ok(JSON.parse(readFileSync(join(dir, 'artist-tags.json'), 'utf8')).covet, 'tags cached for next time')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Rock DNA in the Record Shop (step 2)', () => {
  it('no quiz: no prompt line, nothing extra blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-focus-'))
    try {
      const f = await loadDiscoveryFocus(dir, [], {})
      assert.equal(f.dnaLine, '')
      assert.equal(f.blocks({ artist: 'Greta Van Fleet' }), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('Dislike keeps an artist out; Respect never does; Rocksurgence membership beats the quiz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-focus-'))
    try {
      writeFileSync(join(dir, 'taste-profile.json'), JSON.stringify({ focusPlaylists: ['Rocksurgence'] }))
      writeFileSync(join(dir, 'playlists.json'), JSON.stringify([{ id: 'pl-1', name: 'Rocksurgence', trackIds: [1] }]))
      writeFileSync(join(dir, 'rock-dna.json'), JSON.stringify({ ratings: { 'Greta Van Fleet': 'dislike', Rush: 'respect', Geese: 'dislike' }, answers: { 'c-first': { picks: ['riff'] } } }))
      const f = await loadDiscoveryFocus(dir, [{ id: 1, artist: 'Geese' }], {})
      assert.equal(f.blocks({ artist: 'Greta Van Fleet' }), true)
      assert.equal(f.blocks({ artist: 'greta van fleet' }), true, 'spelling-tolerant')
      assert.equal(f.blocks({ artist: 'Rush' }), false, 'respect is not a no')
      assert.equal(f.blocks({ artist: 'Geese' }), false, 'on Rocksurgence = in, whatever the quiz says')
      assert.match(f.dnaLine, /^Rock DNA \(his own quiz answers\): .*Respects but does NOT enjoy \(never treat as taste\): Rush\./)
      assert.match(f.dnaLine, /came around to Geese/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('wired into the generator (index.ts)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  it('exceptions leave the anchors, Rocksurgence joins the supply, the gate and the exemplars are live', () => {
    assert.match(src, /anchors = focus\.dropExceptions\(getTasteAnchors\(tracks, 16\)\)/)
    assert.match(src, /\.\.\.spotifyAnchors, \.\.\.focus\.anchors\(dayN\)\]/)
    assert.match(src, /focus\.prefetchTags\(/)
    assert.match(src, /genreGate: focus\.blocks/)
    assert.equal((src.match(/focus\.exemplars\(tracks\)/g) || []).length, 2)
    assert.match(src, /const FEED_GEN_VERSION = 1\d/, 'old feeds regenerate with the profile')
  })
  it('Rock DNA rides in the picking prompts', () => {
    assert.match(src, /const tasteLine = `Taste: [^`]*\$\{focus\.dnaLine/)
  })
})
