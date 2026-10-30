/**
 * The album page's credits line on disk (album-credits.ts; Jake 2026-10-30:
 * "it shouldnt have to load everytime"), and the credits read off the
 * personnel lookup's answer. No network anywhere; the store runs in a temp dir.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  albumCreditsKey, albumCreditsPath, cleanCredits, createAlbumCreditsStore, creditsFromPersonnel, isCreditsStale, normalizeAlbumCredits,
  ALBUM_CREDITS_FILE, CREDITS_EMPTY_RECHECK_MS, type AlbumCreditsFile,
} from '../album-credits.ts'
import { peopleFromRelease, releaseTrackCount, type MbReleaseDetail } from '../album-personnel.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const DAY = 24 * 3600 * 1000
const quiet = (): void => {}
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'album-credits-'))

const ABBEY = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'album-personnel-abbey-road-2026-10-30.json'), 'utf-8')) as { releaseId: string; release: MbReleaseDetail }
const QOTSA = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'album-personnel-2026-10-30.json'), 'utf-8')) as { release: MbReleaseDetail }

describe('the key and the cleaning', () => {
  test('the key is the old in-memory one: artist|album, case- and space-folded, plus the tag year', () => {
    assert.equal(albumCreditsKey(' The Beatles ', 'Abbey Road', '1969'), 'the beatles|abbey road|y:1969')
    assert.equal(albumCreditsKey('The Beatles', 'Abbey Road', ''), 'the beatles|abbey road|y:?')
  })

  test('only the four fields, trimmed, never blanks or junk', () => {
    assert.deepEqual(cleanCredits({ released: ' 1969-09-26 ', label: 'Apple Records', producer: '', recorded: 42, extra: 'x' }), { released: '1969-09-26', label: 'Apple Records' })
    assert.deepEqual(cleanCredits(null), {})
    assert.deepEqual(cleanCredits('Apple'), {})
  })

  test('normalize keeps well-formed entries and drops the rest; an empty answer goes stale after 30 days, facts never do', () => {
    const file = normalizeAlbumCredits({ v: 1, entries: {
      good: { credits: { label: 'Apple Records' }, at: NOW },
      empty: { credits: {}, at: NOW },
      'no-at': { credits: { label: 'X' } },
      'bad-credits': { credits: 'Apple', at: NOW },
      nothing: null,
    } })
    assert.deepEqual(file, { v: 1, entries: { good: { credits: { label: 'Apple Records' }, at: NOW }, empty: { credits: {}, at: NOW } } })
    assert.deepEqual(normalizeAlbumCredits(null), { v: 1, entries: {} })
    assert.deepEqual(normalizeAlbumCredits({ entries: [] }), { v: 1, entries: {} })
    assert.equal(isCreditsStale({ credits: {}, at: NOW }, NOW + 29 * DAY), false)
    assert.equal(isCreditsStale({ credits: {}, at: NOW }, NOW + 31 * DAY), true)
    assert.equal(isCreditsStale({ credits: { label: 'Apple Records' }, at: NOW }, NOW + 1000 * DAY), false)
    assert.equal(CREDITS_EMPTY_RECHECK_MS, 30 * DAY)
  })
})

describe('the credits read off the personnel lookup', () => {
  test('Abbey Road: the group\'s date, the record\'s label, and George Martin — his producer credit is on the release itself', () => {
    const people = peopleFromRelease(ABBEY.release)
    assert.deepEqual(
      creditsFromPersonnel({ people, trackCount: releaseTrackCount(ABBEY.release), releaseMbid: ABBEY.releaseId, released: '1969-09-26', label: 'Apple Records' }),
      { released: '1969-09-26', label: 'Apple Records', producer: 'George Martin' },
    )
    // Chris Thomas produced four songs and Glyn Johns one; the main producer is the one on the most of the record.
    assert.ok(people.some((p) => p.name === 'Chris Thomas' && p.roles.includes('producer')))
  })

  test('Songs for the Deaf: Josh Homme (16 tracks) over Adam Kasper (14) and Eric Valentine (13); no label when the browse had none', () => {
    const people = peopleFromRelease(QOTSA.release)
    assert.deepEqual(creditsFromPersonnel({ people, trackCount: 17, releaseMbid: 'r', released: '2002-08-17' }), { released: '2002-08-17', producer: 'Josh Homme' })
  })

  test('a release-level producer credit covers the whole record and beats a per-track one; ties keep the lookup\'s order', () => {
    const people = [
      { name: 'Per Track', roles: ['producer'], tracks: 3, credits: [{ role: 'producer', tracks: [1, 2, 3] }] },
      { name: 'Whole Record', roles: ['producer'], tracks: 0, credits: [{ role: 'producer', tracks: [] }] },
    ]
    assert.equal(creditsFromPersonnel({ people, trackCount: 10, releaseMbid: 'r' })?.producer, 'Whole Record')
    const tied = [
      { name: 'First', roles: ['guitar', 'producer'], tracks: 5, credits: [{ role: 'guitar', tracks: [1, 2, 3, 4, 5] }, { role: 'producer', tracks: [1, 2, 3, 4, 5] }] },
      { name: 'Second', roles: ['producer'], tracks: 5, credits: [{ role: 'producer', tracks: [1, 2, 3, 4, 5] }] },
    ]
    assert.equal(creditsFromPersonnel({ people: tied, trackCount: 5, releaseMbid: 'r' })?.producer, 'First')
  })

  test('no release group found = nothing known (null), not an empty answer; found but bare = the facts alone', () => {
    assert.equal(creditsFromPersonnel({ people: [], trackCount: 0 }), null)
    assert.deepEqual(creditsFromPersonnel({ people: [], trackCount: 12, releaseMbid: 'r' }), {})
    assert.deepEqual(creditsFromPersonnel({ people: [], trackCount: 0, released: '2002' }), { released: '2002' })
  })
})

describe('the store', () => {
  test('set → written atomically to album-credits.json; a new store over the directory reads it back without litter', async () => {
    const dir = tempDir()
    const a = createAlbumCreditsStore(dir, { now: () => NOW, log: quiet })
    assert.equal(await a.get('k'), undefined)
    assert.equal(await a.has('k'), false)
    await a.set('k', { released: '1969-09-26', label: 'Apple Records', producer: '' })
    assert.deepEqual(await a.get('k'), { released: '1969-09-26', label: 'Apple Records' })
    await a.flush()
    assert.equal(albumCreditsPath(dir), join(dir, ALBUM_CREDITS_FILE))
    const onDisk = JSON.parse(readFileSync(albumCreditsPath(dir), 'utf-8')) as AlbumCreditsFile
    assert.deepEqual(onDisk, { v: 1, entries: { k: { credits: { released: '1969-09-26', label: 'Apple Records' }, at: NOW } } })
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no staging litter')

    const b = createAlbumCreditsStore(dir, { now: () => NOW + 400 * DAY, log: quiet })
    assert.deepEqual(await b.get('k'), { released: '1969-09-26', label: 'Apple Records' }, 'facts stay for good')
    assert.equal(await b.has('k'), true)
  })

  test('an empty answer is remembered too — and forgotten after 30 days, so the page asks again', async () => {
    const dir = tempDir()
    let clock = NOW
    const s = createAlbumCreditsStore(dir, { now: () => clock, log: quiet })
    await s.set('k', {})
    assert.deepEqual(await s.get('k'), {})
    assert.equal(await s.has('k'), true)
    clock = NOW + 29 * DAY
    assert.deepEqual(await s.get('k'), {})
    clock = NOW + 31 * DAY
    assert.equal(await s.get('k'), undefined)
    assert.equal(await s.has('k'), false)
  })

  test('many sets in a row coalesce into one serialized writer; the file holds every one', async () => {
    const dir = tempDir()
    const s = createAlbumCreditsStore(dir, { now: () => NOW, log: quiet })
    const sets: Promise<void>[] = []
    for (let i = 0; i < 20; i++) sets.push(s.set(`k${i}`, { label: `L${i}` }))
    await Promise.all(sets)
    await s.flush()
    const onDisk = JSON.parse(readFileSync(albumCreditsPath(dir), 'utf-8')) as AlbumCreditsFile
    assert.equal(Object.keys(onDisk.entries).length, 20)
    assert.deepEqual(onDisk.entries.k7, { credits: { label: 'L7' }, at: NOW })
  })

  test('an unreadable file is one warning and an empty start — never a throw', async () => {
    const dir = tempDir()
    writeFileSync(albumCreditsPath(dir), '{ not json')
    const logs: string[] = []
    const s = createAlbumCreditsStore(dir, { now: () => NOW, log: (m) => logs.push(m) })
    assert.equal(await s.get('k'), undefined)
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /album-credits\.json unreadable/)
    await s.set('k', { label: 'Apple Records' })
    await s.flush()
    assert.deepEqual(JSON.parse(readFileSync(albumCreditsPath(dir), 'utf-8')).entries.k.credits, { label: 'Apple Records' })
  })
})
