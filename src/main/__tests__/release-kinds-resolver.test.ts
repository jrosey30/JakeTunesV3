/**
 * Release kinds resolver + artist-page grouping (Jake 2026-10-18: group an
 * artist's discography into albums / EPs / singles / live / compilations,
 * desktop and phone). MusicBrainz is never called: fetch is injected.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptedReleaseGroups, judgeReleaseGroups, lookupReleaseGroup, entryFor, needsLookup,
  mergeReleaseKinds, writeReleaseKinds, readReleaseKinds, runReleaseKindsPass, startReleaseKindsJob,
  effectiveAlbumRows, releaseGroupSearchUrl, releaseKindsPath, RELEASE_RECHECK_MS,
  type MbReleaseGroup, type ReleaseKindEntry,
} from '../release-kinds.ts'
import { collectAlbumFacts, type AlbumRow } from '../../common/release-sections.ts'
import { nameKey } from '../../common/fold-text.ts'
import type { ReleaseKindsFile } from '../../common/release-kind.ts'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-10-18T12:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function rg(title: string, credits: Array<string | { name: string; joinphrase?: string; artist?: string }>, primary: string | null, secondary: string[] = [], id = `id-${title}`): MbReleaseGroup {
  return {
    id, title, score: 100, 'primary-type': primary, 'secondary-types': secondary,
    'artist-credit': credits.map((c) => typeof c === 'string'
      ? { name: c, artist: { name: c } }
      : { name: c.name, joinphrase: c.joinphrase, artist: { name: c.artist ?? c.name } }),
  }
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => body } as unknown as Response
}

function tempFile(): string {
  return releaseKindsPath(mkdtempSync(join(tmpdir(), 'release-kinds-')))
}

function seed(file: string, albums: ReleaseKindsFile['albums']): void {
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt: iso(NOW - DAY), albums }))
}

function rows(artist: string, album: string, n: number, trackCount = n, durationMs = 200_000, albumArtist = ''): AlbumRow[] {
  return Array.from({ length: n }, () => ({ album, artist, albumArtist, trackCount, duration: durationMs }))
}

describe('MusicBrainz acceptance', () => {
  test('exact folded title AND a credited name that folds to the artist', () => {
    const groups = [rg('Alive & In Person', ['Geese'], 'EP', ['Live'])]
    assert.equal(acceptedReleaseGroups(groups, 'Alive & In Person', 'Geese').length, 1)
    // Store suffix and edition tags come off before comparing
    assert.equal(acceptedReleaseGroups([rg('&Forever', ['Geese'], 'EP')], '&Forever - EP', 'Geese').length, 1)
    assert.equal(acceptedReleaseGroups([rg('1999', ['Prince'], 'Album')], '1999 (Deluxe Edition)', 'Prince').length, 1)
    // Accents and case fold
    assert.equal(acceptedReleaseGroups([rg('Homogenic', ['Björk'], 'Album')], 'homogenic', 'Bjork').length, 1)
  })

  test('near titles and namesakes are refused', () => {
    assert.equal(acceptedReleaseGroups([rg('3D Country (Instrumentals)', ['Geese'], 'Album')], '3D Country', 'Geese').length, 0)
    assert.equal(acceptedReleaseGroups([rg('Past Masters, Volume One', ['The Beatles'], 'Album', ['Compilation'])], 'Past Masters, Vol. 1', 'The Beatles').length, 0)
    assert.equal(acceptedReleaseGroups([rg('Projector', ['Geese Howard'], 'Album')], 'Projector', 'Geese').length, 0)
  })

  test('a joined multi-artist credit, or the credited artist under a different credit name, counts', () => {
    const throne = rg('Watch the Throne', [{ name: 'JAY-Z', joinphrase: ' & ' }, { name: 'Kanye West' }], 'Album')
    assert.equal(acceptedReleaseGroups([throne], 'Watch the Throne', 'JAY‐Z & Kanye West').length, 1)
    assert.equal(acceptedReleaseGroups([throne], 'Watch the Throne', 'Kanye West').length, 1)
    const credited = rg('Band on the Run', [{ name: 'Paul McCartney & Wings', artist: 'Wings' }], 'Album')
    assert.equal(acceptedReleaseGroups([credited], 'Band on the Run', 'Wings').length, 1)
    assert.equal(acceptedReleaseGroups([credited], 'Band on the Run', 'Paul McCartney & Wings').length, 1)
  })

  test('accepted hits that disagree on the kind are ambiguous; agreeing hits are a hit on the first', () => {
    const v = judgeReleaseGroups([rg('Getting Killed', ['Geese'], 'Album', [], 'a'), rg('Getting Killed', ['Geese'], 'Single', [], 'b')], 'Getting Killed', 'Geese')
    assert.equal(v.verdict, 'ambiguous')
    const h = judgeReleaseGroups([rg('Getting Killed', ['Geese'], 'Album', [], 'a'), rg('Getting Killed', ['Geese'], 'Album', ['Soundtrack'], 'b'), rg('Getting Killed', ['Someone Else'], 'Single', [], 'c')], 'Getting Killed', 'Geese')
    assert.deepEqual(h, { verdict: 'hit', mb: { primaryType: 'Album', secondaryTypes: [] }, mbid: 'a' })
    assert.deepEqual(judgeReleaseGroups([], 'Getting Killed', 'Geese'), { verdict: 'miss' })
  })

  test('the request: the spec query, escaped quotes, User-Agent; failures are null', async () => {
    const url = releaseGroupSearchUrl('Say "Hi" - Single', 'Geese')
    assert.ok(url.startsWith('https://musicbrainz.org/ws/2/release-group?query='))
    assert.ok(url.endsWith('&fmt=json&limit=10'))
    assert.equal(decodeURIComponent(url.split('query=')[1].split('&')[0]), 'releasegroup:"Say \\"Hi\\"" AND artist:"Geese"')
    const seen: { url?: string; ua?: string } = {}
    const ok = (async (u: string, init: RequestInit) => {
      seen.url = u
      seen.ua = (init.headers as Record<string, string>)['User-Agent']
      return jsonResponse({ 'release-groups': [rg('EP', ['Geese'], 'EP')] })
    }) as unknown as typeof fetch
    assert.equal((await lookupReleaseGroup('EP', 'Geese', { userAgent: 'JakeTunes/test', fetchFn: ok }))?.verdict, 'hit')
    assert.equal(seen.ua, 'JakeTunes/test')
    assert.equal(seen.url, releaseGroupSearchUrl('EP', 'Geese'))
    assert.equal(await lookupReleaseGroup('EP', 'Geese', { userAgent: 'x', fetchFn: (async () => jsonResponse({}, false)) as unknown as typeof fetch }), null)
    assert.equal(await lookupReleaseGroup('EP', 'Geese', { userAgent: 'x', fetchFn: (async () => { throw new Error('offline') }) as unknown as typeof fetch }), null)
    assert.deepEqual(await lookupReleaseGroup('EP', 'Geese', { userAgent: 'x', fetchFn: (async () => jsonResponse({ nope: 1 })) as unknown as typeof fetch }), { verdict: 'miss' })
  })
})

describe('what gets stored', () => {
  const facts = collectAlbumFacts(rows('Geese', 'Alive & In Person', 7, 7), nameKey).values().next().value!
  test('a hit stores the MusicBrainz kind with its release-group id', () => {
    assert.deepEqual(entryFor(facts, { verdict: 'hit', mb: { primaryType: 'EP', secondaryTypes: ['Live'] }, mbid: 'rg1' }, iso(NOW)),
      { kind: 'live', source: 'musicbrainz', checkedAt: iso(NOW), mbid: 'rg1' })
  })
  test('a miss or an ambiguous answer stores title/shape with checkedAt and no id', () => {
    assert.deepEqual(entryFor(facts, { verdict: 'miss' }, iso(NOW)), { kind: 'album', source: 'shape', checkedAt: iso(NOW) })
    assert.deepEqual(entryFor(facts, { verdict: 'ambiguous', kinds: ['album', 'single'] }, iso(NOW)), { kind: 'album', source: 'shape', checkedAt: iso(NOW) })
  })
  test('a hit whose type the rulebook ignores (Broadcast) falls to title/shape, no id', () => {
    assert.deepEqual(entryFor(facts, { verdict: 'hit', mb: { primaryType: 'Broadcast' }, mbid: 'rg2' }, iso(NOW)), { kind: 'album', source: 'shape', checkedAt: iso(NOW) })
  })
})

describe('the 30-day re-ask rule', () => {
  test('no entry, stale or undated misses are asked; MusicBrainz and manual answers never are', () => {
    assert.equal(needsLookup(undefined, NOW), true)
    assert.equal(needsLookup({ kind: 'album', source: 'musicbrainz', mbid: 'x', checkedAt: iso(NOW - 400 * DAY) }, NOW), false)
    assert.equal(needsLookup({ kind: 'ep', source: 'manual' }, NOW), false)
    assert.equal(needsLookup({ kind: 'album', source: 'shape', checkedAt: iso(NOW - 29 * DAY) }, NOW), false)
    assert.equal(needsLookup({ kind: 'album', source: 'title', checkedAt: iso(NOW - 31 * DAY) }, NOW), true)
    assert.equal(needsLookup({ kind: 'album', source: 'default' }, NOW), true)
    assert.equal(RELEASE_RECHECK_MS, 30 * DAY)
  })

  test('a pass asks only for new albums and misses older than 30 days', async () => {
    const file = tempFile()
    seed(file, {
      'geese|3d country': { kind: 'album', source: 'musicbrainz', mbid: 'm1', checkedAt: iso(NOW - 90 * DAY) },
      'geese|projector': { kind: 'album', source: 'shape', checkedAt: iso(NOW - 10 * DAY) },
      'geese|ep': { kind: 'ep', source: 'title', checkedAt: iso(NOW - 40 * DAY) },
    })
    const asked: string[] = []
    const fetchFn = (async (u: string) => {
      const q = decodeURIComponent(u.split('query=')[1].split('&')[0])
      asked.push(q)
      if (q.includes('"EP"')) return jsonResponse({ 'release-groups': [rg('EP', ['Geese'], 'EP', [], 'm-ep')] })
      return jsonResponse({ 'release-groups': [] })
    }) as unknown as typeof fetch
    const r = await runReleaseKindsPass({
      file, fetchFn, userAgent: 't', throttle: async () => undefined, now: () => NOW, log: () => undefined,
      rows: async () => [...rows('Geese', '3D Country', 10), ...rows('Geese', 'Projector', 10), ...rows('Geese', 'EP', 4), ...rows('Geese', '4D Country', 5)],
    })
    assert.deepEqual(asked.sort(), ['releasegroup:"4D Country" AND artist:"Geese"', 'releasegroup:"EP" AND artist:"Geese"'])
    assert.equal(r.asked, 2)
    const out = JSON.parse(readFileSync(file, 'utf8')) as ReleaseKindsFile
    assert.equal(out.version, 1)
    assert.deepEqual(out.albums['geese|ep'], { kind: 'ep', source: 'musicbrainz', checkedAt: iso(NOW), mbid: 'm-ep' })
    assert.deepEqual(out.albums['geese|4d country'], { kind: 'ep', source: 'shape', checkedAt: iso(NOW) })
    assert.deepEqual(out.albums['geese|3d country'], { kind: 'album', source: 'musicbrainz', mbid: 'm1', checkedAt: iso(NOW - 90 * DAY) })
    assert.deepEqual(out.albums['geese|projector'], { kind: 'album', source: 'shape', checkedAt: iso(NOW - 10 * DAY) })
  })

  test('network failures store nothing (retried next run) and a run of them ends the pass', async () => {
    const file = tempFile()
    let calls = 0
    const r = await runReleaseKindsPass({
      file, userAgent: 't', throttle: async () => undefined, now: () => NOW, log: () => undefined, maxConsecutiveFailures: 3,
      fetchFn: (async () => { calls++; throw new Error('offline') }) as unknown as typeof fetch,
      rows: async () => Array.from({ length: 8 }, (_, i) => rows('A', `Album ${i}`, 10)).flat(),
    })
    assert.equal(calls, 3)
    assert.equal(r.failures, 3)
    assert.equal(r.remaining, 8)
    assert.equal(existsSync(file), false)
  })

  test('a not-yet-due title/shape answer follows the library without asking', async () => {
    const file = tempFile()
    seed(file, { 'a|thing': { kind: 'single', source: 'shape', checkedAt: iso(NOW - 5 * DAY) } })
    let calls = 0
    const r = await runReleaseKindsPass({
      file, userAgent: 't', throttle: async () => undefined, now: () => NOW, log: () => undefined,
      fetchFn: (async () => { calls++; return jsonResponse({ 'release-groups': [] }) }) as unknown as typeof fetch,
      rows: async () => rows('A', 'Thing', 5, 5),   // the 2-song single grew into a 5-song EP
    })
    assert.equal(calls, 0)
    assert.equal(r.refreshed, 1)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).albums['a|thing'], { kind: 'ep', source: 'shape', checkedAt: iso(NOW - 5 * DAY) })
  })
})

describe('writes: atomic, merged onto the FRESH file', () => {
  test('manual answers are never overwritten; MusicBrainz answers never lose to a guess', () => {
    const fresh: ReleaseKindsFile = { version: 1, updatedAt: 'x', albums: {
      m: { kind: 'live', source: 'manual' },
      b: { kind: 'compilation', source: 'musicbrainz', mbid: '1' },
      c: { kind: 'album', source: 'shape', checkedAt: 'old' },
    } }
    const merged = mergeReleaseKinds(fresh, {
      m: { kind: 'album', source: 'musicbrainz', mbid: '2' },
      b: { kind: 'album', source: 'title', checkedAt: 'now' },
      c: { kind: 'ep', source: 'musicbrainz', mbid: '3' },
      d: { kind: 'single', source: 'shape', checkedAt: 'now' },
    }, 'now')
    assert.deepEqual(merged.albums.m, { kind: 'live', source: 'manual' })
    assert.deepEqual(merged.albums.b, { kind: 'compilation', source: 'musicbrainz', mbid: '1' })
    assert.equal(merged.albums.c.kind, 'ep')
    assert.equal(merged.albums.d.kind, 'single')
    assert.equal(merged.updatedAt, 'now')
  })

  test('an entry written by someone else mid-pass survives the pass, and is not re-asked', async () => {
    const file = tempFile()
    const asked: string[] = []
    const fetchFn = (async (u: string) => {
      const q = decodeURIComponent(u.split('query=')[1].split('&')[0])
      asked.push(q)
      if (asked.length === 1) {
        // Another writer lands between our flushes: a manual answer + an answer for an album still in our queue.
        writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 'other', albums: {
          'x|hand set': { kind: 'live', source: 'manual' },
          'a|album 3': { kind: 'compilation', source: 'musicbrainz', mbid: 'theirs' },
        } }))
      }
      return jsonResponse({ 'release-groups': [] })
    }) as unknown as typeof fetch
    await runReleaseKindsPass({
      file, fetchFn, userAgent: 't', throttle: async () => undefined, now: () => NOW, log: () => undefined, flushEvery: 1,
      rows: async () => Array.from({ length: 4 }, (_, i) => rows('A', `Album ${i}`, 10)).flat(),
    })
    const out = readReleaseKinds(file)
    const albums = (await out).albums
    assert.deepEqual(albums['x|hand set'], { kind: 'live', source: 'manual' })
    assert.deepEqual(albums['a|album 3'], { kind: 'compilation', source: 'musicbrainz', mbid: 'theirs' })
    for (const k of ['a|album 0', 'a|album 1', 'a|album 2']) assert.equal(albums[k]?.source, 'shape', k)
    assert.equal(asked.some((q) => q.includes('Album 3')), false)
    // No staging files left beside it
    assert.deepEqual(readdirSync(join(file, '..')).filter((f) => f !== 'release-kinds.json'), [])
  })

  test('concurrent writes in one process serialize — neither update is lost', async () => {
    const file = tempFile()
    await Promise.all([
      writeReleaseKinds(file, { a: { kind: 'ep', source: 'shape', checkedAt: 'n' } }, { nowIso: '1' }),
      writeReleaseKinds(file, { b: { kind: 'live', source: 'title', checkedAt: 'n' } }, { nowIso: '2' }),
    ])
    const albums = (await readReleaseKinds(file)).albums
    assert.equal(albums.a?.kind, 'ep')
    assert.equal(albums.b?.kind, 'live')
  })

  test('a file that does not parse is kept aside, never merged over', async () => {
    const file = tempFile()
    writeFileSync(file, '{"version":1,"albums":{"a|b":{"kind":"ep"')
    await writeReleaseKinds(file, { c: { kind: 'single', source: 'shape', checkedAt: 'n' } }, { nowIso: 'n', log: () => undefined })
    const aside = readdirSync(join(file, '..')).filter((f) => f.startsWith('release-kinds.json.corrupt-'))
    assert.equal(aside.length, 1)
    assert.equal(readFileSync(join(file, '..', aside[0]), 'utf8'), '{"version":1,"albums":{"a|b":{"kind":"ep"')
    assert.equal((await readReleaseKinds(file)).albums.c?.kind, 'single')
  })

  test('the reader drops malformed entries instead of trusting them', async () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 'u', albums: { ok: { kind: 'ep', source: 'title' }, bad: { kind: 'mixtape', source: 'title' }, worse: 7 } }))
    assert.deepEqual((await readReleaseKinds(file)).albums, { ok: { kind: 'ep', source: 'title' } })
    assert.deepEqual((await readReleaseKinds(join(file, '..', 'missing.json'))).albums, {})
  })
})

describe('the background job', () => {
  test('a replica never asks MusicBrainz', async () => {
    let calls = 0
    const job = startReleaseKindsJob({
      file: tempFile(), userAgent: 't', throttle: async () => undefined, log: () => undefined, firstDelayMs: 3_600_000,
      isReplica: async () => true,
      fetchFn: (async () => { calls++; return jsonResponse({}) }) as unknown as typeof fetch,
      rows: async () => rows('A', 'B', 10),
    })
    await job.runNow()
    job.stop()
    assert.equal(calls, 0)
  })
})

describe('library rows', () => {
  test('overrides apply only to the track they were saved against (fingerprint)', () => {
    const tracks = [
      { id: 1, title: 'Song', artist: 'Geese', album: 'Wrong', albumArtist: '', trackCount: 9, duration: 1000 },
      { id: 2, title: 'Other', artist: 'Geese', album: 'Kept', albumArtist: '', trackCount: 9, duration: 1000 },
    ]
    const out = effectiveAlbumRows(tracks, {
      1: { fp: 'song|geese|1000', fields: { album: 'Right', trackCount: '5' } },
      2: { fp: 'other|geese|9999', fields: { album: 'Stale' } },
    })
    assert.equal(out[0].album, 'Right')
    assert.equal(out[0].trackCount, '5')
    assert.equal(out[1].album, 'Kept')
  })

})

describe('WIRING — the tested code is the live code', () => {
  const SRC = join(import.meta.dirname, '../..')
  const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8')
  test('index.ts starts the job, registers the read, and mirrors the file to the NAS (where the phone reads it)', () => {
    const idx = read('main/index.ts')
    assert.match(idx, /(?<![\w.])startReleaseKindsJob\(/)
    assert.match(idx, /(?<![\w.])registerReleaseKindsIpc\(/)
    const start = idx.indexOf('const STATE_FILE_NAMES = [')
    const end = idx.indexOf('] as const', start)
    assert.ok(start > 0 && end > start)
    assert.ok(idx.slice(start, end).includes(`'release-kinds.json'`), 'release-kinds.json left STATE_FILE_NAMES — the phone stops getting it')
  })
  test('homemini sync pushes it to homemini\'s own JakeTunes; workmini deploy carries it to the replica', () => {
    const sync = read('../Dr. Claude/scripts/jaketunes-homemini-sync.sh')
    const assigned = sync.match(/\nSYNC_FILES=\(([^)]*)\)/)
    assert.ok(assigned && assigned[1].split(/\s+/).includes('release-kinds.json'))
    const deploy = read('../Dr. Claude/scripts/jaketunes-workmini-deploy.sh')
    const sidecars = deploy.match(/\nSIDECARS=\(([^)]*)\)/)
    assert.ok(sidecars && sidecars[1].split(/\s+/).includes('release-kinds.json'))
  })
})
