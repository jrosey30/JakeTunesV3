/**
 * The album credits prefetch (album-personnel-prefetch.ts; Jake 2026-10-30:
 * "it should just be there. it shouldnt have to load everytime").
 *
 * The planning is pure and tested as such; the loop runs on a fake clock, a
 * fake service and a temp directory — no MusicBrainz, no timers.
 */
import assert from 'node:assert/strict'
import test, { describe, afterEach } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rankLibraryAlbums, libraryAlbumKey, planPass, albumStatus, nextPassDelay, progressLine,
  normalizePrefetchCursor, readPrefetchCursor, prefetchCursorPath, startAlbumPersonnelPrefetch,
  PREFETCH_START_DELAY_MS, PREFETCH_RERUN_MS, PREFETCH_LOG_EVERY, PREFETCH_FAILURES_BEFORE_PAUSE, PREFETCH_FAILURE_PAUSE_MS, PREFETCH_CURSOR_FILE, PREFETCH_ENV,
  type LibraryAlbum, type PrefetchCursor, type PrefetchService, type PrefetchHandle,
} from '../album-personnel-prefetch.ts'
import { createBackgroundGate, createMbThrottle, BACKGROUND_GAP_MS, PERSONNEL_EMPTY_RECHECK_MS, type AlbumPersonnel, type PersonnelCacheEntry } from '../album-personnel.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const DAY = 24 * 3600 * 1000
const quiet = (): void => {}
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'album-personnel-prefetch-'))
const SRC = join(import.meta.dirname, '../..')

const album = (artist: string, album: string, score = 0, year = ''): LibraryAlbum => ({ artist, album, year, score })
const entry = (people: number, at = NOW): PersonnelCacheEntry => ({
  people: Array.from({ length: people }, (_, i) => ({ name: `P${i}`, roles: ['guitar'], tracks: 1, credits: [{ role: 'guitar', tracks: [1] }] })),
  trackCount: 10, at,
})

describe('ranking the library', () => {
  test('albums group by album artist (else artist) and title, the way the page asks; blanks are skipped', () => {
    const ranked = rankLibraryAlbums([
      { artist: 'Lost Desert', albumArtist: 'Various Artists', album: 'SPIRITS VIII', dateAdded: '2020-01-01' },
      { artist: 'Someone Else', albumArtist: 'Various Artists', album: 'SPIRITS VIII', dateAdded: '2020-01-01' },
      { artist: 'The Beatles', album: 'Abbey Road', year: 1969, dateAdded: '2020-01-01' },
      { artist: 'The Beatles', album: '', dateAdded: '2020-01-01' },
      { album: 'No Artist' },
      null, 'junk', 42,
    ], NOW)
    assert.deepEqual(ranked.map((a) => [a.artist, a.album, a.year]), [['The Beatles', 'Abbey Road', '1969'], ['Various Artists', 'SPIRITS VIII', '']])
    assert.equal(libraryAlbumKey(ranked[0]!), 'the beatles|abbey road')
  })

  test('starred and played first, then the just-added, then the rest; ties break on the key so the order is stable', () => {
    const t = (album: string, extra: Record<string, unknown>) => ({ artist: 'A', album, dateAdded: '2020-01-01', ...extra })
    const ranked = rankLibraryAlbums([
      t('Quiet', {}),
      t('Played', { playCount: 12 }),
      t('Starred', { rating: 5 }), t('Starred', { rating: 5 }), t('Starred', { rating: 4, playCount: 3 }),
      t('New', { dateAdded: new Date(NOW - 2 * DAY).toISOString().slice(0, 10) }),
      t('Newish', { dateAdded: new Date(NOW - 60 * DAY).toISOString().slice(0, 10) }),
      t('Also Quiet', {}),
    ], NOW)
    assert.deepEqual(ranked.map((a) => a.album), ['Starred', 'New', 'Played', 'Newish', 'Also Quiet', 'Quiet'])
    const by = Object.fromEntries(ranked.map((a) => [a.album, a.score]))
    assert.equal(by.Starred, (5 + 5 + 4) * 2 + 3, 'rating is 0–5: a starred song is 5 → 10 points; plays count 1 each')
    assert.equal(by.Played, 12)
    assert.ok(by.New > 24 && by.New <= 25, `added two days ago: ${by.New}`)
    assert.ok(by.Newish > 8 && by.Newish < 9, `added sixty days ago: ${by.Newish}`)
    assert.equal(by.Quiet, 0)
    // A rating above 5 (a legacy 0–100 value, say) does not swamp everything.
    assert.equal(rankLibraryAlbums([t('Odd', { rating: 100 })], NOW)[0]!.score, 10)
  })
})

describe('planning a pass', () => {
  const albums = [album('A', '1', 5), album('A', '2', 4), album('A', '3', 3), album('A', '4', 2), album('A', '5', 1)]
  const fresh = new Set(['a|2'])
  const status = (a: LibraryAlbum) => (fresh.has(libraryAlbumKey(a)) ? 'fresh' as const : a.album === '4' ? 'stale' as const : 'missing' as const)

  test('albumStatus: nothing cached is missing; an empty answer past 30 days is stale; anything else is fresh', () => {
    assert.equal(albumStatus(undefined, NOW), 'missing')
    assert.equal(albumStatus(entry(3, NOW - 1000 * DAY), NOW), 'fresh')
    assert.equal(albumStatus(entry(0, NOW - 29 * DAY), NOW), 'fresh')
    assert.equal(albumStatus(entry(0, NOW - PERSONNEL_EMPTY_RECHECK_MS - DAY), NOW), 'stale')
  })

  test('a fresh pass: every album not fresh in the cache, in rank order (stale ones included)', () => {
    assert.deepEqual(planPass(albums, status, null).map((a) => a.album), ['1', '3', '4', '5'])
    const finished: PrefetchCursor = { v: 1, startedAt: NOW - DAY, done: 5, lastKey: 'a|5', finishedAt: NOW - DAY }
    assert.deepEqual(planPass(albums, status, finished).map((a) => a.album), ['1', '3', '4', '5'], 'a finished cursor starts a new pass from the top')
  })

  test('resuming: the albums after the cursor\'s last one come first; the ones before it are reached at the end, not lost', () => {
    const unfinished: PrefetchCursor = { v: 1, startedAt: NOW - 3600_000, done: 2, lastKey: 'a|3' }
    assert.deepEqual(planPass(albums, status, unfinished).map((a) => a.album), ['4', '5', '1', '3'])
    const gone: PrefetchCursor = { v: 1, startedAt: NOW, done: 1, lastKey: 'b|deleted' }
    assert.deepEqual(planPass(albums, status, gone).map((a) => a.album), ['1', '3', '4', '5'], 'an album no longer in the library: from the top')
    assert.deepEqual(planPass(albums, () => 'fresh', unfinished), [], 'nothing to do when everything is cached')
  })

  test('nextPassDelay: at once unless the last pass finished less than a day ago', () => {
    assert.equal(nextPassDelay(null, NOW), 0)
    assert.equal(nextPassDelay({ v: 1, startedAt: NOW, done: 3, lastKey: 'x' }, NOW), 0, 'an unfinished pass resumes at once')
    assert.equal(nextPassDelay({ v: 1, startedAt: NOW - DAY, done: 3, lastKey: 'x', finishedAt: NOW - 3600_000 }, NOW), PREFETCH_RERUN_MS - 3600_000)
    assert.equal(nextPassDelay({ v: 1, startedAt: NOW - 3 * DAY, done: 3, lastKey: 'x', finishedAt: NOW - 2 * DAY }, NOW), 0)
  })

  test('the progress line: "1,240 of 2,603 albums known, 980 with credits"', () => {
    const statuses = [
      ...Array.from({ length: 980 }, () => ({ status: 'fresh' as const, withCredits: true })),
      ...Array.from({ length: 200 }, () => ({ status: 'fresh' as const, withCredits: false })),
      ...Array.from({ length: 60 }, () => ({ status: 'stale' as const, withCredits: false })),
      ...Array.from({ length: 1363 }, () => ({ status: 'missing' as const, withCredits: false })),
    ]
    assert.equal(progressLine(statuses), '1,240 of 2,603 albums known, 980 with credits')
  })
})

describe('the cursor file', () => {
  test('round trip: written by the loop, read back; junk or a missing file is null (a fresh pass)', async () => {
    const dir = tempDir()
    const file = prefetchCursorPath(dir)
    assert.equal(file, join(dir, PREFETCH_CURSOR_FILE))
    assert.equal(await readPrefetchCursor(file, quiet), null)
    writeFileSync(file, JSON.stringify({ v: 1, startedAt: NOW, done: 12, lastKey: 'a|b', finishedAt: NOW + 1000 }))
    assert.deepEqual(await readPrefetchCursor(file, quiet), { v: 1, startedAt: NOW, done: 12, lastKey: 'a|b', finishedAt: NOW + 1000 })
    const logs: string[] = []
    writeFileSync(file, '{ nope')
    assert.equal(await readPrefetchCursor(file, (m) => logs.push(m)), null)
    assert.equal(logs.length, 1)
  })

  test('normalize: the shape is checked field by field; finishedAt is optional', () => {
    assert.deepEqual(normalizePrefetchCursor({ startedAt: 1, done: 2, lastKey: 'k' }), { v: 1, startedAt: 1, done: 2, lastKey: 'k' })
    assert.equal(normalizePrefetchCursor({ startedAt: 1, done: 2.5, lastKey: 'k' }), null)
    assert.equal(normalizePrefetchCursor({ startedAt: 'yesterday', done: 2, lastKey: 'k' }), null)
    assert.equal(normalizePrefetchCursor({ startedAt: 1, done: 2 }), null)
    assert.equal(normalizePrefetchCursor(null), null)
    assert.deepEqual(normalizePrefetchCursor({ startedAt: 1, done: 2, lastKey: 'k', finishedAt: 'soon' }), { v: 1, startedAt: 1, done: 2, lastKey: 'k' })
  })
})

describe('the background gate — a page\'s lookup goes first', () => {
  test('background requests keep BACKGROUND_GAP_MS between them, then take the app throttle like everyone', async () => {
    let clock = 0
    const waits: number[] = []
    const wait = async (ms: number): Promise<void> => { waits.push(ms); clock += ms }
    let throttled = 0
    const gate = createBackgroundGate({ pagesBusy: () => false, spacing: createMbThrottle(BACKGROUND_GAP_MS, () => clock, wait), throttle: async () => { throttled++ }, wait })
    await gate()
    await gate()
    clock += 10_000
    await gate()
    assert.deepEqual(waits, [BACKGROUND_GAP_MS], 'the second request waits the full gap; the third, after a quiet spell, does not')
    assert.equal(throttled, 3)
    assert.equal(BACKGROUND_GAP_MS, 2500)
  })

  test('while a page is busy a background request waits, looking again every yield; a page waiting on this very lookup skips the spacing', async () => {
    let busy = true
    const waits: number[] = []
    let spaced = 0
    const gate = createBackgroundGate({
      pagesBusy: () => busy,
      spacing: async () => { spaced++ },
      throttle: async () => {},
      wait: async (ms) => { waits.push(ms); if (waits.length === 3) busy = false },
      yieldMs: 250,
    })
    await gate()
    assert.deepEqual(waits, [250, 250, 250])
    assert.equal(spaced, 1)
    const shared = createBackgroundGate({ pagesBusy: () => false, pageWaitingOnThis: () => true, spacing: async () => { spaced++ }, throttle: async () => {} })
    await shared()
    assert.equal(spaced, 1, 'no spacing when a page waits on this lookup')
  })
})

describe('the loop', () => {
  // A fake world: a virtual clock the fake `wait` advances, a service whose
  // answers and cache are plain Maps, a temp directory for the cursor.
  interface World {
    clock: number
    waits: number[]
    logs: string[]
    gets: string[]
    fills: string[]
    cache: Map<string, PersonnelCacheEntry>
    answers: (key: string) => AlbumPersonnel
    pagesBusy: boolean
    service: PrefetchService
    dir: string
    handle?: PrefetchHandle
    stopAtRerun: boolean
  }
  const found = (): AlbumPersonnel => ({ ok: true, people: entry(2).people, trackCount: 10 })
  const failed = (): AlbumPersonnel => ({ ok: false, people: [], trackCount: 0, error: 'rate-limited' })
  function world(): World {
    const w: World = {
      clock: NOW, waits: [], logs: [], gets: [], fills: [], cache: new Map(), answers: found, pagesBusy: false, dir: tempDir(), stopAtRerun: true,
      service: {
        get: async (artist, album, opts) => {
          const key = libraryAlbumKey({ artist, album })
          w.gets.push(`${key}${opts?.background ? '' : ' (PAGE)'}`)
          const hit = w.cache.get(key)
          if (hit) return { ok: true, people: hit.people, trackCount: hit.trackCount }
          const r = w.answers(key)
          if (r.ok) w.cache.set(key, { people: r.people, trackCount: r.trackCount, at: w.clock })
          return r
        },
        peek: async (artist, album) => w.cache.get(libraryAlbumKey({ artist, album })),
        busy: () => w.pagesBusy,
      },
    }
    return w
  }
  const start = (w: World, albums: readonly LibraryAlbum[], extra: Partial<Parameters<typeof startAlbumPersonnelPrefetch>[0]> = {}): PrefetchHandle => {
    w.handle = startAlbumPersonnelPrefetch({
      dir: w.dir,
      listAlbums: () => albums,
      service: w.service,
      fillCredits: async (a) => { w.fills.push(libraryAlbumKey(a)) },
      now: () => w.clock,
      wait: async (ms) => {
        w.waits.push(ms)
        w.clock += ms
        // The pass finished and the loop sleeps until tomorrow: the test is over.
        if (ms === PREFETCH_RERUN_MS && w.stopAtRerun) w.handle?.stop()
        await new Promise<void>((r) => setImmediate(r))
      },
      log: (m) => w.logs.push(m),
      env: {},
      ...extra,
    })
    return w.handle
  }
  const cursor = (w: World): PrefetchCursor => JSON.parse(readFileSync(prefetchCursorPath(w.dir), 'utf-8')) as PrefetchCursor

  let live: PrefetchHandle | null = null
  afterEach(async () => {
    live?.stop()
    await live?.done
    live = null
  })

  test('after the start delay it walks the plan in rank order as background lookups, fills credits, writes the cursor, stops when done', async () => {
    const w = world()
    const albums = [album('A', 'Loved', 9), album('B', 'Played', 5), album('C', 'Quiet', 0)]
    w.cache.set('b|played', entry(3))   // already known: skipped
    live = start(w, albums)
    assert.equal(live.enabled, true)
    await live.done
    assert.equal(w.waits[0], PREFETCH_START_DELAY_MS, 'nothing before the app has settled')
    assert.deepEqual(w.gets, ['a|loved', 'c|quiet'], 'background lookups, rank order, the cached one skipped')
    assert.deepEqual(w.fills, ['a|loved', 'c|quiet'])
    const c = cursor(w)
    assert.equal(c.done, 2)
    assert.equal(c.lastKey, 'c|quiet')
    assert.ok(c.finishedAt, 'the pass is marked finished')
    assert.ok(w.logs.some((m) => m === '[album-personnel] prefetch: 3 of 3 albums known, 3 with credits — pass complete, next in 24 h'), w.logs.join('\n'))
    assert.ok(w.waits.includes(PREFETCH_RERUN_MS), 'then it sleeps until tomorrow')
    assert.deepEqual(readdirSync(w.dir).filter((f) => f.endsWith('.tmp')), [], 'no staging litter')
  })

  test('a relaunch resumes after the cursor\'s last album; a finished pass waits a day, then asks only about what is stale or new', async () => {
    const w = world()
    const albums = Array.from({ length: 6 }, (_, i) => album('A', `${i + 1}`, 6 - i))
    writeFileSync(prefetchCursorPath(w.dir), JSON.stringify({ v: 1, startedAt: NOW - 3600_000, done: 3, lastKey: 'a|3' }))
    w.cache.set('a|1', entry(1)); w.cache.set('a|2', entry(1))   // done last time; 3 failed (not cached)
    live = start(w, albums)
    await live.done
    assert.deepEqual(w.gets, ['a|4', 'a|5', 'a|6', 'a|3'], 'carries on after 3, comes back for it at the end')
    assert.equal(cursor(w).done, 7)
    assert.ok(w.logs.some((m) => /resuming after 3 albums, 4 of 6 albums to ask about/.test(m)), w.logs.join('\n'))
    live = null

    // Day two: one empty answer went stale, one album is new; the rest are fresh.
    const w2 = world()
    w2.dir = w.dir
    w2.cache = w.cache
    w2.clock = NOW + 2 * DAY
    w2.cache.set('a|5', { people: [], trackCount: 0, at: NOW - PERSONNEL_EMPTY_RECHECK_MS - DAY })
    live = start(w2, [...albums, album('A', '7', 0)])
    await live.done
    assert.deepEqual(w2.gets, ['a|5', 'a|7'])
    assert.ok(!w2.logs.some((m) => /resuming/.test(m)), 'a finished cursor is a new pass, not a resume')
  })

  test('a pass that finished an hour ago waits the rest of the day before looking again', async () => {
    const w = world()
    writeFileSync(prefetchCursorPath(w.dir), JSON.stringify({ v: 1, startedAt: NOW - DAY, done: 1, lastKey: 'a|1', finishedAt: NOW - 3600_000 }))
    w.stopAtRerun = false
    live = start(w, [album('A', '1'), album('A', '2')], { wait: async (ms) => { w.waits.push(ms); w.clock += ms; if (w.waits.length === 2) w.handle?.stop(); await new Promise<void>((r) => setImmediate(r)) } })
    await live.done
    // The start delay has already passed on the fake clock by the time the cursor is read.
    assert.deepEqual(w.waits, [PREFETCH_START_DELAY_MS, PREFETCH_RERUN_MS - 3600_000 - PREFETCH_START_DELAY_MS])
    assert.deepEqual(w.gets, [], 'nothing asked before the day is up')
  })

  test('it pauses while a page has a lookup of its own in flight, and looks again every half second', async () => {
    const w = world()
    w.pagesBusy = true
    let polls = 0
    live = start(w, [album('A', '1')], { wait: async (ms) => {
      w.waits.push(ms); w.clock += ms
      if (ms === 500 && ++polls === 3) w.pagesBusy = false
      if (ms === PREFETCH_RERUN_MS) w.handle?.stop()
      await new Promise<void>((r) => setImmediate(r))
    } })
    await live.done
    assert.deepEqual(w.waits.filter((ms) => ms === 500), [500, 500, 500])
    assert.deepEqual(w.gets, ['a|1'])
  })

  test('five MusicBrainz failures in a row pause the pass for fifteen minutes; failures are counted done and retried next pass', async () => {
    const w = world()
    let fails = 0
    w.answers = () => (fails++ < 5 ? failed() : found())
    live = start(w, Array.from({ length: 7 }, (_, i) => album('A', `${i + 1}`, 7 - i)))
    await live.done
    assert.equal(PREFETCH_FAILURES_BEFORE_PAUSE, 5)
    assert.deepEqual(w.waits.filter((ms) => ms === PREFETCH_FAILURE_PAUSE_MS), [PREFETCH_FAILURE_PAUSE_MS])
    assert.ok(w.logs.some((m) => /MusicBrainz is not answering \(rate-limited\); pausing 15 min/.test(m)))
    assert.equal(w.gets.length, 7, 'the pass carries on after the pause')
    assert.deepEqual(w.fills, ['a|6', 'a|7'], 'credits are filled only for albums that answered')
    assert.equal(cursor(w).done, 7)
    assert.ok(w.logs.some((m) => /2 of 7 albums known, 2 with credits — pass complete/.test(m)), w.logs.join('\n'))
  })

  test(`it logs progress every ${PREFETCH_LOG_EVERY} albums`, async () => {
    const w = world()
    live = start(w, Array.from({ length: 120 }, (_, i) => album('A', `${i + 1}`, 120 - i)))
    await live.done
    const progress = w.logs.filter((m) => /^\[album-personnel\] prefetch: \d+ of 120 albums known/.test(m))
    assert.deepEqual(progress, [
      '[album-personnel] prefetch: 50 of 120 albums known, 50 with credits',
      '[album-personnel] prefetch: 100 of 120 albums known, 100 with credits',
      '[album-personnel] prefetch: 120 of 120 albums known, 120 with credits — pass complete, next in 24 h',
    ])
  })

  test('stop() ends the loop after the album in hand; the cursor keeps the place', async () => {
    const w = world()
    live = start(w, Array.from({ length: 10 }, (_, i) => album('A', `${i + 1}`, 10 - i)), { fillCredits: async (a) => { w.fills.push(libraryAlbumKey(a)); if (w.fills.length === 3) w.handle?.stop() } })
    await live.done
    assert.equal(w.gets.length, 3)
    const c = cursor(w)
    assert.equal(c.done, 3)
    assert.equal(c.lastKey, 'a|3')
    assert.equal(c.finishedAt, undefined)
  })

  test('never two at once: a second start returns the running one; after it exits a new one may start', async () => {
    const w = world()
    live = start(w, [album('A', '1')])
    const again = startAlbumPersonnelPrefetch({ dir: tempDir(), listAlbums: () => [], service: w.service, now: () => w.clock, wait: async () => {}, log: quiet, env: {} })
    assert.equal(again, live)
    await live.done
    live = null
    const w2 = world()
    live = start(w2, [album('B', '1')])
    assert.notEqual(live, again)
    await live.done
    assert.deepEqual(w2.gets, ['b|1'])
  })

  test(`the kill switch: ${PREFETCH_ENV}=0 logs one line and does nothing`, async () => {
    const w = world()
    const h = start(w, [album('A', '1')], { env: { [PREFETCH_ENV]: '0' } })
    assert.equal(h.enabled, false)
    await h.done
    assert.deepEqual(w.gets, [])
    assert.deepEqual(w.logs, [`[album-personnel] prefetch off (${PREFETCH_ENV}=0)`])
    assert.equal(existsSync(prefetchCursorPath(w.dir)), false)
    const on = start(w, [album('A', '1')], { env: { [PREFETCH_ENV]: '1' } })
    live = on
    assert.equal(on.enabled, true)
  })

  test('a listAlbums that throws is logged and retried after the failure pause, not fatal', async () => {
    const w = world()
    let calls = 0
    live = start(w, [], { listAlbums: () => { if (calls++ === 0) throw new Error('library unreadable'); return [album('A', '1')] } })
    await live.done
    assert.ok(w.logs.some((m) => /pass failed \(library unreadable\); retrying in 15 min/.test(m)), w.logs.join('\n'))
    assert.ok(w.waits.includes(PREFETCH_FAILURE_PAUSE_MS))
    assert.deepEqual(w.gets, ['a|1'])
  })
})

describe('wiring — started once, from the album-info registrar, never from index.ts', () => {
  test('exactly one live call site, inside registerAlbumInfoIpc, after the personnel service it feeds', () => {
    const ipc = readFileSync(join(SRC, 'main/ipc/album-info-ipc.ts'), 'utf-8')
    assert.equal(ipc.split('startAlbumPersonnelPrefetch(').length - 1, 1)
    assert.ok(ipc.indexOf('createAlbumPersonnelService(') < ipc.indexOf('startAlbumPersonnelPrefetch('))
    assert.match(ipc, /startAlbumPersonnelPrefetch\(\{\s*dir: app\.getPath\('userData'\),\s*listAlbums: \(\) => host\.listAlbums\?\.\(\) \?\? \[\],\s*service: personnel,\s*fillCredits,/)
    const index = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
    assert.doesNotMatch(index, /startAlbumPersonnelPrefetch/, 'index.ts hands over the library and nothing more (the line-count ratchet)')
    assert.match(index, /registerAlbumInfoIpc\(ipc, \{ mbThrottle, listAlbums: async \(\) => rankLibraryAlbums\(\(await libraryCache\.get\(\)\)\.tracks\) \}\)/)
    // No other module starts it.
    const others = readdirSync(join(SRC, 'main')).filter((f) => f.endsWith('.ts') && f !== 'album-personnel-prefetch.ts')
    for (const f of others) assert.doesNotMatch(readFileSync(join(SRC, 'main', f), 'utf-8'), /startAlbumPersonnelPrefetch\(/, f)
  })

  test('the module never touches Electron — it is testable under plain Node', () => {
    const src = readFileSync(join(SRC, 'main/album-personnel-prefetch.ts'), 'utf-8')
    assert.doesNotMatch(src, /from 'electron'/)
    assert.doesNotMatch(src, /require\('electron'\)/)
  })
})
