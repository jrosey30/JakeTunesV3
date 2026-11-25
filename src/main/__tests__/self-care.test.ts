/**
 * V7: the library looks after itself. The nightly check (self-care.ts, rules in
 * self-care-core.ts): when it may run, that music or a sync stops it, that it
 * picks up where it stopped, that each job does nothing the second time, and
 * that it runs at background priority.
 */
import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, symlink, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analysisCandidates, fieldsToWrite, isAppTempFile, jobsFor, overrideHash, overrideNeedsWrite, parseStatus, pruneBrake, selfCareGate,
  OVERDUE_MS, QUIET_MS, SELF_CARE_JOBS, TEMP_MIN_AGE_MS, type SelfCareJob, type SelfCareStatus,
} from '../self-care-core.ts'
import { createSelfCare, type JobRunner, type SelfCareHost } from '../self-care.ts'
import { runTagJob, type TagJobHost } from '../self-care-overrides.ts'
import { removeAppTempFiles } from '../self-care-files.ts'

const H = 3_600_000
const NIGHT = new Date(2026, 10, 24, 3, 0, 0).getTime()   // 03:00 local
const quietNight = { now: NIGHT, hour: 3, lastRunAt: null, playing: false, lastMusicAt: NIGHT - QUIET_MS - 1, syncInFlight: false }

describe('the gate: music and syncs always win', () => {
  it('runs on a quiet night that has not been checked', () => {
    assert.deepEqual(selfCareGate(quietNight), { run: true })
  })
  it('never while music plays, never within ten minutes of it, never during a sync', () => {
    assert.deepEqual(selfCareGate({ ...quietNight, playing: true }), { run: false, why: 'playing' })
    assert.deepEqual(selfCareGate({ ...quietNight, lastMusicAt: NIGHT - QUIET_MS + 1000 }), { run: false, why: 'recent-music' })
    assert.deepEqual(selfCareGate({ ...quietNight, syncInFlight: true }), { run: false, why: 'sync' })
  })
  it('once a day: a finished check waits', () => {
    assert.deepEqual(selfCareGate({ ...quietNight, lastRunAt: NIGHT - 2 * H }), { run: false, why: 'not-due' })
  })
  it('only at night, unless two days have passed (a laptop closed every night)', () => {
    const noon = { ...quietNight, hour: 12 }
    assert.deepEqual(selfCareGate({ ...noon, lastRunAt: NIGHT - 30 * H }), { run: false, why: 'outside-window' })
    assert.deepEqual(selfCareGate({ ...noon, lastRunAt: NIGHT - OVERDUE_MS - 1 }), { run: true })
    assert.deepEqual(selfCareGate({ ...noon, playing: true, lastRunAt: null }), { run: false, why: 'playing' })
  })
})

test('a replica only prunes its own play cache; the hub runs every job', () => {
  assert.deepEqual(jobsFor(false), [...SELF_CARE_JOBS])
  assert.deepEqual(jobsFor(true), ['play-cache'])
})

function rig(over: Partial<SelfCareHost> = {}) {
  let stored: string | null = null
  const ran: SelfCareJob[] = []
  const log: string[] = []
  const state = { now: NIGHT, playing: false, sync: false }
  const job = (name: SelfCareJob): JobRunner => async () => { ran.push(name); return { ok: true, note: 'fine' } }
  const jobs = Object.fromEntries(SELF_CARE_JOBS.map((j) => [j, job(j)])) as Record<SelfCareJob, JobRunner>
  const host: SelfCareHost = {
    now: () => state.now, hour: () => new Date(state.now).getHours(),
    playing: () => state.playing, lastMusicAt: () => NIGHT - QUIET_MS - 1, syncInFlight: () => state.sync,
    isReplica: async () => false,
    readStatus: async () => stored, writeStatus: async (s: SelfCareStatus) => { stored = JSON.stringify(s) },
    jobs, log: (m) => log.push(m),
    ...over,
  }
  return { host, ran, log, state, jobs, stored: () => parseStatus(stored) }
}

describe('the runner', () => {
  it('runs every job in order, once, and a second look the same night runs nothing', async () => {
    const r = rig()
    const care = createSelfCare(r.host)
    assert.equal(await care.tick(), 'done')
    assert.deepEqual(r.ran, [...SELF_CARE_JOBS])
    r.state.now += 10 * 60_000
    assert.equal(await care.tick(), 'held')
    assert.equal(r.ran.length, SELF_CARE_JOBS.length)
    assert.ok(r.stored().lastRunAt)
  })

  it('does not start while music plays', async () => {
    const r = rig()
    r.state.playing = true
    assert.equal(await createSelfCare(r.host).tick(), 'held')
    assert.deepEqual(r.ran, [])
  })

  it('music starting mid-check stops it before the next job; the next quiet look runs only the jobs left', async () => {
    const r = rig()
    r.jobs['file-sizes'] = async () => { r.ran.push('file-sizes'); r.state.playing = true; return { ok: true, note: '' } }
    const care = createSelfCare(r.host)
    assert.equal(await care.tick(), 'interrupted')
    assert.deepEqual(r.ran, ['play-cache', 'orphans', 'file-sizes'])
    r.state.playing = false
    r.state.now += 20 * 60_000
    assert.equal(await care.tick(), 'done')
    assert.deepEqual(r.ran, ['play-cache', 'orphans', 'file-sizes', 'overrides', 'ai-index', 'analysis'])
  })

  it('a sync starting stops it the same way', async () => {
    const r = rig()
    r.jobs.orphans = async () => { r.ran.push('orphans'); r.state.sync = true; return { ok: true, note: '' } }
    assert.equal(await createSelfCare(r.host).tick(), 'interrupted')
    assert.deepEqual(r.ran, ['play-cache', 'orphans'])
  })

  it('a job that stopped itself for music runs again next time', async () => {
    const r = rig()
    let first = true
    r.jobs.overrides = async () => { r.ran.push('overrides'); if (first) { first = false; return { ok: true, note: '', interrupted: true } } return { ok: true, note: '' } }
    const care = createSelfCare(r.host)
    assert.equal(await care.tick(), 'interrupted')
    assert.equal(await care.tick(), 'done')
    assert.deepEqual(r.ran.filter((j) => j === 'overrides').length, 2)
    assert.deepEqual(r.ran.filter((j) => j === 'play-cache').length, 1)
  })

  it('one failing job is logged and the rest still run', async () => {
    const r = rig()
    r.jobs.orphans = async () => { throw new Error('disk said no') }
    assert.equal(await createSelfCare(r.host).tick(), 'done')
    assert.equal(r.stored().jobs.orphans?.ok, false)
    assert.ok(r.log.some((l) => l.includes('[self-care] orphans failed') && l.includes('disk said no')))
    assert.ok(r.ran.includes('analysis'))
  })

  it('what needs Jake is kept for the Needs You list', async () => {
    const r = rig()
    r.jobs.orphans = async () => ({ ok: true, note: '', needsYou: { orphanFiles: 3, orphanBytes: 9e6 } })
    await createSelfCare(r.host).tick()
    assert.deepEqual(r.stored().needsYou, { orphanFiles: 3, orphanBytes: 9e6 })
  })

  it('on a replica it never touches the music files', async () => {
    const r = rig({ isReplica: async () => true })
    await createSelfCare(r.host).tick()
    assert.deepEqual(r.ran, ['play-cache'])
  })

  it('a garbled status file is a fresh start, never a crash', () => {
    assert.equal(parseStatus('{nope').lastRunAt, null)
    assert.equal(parseStatus(null).cycleStartedAt, null)
  })
})

describe('orphans: only the app\'s own leftovers are removed', () => {
  const now = NIGHT
  it('by name and age', () => {
    const old = now - TEMP_MIN_AGE_MS - 1
    assert.equal(isAppTempFile('.Song.m4a.tagwrite-0a1b2c3d.m4a', old, now), true)
    assert.equal(isAppTempFile('library.json.123.456.ab12.tmp', old, now), true)
    assert.equal(isAppTempFile('Song.m4a.compact.tmp', old, now), true)
    assert.equal(isAppTempFile('Song.m4a.compact.tmp', now - 60_000, now), false, 'a write may still be under way')
    assert.equal(isAppTempFile('GYUR.m4a', old, now), false, 'a song file is only shown to Jake')
    assert.equal(isAppTempFile('._GYUR.m4a', old, now), false)
    assert.equal(isAppTempFile('.Song.m4a.tagwrite-zz.m4a', old, now), false)
  })

  it('on disk: removes old leftovers, keeps songs and young leftovers, never walks a link, and the second run removes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'self-care-'))
    const outside = await mkdtemp(join(tmpdir(), 'self-care-vault-'))
    try {
      const f = join(root, 'F01')
      await mkdir(f)
      const old = new Date(Date.now() - TEMP_MIN_AGE_MS - H)
      for (const n of ['A.m4a', '.A.m4a.tagwrite-deadbeef.m4a', 'x.tmp', 'young.tmp']) await writeFile(join(f, n), 'x')
      await utimes(join(f, '.A.m4a.tagwrite-deadbeef.m4a'), old, old)
      await utimes(join(f, 'x.tmp'), old, old)
      await writeFile(join(outside, 'vault.tmp'), 'x')
      await utimes(join(outside, 'vault.tmp'), old, old)
      await symlink(outside, join(root, 'linked'))
      const first = await removeAppTempFiles(root, { now: Date.now(), stillQuiet: () => true, log: () => {} })
      assert.equal(first.removed, 2)
      assert.deepEqual((await readdir(f)).sort(), ['A.m4a', 'young.tmp'])
      assert.deepEqual(await readdir(outside), ['vault.tmp'], 'a linked folder is never walked')
      const second = await removeAppTempFiles(root, { now: Date.now(), stillQuiet: () => true, log: () => {} })
      assert.equal(second.removed, 0)
      const stopped = await removeAppTempFiles(root, { now: Date.now(), stillQuiet: () => false, log: () => {} })
      assert.equal(stopped.stopped, true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('play cache: the night never empties the cache on a short library read', () => {
  assert.equal(pruneBrake({ libraryTracks: 9700, entries: 4000, unclaimed: 120 }), null)
  assert.match(String(pruneBrake({ libraryTracks: 9700, entries: 4000, unclaimed: 3900 })), /would remove 3900 of 4000/)
  assert.match(String(pruneBrake({ libraryTracks: 12, entries: 4000, unclaimed: 0 })), /only 12 songs/)
})

test('tempo and key: never-measured songs, and failures only once a month', () => {
  const day = 86_400_000
  const rows = [
    { id: 1, path: ':a' },
    { id: 2, path: ':b', bpm: 120, audioAnalysisAt: NIGHT - day },
    { id: 3, path: ':c', audioAnalysisAt: NIGHT - day },
    { id: 4, path: ':d', audioAnalysisAt: String(NIGHT - 31 * day) },
    { id: 5 },
  ]
  assert.deepEqual(analysisCandidates(rows, NIGHT).map((r) => r.id), [1, 4])
})

describe('tags: a file is written only when it differs, and never twice', () => {
  test('numbers compare as numbers, words as words', () => {
    assert.deepEqual(fieldsToWrite({ trackNumber: 7, year: 1972, title: 'Reelin' }, { trackNumber: '07', year: '1972', title: 'Reelin' }), [])
    assert.deepEqual(fieldsToWrite({ title: 'Reelin', genre: 'Rock' }, { title: 'Reelin’ in the Years', genre: 'Rock' }), ['title'])
  })

  function tagHost(over: Partial<TagJobHost> = {}) {
    const files = new Map<string, Record<string, unknown>>([['/m/F01/A.m4a', { title: 'Old', genre: 'Rock' }], ['/m/F01/B.m4a', { title: 'Same' }]])
    let ledger: Record<string, string> = {}
    const writes: Array<[string, Record<string, unknown>]> = []
    const queued: unknown[] = []
    const host: TagJobHost = {
      tracks: async () => [{ id: 1, path: ':F01:A.m4a', title: 'Old', duration: 1000 }, { id: 2, path: ':F01:B.m4a', title: 'Same', duration: 1000 }],
      overrides: async () => ({ '1': { fields: { title: 'New', bpm: '120' } }, '2': { fields: { title: 'Same' } } }),
      playerUsing: () => false,
      queueEdit: async (e) => { queued.push(e) },
      toAbs: (c) => '/m' + c.replace(/:/g, '/'),
      readTags: async (abs) => files.get(abs) ?? null,
      writeTags: async (abs, f) => { writes.push([abs, f]); files.set(abs, { ...files.get(abs), ...f }); return { ok: true, written: Object.keys(f).length } },
      remeasure: async () => {},
      readLedger: async () => ({ ...ledger }),
      writeLedger: async (l) => { ledger = { ...l } },
      ...over,
    }
    return { host, writes, queued, ledger: () => ledger }
  }

  test('first night writes the one field that differs; the second writes nothing', async () => {
    const t = tagHost()
    const ctx = { stillQuiet: () => true }
    const one = await runTagJob(t.host, ctx)
    assert.deepEqual(t.writes, [['/m/F01/A.m4a', { title: 'New' }]], 'only the differing field, never an analysis field')
    assert.match(one.note, /1 written, 1 already right/)
    const two = await runTagJob(t.host, ctx)
    assert.equal(t.writes.length, 1)
    assert.match(two.note, /0 written, 2 already right/)
  })

  test('the second night doesn\'t even open a file it already wrote', async () => {
    const t = tagHost()
    let reads = 0
    const readTags = t.host.readTags
    t.host.readTags = async (abs) => { reads++; return readTags(abs) }
    await runTagJob(t.host, { stillQuiet: () => true })
    reads = 0
    await runTagJob(t.host, { stillQuiet: () => true })
    assert.equal(reads, 0)
  })

  test('the ledger alone says "already written", whatever the reader says', () => {
    const wanted = { title: 'New' }
    const hash = overrideHash(':F01:A.m4a', wanted)
    assert.deepEqual(overrideNeedsWrite({ ledgerHash: hash, hash, onFile: { title: 'Old' }, wanted }), [])
    assert.deepEqual(overrideNeedsWrite({ ledgerHash: undefined, hash, onFile: { title: 'Old' }, wanted }), ['title'])
    assert.deepEqual(overrideNeedsWrite({ ledgerHash: undefined, hash, onFile: null, wanted }), ['title'])
  })

  test('a reader that reports a field differently can\'t make it rewrite every night (the ledger)', async () => {
    const t = tagHost({ readTags: async () => ({ title: 'something the reader made up' }) })
    await runTagJob(t.host, { stillQuiet: () => true })
    await runTagJob(t.host, { stillQuiet: () => true })
    assert.equal(t.writes.filter(([p]) => p === '/m/F01/A.m4a').length, 1)
    assert.equal(t.ledger()['1'], overrideHash(':F01:A.m4a', { title: 'New' }))
  })

  test('an entry that names another song is never written', async () => {
    const t = tagHost({ overrides: async () => ({ '1': { fp: 'some other song|someone|999', fields: { genre: 'Jazz' } } }) })
    const r = await runTagJob(t.host, { stillQuiet: () => true })
    assert.equal(t.writes.length, 0)
    assert.match(r.note, /1 no longer that song/)
  })

  test('a song the player is using goes on the per-edit line, not written now', async () => {
    const t = tagHost({ playerUsing: (c) => c === ':F01:A.m4a' })
    await runTagJob(t.host, { stillQuiet: () => true })
    assert.equal(t.writes.length, 0)
    assert.deepEqual(t.queued, [{ trackId: 1, field: 'title', value: 'New' }])
  })

  test('music starting stops it', async () => {
    const t = tagHost()
    const r = await runTagJob(t.host, { stillQuiet: () => false })
    assert.equal(t.writes.length, 0)
    assert.equal(r.interrupted, true)
  })
})

describe('background priority and wiring', () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8')
  const index = src('index.ts')

  test('the tag writer and its decode check run at background priority when the night asks', () => {
    const tw = src('tag-writer.ts')
    assert.match(tw, /background \? atBackgroundPriority\(PYTHON_CMD \?\? 'python3', \[script, audioFilePath\]\)/)
    assert.match(tw, /opts\.background \? \{ check: \(p\) => decodeCheck\(p, \{ background: true \}\) \}/)
    assert.match(src('audio-write-guard.ts'), /opts\.background \? atBackgroundPriority\(opts\.ffmpeg \?\? 'ffmpeg', args\)/)
    assert.match(index, /writeTagsToFile\(\{ audioFilePath: abs, overrides: fields \}, \{ background: true \}\)/)
  })

  test('tempo and key analysis runs at background priority', () => {
    assert.match(index, /spawn\(\.\.\.atBackgroundPriority\(PYTHON_CMD \?\? 'python3', \[scriptPath, \.\.\.paths\]\)/)
  })

  test('index.ts starts the check once, with the real gates and every job', () => {
    assert.equal((index.match(/startSelfCare\(\{/g) || []).length, 1)
    const at = index.indexOf('startSelfCare({')
    const wiring = index.slice(at, index.indexOf('\n  })\n', at))
    assert.match(wiring, /playing: \(\) => playbackActive, lastMusicAt: \(\) => musicSeenAt/)
    assert.match(wiring, /syncInFlight: \(\) => syncEngine\.isSyncInFlight\(\), isReplica: isHomeminiPlaybackClientCached/)
    for (const j of SELF_CARE_JOBS) assert.ok(wiring.includes(`'${j}':`) || wiring.includes(`\n      ${j}:`) || wiring.includes(` ${j}: `), `job ${j} wired`)
    assert.match(index, /playbackActive = !!active\n\s*musicSeenAt = Date\.now\(\)/)
    // The play cache prune runs with its brake; leftovers are removed only on a disk of this Mac's own.
    assert.match(wiring, /prunePlayCache\(true\)/)
    assert.match(wiring, /const refused = await localAudioDropRefused\(MUSIC_DIR\)\n\s*const temp = refused \? null : await removeAppTempFiles\(MUSIC_DIR/)
  })
})
