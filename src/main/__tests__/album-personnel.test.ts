/**
 * Album personnel (Jake, 2026-10-30: "mention the album personnel somewhere").
 *
 * MusicBrainz is never called: every answer is the recorded fixture
 * (fixtures/album-personnel-2026-10-30.json — Queens of the Stone Age, Songs
 * for the Deaf, recorded 2026-10-30 and trimmed to the fields the module
 * reads) or a hand-built shape. The disk cache runs in a temp dir.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  peopleFromRelease, relationRoles, instrumentLabel, pickRelease, pickReleaseGroup, impliedPrimaryType, dateKey,
  lookupAlbumPersonnel, createAlbumPersonnelService, createMbThrottle, normalizePersonnelCache, readPersonnelCache,
  isPersonnelStale, personnelCacheKey, personnelCachePath, mbReleasesUrl, mbReleaseUrl,
  PERSONNEL_EMPTY_RECHECK_MS, MAX_PEOPLE, MB_MIN_GAP_MS, PERSONNEL_CACHE_FILE,
  type MbRelation, type MbReleaseDetail, type MbReleaseSummary, type MbSearchGroup, type AlbumPersonnel, type PersonnelCacheFile,
} from '../album-personnel.ts'
import { releaseGroupSearchUrl } from '../release-kinds.ts'
import { assertIpcRegisterOptions } from '../ipc-register.ts'

const SRC = join(import.meta.dirname, '../..')
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'album-personnel-2026-10-30.json'), 'utf-8')) as {
  artist: string
  album: string
  search: { 'release-groups': MbSearchGroup[] }
  releases: { releases: MbReleaseSummary[] }
  release: MbReleaseDetail
}
const ARTIST = FIXTURE.artist
const ALBUM = FIXTURE.album
const GROUP_ID = 'cbffb669-c390-3a4d-b46f-1be8ea934b03'
const RELEASE_ID = 'd4fe720d-595a-4e2a-8ada-0fe0aa943046'
const NOW = Date.parse('2026-10-30T12:00:00Z')
const DAY = 24 * 3600 * 1000
const quiet = (): void => {}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

type Call = { url: string; ua: string | undefined }

/** A fetch that answers the three recorded requests and records every call. */
function recordedFetch(overrides: { search?: unknown; browse?: unknown; release?: unknown } = {}): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.['User-Agent'] })
    if (url === releaseGroupSearchUrl(ALBUM, ARTIST)) return jsonResponse(overrides.search ?? FIXTURE.search)
    if (url === mbReleasesUrl(GROUP_ID)) return jsonResponse(overrides.browse ?? FIXTURE.releases)
    if (url === mbReleaseUrl(RELEASE_ID)) return jsonResponse(overrides.release ?? FIXTURE.release)
    return jsonResponse({ error: 'Not Found' }, 404)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

/** A fetch that plays scripted answers per URL (a function answer may throw), recording calls. */
function scriptedFetch(script: Record<string, Array<Response | (() => Response)>>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.['User-Agent'] })
    const next = script[url]?.shift()
    if (!next) return jsonResponse({ error: 'Not Found' }, 404)
    return typeof next === 'function' ? next() : next
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const neverFetch = (async (url: string) => { throw new Error(`unexpected network request: ${url}`) }) as unknown as typeof fetch

const rel = (type: string, name: string, attributes: string[] = [], extra: Partial<MbRelation> = {}): MbRelation =>
  ({ type, direction: 'backward', 'target-type': 'artist', attributes, artist: { id: `id-${name}`, name }, ...extra })

/** A release whose recordings carry the given relations (one inner array per recording). */
const releaseOf = (recordings: MbRelation[][], releaseLevel: MbRelation[] = []): MbReleaseDetail => ({
  id: 'rel', relations: releaseLevel,
  media: [{ position: 1, tracks: recordings.map((relations, i) => ({ position: i + 1, recording: { id: `rec-${i}`, relations } })) }],
})

const group = (title: string, credit: string, primary: string | null, firstDate = '2000-01-01', id = `rg-${title}-${primary}`): MbSearchGroup =>
  ({ id, title, score: 100, 'primary-type': primary, 'secondary-types': [], 'first-release-date': firstDate, 'artist-credit': [{ name: credit, artist: { name: credit } }] })

const summary = (id: string, status: string | undefined, date: string, disambiguation = ''): MbReleaseSummary => ({ id, title: 'T', status, date, disambiguation })

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'album-personnel-'))

const lookupDeps = (fetchFn: typeof fetch) => ({ userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, log: quiet })

describe('roles — one relationship to its labels', () => {
  test('instrument and vocal credits are labelled by their attributes, lowercase, parentheticals dropped', () => {
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['drums (drum set)'])), { performer: true, labels: ['drums'] })
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['Bass Guitar'])), { performer: true, labels: ['bass guitar'] })
    assert.deepEqual(relationRoles(rel('vocal', 'A', ['lead vocals'])), { performer: true, labels: ['lead vocals'] })
    assert.deepEqual(relationRoles(rel('vocal', 'A', ['background vocals'])), { performer: true, labels: ['background vocals'] })
    assert.equal(instrumentLabel('Drums (drum set)'), 'drums')
  })

  test('one relation can name several instruments; qualifiers like guest / additional / solo fall away', () => {
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['guitar', 'piano'])), { performer: true, labels: ['guitar', 'piano'] })
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['guest', 'guitar'])), { performer: true, labels: ['guitar'] })
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['additional', 'solo', 'theremin'])), { performer: true, labels: ['theremin'] })
    assert.deepEqual(relationRoles(rel('vocal', 'A', ['guest', 'lead vocals'])), { performer: true, labels: ['lead vocals'] })
  })

  test('a bare instrument or vocal credit still names the kind of credit', () => {
    assert.deepEqual(relationRoles(rel('vocal', 'A', [])), { performer: true, labels: ['vocals'] })
    assert.deepEqual(relationRoles(rel('instrument', 'A', ['guest'])), { performer: true, labels: ['instruments'] })
    assert.deepEqual(relationRoles(rel('instrument', 'A')), { performer: true, labels: ['instruments'] })
  })

  test('production credits are one plain word each; their qualifiers (assistant, executive, co) fall away', () => {
    assert.deepEqual(relationRoles(rel('producer', 'A', ['executive'])), { performer: false, labels: ['producer'] })
    assert.deepEqual(relationRoles(rel('engineer', 'A', ['assistant'])), { performer: false, labels: ['engineer'] })
    assert.deepEqual(relationRoles(rel('mix', 'A')), { performer: false, labels: ['mixing'] })
    assert.deepEqual(relationRoles(rel('mastering', 'A')), { performer: false, labels: ['mastering'] })
    assert.deepEqual(relationRoles(rel('recording', 'A')), { performer: false, labels: ['recording'] })
    assert.deepEqual(relationRoles(rel('programming', 'A')), { performer: false, labels: ['programming'] })
    assert.deepEqual(relationRoles(rel('arranger', 'A')), { performer: false, labels: ['arranger'] })
    assert.deepEqual(relationRoles(rel('remixer', 'A')), { performer: false, labels: ['remixer'] })
  })

  test('performer, performing orchestra and conductor are performer roles; type names are case-insensitive', () => {
    assert.deepEqual(relationRoles(rel('performer', 'A')), { performer: true, labels: ['performer'] })
    assert.deepEqual(relationRoles(rel('performing orchestra', 'A')), { performer: true, labels: ['orchestra'] })
    assert.deepEqual(relationRoles(rel('conductor', 'A')), { performer: true, labels: ['conductor'] })
    assert.deepEqual(relationRoles(rel('Producer', 'A')), { performer: false, labels: ['producer'] })
  })

  test('credits this feature does not show are ignored, not mislabelled', () => {
    for (const type of ['composer', 'lyricist', 'writer', 'design/illustration', 'art direction', 'photography', 'phonographic copyright', 'copyright', 'misc', 'publishing', 'samples from artist', '']) {
      assert.equal(relationRoles(rel(type, 'A')), null, type)
    }
    assert.equal(relationRoles({}), null)
  })
})

describe('people from the recorded Songs for the Deaf release', () => {
  const people = peopleFromRelease(FIXTURE.release)

  test('the first six: the band and its guests, by how many recordings they are on', () => {
    assert.deepEqual(people.slice(0, 6), [
      { name: 'Josh Homme', roles: ['guitar', 'lead vocals', 'producer'], tracks: 16 },
      { name: 'Dave Grohl', roles: ['drums', 'percussion'], tracks: 14 },
      { name: 'Nick Oliveri', roles: ['bass guitar', 'lead vocals', 'background vocals'], tracks: 14 },
      { name: 'Alain Johannes', roles: ['keyboard', 'theremin', 'organ', 'guitar', 'piano', 'mixing', 'recording'], tracks: 7 },
      { name: 'Gene Trautmann', roles: ['drums'], tracks: 4 },
      { name: 'Mark Lanegan', roles: ['lead vocals'], tracks: 4 },
    ])
  })

  test('seventeen people in a fixed order: performers by tracks then name, then production-only people', () => {
    assert.deepEqual(people.map((p) => p.name), [
      'Josh Homme', 'Dave Grohl', 'Nick Oliveri', 'Alain Johannes', 'Gene Trautmann', 'Mark Lanegan', 'Dean Ween',
      'Anna Lenchantin', 'Brendon McNichol', 'Natasha Shneider', 'Paz Lenchantin', 'Chris Goss', 'Molly McGuire',
      'Adam Kasper', 'Joe Marlett', 'Kevin Szymanski', 'Eric Valentine',
    ])
    const production = people.slice(13)
    assert.deepEqual(production.map((p) => p.roles), [['engineer', 'mixing', 'producer'], ['engineer'], ['engineer'], ['producer', 'engineer']])
    assert.deepEqual(production.map((p) => p.tracks), [14, 14, 14, 13])
  })

  test('names are as the release credits them, not MusicBrainz\'s canonical spelling or script', () => {
    const names = people.map((p) => p.name)
    assert.ok(names.includes('Natasha Shneider'), 'the credit, not the Cyrillic artist name Наташа Шнайдер')
    assert.ok(!names.includes('Наташа Шнайдер'))
    assert.ok(names.includes('Anna Lenchantin'), 'the liner-notes spelling, not the artist entry "Ana Lenchantin"')
  })

  test('every role is lowercase and listed once per person; assistant engineers read as engineers', () => {
    for (const p of people) {
      assert.deepEqual(p.roles, [...new Set(p.roles)], p.name)
      for (const r of p.roles) assert.equal(r, r.toLowerCase(), p.name)
    }
    assert.deepEqual(people.find((p) => p.name === 'Joe Marlett'), { name: 'Joe Marlett', roles: ['engineer'], tracks: 14 })
  })
})

describe('people — ordering, dedupe and the cap (hand-built releases)', () => {
  test('a person credited on the release as a whole has 0 tracks and, as production-only, follows the performers', () => {
    const people = peopleFromRelease(releaseOf([[rel('instrument', 'Guitarist', ['guitar'])]], [rel('mastering', 'Masterer'), rel('producer', 'Exec', ['executive'])]))
    assert.deepEqual(people, [
      { name: 'Guitarist', roles: ['guitar'], tracks: 1 },
      { name: 'Exec', roles: ['producer'], tracks: 0 },
      { name: 'Masterer', roles: ['mastering'], tracks: 0 },
    ])
  })

  test('one person, many credits: deduped by artist id, performer roles first, tracks counted once per recording', () => {
    const people = peopleFromRelease(releaseOf([
      [rel('producer', 'Josh'), rel('instrument', 'Josh', ['guitar']), rel('vocal', 'Josh', ['lead vocals'])],
      [rel('instrument', 'Josh', ['guitar']), rel('instrument', 'Josh', ['piano'])],
      [rel('producer', 'Josh')],
    ]))
    assert.deepEqual(people, [{ name: 'Josh', roles: ['guitar', 'lead vocals', 'piano', 'producer'], tracks: 3 }])
  })

  test('within a bucket the most frequent role comes first; ties keep first-seen order', () => {
    const [p] = peopleFromRelease(releaseOf([
      [rel('instrument', 'A', ['theremin'])],
      [rel('instrument', 'A', ['keyboard'])],
      [rel('instrument', 'A', ['keyboard'])],
      [rel('instrument', 'A', ['organ'])],
    ]))
    assert.deepEqual(p.roles, ['keyboard', 'theremin', 'organ'])
  })

  test('performers sort by tracks descending then name; production-only people after them the same way', () => {
    const people = peopleFromRelease(releaseOf([
      [rel('instrument', 'Zed', ['bass guitar']), rel('instrument', 'Amy', ['drums']), rel('engineer', 'Eng')],
      [rel('instrument', 'Zed', ['bass guitar']), rel('instrument', 'Amy', ['drums']), rel('producer', 'Prod')],
      [rel('instrument', 'Bob', ['guitar']), rel('producer', 'Prod')],
    ]))
    assert.deepEqual(people.map((p) => [p.name, p.tracks]), [['Amy', 2], ['Zed', 2], ['Bob', 1], ['Prod', 2], ['Eng', 1]])
  })

  test('the as-credited name wins when the release prints one; the most frequent credit on ties of spelling', () => {
    const [p] = peopleFromRelease(releaseOf([
      [rel('vocal', 'Наташа Шнайдер', ['lead vocals'], { 'target-credit': 'Natasha Shneider' })],
      [rel('instrument', 'Наташа Шнайдер', ['keyboard'], { 'target-credit': 'N. Shneider' })],
      [rel('instrument', 'Наташа Шнайдер', ['keyboard'], { 'target-credit': 'Natasha Shneider' })],
      [rel('instrument', 'Наташа Шнайдер', ['keyboard'])],
    ]))
    assert.equal(p.name, 'Natasha Shneider')
    const [q] = peopleFromRelease(releaseOf([[rel('vocal', 'Plain Name', ['lead vocals'], { 'target-credit': '' })]]))
    assert.equal(q.name, 'Plain Name')
  })

  test('without an artist id, the folded name is the identity', () => {
    const people = peopleFromRelease(releaseOf([
      [{ type: 'instrument', attributes: ['guitar'], artist: { name: 'Björk' } }],
      [{ type: 'instrument', attributes: ['guitar'], artist: { name: 'bjork' } }],
    ]))
    assert.deepEqual(people, [{ name: 'Björk', roles: ['guitar'], tracks: 2 }])
  })

  test('people with only ignored credits are absent; relations without a name are skipped', () => {
    const people = peopleFromRelease(releaseOf([[rel('composer', 'Writer'), rel('design/illustration', 'Designer'), { type: 'producer', artist: {} }, rel('producer', 'Prod')]]))
    assert.deepEqual(people, [{ name: 'Prod', roles: ['producer'], tracks: 1 }])
  })

  test('recordings without an id still count as distinct tracks', () => {
    const release: MbReleaseDetail = { media: [{ tracks: [{ position: 1, recording: { relations: [rel('instrument', 'A', ['guitar'])] } }, { position: 2, recording: { relations: [rel('instrument', 'A', ['guitar'])] } }] }] }
    assert.deepEqual(peopleFromRelease(release), [{ name: 'A', roles: ['guitar'], tracks: 2 }])
  })

  test(`at most ${MAX_PEOPLE} people — the performers on the most recordings survive the cut`, () => {
    const recordings: MbRelation[][] = []
    for (let i = 0; i < 50; i++) recordings.push(Array.from({ length: i + 1 }, () => rel('instrument', `P${i}`, ['guitar'])))
    // P49 is on one recording 50 times; spread each person across their own recordings instead:
    const spread: MbRelation[][] = Array.from({ length: 50 }, () => [])
    for (let person = 0; person < 50; person++) for (let t = 0; t <= person; t++) spread[t].push(rel('instrument', `P${person}`, ['guitar']))
    const people = peopleFromRelease(releaseOf(spread))
    assert.equal(people.length, MAX_PEOPLE)
    assert.equal(people[0].name, 'P49')
    assert.equal(people[0].tracks, 50)
    assert.equal(people[MAX_PEOPLE - 1].tracks, 11)
  })

  test('an empty or malformed release yields nobody', () => {
    assert.deepEqual(peopleFromRelease({}), [])
    assert.deepEqual(peopleFromRelease({ media: [{}], relations: [] }), [])
  })
})

describe('choosing the release group', () => {
  test('the recorded search: the album itself, not the "Rated R + Songs for the Deaf" compilation', () => {
    const g = pickReleaseGroup(FIXTURE.search['release-groups'], ALBUM, ARTIST)
    assert.equal(g?.id, GROUP_ID)
    assert.equal(FIXTURE.search['release-groups'].length, 2, 'the fixture carries the near miss too')
  })

  test('a group by another artist with the same title is refused — a wrong release is worse than none', () => {
    assert.equal(pickReleaseGroup([group('Songs for the Deaf', 'Kyuss', 'Album')], 'Songs for the Deaf', 'Queens of the Stone Age'), undefined)
    assert.equal(pickReleaseGroup([group('Songs for the Deaf', 'Queens of the Stone Age Tribute Band', 'Album')], 'Songs for the Deaf', 'Queens of the Stone Age'), undefined)
  })

  test('a near title is refused; accents, case and edition tags fold', () => {
    assert.equal(pickReleaseGroup([group('Songs for the Deaf (Instrumentals)', 'Queens of the Stone Age', 'Album')], 'Songs for the Deaf', 'Queens of the Stone Age'), undefined)
    assert.equal(pickReleaseGroup([group('Homogenic', 'Björk', 'Album')], 'homogenic (Deluxe Edition)', 'Bjork')?.title, 'Homogenic')
  })

  test('the library title says what kind of release it means: "- Single" picks the Single, otherwise the Album', () => {
    const groups = [group('Getting Killed', 'Geese', 'Single', '2025-06-01', 'single'), group('Getting Killed', 'Geese', 'Album', '2025-09-26', 'album')]
    assert.equal(pickReleaseGroup(groups, 'Getting Killed - Single', 'Geese')?.id, 'single')
    assert.equal(pickReleaseGroup(groups, 'Getting Killed', 'Geese')?.id, 'album')
    assert.equal(pickReleaseGroup([groups[0]], 'Getting Killed', 'Geese')?.id, 'single', 'when only a single exists, it is the answer')
    assert.equal(impliedPrimaryType('Alive & In Person - EP'), 'EP')
    assert.equal(impliedPrimaryType('&Forever – EP'), 'EP')
    assert.equal(impliedPrimaryType('Projector'), 'Album')
  })

  test('among equals: the earliest first-release-date, then id', () => {
    const groups = [group('X', 'A', 'Album', '2010', 'later'), group('X', 'A', 'Album', '2009-05-01', 'earlier'), group('X', 'A', 'Album', '2009-05-01', 'earlier-2')]
    assert.equal(pickReleaseGroup(groups, 'X', 'A')?.id, 'earlier')
    assert.equal(pickReleaseGroup([], 'X', 'A'), undefined)
  })
})

describe('choosing the release', () => {
  test('the recorded browse: the first Official release — 2002-08-17 (JP), not the year-only "2002" US pressing', () => {
    const r = pickRelease(FIXTURE.releases.releases)
    assert.equal(r?.id, RELEASE_ID)
    assert.equal(r?.status, 'Official')
    assert.equal(r?.date, '2002-08-17')
    assert.equal(r?.disambiguation, '')
    assert.equal(FIXTURE.releases.releases.length, 32)
  })

  test('a bare year counts as the end of that year; an unknown date sorts last', () => {
    assert.equal(dateKey('2002'), '2002-12-31')
    assert.equal(dateKey('2002-08'), '2002-08-31')
    assert.equal(dateKey('2002-08-17'), '2002-08-17')
    assert.equal(dateKey(''), '9999-12-31')
    assert.equal(dateKey(undefined), '9999-12-31')
    assert.equal(dateKey('soon'), '9999-12-31')
  })

  test('Official beats Promotion and Bootleg even when they are dated earlier', () => {
    assert.equal(pickRelease([summary('promo', 'Promotion', '2001-01-01'), summary('boot', 'Bootleg', '2000-01-01'), summary('off', 'Official', '2002-08-27')])?.id, 'off')
  })

  test('with no Official release: Promotion before unknown before Bootleg', () => {
    assert.equal(pickRelease([summary('boot', 'Bootleg', '2000-01-01'), summary('none', undefined, '2000-01-01'), summary('promo', 'Promotion', '2001-01-01')])?.id, 'promo')
    assert.equal(pickRelease([summary('boot', 'Bootleg', '2000-01-01'), summary('none', undefined, '2001-01-01')])?.id, 'none')
  })

  test('same status: earliest date, then a plain edition before a variant, then id', () => {
    assert.equal(pickRelease([summary('b', 'Official', '2002-08-17', 'limited edition'), summary('a', 'Official', '2002-08-17')])?.id, 'a')
    assert.equal(pickRelease([summary('b', 'Official', '2002-08-17'), summary('a', 'Official', '2002-08-17')])?.id, 'a')
    assert.equal(pickRelease([summary('plain-later', 'Official', '2003-01-01'), summary('variant-earlier', 'Official', '2002-08-17', 'tour edition')])?.id, 'variant-earlier')
    assert.equal(pickRelease([summary('year', 'Official', '2002'), summary('dated', 'Official', '2002-08-17')])?.id, 'dated')
  })

  test('releases without an id are skipped; nothing to choose from is undefined', () => {
    assert.equal(pickRelease([{ status: 'Official', date: '2002' }, summary('x', 'Official', '2003')])?.id, 'x')
    assert.equal(pickRelease([]), undefined)
  })
})

describe('the lookup — three requests on recorded answers', () => {
  test('search → the group\'s releases → the chosen release, each with the User-Agent, each through the throttle', async () => {
    const { fetchFn, calls } = recordedFetch()
    let throttled = 0
    const r = await lookupAlbumPersonnel(ARTIST, ALBUM, { ...lookupDeps(fetchFn), throttle: async () => { throttled++ } })
    assert.deepEqual(calls.map((c) => c.url), [releaseGroupSearchUrl(ALBUM, ARTIST), mbReleasesUrl(GROUP_ID), mbReleaseUrl(RELEASE_ID)])
    assert.ok(calls.every((c) => c.ua === 'JakeTunes/test'), 'MusicBrainz requires a descriptive User-Agent on every request')
    assert.equal(throttled, 3)
    assert.ok(r.ok)
    if (r.ok) {
      assert.equal(r.releaseMbid, RELEASE_ID)
      assert.equal(r.people.length, 17)
      assert.equal(r.people[0].name, 'Josh Homme')
    }
  })

  test('the request URLs are MusicBrainz WS2 JSON with the credits included', () => {
    assert.equal(mbReleasesUrl(GROUP_ID), `https://musicbrainz.org/ws/2/release?release-group=${GROUP_ID}&fmt=json&limit=100`)
    assert.equal(mbReleaseUrl(RELEASE_ID), `https://musicbrainz.org/ws/2/release/${RELEASE_ID}?inc=artist-rels+recordings+recording-level-rels&fmt=json`)
    assert.match(releaseGroupSearchUrl(ALBUM, ARTIST), /^https:\/\/musicbrainz\.org\/ws\/2\/release-group\?query=releasegroup%3A%22Songs%20for%20the%20Deaf%22%20AND%20artist%3A%22Queens%20of%20the%20Stone%20Age%22&fmt=json&limit=10$/)
  })

  test('wrong artist: a group credited to someone else is nobody, and the lookup stops after the search', async () => {
    const { fetchFn, calls } = recordedFetch({ search: { 'release-groups': [group('Songs for the Deaf', 'Kyuss', 'Album', '2002-08-17', GROUP_ID)] } })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(fetchFn)), { ok: true, people: [] })
    assert.equal(calls.length, 1)
  })

  test('no release group at all, or a group with no releases, is a real empty answer', async () => {
    const none = recordedFetch({ search: { 'release-groups': [] } })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(none.fetchFn)), { ok: true, people: [] })
    assert.equal(none.calls.length, 1)
    const bare = recordedFetch({ browse: { releases: [] } })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(bare.fetchFn)), { ok: true, people: [] })
    assert.equal(bare.calls.length, 2)
    const odd = recordedFetch({ search: 'not an object' })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(odd.fetchFn)), { ok: true, people: [] })
  })

  test('a busy MusicBrainz (503) is retried once and then reported as rate-limited, never as an answer', async () => {
    const busy = jsonResponse({ error: 'The MusicBrainz web server is currently busy. Please try again later.' }, 503)
    const { fetchFn, calls } = scriptedFetch({ [releaseGroupSearchUrl(ALBUM, ARTIST)]: [busy, busy] })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(fetchFn)), { ok: false, error: 'rate-limited' })
    assert.equal(calls.length, 2)
  })

  test('503 then 200 recovers; the retry goes through the throttle too', async () => {
    const busy = jsonResponse({ error: 'rate limit' }, 503)
    const { fetchFn, calls } = scriptedFetch({
      [releaseGroupSearchUrl(ALBUM, ARTIST)]: [jsonResponse(FIXTURE.search)],
      [mbReleasesUrl(GROUP_ID)]: [busy, jsonResponse(FIXTURE.releases)],
      [mbReleaseUrl(RELEASE_ID)]: [jsonResponse(FIXTURE.release)],
    })
    let throttled = 0
    const r = await lookupAlbumPersonnel(ARTIST, ALBUM, { ...lookupDeps(fetchFn), throttle: async () => { throttled++ } })
    assert.ok(r.ok)
    assert.equal(calls.length, 4)
    assert.equal(throttled, 4)
  })

  test('a 5xx or a dropped socket is retried once then api-failed; a 4xx is final at once', async () => {
    const five = scriptedFetch({ [releaseGroupSearchUrl(ALBUM, ARTIST)]: [jsonResponse({}, 502), jsonResponse({}, 500)] })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(five.fetchFn)), { ok: false, error: 'api-failed' })
    assert.equal(five.calls.length, 2)
    const thrown = scriptedFetch({ [releaseGroupSearchUrl(ALBUM, ARTIST)]: [() => { throw new TypeError('fetch failed') }, () => { throw new TypeError('fetch failed') }] })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(thrown.fetchFn)), { ok: false, error: 'api-failed' })
    assert.equal(thrown.calls.length, 2)
    const four = scriptedFetch({ [releaseGroupSearchUrl(ALBUM, ARTIST)]: [jsonResponse({ error: 'bad query' }, 400), jsonResponse(FIXTURE.search)] })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(four.fetchFn)), { ok: false, error: 'api-failed' })
    assert.equal(four.calls.length, 1)
  })

  test('a failure on the last request fails the whole lookup — half an answer is not cached as an answer', async () => {
    const { fetchFn } = scriptedFetch({
      [releaseGroupSearchUrl(ALBUM, ARTIST)]: [jsonResponse(FIXTURE.search)],
      [mbReleasesUrl(GROUP_ID)]: [jsonResponse(FIXTURE.releases)],
      [mbReleaseUrl(RELEASE_ID)]: [jsonResponse({}, 503), jsonResponse({}, 503)],
    })
    assert.deepEqual(await lookupAlbumPersonnel(ARTIST, ALBUM, lookupDeps(fetchFn)), { ok: false, error: 'rate-limited' })
  })
})

describe('the throttle', () => {
  test('callers are spaced MB_MIN_GAP_MS apart from the previous grant; a rejected caller does not poison the chain', async () => {
    let clock = 1_000_000
    const waits: number[] = []
    const throttle = createMbThrottle(MB_MIN_GAP_MS, () => clock, async (ms) => { waits.push(ms); clock += ms })
    await throttle()
    assert.deepEqual(waits, [], 'the first caller goes straight through')
    clock += 300
    await throttle()
    assert.deepEqual(waits, [MB_MIN_GAP_MS - 300])
    clock += 5000
    await throttle()
    assert.deepEqual(waits, [MB_MIN_GAP_MS - 300], 'a caller after a long quiet does not wait')
    // Straight after a grant, the next caller waits the full gap — including the
    // one after a caller that failed: the chain is not poisoned by it.
    const a = throttle().then(() => { throw new Error('caller failed') })
    await assert.rejects(a)
    await throttle()
    assert.deepEqual(waits, [MB_MIN_GAP_MS - 300, MB_MIN_GAP_MS, MB_MIN_GAP_MS])
  })

  test('concurrent callers are granted one at a time, each a full gap after the last', async () => {
    let clock = 0
    const grants: number[] = []
    const throttle = createMbThrottle(1100, () => clock, async (ms) => { clock += ms })
    await Promise.all([throttle().then(() => grants.push(clock)), throttle().then(() => grants.push(clock)), throttle().then(() => grants.push(clock))])
    assert.deepEqual(grants, [0, 1100, 2200])
  })
})

describe('the disk cache', () => {
  test('a looked-up album is written to album-personnel.json and survives a restart without a network call', async () => {
    const dir = tempDir()
    const { fetchFn, calls } = recordedFetch()
    const a = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => NOW, log: quiet })
    const first = await a.get(ARTIST, ALBUM)
    assert.equal(first.ok, true)
    assert.equal(first.releaseMbid, RELEASE_ID)
    assert.equal(first.people.length, 17)
    assert.equal(calls.length, 3)
    await a.flush()

    const file = personnelCachePath(dir)
    assert.equal(file, join(dir, PERSONNEL_CACHE_FILE))
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as PersonnelCacheFile
    assert.equal(onDisk.v, 1)
    const entry = onDisk.entries[personnelCacheKey(ARTIST, ALBUM)]
    assert.equal(personnelCacheKey(ARTIST, ALBUM), 'queens of the stone age|songs for the deaf')
    assert.deepEqual(entry, { people: first.people, releaseMbid: RELEASE_ID, at: NOW })
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no staging litter')

    // "Restart": a new service over the same directory, with a fetch that must never be reached.
    const b = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn: neverFetch, throttle: async () => {}, now: () => NOW + 400 * DAY, log: quiet })
    const again = await b.get(ARTIST, ALBUM)
    assert.deepEqual(again, first)
    assert.deepEqual(await b.get('  QUEENS OF THE STONE AGE ', 'songs for the deaf'), first, 'the key is case- and space-insensitive')
    assert.equal(calls.length, 3)
  })

  test('a found list stays put — it is never asked again, even long after', async () => {
    const dir = tempDir()
    const { fetchFn, calls } = recordedFetch()
    let clock = NOW
    const svc = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => clock, log: quiet })
    await svc.get(ARTIST, ALBUM)
    clock = NOW + 1000 * DAY
    await svc.get(ARTIST, ALBUM)
    assert.equal(calls.length, 3)
  })

  test('a looked-up-but-empty answer is cached too, and asked again after 30 days', async () => {
    const dir = tempDir()
    let clock = NOW
    const { fetchFn, calls } = recordedFetch({ search: { 'release-groups': [] } })
    const svc = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => clock, log: quiet })
    assert.deepEqual(await svc.get(ARTIST, ALBUM), { ok: true, people: [] })
    assert.equal(calls.length, 1)
    await svc.flush()
    const onDisk = JSON.parse(readFileSync(personnelCachePath(dir), 'utf-8')) as PersonnelCacheFile
    assert.deepEqual(onDisk.entries[personnelCacheKey(ARTIST, ALBUM)], { people: [], at: NOW })

    clock = NOW + 29 * DAY
    assert.deepEqual(await svc.get(ARTIST, ALBUM), { ok: true, people: [] })
    assert.equal(calls.length, 1, 'still remembered at 29 days')

    clock = NOW + PERSONNEL_EMPTY_RECHECK_MS + DAY
    assert.deepEqual(await svc.get(ARTIST, ALBUM), { ok: true, people: [] })
    assert.equal(calls.length, 2, 'asked again after 30 days')
    await svc.flush()
    const later = JSON.parse(readFileSync(personnelCachePath(dir), 'utf-8')) as PersonnelCacheFile
    assert.equal(later.entries[personnelCacheKey(ARTIST, ALBUM)].at, clock, 'the re-check restarts the 30-day clock')
  })

  test('isPersonnelStale: only an empty answer goes stale, and only after 30 days', () => {
    assert.equal(isPersonnelStale({ people: [], at: NOW }, NOW + 29 * DAY), false)
    assert.equal(isPersonnelStale({ people: [], at: NOW }, NOW + 31 * DAY), true)
    assert.equal(isPersonnelStale({ people: [{ name: 'A', roles: ['guitar'], tracks: 1 }], at: NOW }, NOW + 1000 * DAY), false)
    assert.equal(PERSONNEL_EMPTY_RECHECK_MS, 30 * DAY)
  })

  test('a failed lookup is reported, not remembered: the next visit asks again and then caches', async () => {
    const dir = tempDir()
    const busy = jsonResponse({ error: 'busy' }, 503)
    const { fetchFn, calls } = scriptedFetch({
      [releaseGroupSearchUrl(ALBUM, ARTIST)]: [busy, busy, jsonResponse(FIXTURE.search)],
      [mbReleasesUrl(GROUP_ID)]: [jsonResponse(FIXTURE.releases)],
      [mbReleaseUrl(RELEASE_ID)]: [jsonResponse(FIXTURE.release)],
    })
    const svc = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => NOW, log: quiet })
    assert.deepEqual(await svc.get(ARTIST, ALBUM), { ok: false, people: [], error: 'rate-limited' })
    await svc.flush()
    assert.equal(existsSync(personnelCachePath(dir)), false, 'nothing written for a failure')
    const second = await svc.get(ARTIST, ALBUM)
    assert.equal(second.ok, true)
    assert.equal(second.people.length, 17)
    assert.equal(calls.length, 5)
    await svc.flush()
    assert.equal(existsSync(personnelCachePath(dir)), true)
  })

  test('two album pages asking at once share one lookup', async () => {
    const dir = tempDir()
    const { fetchFn, calls } = recordedFetch()
    const svc = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => NOW, log: quiet })
    const [a, b] = await Promise.all([svc.get(ARTIST, ALBUM), svc.get(ARTIST, ALBUM)])
    assert.deepEqual(a, b)
    assert.equal(calls.length, 3)
  })

  test('bad input never reaches the network: non-strings are invalid-input, blanks are nobody', async () => {
    const svc = createAlbumPersonnelService({ dir: tempDir(), userAgent: 'JakeTunes/test', fetchFn: neverFetch, throttle: async () => {}, log: quiet })
    assert.deepEqual(await svc.get(undefined as unknown as string, ALBUM), { ok: false, people: [], error: 'invalid-input' })
    assert.deepEqual(await svc.get(ARTIST, 42 as unknown as string), { ok: false, people: [], error: 'invalid-input' })
    assert.deepEqual(await svc.get(ARTIST, '  '), { ok: true, people: [] })
    assert.deepEqual(await svc.get('', ALBUM), { ok: true, people: [] })
  })

  test('a corrupt cache file is moved aside (kept), the service starts fresh and writes a new one', async () => {
    const dir = tempDir()
    writeFileSync(personnelCachePath(dir), '{ "v": 1, "entries": { trailing garbage')
    const logs: string[] = []
    const { fetchFn, calls } = recordedFetch()
    const svc = createAlbumPersonnelService({ dir, userAgent: 'JakeTunes/test', fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => NOW, log: (m) => logs.push(m) })
    const r = await svc.get(ARTIST, ALBUM)
    assert.equal(r.ok, true)
    assert.equal(calls.length, 3)
    await svc.flush()
    const files = readdirSync(dir)
    assert.ok(files.some((f) => f.startsWith(`${PERSONNEL_CACHE_FILE}.corrupt-`)), `kept aside: ${files.join(', ')}`)
    const fresh = JSON.parse(readFileSync(personnelCachePath(dir), 'utf-8')) as PersonnelCacheFile
    assert.equal(Object.keys(fresh.entries).length, 1)
    assert.ok(logs.some((m) => /did not parse/.test(m)))
  })

  test('a missing file is simply empty; junk entries in a file are dropped, not trusted', async () => {
    assert.deepEqual(await readPersonnelCache(join(tempDir(), 'nope.json'), quiet), { v: 1, entries: {} })
    const good = { people: [{ name: 'A', roles: ['guitar'], tracks: 2 }], releaseMbid: 'm', at: NOW }
    const norm = normalizePersonnelCache({
      v: 1,
      entries: {
        good,
        'no-at': { people: [] },
        'people-not-array': { people: 'Josh', at: NOW },
        'bad-person': { people: [{ name: 'A', roles: 'guitar', tracks: 1 }], at: NOW },
        'extra-fields': { people: [{ name: 'B', roles: [], tracks: 0, extra: true }], at: NOW, releaseMbid: '' },
        'null': null,
      },
    })
    assert.deepEqual(norm, { v: 1, entries: { good, 'extra-fields': { people: [{ name: 'B', roles: [], tracks: 0 }], at: NOW } } })
    assert.deepEqual(normalizePersonnelCache(null), { v: 1, entries: {} })
    assert.deepEqual(normalizePersonnelCache([]), { v: 1, entries: {} })
    assert.deepEqual(normalizePersonnelCache({ entries: 'x' }), { v: 1, entries: {} })
  })
})

describe('wiring — the registrar, the preload and the renderer twin', () => {
  const main = readFileSync(join(SRC, 'main/album-personnel.ts'), 'utf-8')
  const ipc = readFileSync(join(SRC, 'main/ipc/album-info-ipc.ts'), 'utf-8')
  const preload = readFileSync(join(SRC, 'preload/index.ts'), 'utf-8')
  const renderer = readFileSync(join(SRC, 'renderer/types.ts'), 'utf-8')

  test('get-album-personnel is registered inside registerAlbumInfoIpc through the registrar with a full-shape refusal', () => {
    assert.match(ipc, /ipc\.handle\('get-album-personnel', async \(_e, artist: string, album: string\): Promise<AlbumPersonnel> => personnel\.get\(artist, album\),\s*\{ refuse: \{ ok: false, people: \[\], error: REFUSED_SENDER\.error \} \}\)/)
    assert.doesNotMatch(ipc, /ipcMain\.handle/)
    assert.match(ipc, /createAlbumPersonnelService\(\{[\s\S]*?dir: app\.getPath\('userData'\),[\s\S]*?userAgent: `JakeTunes\/\$\{app\.getVersion\(\)\} \(jacobrosenbaum@gmail\.com\)`,[\s\S]*?throttle: host\.mbThrottle,[\s\S]*?\}\)/)
    assert.match(ipc, /export function registerAlbumInfoIpc\(ipc: IpcRegistrar, host: AlbumInfoHost = \{\}\)/, 'index.ts keeps its one-argument call')
    assert.throws(() => assertIpcRegisterOptions('get-album-personnel', undefined), /must pass \{ refuse \} or \{ public: true \}/)
  })

  test('the preload exposes getAlbumPersonnel beside getAlbumInfo', () => {
    assert.match(preload, /getAlbumInfo: \(artist: string, album: string, year\?: string\) => ipcRenderer\.invoke\('get-album-info', artist, album, year\),\n[^\n]*\n\s*getAlbumPersonnel: \(artist: string, album: string\) => ipcRenderer\.invoke\('get-album-personnel', artist, album\),/)
  })

  test('the renderer declares the method with the twin type, and both sides name each other', () => {
    assert.match(renderer, /getAlbumPersonnel: \(artist: string, album: string\) => Promise<AlbumPersonnel>/)
    assert.match(renderer, /⚠️ TWIN: src\/main\/album-personnel\.ts AlbumPerson \/ AlbumPersonnel/)
    assert.match(main, /⚠️ TWIN: src\/renderer\/types\.ts \(AlbumPerson, AlbumPersonnel\)/)
  })

  test('the twin interfaces are field-for-field identical on both sides of the IPC boundary', () => {
    const body = (src: string, name: string): string => {
      const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)
      assert.ok(m, `${name} missing`)
      // Fields only: strip the doc comments, then whitespace.
      return m![1].replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()
    }
    for (const name of ['AlbumPerson', 'AlbumPersonnel']) {
      assert.equal(body(renderer, name), body(main, name), `${name} drifted between main and renderer`)
    }
    assert.equal(body(main, 'AlbumPerson'), 'name: string roles: string[] tracks: number')
    assert.equal(body(main, 'AlbumPersonnel'), 'ok: boolean people: AlbumPerson[] releaseMbid?: string error?: string')
  })

  test('the module never touches Electron — it is testable under plain Node', () => {
    assert.doesNotMatch(main, /from 'electron'/)
    assert.doesNotMatch(main, /require\('electron'\)/)
  })

  test('the service answers the documented shape on every path', async () => {
    const shape = (r: AlbumPersonnel): void => {
      assert.equal(typeof r.ok, 'boolean')
      assert.ok(Array.isArray(r.people))
    }
    const svc = createAlbumPersonnelService({ dir: tempDir(), userAgent: 'JakeTunes/test', fetchFn: recordedFetch().fetchFn, throttle: async () => {}, retryDelayMs: 0, now: () => NOW, log: quiet })
    shape(await svc.get(ARTIST, ALBUM))
    shape(await svc.get(ARTIST, ''))
    shape(await svc.get(null as unknown as string, ''))
  })
})
