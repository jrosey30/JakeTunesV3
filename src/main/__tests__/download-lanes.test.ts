/**
 * Brief 258 — Downloads you can trust (Record Shop Phase 5).
 *
 *  - Two lanes: a song never waits behind an album; each lane runs one job.
 *  - Cancel stops only its own job.
 *  - The waiting list is saved atomically, comes back after a restart in the
 *    same order, restarts the job that was mid-download, and never downloads
 *    a job main finished just before the quit.
 *  - Done when: a quit in the middle of three album saves loses nothing.
 *  - "7 of 12", and the one list: In progress, Done today, Needs you.
 *  - main's side: each job's cancel and rip error are its own; imports go one at a time.
 */
import { main, type Answer } from './download-lanes-window.ts'
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueue, getQueue, cancel, albumQueryId, trackQueryId, resetQueueForTests, restoreSavedQueue, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { createDownloadQueueStore } from '../download-queue-store.ts'
import {
  laneOf, nextInLane, toSavedJob, toSavedJobs, parseSavedQueue, restoreJobs, capSaved, pruneFinished, songProgressLine, landedCount,
  sectionOf, startOfDay, emptyQueueDoc, MAX_SAVED_JOBS, SAVED_QUEUE_VERSION, type SavedJob, type SavedQueueDoc,
} from '../../common/download-lanes.ts'
import { downloadsPanelRows, downloadsPanelSections } from '../../common/downloads-panel-model.ts'
import { runInJob, currentJob, cancelJobs, importOneAtATime, watchLanding } from '../streamrip-store/rip-jobs.ts'
import { waitFor } from './wait-for.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hang = (): Promise<Answer> => new Promise(() => { /* until canceled */ })
const album = (name: string, trackCount = 12): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'album', id: albumQueryId('Band', name), desc: name, artist: 'Band', album: name, trackCount })
const song = (title: string): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('Band', title), desc: title, artist: 'Band', title })
const job = (name: string) => getQueue().find((q) => (q.result.album ?? q.result.title) === name)
const names = () => getQueue().map((q) => q.result.album ?? q.result.title)
const finishAll = async () => { for (const res of main.inFlight.values()) res({ ok: false, error: 'canceled', outcome: 'canceled' }); await sleep(5) }

let dir = ''
beforeEach(async () => {
  await finishAll()
  resetQueueForTests()
  main.calls.length = 0; main.answers.clear(); main.canceled.length = 0; main.saved.length = 0
  main.running.most = { album: 0, song: 0, total: 0 }
  main.load = async () => null
  main.save = async (jobs) => { main.saved.push(jobs) }
  dir = await mkdtemp(join(tmpdir(), 'jt-lanes-'))
})
after(async () => { await finishAll() })

describe('two lanes', () => {
  it('a song does not wait behind an album', async () => {
    main.answers.set('Long Album', hang)
    enqueue(album('Long Album'))
    enqueue(song('Quick Song'))
    await waitFor(() => job('Quick Song')?.status === 'done', 'the song to finish')
    assert.equal(job('Long Album')!.status, 'downloading', 'the album is still going')
  })

  it('each lane runs one job at a time, so at most two at once', async () => {
    let releaseA: (a: Answer) => void = () => {}
    main.answers.set('Album A', () => new Promise<Answer>((r) => { releaseA = r }))
    for (const n of ['Album A', 'Album B', 'Album C']) enqueue(album(n))
    for (const n of ['Song 1', 'Song 2', 'Song 3']) enqueue(song(n))
    await waitFor(() => job('Song 3')?.status === 'done', 'the songs')
    assert.equal(job('Album B')!.status, 'queued', 'the second album waits for the first')
    assert.deepEqual(main.calls.filter((c) => c.opts.album).map((c) => c.what), ['Album A'])
    releaseA({ ok: true, imported: 12 })
    await waitFor(() => job('Album C')?.status === 'done', 'the albums')
    assert.deepEqual(main.calls.filter((c) => c.opts.album).map((c) => c.what), ['Album A', 'Album B', 'Album C'], 'albums keep their order')
    assert.equal(main.running.most.album, 1)
    assert.equal(main.running.most.song, 1)
    assert.equal(main.running.most.total, 2)
  })

  it('every job tells main its own id; Cancel stops only that job', async () => {
    main.answers.set('Big Album', hang); main.answers.set('Slow Song', hang)
    enqueue(album('Big Album')); enqueue(song('Slow Song'))
    await waitFor(() => main.calls.length === 2, 'both to start')
    const a = job('Big Album')!, s = job('Slow Song')!
    assert.ok(a.armId && s.armId && a.armId !== s.armId)
    assert.deepEqual(main.calls.map((c) => c.jobId).sort(), [a.armId, s.armId].sort())
    await cancel(s.key)
    assert.deepEqual(main.canceled, [s.armId])
    await sleep(10)
    assert.equal(job('Slow Song')!.status, 'canceled')
    assert.equal(job('Big Album')!.status, 'downloading', 'the album lane keeps going')
  })

  it('an album shows its songs landing, "7 of 12", from main', async () => {
    main.answers.set('Twelve', hang)
    enqueue(album('Twelve', 12))
    await waitFor(() => job('Twelve')?.status === 'downloading', 'the album to start')
    const it = job('Twelve')!
    assert.deepEqual(it.progress, { have: 0, of: 12 })
    main.progress!({ jobId: 'someone-else', have: 3, of: 9 })
    assert.deepEqual(job('Twelve')!.progress, { have: 0, of: 12 }, 'another job’s count is not this one’s')
    main.progress!({ jobId: it.armId!, have: 7, of: 12 })
    const row = downloadsPanelRows(getQueue(), Date.now()).find((r) => r.key === it.key)!
    assert.equal(row.progress, '7 of 12')
  })

  it('lane rules', () => {
    assert.equal(laneOf({ mediaType: 'album' }), 'album')
    assert.equal(laneOf({ mediaType: 'track' }), 'song')
    assert.equal(laneOf({ mediaType: 'playlist' }), 'song')
    const q = [
      { status: 'done', result: { mediaType: 'album' }, n: 0 },
      { status: 'queued', result: { mediaType: 'track' }, n: 1 },
      { status: 'queued', result: { mediaType: 'album' }, n: 2 },
      { status: 'queued', result: { mediaType: 'album' }, n: 3 },
    ]
    assert.equal(nextInLane(q, 'album')?.n, 2)
    assert.equal(nextInLane(q, 'song')?.n, 1)
  })
})

describe('the saved list', () => {
  const now = new Date(2026, 10, 20, 15, 0, 0).getTime()
  const today = now - 3600_000
  const yesterday = startOfDay(now) - 3600_000
  const j = (key: string, status: SavedJob['status'], extra: Record<string, unknown> = {}): SavedJob => ({ key, result: { mediaType: key.startsWith('a') ? 'album' : 'track', desc: key }, status, armId: `arm-${key}`, ...extra })

  it('a job goes to disk with its saved fields only', () => {
    const s = toSavedJob({ key: 'k', status: 'queued', armId: 'x', result: { mediaType: 'album', clickedAt: 5, album: 'A' }, preflight: 'asking', progress: { have: 1, of: 2 }, logged: true })!
    assert.deepEqual(s, { key: 'k', status: 'queued', armId: 'x', result: { mediaType: 'album', album: 'A' } })
    assert.equal(toSavedJob({ key: 'k', status: 'weird', result: {} }), null)
    assert.equal(toSavedJobs([{ nope: 1 }, { key: 'k', status: 'done', result: {} }]).length, 1)
  })

  it('a foreign or newer file is not read as a list', () => {
    assert.equal(parseSavedQueue(null), null)
    assert.equal(parseSavedQueue({ version: SAVED_QUEUE_VERSION + 1, jobs: [] }), null)
    assert.equal(parseSavedQueue({ version: SAVED_QUEUE_VERSION }), null)
    const d = parseSavedQueue({ version: SAVED_QUEUE_VERSION, savedAt: 1, jobs: [j('a1', 'queued'), { bad: true }], finished: { x: { at: 1 }, y: 'no' } })!
    assert.equal(d.jobs.length, 1)
    assert.deepEqual(Object.keys(d.finished), ['x'])
  })

  it('after a restart: the interrupted job first and restarted, the rest in order, old finished jobs let go', () => {
    const doc: SavedQueueDoc = {
      ...emptyQueueDoc(),
      jobs: [
        j('s0', 'done', { endedAt: yesterday }),
        j('s1', 'done', { endedAt: today }),
        j('a1', 'queued'),
        j('a0', 'downloading', { startedAt: today }),
        j('s2', 'queued'),
        j('a2', 'failed', { endedAt: yesterday, primary: 'Not on Qobuz' }),
        j('s3', 'canceled', { endedAt: yesterday }),
      ],
    }
    const back = restoreJobs(doc, now)
    assert.deepEqual(back.map((x) => x.key), ['a0', 's1', 'a1', 's2', 'a2'])
    assert.equal(back[0].status, 'queued')
    assert.equal(back[0].interrupted, true)
    assert.equal(back[0].startedAt, undefined)
  })

  it('a job main finished just before the quit is done, not downloaded again', () => {
    const doc: SavedQueueDoc = { ...emptyQueueDoc(), jobs: [j('a0', 'downloading'), j('a1', 'queued')], finished: { 'arm-a0': { at: today, imported: 11, dupes: 1, completion: '12 tracks' } } }
    const back = restoreJobs(doc, now)
    assert.equal(back.find((x) => x.key === 'a0')!.status, 'done')
    assert.equal(back.find((x) => x.key === 'a0')!.imported, 11)
    assert.equal(back.find((x) => x.key === 'a1')!.status, 'queued')
  })

  it('the list is capped, oldest finished first; the ledger keeps what the list names and the last day', () => {
    const many = Array.from({ length: MAX_SAVED_JOBS + 10 }, (_, i) => j(`s${i}`, 'done', { endedAt: today - (MAX_SAVED_JOBS + 10 - i) }))
    const capped = capSaved([...many, j('a-wait', 'queued')], now)
    assert.equal(capped.length, MAX_SAVED_JOBS)
    assert.ok(capped.some((x) => x.key === 'a-wait'))
    assert.ok(!capped.some((x) => x.key === 's0'), 'the oldest finished goes first')
    const f = pruneFinished({ 'arm-a': { at: 0 }, old: { at: 0 }, fresh: { at: now - 1000 } }, [j('a', 'downloading')], now)
    assert.deepEqual(Object.keys(f).sort(), ['arm-a', 'fresh'])
  })

  it('on disk: written atomically, newest wins, no temp files left, a bad file reads as empty', async () => {
    const path = join(dir, 'download-queue.json')
    let writes = 0
    const store = createDownloadQueueStore({ path, warn: () => {}, write: async (p, d) => { writes++; const { writeJsonAtomic } = await import('../atomic-write.ts'); await writeJsonAtomic(p, d, false) } })
    const saves = Array.from({ length: 20 }, (_, i) => store.saveJobs([j(`a${i}`, 'queued')]))
    await Promise.all(saves)
    await store.flush()
    const doc = JSON.parse(await readFile(path, 'utf-8')) as SavedQueueDoc
    assert.deepEqual(doc.jobs.map((x) => x.key), ['a19'])
    assert.ok(writes < 20, `saves were coalesced (${writes} writes)`)
    assert.deepEqual((await readdir(dir)).filter((f) => f !== 'download-queue.json'), [], 'no temp file left beside it')
    await store.markFinished('arm-a19', { imported: 3 })
    const again = createDownloadQueueStore({ path })
    assert.equal((await again.load()).finished['arm-a19'].imported, 3)
    await writeFile(path, '{"version":1,"jobs":[{"key"')   // a torn file (never written by us)
    const torn = createDownloadQueueStore({ path, warn: () => {} })
    assert.deepEqual((await torn.load()).jobs, [])
  })
})

describe('done when: a quit in the middle of three album saves loses nothing', () => {
  it('the same jobs come back, in order, the interrupted one restarted', async () => {
    const path = join(dir, 'download-queue.json')
    const store = createDownloadQueueStore({ path })
    main.save = (jobs) => store.saveJobs(jobs)
    for (const n of ['First Album', 'Second Album', 'Third Album']) main.answers.set(n, hang)
    enqueue(album('First Album', 9)); enqueue(album('Second Album', 12)); enqueue(album('Third Album', 10))
    await waitFor(() => job('First Album')?.status === 'downloading', 'the first album to start')
    const firstArm = job('First Album')!.armId
    main.progress!({ jobId: firstArm!, have: 4, of: 9 })
    await sleep(5); await store.flush()

    // The quit: the app's memory goes; only the file is left.
    resetQueueForTests({ restored: false })
    main.inFlight.clear(); main.calls.length = 0; main.answers.clear()
    for (const n of ['First Album', 'Second Album', 'Third Album']) main.answers.set(n, hang)
    const reopened = createDownloadQueueStore({ path })
    await restoreSavedQueue(await reopened.load())

    assert.deepEqual(names(), ['First Album', 'Second Album', 'Third Album'])
    await waitFor(() => main.calls.length === 1, 'the interrupted album to start again')
    assert.equal(main.calls[0].what, 'First Album', 'the interrupted job starts again first')
    assert.equal(job('First Album')!.status, 'downloading')
    assert.notEqual(job('First Album')!.armId, firstArm, 'a fresh arm: nothing of the half download is reused')
    assert.deepEqual(job('First Album')!.progress, { have: 0, of: 9 }, 'from nothing')
    assert.equal(job('Second Album')!.status, 'queued')
    assert.equal(job('Third Album')!.status, 'queued')
    assert.equal(job('Second Album')!.result.trackCount, 12, 'the edition rides along')
  })

  it('an album that finished just before the quit is not downloaded again', async () => {
    const path = join(dir, 'download-queue.json')
    const store = createDownloadQueueStore({ path })
    main.save = (jobs) => store.saveJobs(jobs)
    let finish: (a: Answer) => void = () => {}
    main.answers.set('Just Done', () => new Promise<Answer>((r) => { finish = r }))
    main.answers.set('Still Waiting', hang)
    enqueue(album('Just Done')); enqueue(album('Still Waiting'))
    await waitFor(() => job('Just Done')?.status === 'downloading', 'it to start')
    await store.flush()
    // main imported it and noted it in its ledger; the app quit before the renderer saved "done".
    await store.markFinished(job('Just Done')!.armId!, { imported: 12, dupes: 0, completion: '12 tracks' })
    await store.flush()
    void finish

    resetQueueForTests({ restored: false })
    main.inFlight.clear(); main.calls.length = 0
    const reopened = createDownloadQueueStore({ path })
    await restoreSavedQueue(await reopened.load())
    assert.equal(job('Just Done')!.status, 'done')
    assert.equal(job('Just Done')!.imported, 12)
    await waitFor(() => main.calls.length === 1, 'the next album')
    assert.deepEqual(main.calls.map((c) => c.what), ['Still Waiting'], 'the finished album is not downloaded twice')
  })

  it('nothing is saved before the saved list is read back, so a fresh start never overwrites it', async () => {
    resetQueueForTests({ restored: false })
    enqueue(song('Clicked Early'))
    await sleep(10)
    assert.equal(main.saved.length, 0)
    assert.equal(main.calls.length, 0, 'and nothing starts before the saved order is known')
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [{ key: 'old', status: 'queued', result: { mediaType: 'track', kind: 'query', source: 'qobuz', id: 'old', desc: 'Old Song', title: 'Old Song', artist: 'Band' } }] })
    assert.deepEqual(names(), ['Old Song', 'Clicked Early'])
    await waitFor(() => main.saved.length > 0, 'a save')
  })
})

describe('the one list', () => {
  const now = new Date(2026, 10, 20, 15, 0, 0).getTime()
  it('In progress, Done today, Needs you — in that order', () => {
    assert.equal(sectionOf({ status: 'downloading' }, now), 'inProgress')
    assert.equal(sectionOf({ status: 'queued' }, now), 'inProgress')
    assert.equal(sectionOf({ status: 'refused', groupInFlight: 2 }, now), 'inProgress')
    assert.equal(sectionOf({ status: 'failed' }, now), 'needsYou')
    assert.equal(sectionOf({ status: 'refused' }, now), 'needsYou')
    assert.equal(sectionOf({ status: 'done', endedAt: now - 1000 }, now), 'doneToday')
    assert.equal(sectionOf({ status: 'canceled', endedAt: now - 1000 }, now), 'doneToday')
    assert.equal(sectionOf({ status: 'done', endedAt: startOfDay(now) - 1 }, now), null)

    const q = [
      { key: 'f', status: 'failed' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'f', desc: 'F', artist: 'Band', album: 'F' }, primary: 'Not on Qobuz', endedAt: now - 10 },
      { key: 'd', status: 'done' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'track', id: 'd', desc: 'D', artist: 'Band', title: 'D' }, imported: 1, endedAt: now - 5 },
      { key: 'g', status: 'downloading' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'g', desc: 'G', artist: 'Band', album: 'G', trackCount: 12 }, startedAt: now - 3000, progress: { have: 7, of: 12 } },
      { key: 'old', status: 'done' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'track', id: 'old', desc: 'Old', artist: 'Band', title: 'Old' }, endedAt: startOfDay(now) - 5 },
    ]
    const sections = downloadsPanelSections(downloadsPanelRows(q, now), now)
    assert.deepEqual(sections.map((s) => [s.title, s.rows.map((r) => r.key)]), [['In progress', ['g']], ['Done today', ['d']], ['Needs you', ['f']]])
    assert.equal(sections[0].rows[0].progress, '7 of 12')
    assert.deepEqual(sections[2].rows[0].needsYou, { kind: 'failed', line: 'Not on Qobuz' })
    assert.equal(sections[1].rows[0].needsYou, null)
  })

  it('"7 of 12": a count only for an album, held between 0 and its size, never going back', () => {
    assert.equal(songProgressLine({ have: 7, of: 12 }), '7 of 12')
    assert.equal(songProgressLine({ have: 15, of: 12 }), '12 of 12')
    assert.equal(songProgressLine({ have: 1, of: 1 }), null)
    assert.equal(songProgressLine(null), null)
    const a = new Map([['1.flac', 100], ['2.flac', 50]])
    const b = new Map([['1.flac', 100], ['2.flac', 90], ['3.flac', 10]])
    assert.equal(landedCount(new Map(), a, 0, 12), 0, 'a first look proves nothing')
    assert.equal(landedCount(a, b, 0, 12), 1, 'only the file that held still')
    assert.equal(landedCount(b, new Map(), 1, 12), 1, 'a wiped folder never counts down mid-job')
    assert.equal(landedCount(b, b, 0, 2), 2, 'never more than the album')
  })
})

describe('main: each job is its own', () => {
  it('cancel and the last rip error belong to one job; the other lane is untouched', async () => {
    let seenA = false, seenB = false
    const killedA: string[] = []
    const a = runInJob('job-a', 12, undefined, async () => {
      currentJob().procs.add({ kill: () => { killedA.push('a'); return true } })
      currentJob().lastStageFailure = 'A failed'
      await sleep(20)
      seenA = currentJob().canceled
      return currentJob().lastStageFailure
    })
    const b = runInJob('job-b', null, undefined, async () => {
      await sleep(5)
      currentJob().lastStageFailure = 'B failed'
      await sleep(20)
      seenB = currentJob().canceled
      return currentJob().lastStageFailure
    })
    await sleep(2)
    assert.equal(cancelJobs('job-a'), 1)
    const [la, lb] = await Promise.all([a, b])
    assert.equal(seenA, true); assert.equal(seenB, false)
    assert.deepEqual(killedA, ['a'])
    assert.equal(la, 'A failed'); assert.equal(lb, 'B failed')
    assert.equal(currentJob().canceled, false, 'outside any job: never canceled')
  })

  it('imports from the two lanes go one after the other', async () => {
    const order: string[] = []
    let inside = 0, most = 0
    const imp = (n: string, ms: number) => importOneAtATime(async () => { inside++; most = Math.max(most, inside); order.push(`${n}+`); await sleep(ms); order.push(`${n}-`); inside--; if (n === 'boom') throw new Error('x'); return n })
    const r = await Promise.allSettled([imp('album', 20), imp('boom', 1), imp('song', 1)])
    assert.equal(most, 1)
    assert.deepEqual(order, ['album+', 'album-', 'boom+', 'boom-', 'song+', 'song-'])
    assert.equal(r[2].status, 'fulfilled', 'a failed import never blocks the next')
  })

  it('an album rip reports songs as they land', async () => {
    const stage = join(dir, 'stage', 'Disc 1')
    await mkdir(stage, { recursive: true })
    const seen: Array<[number, number]> = []
    await runInJob('job-c', 3, (h, o) => { seen.push([h, o]) }, async () => {
      const stop = watchLanding(join(dir, 'stage'), 15)
      await writeFile(join(stage, '01.flac'), 'x'.repeat(100))
      await writeFile(join(stage, 'cover.jpg'), 'x')
      await waitFor(() => seen.some(([h]) => h === 1), 'one song landed')
      await writeFile(join(stage, '02.flac'), 'x'.repeat(100))
      await waitFor(() => seen.some(([h]) => h === 2), 'two songs landed')
      stop()
    })
    assert.deepEqual(seen[0], [0, 3])
    assert.ok(seen.every(([h, o]) => o === 3 && h <= 2))
    // A song job reports nothing.
    const none: number[] = []
    await runInJob('job-d', null, (h) => { none.push(h) }, async () => { watchLanding(dir, 15)(); })
    assert.deepEqual(none, [])
    await rm(join(dir, 'stage'), { recursive: true, force: true })
  })
})
