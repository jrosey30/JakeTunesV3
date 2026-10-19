/**
 * Overnight pre-load (2026-10-19) — the pins: the priority list is ordered
 * and de-duplicated, the budget and the 30 GB disk floor stop the night,
 * only 01:00–06:00 runs, playback always wins, the pre-loaded key is the key
 * a daytime play asks for, pinned files survive the cap pass, and a machine
 * without the stream-compressed marker does nothing at all.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, utimes } from 'node:fs/promises'
import {
  buildPreloadPlan, runPreloadNight, scheduleOvernightPreload, startOvernightPreload, preloadTarget,
  estimateBytes, inPreloadWindow, DISK_FLOOR_BYTES, PRELOAD_BUDGET_BYTES,
  type PlanInputs, type PreloadTrack, type NightDeps, type PlanEntry,
} from '../overnight-preload.ts'
import { homeminiStreamTarget, readStreamCompressed } from '../stream-format.ts'
import {
  enforceSpoolCap, ensureSpool, preloadSpool, readPreloadPins, spoolAwareServe, spoolLimitsFor, spoolQueueState,
  spoolReady, writePreloadPins, THIN_LINK_SPOOL_CAP_BYTES, PRELOAD_PINS_FILE, type PreloadOutcome,
} from '../stream-spool.ts'

const BASE = 'http://homemini:3000/audio'
const DAY = 86_400_000
/** Local wall-clock time, so the window tests hold in any time zone. */
const at = (h: number, m = 0, day = 20): number => new Date(2026, 9, day, h, m).getTime()
const NOW = at(2, 0)

const trk = (id: number, extra: Partial<PreloadTrack> = {}): PreloadTrack => ({
  id, path: `:iPod_Control:Music:F00:imported_${id}.m4a`, duration: 60_000, codec: 'aac', playCount: 0,
  title: `T${id}`, artist: `Artist ${id}`, album: `Album ${id}`, ...extra,
})

const inputs = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  tracks: [], plays: [], playlists: [], islandAlbums: [], favoriteArtists: [], now: NOW, ...over,
})

// ── 1. Priority order + de-duplication ──────────────────────────────────

describe('buildPreloadPlan — priority order and de-duplication', () => {
  const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString()
  const tracks: PreloadTrack[] = [
    trk(1, { dateAdded: daysAgo(2) }),                                   // recent, newest
    trk(2, { dateAdded: daysAgo(10), playCount: 40 }),                   // recent AND heavy → recent only
    trk(3, { dateAdded: daysAgo(40) }),                                  // heavy #1 (5 plays)
    trk(4, { dateAdded: daysAgo(400) }),                                 // heavy #2 (2 in window, 10 stale)
    trk(5, { artist: 'The Postal Service', album: 'Give Up', trackNumber: 2 }),
    trk(6, { artist: 'The Postal Service', album: 'Give Up', trackNumber: 1 }),
    trk(7, { artist: 'Geese', playCount: 3 }),
    trk(8, { albumArtist: 'Geese', artist: 'Geese & Friend', playCount: 9 }),
    trk(9),                                                               // edited playlist
    trk(10),                                                              // older playlist
    trk(11),                                                              // only in an iPod smart-playlist copy
    trk(12, { playCount: 50 }),                                           // most-played tail
    trk(13),                                                              // nothing → not listed
    trk(14, { dateAdded: daysAgo(1), audioMissing: true }),              // can't stream
    trk(15, { dateAdded: daysAgo(1), path: '' }),                        // no library path
  ]
  const plays = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: 3, ts: NOW - (i + 1) * DAY })),
    { id: 4, ts: NOW - 3 * DAY }, { id: 4, ts: NOW - 4 * DAY },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 4, ts: NOW - (100 + i) * DAY })),   // outside 90 days
    { id: 2, ts: NOW - DAY }, { id: 2, ts: NOW - 2 * DAY }, { id: 2, ts: NOW - 3 * DAY },
    { id: 9, ts: NOW + DAY },                                                         // the future never counts
  ]
  const plan = buildPreloadPlan(inputs({
    tracks,
    plays,
    islandAlbums: [{ artist: 'The Postal Service', album: 'Give Up' }, null],
    favoriteArtists: [null, 'geese'],
    playlists: [
      { name: 'Older', trackIds: [10, 1] },
      { name: 'Recently Played', trackIds: [11] },
      { name: 'Edited', trackIds: [9, '3'], modifiedAt: daysAgo(1) },
      { name: 'Synced', trackIds: [11], category: 'synced-set' },
    ],
  }))

  test('tiers come out in Jake\'s order, each one ordered inside', () => {
    assert.deepEqual(plan.map((e) => e.streamId), [1, 2, 3, 4, 6, 5, 8, 7, 9, 10, 12])
    assert.deepEqual(plan.map((e) => e.tier), [
      'recent-add', 'recent-add', 'heavy-rotation', 'heavy-rotation', 'island-album', 'island-album',
      'favorite-artist', 'favorite-artist', 'playlist', 'playlist', 'most-played',
    ])
  })

  test('every track appears once, under its highest tier', () => {
    const ids = plan.map((e) => String(e.streamId))
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(plan.find((e) => e.streamId === 2)?.tier, 'recent-add', 'heavy rotation does not list it twice')
    assert.equal(plan.find((e) => e.streamId === 12)?.tier, 'most-played')
  })

  test('unstreamable rows and smart-playlist copies stay out', () => {
    const ids = new Set(plan.map((e) => e.streamId))
    for (const id of [11, 13, 14, 15]) assert.ok(!ids.has(id), `track ${id} must not be listed`)
  })

  test('two rows on one path collapse to the id playback asks for (the LAST row, like trackIdForAbsPath)', () => {
    const p = ':iPod_Control:Music:F01:same.m4a'
    const dup = buildPreloadPlan(inputs({
      tracks: [trk(20, { path: p, dateAdded: new Date(NOW - DAY).toISOString() }), trk(21, { path: p, dateAdded: new Date(NOW - 2 * DAY).toISOString() })],
    }))
    assert.deepEqual(dup.map((e) => e.streamId), [21])
  })
})

// ── Night harness ────────────────────────────────────────────────────────

const EST = estimateBytes(trk(0), 256)

function harness(tracks: PreloadTrack[], over: Partial<NightDeps> = {}) {
  let t = NOW
  const log: string[] = []
  const fetched: string[] = []
  const pins: string[][] = []
  const deps: NightDeps = {
    spoolDir: '/nowhere',
    audioBase: BASE,
    kbps: 256,
    inputs: async () => inputs({ tracks: tracks.map((x) => ({ ...x, playCount: x.playCount || 1 })) }),
    isPlaying: () => false,
    freeBytes: async () => 80e9,
    download: async (key, _url, _signal, est) => { fetched.push(key); return { kind: 'landed', bytes: est } },
    landedBytes: async () => null,
    writePins: async (keys) => { pins.push(keys) },
    spoolUsage: async () => 0,
    now: () => t,
    sleep: async (ms) => { t += ms },
    log: (l) => log.push(l),
    pollMs: 1_000,
    quietMs: 3_000,
    watchMs: 1,
    backoffMs: 10,
    ...over,
  }
  return { deps, log, fetched, pins, clock: { get: () => t, set: (v: number) => { t = v } } }
}

const five = [1, 2, 3, 4, 5].map((id) => trk(id))
const key = (id: number): string => `${id}-aac256`

// ── 2. Budget + disk floor ──────────────────────────────────────────────

describe('runPreloadNight — budget and disk-floor stops', () => {
  test('the budget selects a prefix of the list, pins exactly it, and stops there', async () => {
    const h = harness(five, { budgetBytes: EST * 3 + 10 })
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.pins[0], [key(1), key(2), key(3)])
    assert.deepEqual(h.fetched, [key(1), key(2), key(3)])
    assert.equal(r.stoppedBy, 'budget')
    assert.match(h.log.at(-1)!, /stopped: budget full/)
  })

  test('already-landed files count at their real size', async () => {
    const h = harness(five, { budgetBytes: 6_100_000, landedBytes: async (k) => (k === key(1) ? 5_000_000 : null) })
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.pins[0], [key(1)])
    assert.deepEqual(h.fetched, [])
    assert.equal(r.localAtStart, 1)
    assert.equal(r.stoppedBy, 'budget')
  })

  test('files bigger than estimated still stop at the budget', async () => {
    const h = harness(five, {
      budgetBytes: EST * 5,
      download: async (k, _u, _s, est) => { h.fetched.push(k); return { kind: 'landed', bytes: est * 3 } },
    })
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1), key(2)], 'third fetch would pass the budget on real sizes')
    assert.equal(r.stoppedBy, 'budget')
  })

  test('never takes the disk below 30 GB free', async () => {
    let free = DISK_FLOOR_BYTES + EST * 2.5
    const h = harness(five, {
      freeBytes: async () => free,
      download: async (k, _u, _s, est) => { h.fetched.push(k); free -= est; return { kind: 'landed', bytes: est } },
    })
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1), key(2)])
    assert.equal(r.stoppedBy, 'disk')
    assert.ok(free >= DISK_FLOOR_BYTES)
    assert.match(h.log.at(-1)!, /disk floor/)
  })

  test('an unreadable free-space figure stops the night (fail safe)', async () => {
    const h = harness(five, { freeBytes: async () => 0 })
    assert.equal((await runPreloadNight(h.deps)).stoppedBy, 'disk')
    assert.deepEqual(h.fetched, [])
  })

  test('three link failures in a row end the night; a 404 is not the link', async () => {
    const outcomes: PreloadOutcome[] = [{ kind: 'missing', status: 404 }, { kind: 'failed', reason: 'stalled' }, { kind: 'failed', reason: 'stalled' }, { kind: 'failed', reason: 'stalled' }]
    const h = harness(five, { download: async (k) => { h.fetched.push(k); return outcomes.shift() ?? { kind: 'landed', bytes: 1 } } })
    const r = await runPreloadNight(h.deps)
    assert.equal(r.stoppedBy, 'errors')
    assert.equal(r.missing, 1)
    assert.equal(r.failures, 3)
    assert.deepEqual(h.fetched, [key(1), key(2), key(3), key(4)])
  })

  test('a whole list that fits and lands reports complete, with the status lines', async () => {
    const h = harness(five)
    const r = await runPreloadNight(h.deps)
    assert.equal(r.stoppedBy, 'complete')
    assert.equal(r.loaded, 5)
    assert.match(h.log[0], /^\[preload\] night start — priority list 5 tracks .*0 already local; pinning 5/)
    assert.match(h.log.at(-1)!, /^\[preload\] night end — stopped: whole list is local; pre-loaded 5 tonight .* 5\/5 of the priority list local/)
  })

  test('defaults: 28 GB of pins inside a 30 GB thin-link spool', () => {
    assert.equal(THIN_LINK_SPOOL_CAP_BYTES, 30e9)
    assert.equal(PRELOAD_BUDGET_BYTES, 28e9)
    assert.equal(DISK_FLOOR_BYTES, 30e9)
  })
})

// ── 3. The time window ──────────────────────────────────────────────────

describe('the 01:00–06:00 window', () => {
  test('edges', () => {
    assert.equal(inPreloadWindow(new Date(at(0, 59))), false)
    assert.equal(inPreloadWindow(new Date(at(1, 0))), true)
    assert.equal(inPreloadWindow(new Date(at(5, 59))), true)
    assert.equal(inPreloadWindow(new Date(at(6, 0))), false)
    assert.equal(inPreloadWindow(new Date(at(14, 0))), false)
  })

  test('06:00 stops the night mid-list', async () => {
    const h = harness(five)
    h.deps.download = async (k, _u, _s, est) => { h.fetched.push(k); h.clock.set(h.clock.get() + 2.5 * 3600_000); return { kind: 'landed', bytes: est } }
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1), key(2)], '02:00 → 04:30 → 07:00')
    assert.equal(r.stoppedBy, 'window')
    assert.match(h.log.at(-1)!, /stopped: 06:00/)
  })

  test('06:00 arriving mid-download aborts it', async () => {
    const h = harness(five)
    h.deps.download = (k, _u, signal) => new Promise((resolve) => {
      h.fetched.push(k)
      h.clock.set(at(6, 1))
      signal.addEventListener('abort', () => resolve({ kind: 'aborted' }))
    })
    const r = await runPreloadNight(h.deps)
    assert.equal(r.stoppedBy, 'window')
    assert.deepEqual(h.fetched, [key(1)])
  })

  test('the scheduler runs once per night, only inside the window, and right away on launch', async () => {
    let t = at(0, 30)
    let runs = 0
    const sched = await scheduleOvernightPreload({
      isThinLink: async () => true,
      night: async () => ({}) as NightDeps,
      run: async () => { runs++; return {} as never },
      now: () => t,
      setInterval: () => 1,
      clearInterval: () => undefined,
    })
    assert.ok(sched)
    await sched.tick()
    assert.equal(runs, 0, '00:30 is outside the window')
    t = at(1, 5); await sched.tick()
    assert.equal(runs, 1)
    t = at(3, 0); await sched.tick()
    assert.equal(runs, 1, 'one run per night')
    t = at(1, 5, 21); await sched.tick()
    assert.equal(runs, 2, 'next night runs again')

    let launchRuns = 0
    await scheduleOvernightPreload({
      isThinLink: async () => true, night: async () => ({}) as NightDeps,
      run: async () => { launchRuns++; return {} as never },
      now: () => at(4, 0), setInterval: () => 1,
    })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(launchRuns, 1, 'launching inside the window starts the night')
  })
})

// ── 4. Yielding to playback ─────────────────────────────────────────────

describe('playback always wins', () => {
  test('music playing at the start: no download until it has been off for the quiet period', async () => {
    let playing = true
    let sleeps = 0
    const h = harness(five.slice(0, 1))
    h.deps.isPlaying = () => playing
    h.deps.sleep = async (ms) => { h.clock.set(h.clock.get() + ms); if (++sleeps === 4) playing = false }
    h.deps.download = async (k, _u, _s, est) => {
      assert.equal(playing, false, 'never downloads while music plays')
      h.fetched.push(k)
      return { kind: 'landed', bytes: est }
    }
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1)])
    // Last poll that saw music: +3 s. Quiet period 3 s → first download at +6 s.
    assert.equal(sleeps, 6, 'waited out the quiet period after the music stopped')
    assert.equal(r.pausedForPlaybackMs, 6_000)
    assert.ok(h.log.some((l) => /paused between tracks/.test(l)))
  })

  test('music starting mid-download aborts it, and the same track is fetched again later', async () => {
    let playing = false
    let calls = 0
    const h = harness(five.slice(0, 2))
    h.deps.isPlaying = () => playing
    h.deps.sleep = async (ms) => { h.clock.set(h.clock.get() + ms); playing = false }
    h.deps.download = (k, _u, signal, est) => new Promise<PreloadOutcome>((resolve) => {
      h.fetched.push(k)
      if (calls++ > 0) return resolve({ kind: 'landed', bytes: est })
      setTimeout(() => { playing = true }, 3)
      signal.addEventListener('abort', () => resolve({ kind: 'aborted' }))
    })
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1), key(1), key(2)])
    assert.equal(r.loaded, 2)
    assert.equal(r.stoppedBy, 'complete')
  })

  test('music still playing at 06:00 ends the night as "playback"', async () => {
    const h = harness(five)
    h.deps.isPlaying = () => true
    const r = await runPreloadNight(h.deps)
    assert.equal(r.stoppedBy, 'playback')
    assert.deepEqual(h.fetched, [])
  })

  test('a busy spool slot (a playing song\'s own spool) is waited out, not skipped', async () => {
    const outcomes: PreloadOutcome[] = [{ kind: 'busy' }, { kind: 'busy' }]
    const h = harness(five.slice(0, 1))
    h.deps.download = async (k, _u, _s, est) => { h.fetched.push(k); return outcomes.shift() ?? { kind: 'landed', bytes: est } }
    const r = await runPreloadNight(h.deps)
    assert.deepEqual(h.fetched, [key(1), key(1), key(1)])
    assert.equal(r.loaded, 1)
  })
})

// ── 5. The pre-loaded key is the key playback asks for ──────────────────

describe('pre-load keys match what playback requests', () => {
  const entry = (t: PreloadTrack): PlanEntry => ({ streamId: t.id, track: t, tier: 'recent-add' })

  for (const codec of ['alac', 'aac', 'aac-256', undefined]) {
    test(`codec ${codec ?? '(none)'}: same URL + spool key as fetchAudioFromHomemini on a thin link, wantFlac or not`, () => {
      const t = trk(4321, { codec })
      const pre = preloadTarget(BASE, 256, entry(t))
      for (const wantFlac of [true, false]) {
        const play = homeminiStreamTarget(BASE, 4321, { compressed: true, kbps: 256, wantFlac })
        assert.equal(pre.spoolKey, play.spoolKey)
        assert.equal(pre.url, play.url)
      }
      assert.equal(pre.spoolKey, '4321-aac256')
      assert.equal(pre.url, `${BASE}/4321?fmt=aac&kbps=256`)
    })
  }

  test('a marker asking for another bitrate keys that bitrate', () => {
    assert.equal(preloadTarget(BASE, 192, entry(trk(7))).spoolKey, '7-aac192')
  })

  test('index.ts derives its spool key from the same function, and the pre-load is wired to the same base + marker', async () => {
    const idx = await readFile(join(import.meta.dirname, '../index.ts'), 'utf-8')
    const fn = idx.slice(idx.indexOf('async function fetchAudioFromHomemini'), idx.indexOf('const once = async'))
    assert.match(fn, /homeminiStreamTarget\(HOMEMINI_AUDIO_BASE, id, \{ compressed: compressed\.on, kbps: compressed\.kbps, wantFlac \}\)/)
    assert.match(fn, /spoolAwareServe\(join\(app\.getPath\('userData'\), SPOOL_DIR_NAME\), spoolKey, url, /)
    assert.match(fn, /spoolLimitsFor\(compressed\.on\)/, 'the thin-link cap + pins reach the playback spool')
    assert.match(idx, /startOvernightPreload\(\{ userData: app\.getPath\('userData'\), audioBase: HOMEMINI_AUDIO_BASE, isPlaying: \(\) => playbackActive, streamCompressed: readStreamCompressedCached/)
  })

  test('end to end: a pre-loaded track is served from local disk by the daytime path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-e2e-'))
    const body = Buffer.from(Array.from({ length: 30_000 }, (_, i) => i % 253))
    const asked: string[] = []
    const fetchFn = (async (url: string) => {
      asked.push(String(url))
      return new Response(body, { status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': String(body.length) } })
    }) as unknown as typeof fetch
    const h = harness([trk(77, { codec: 'alac' })], {
      spoolDir: dir,
      landedBytes: async (k) => (await spoolReady(dir, k))?.total ?? null,
      writePins: (keys) => writePreloadPins(dir, keys),
      download: (k, url, signal) => preloadSpool(dir, k, url, { fetchFn, paceBytesPerSec: 0, signal, stallMs: 2_000, headerTimeoutMs: 2_000, deadlineMs: 5_000, limits: spoolLimitsFor(true) }),
    })
    const r = await runPreloadNight(h.deps)
    assert.equal(r.loaded, 1)
    const play = homeminiStreamTarget(BASE, 77, { compressed: true, kbps: 256, wantFlac: true })
    assert.deepEqual(asked, [play.url])
    assert.deepEqual([...await readPreloadPins(dir)], [play.spoolKey])
    let liveProxyFetches = 0
    const res = await spoolAwareServe(dir, play.spoolKey, play.url, 'bytes=0-99', (async () => { liveProxyFetches++; throw new Error('no WAN') }) as unknown as typeof fetch)
    assert.ok(res, 'served without the WAN')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('X-JT-Audio-Source'), 'stream-spool')
    assert.equal(liveProxyFetches, 0)
  })
})

// ── 6. Pinned files survive eviction ────────────────────────────────────

describe('pinned pre-loads survive the cap pass', () => {
  async function spoolWith(names: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'preload-pins-'))
    let t = Date.now() / 1000 - 1000
    for (const n of names) {
      await writeFile(join(dir, `${n}.done`), Buffer.alloc(1000, 1))
      await writeFile(join(dir, `${n}.meta.json`), JSON.stringify({ contentType: 'audio/mp4', total: 1000 }))
      await utimes(join(dir, `${n}.done`), t, t)
      t += 100
    }
    return dir
  }
  const left = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((n) => n.endsWith('.done')).map((n) => n.slice(0, -5)).sort()

  test('thin link: the oldest PINNED file stays; unpinned ones make the room', async () => {
    const dir = await spoolWith(['pinned-old', 'daytime-old', 'daytime-new'])
    await writePreloadPins(dir, ['pinned-old'])
    await enforceSpoolCap(dir, 2000, true)
    assert.deepEqual(await left(dir), ['daytime-new', 'pinned-old'])
  })

  test('a daytime landing on a thin link can push out other daytime tracks, never a pin', async () => {
    const dir = await spoolWith(['p1', 'p2', 'day1'])
    await writePreloadPins(dir, ['p1', 'p2'])
    const fetchFn = (async () => new Response(Buffer.alloc(1000, 2), { status: 200, headers: { 'content-length': '1000' } })) as unknown as typeof fetch
    ensureSpool(dir, 'day2', 'http://h/day2', fetchFn, 0, { capBytes: 3000, honorPins: true })
    for (let i = 0; i < 100 && !(await spoolReady(dir, 'day2')); i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(await left(dir), ['day2', 'p1', 'p2'])
  })

  test('fat link ignores even a stale pin file — oldest goes, exactly as before', async () => {
    const dir = await spoolWith(['pinned-old', 'daytime-old', 'daytime-new'])
    await writePreloadPins(dir, ['pinned-old'])
    await enforceSpoolCap(dir, 2000)
    assert.deepEqual(await left(dir), ['daytime-new', 'daytime-old'])
  })

  test('limits: 30 GB + pins on a thin link, the old 6 GB without pins elsewhere', () => {
    assert.deepEqual(spoolLimitsFor(true), { capBytes: 30e9, honorPins: true })
    assert.deepEqual(spoolLimitsFor(false), { capBytes: 6 * 1024 ** 3, honorPins: false })
  })

  test('each night rewrites the pins: a track that fell off the list is evictable again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-repin-'))
    await writePreloadPins(dir, ['1-aac256', '2-aac256'])
    const h = harness([trk(2)], { spoolDir: dir, writePins: (keys) => writePreloadPins(dir, keys) })
    await runPreloadNight(h.deps)
    assert.deepEqual([...await readPreloadPins(dir)], ['2-aac256'])
    assert.ok((await stat(join(dir, PRELOAD_PINS_FILE))).size > 0)
  })
})

// ── preloadSpool: the shared slot ────────────────────────────────────────

describe('preloadSpool', () => {
  const opts = { paceBytesPerSec: 0, stallMs: 2_000, headerTimeoutMs: 2_000, deadlineMs: 5_000, limits: spoolLimitsFor(true) }

  test('never takes the slot from a playback spool — "busy"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-busy-'))
    let release = (): void => {}
    const hold = (async () => {
      await new Promise<void>((r) => { release = r })
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-length': '1' } })
    }) as unknown as typeof fetch
    ensureSpool(dir, 'playing', 'http://h/playing', hold)
    await new Promise((r) => setTimeout(r, 10))
    const out = await preloadSpool(dir, 'night', 'http://h/night', { ...opts, fetchFn: hold })
    assert.deepEqual(out, { kind: 'busy' })
    release()
    for (let i = 0; i < 50 && spoolQueueState().active > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(spoolQueueState(), { active: 0, waiting: 0 })
  })

  test('404 = missing (not a link failure); 503 = failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-http-'))
    const status = (s: number) => (async () => new Response('nope', { status: s })) as unknown as typeof fetch
    assert.deepEqual(await preloadSpool(dir, 'a', 'http://h/a', { ...opts, fetchFn: status(404) }), { kind: 'missing', status: 404 })
    const failed = await preloadSpool(dir, 'b', 'http://h/b', { ...opts, fetchFn: status(503) })
    assert.equal(failed.kind, 'failed')
  })

  test('aborting mid-body leaves no .part and no landed file, and frees the slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-abort-'))
    const ac = new AbortController()
    const slow = (async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(100)); init.signal?.addEventListener('abort', () => c.error(new Error('aborted'))) },
      })
      return new Response(body, { status: 200, headers: { 'content-length': '1000' } })
    }) as unknown as typeof fetch
    setTimeout(() => ac.abort(), 20)
    const out = await preloadSpool(dir, 'x', 'http://h/x', { ...opts, fetchFn: slow, signal: ac.signal })
    assert.deepEqual(out, { kind: 'aborted' })
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('x.')), [])
    assert.deepEqual(spoolQueueState(), { active: 0, waiting: 0 })
  })

  test('a body that goes silent is a stall → failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preload-stall-'))
    const silent = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)) } }), { status: 200, headers: { 'content-length': '1000' } })) as unknown as typeof fetch
    const out = await preloadSpool(dir, 's', 'http://h/s', { ...opts, stallMs: 30, fetchFn: silent })
    assert.equal(out.kind, 'failed')
    assert.match((out as { reason: string }).reason, /stalled/)
    assert.equal(await spoolReady(dir, 's'), null)
  })
})

// ── 7. No marker = nothing at all ───────────────────────────────────────

describe('a machine without the stream-compressed marker', () => {
  test('the scheduler returns null: no timer, no night, no download', async () => {
    let intervals = 0
    let nights = 0
    const sched = await scheduleOvernightPreload({
      isThinLink: async () => false,
      night: async () => { nights++; return {} as NightDeps },
      run: async () => { throw new Error('must not run') },
      now: () => at(2, 0),
      setInterval: () => { intervals++; return 1 },
    })
    assert.equal(sched, null)
    assert.equal(intervals, 0)
    assert.equal(nights, 0)
  })

  test('startOvernightPreload reads nothing past the marker — not the library, not the playlists', async () => {
    let reads = 0
    const host = {
      userData: '/nowhere',
      audioBase: BASE,
      isPlaying: () => false,
      streamCompressed: async () => ({ on: false, kbps: 256 }),
      isStreamingClient: async () => { reads++; return true },
      library: async () => { reads++; return { tracks: [] } },
      playlists: async () => { reads++; return [] },
      playEventsPath: '/nowhere/play-events.jsonl',
    }
    assert.equal(await startOvernightPreload(host), null)
    assert.equal(reads, 0)
  })

  test('a marker on a machine that does not stream from homemini also stays idle', async () => {
    const host = {
      userData: '/nowhere', audioBase: BASE, isPlaying: () => false,
      streamCompressed: async () => ({ on: true, kbps: 256 }),
      isStreamingClient: async () => false,
      library: async () => { throw new Error('must not read') },
      playlists: async () => { throw new Error('must not read') },
      playEventsPath: '/nowhere/play-events.jsonl',
    }
    assert.equal(await startOvernightPreload(host), null)
  })

  test('the marker is read the way playback reads it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'preload-home-'))
    assert.deepEqual(await readStreamCompressed(home), { on: false, kbps: 256 })
    await mkdir(join(home, '.config/jaketunes'), { recursive: true })
    await writeFile(join(home, '.config/jaketunes/stream-compressed'), '')
    assert.deepEqual(await readStreamCompressed(home), { on: true, kbps: 256 })
    await writeFile(join(home, '.config/jaketunes/stream-compressed'), '192\n')
    assert.deepEqual(await readStreamCompressed(home), { on: true, kbps: 192 })
  })
})
