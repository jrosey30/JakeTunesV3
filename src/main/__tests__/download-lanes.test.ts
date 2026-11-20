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
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueue, getQueue, cancel, albumQueryId, trackQueryId, resetQueueForTests, restoreSavedQueue, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { createDownloadQueueStore } from '../download-queue-store.ts'
import {
  laneOf, nextInLane, toSavedJob, toSavedJobs, parseSavedQueue, restoreJobs, capSaved, pruneFinished, songProgressLine, landedCount, nextProgress, isNewerQueueFile,
  sectionOf, startOfDay, emptyQueueDoc, MAX_SAVED_JOBS, SAVED_QUEUE_VERSION, type SavedJob, type SavedQueueDoc,
} from '../../common/download-lanes.ts'
import { downloadsPanelRows, downloadsPanelSections } from '../../common/downloads-panel-model.ts'
import { runInJob, currentJob, cancelJobs, importOneAtATime, watchLanding, clearLanding, liveJobIds, sweepOrphanedStaging } from '../streamrip-store/rip-jobs.ts'
import { registerDownloadQueueStore } from '../download-queue-store.ts'
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
    main.progress!({ jobId: it.armId!, have: 2, of: 12 })
    assert.deepEqual(job('Twelve')!.progress, { have: 7, of: 12 }, 'a retry’s smaller count never shows')
    main.progress!({ jobId: it.armId!, have: 0, of: 12, reset: true })
    assert.deepEqual(job('Twelve')!.progress, { have: 0, of: 12 }, 'Bandcamp starts over')
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

  it('a refused album keeps its offers, the offer taken and its songs\' album group across a restart (Brief 257)', () => {
    const answer = { answer: 'no', why: 'edition', offers: [{ kind: 'songs-each', of: 12 }], asked: 'Deluxe', askedCount: 12 }
    const group = { parentKey: 'p', label: 'A', of: 12, position: 3, notAcquired: [], skippedOwned: 0 }
    const jobs = toSavedJobs([
      { key: 'p', status: 'failed', armId: 'x', result: { mediaType: 'album', album: 'A', lossyOk: true }, preflight: 'no', preflightAnswer: answer, offerTaken: 'songs-each', endedAt: 1 },
      { key: 's', status: 'queued', armId: 'y', result: { mediaType: 'track', title: 'T', offerOf: 'p', origin: { recommendationIds: [], group } }, fromMemory: true },
    ])
    const back = parseSavedQueue(JSON.parse(JSON.stringify({ version: SAVED_QUEUE_VERSION, savedAt: 1, jobs, finished: {} })))!
    assert.deepEqual(back.jobs[0].preflightAnswer, answer)
    assert.equal(back.jobs[0].offerTaken, 'songs-each')
    assert.equal(back.jobs[0].preflight, undefined)
    assert.equal((back.jobs[0].result as { lossyOk?: boolean }).lossyOk, true)
    assert.deepEqual((back.jobs[1].result as { origin: { group: unknown } }).origin.group, group)
    assert.equal((back.jobs[1].result as { offerOf?: string }).offerOf, 'p')
    assert.equal(back.jobs[1].fromMemory, true)
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

  it('a file from a newer app is left exactly as it is, and this app starts empty', async () => {
    const path = join(dir, 'download-queue.json')
    const newer = JSON.stringify({ version: SAVED_QUEUE_VERSION + 1, jobs: [{ key: 'future' }], somethingNew: true })
    await writeFile(path, newer)
    assert.equal(isNewerQueueFile(JSON.parse(newer)), true)
    assert.equal(isNewerQueueFile({ version: SAVED_QUEUE_VERSION }), false)
    let writes = 0
    const store = createDownloadQueueStore({ path, warn: () => {}, write: async () => { writes++ } })
    assert.deepEqual((await store.load()).jobs, [])
    await store.saveJobs([j('a1', 'queued')])
    await store.markFinished('arm-a1', { imported: 1 })
    await store.flush()
    assert.equal(writes, 0, 'never written')
    assert.equal(await readFile(path, 'utf-8'), newer, 'untouched')
  })

  it('a file that can’t be read right now is not an empty list: the load fails and is asked again', async () => {
    const path = join(dir, 'download-queue.json')
    await mkdir(path)   // EISDIR: a read error that isn't "not there"
    let writes = 0
    const store = createDownloadQueueStore({ path, warn: () => {}, write: async () => { writes++ } })
    await assert.rejects(store.load())
    await assert.rejects(store.saveJobs([j('a1', 'queued')]))
    assert.equal(writes, 0)
    await rm(path, { recursive: true })
    await writeFile(path, JSON.stringify({ version: SAVED_QUEUE_VERSION, savedAt: 1, jobs: [j('a7', 'queued')], finished: {} }))
    assert.deepEqual((await store.load()).jobs.map((x) => x.key), ['a7'], 'the next ask reads it')
  })

  it('main answers a load with who is running, read before the list', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const store = createDownloadQueueStore({ path: join(dir, 'q.json') })
    const order: string[] = []
    const origLoad = store.load
    store.load = () => { order.push('list'); return origLoad() }
    registerDownloadQueueStore({ handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } } as never, store, { liveJobs: () => { order.push('live'); return ['arm-x'] } })
    const d = await handlers.get('download-queue:load')!({}) as SavedQueueDoc
    assert.deepEqual(d.live, ['arm-x'])
    assert.deepEqual(order, ['live', 'list'])
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

  it('a load that fails (main not ready yet) is asked again; nothing is saved until one succeeds', async () => {
    resetQueueForTests({ restored: false, retryMs: 5 })
    let asks = 0
    const saved: SavedQueueDoc = { ...emptyQueueDoc(), jobs: [{ key: 'kept', status: 'queued', result: { mediaType: 'track', kind: 'query', source: 'qobuz', id: 'kept', desc: 'Kept Song', title: 'Kept Song', artist: 'Band' } }] }
    main.load = async () => { asks++; if (asks < 3) throw new Error('No handler registered for download-queue:load'); return saved }
    main.answers.set('Kept Song', hang)
    enqueue(song('Clicked Early'))
    const restoring = restoreSavedQueue()
    await sleep(2)
    assert.equal(main.saved.length, 0, 'a failed load never lets a save through')
    await restoring
    assert.equal(asks, 3)
    assert.deepEqual(names(), ['Kept Song', 'Clicked Early'], 'the saved list came back, not overwritten')
    await waitFor(() => main.saved.length > 0, 'a save, after the load')
    assert.ok(main.saved[0].some((x) => x.key === 'kept'))
  })

  it('a load that keeps failing lets the lanes run, still without saving', async () => {
    resetQueueForTests({ restored: false, retryMs: 1 })
    let ok = false
    main.load = async () => { if (!ok) throw new Error('down'); return null }
    enqueue(song('Meanwhile'))
    const restoring = restoreSavedQueue()
    await waitFor(() => job('Meanwhile')?.status === 'done', 'the song to download meanwhile')
    assert.equal(main.saved.length, 0)
    ok = true
    await restoring
    await waitFor(() => main.saved.length > 0, 'saves once the list is back')
  })

  it('a download started while the list could not be read is not stopped when the list comes back', async () => {
    resetQueueForTests({ restored: false, retryMs: 1 })
    let ok = false
    main.load = async () => {
      if (!ok) throw new Error('down')
      const meanwhile = job('Started Meanwhile')!
      return { ...emptyQueueDoc(), jobs: [], live: [meanwhile.armId!] }
    }
    main.answers.set('Started Meanwhile', hang)
    enqueue(song('Started Meanwhile'))
    const restoring = restoreSavedQueue()
    await waitFor(() => job('Started Meanwhile')?.status === 'downloading', 'it to start meanwhile')
    ok = true
    await restoring
    assert.deepEqual(main.canceled, [], 'its own download is never stopped')
    assert.equal(job('Started Meanwhile')!.status, 'downloading')
    await finishAll()
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

  it('Brief 257: offers wait in Needs you; an offer taken leaves it, and its songs fold under the album', () => {
    const album = (key: string, extra: Record<string, unknown> = {}) => ({ key, status: 'failed' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: key, desc: key, artist: 'Band', album: key, trackCount: 3 }, outcome: 'exact-not-found', primary: 'Not on Qobuz', endedAt: now - 10, preflightAnswer: { answer: 'no' as const, why: 'missing' as const, offers: [{ kind: 'songs-each' as const, of: 3 }] }, ...extra })
    const song = (key: string, parentKey: string, position: number, status: 'queued' | 'done' | 'failed') => ({ key, status, result: { kind: 'query', source: 'qobuz', mediaType: 'track', id: key, desc: key, artist: 'Band', title: key, origin: { recommendationIds: [], group: { parentKey, label: parentKey, of: 3, position, notAcquired: [], skippedOwned: 0 } } }, endedAt: status === 'queued' ? undefined : now - 1 })
    const q = [
      album('offer'),
      album('songs', { offerTaken: 'songs-each' }), song('s1', 'songs', 1, 'done'), song('s2', 'songs', 2, 'queued'),
      album('edition', { offerTaken: 'edition' }),
      { key: 'ed2', status: 'queued' as const, result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'ed2', desc: 'ed2', artist: 'Band', album: 'ed2', offerOf: 'edition' } },
    ]
    const rows = downloadsPanelRows(q as Parameters<typeof downloadsPanelRows>[0], now)
    const sections = downloadsPanelSections(rows, now)
    assert.deepEqual(sections.map((s) => [s.title, s.rows.map((r) => r.key)]), [['In progress', ['ed2', 'songs']], ['Needs you', ['offer']]])
    assert.equal(sections[1].rows[0].offers.length, 1, 'the offer rides on the Needs you row')
    const songs = sections[0].rows.find((r) => r.key === 'songs')!
    assert.equal(songs.needsYou, null)
    assert.equal(songs.group?.line, '1 of 3 in your library · 1 on the way')
    // One song failed and nothing is left on the way: back in Needs you, with "Retry the 1 that failed".
    const q2 = [album('songs', { offerTaken: 'songs-each' }), song('s1', 'songs', 1, 'done'), song('s2', 'songs', 2, 'failed')]
    const s2 = downloadsPanelSections(downloadsPanelRows(q2 as Parameters<typeof downloadsPanelRows>[0], now), now)
    assert.deepEqual(s2.map((s) => [s.title, s.rows.map((r) => r.key)]), [['Needs you', ['songs']]])
    assert.ok(s2[0].rows[0].actions.includes('retryGroup'))
  })

  it('"7 of 12": a count only for an album, held between 0 and its size, never going back', () => {
    assert.equal(songProgressLine({ have: 7, of: 12 }), '7 of 12')
    assert.equal(songProgressLine({ have: 15, of: 12 }), '12 of 12')
    assert.equal(songProgressLine({ have: 1, of: 1 }), null)
    assert.equal(songProgressLine(null), null)
    const f = (size: number, mtimeMs: number) => ({ size, mtimeMs })
    const a = new Map([['1.flac', f(100, 1)], ['2.flac', f(50, 2)]])
    const b = new Map([['1.flac', f(100, 1)], ['2.flac', f(90, 3)], ['3.flac', f(10, 4)]])
    assert.equal(landedCount(new Map(), a, 0, 12), 0, 'a first look proves nothing')
    assert.equal(landedCount(a, b, 0, 12), 1, 'only the file that held still')
    assert.equal(landedCount(b, new Map(), 1, 12), 1, 'a wiped folder never counts down mid-job')
    const c = new Map([['1.flac', f(100, 1)], ['2.flac', f(90, 3)], ['3.flac', f(10, 4)], ['4.flac', f(5, 5)]])
    assert.equal(landedCount(c, c, 0, 3), 3, 'never more than the album')
  })

  it('"N of N" never shows while the last song is still arriving', () => {
    const f = (size: number, mtimeMs: number) => ({ size, mtimeMs })
    // Two songs of two: the second has paused between writes (same size twice) but is the newest file.
    const look = new Map([['1.flac', f(100, 1)], ['2.flac', f(40, 9)]])
    assert.equal(landedCount(look, look, 0, 2), 1, 'the newest file is still arriving: 1 of 2, not 2 of 2')
    assert.equal(landedCount(look, look, 0, 2, true), 2, 'the rip ended cleanly: now it is 2 of 2')
    const one = new Map([['1.flac', f(100, 1)]])
    assert.equal(landedCount(one, one, 0, 12), 0, 'a lone file counts when the next starts')
    const next = new Map([['1.flac', f(100, 1)], ['2.flac', f(3, 2)]])
    assert.equal(landedCount(one, next, 0, 12), 1)
  })

  it('the count on screen never goes back; a move to Bandcamp clears the Qobuz count', () => {
    assert.deepEqual(nextProgress({ have: 7, of: 12 }, { have: 3, of: 12 }), { have: 7, of: 12 })
    assert.deepEqual(nextProgress({ have: 7, of: 12 }, { have: 9, of: 12 }), { have: 9, of: 12 })
    assert.deepEqual(nextProgress({ have: 7, of: 12 }, { have: 0, of: 12, reset: true }), { have: 0, of: 12 })
    assert.deepEqual(nextProgress(undefined, { have: 2, of: 12 }), { have: 2, of: 12 })
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
      await sleep(60)
      assert.ok(!seen.some(([h]) => h === 1), 'the newest file may still be arriving: not counted yet')
      await sleep(5)
      await writeFile(join(stage, '02.flac'), 'x'.repeat(100))
      await waitFor(() => seen.some(([h]) => h === 1), 'one song landed once the next started')
      stop(true)
      await waitFor(() => seen.some(([h]) => h === 2), 'the rip ended: two songs landed')
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

describe('a window reload while main keeps a job going', () => {
  const albumJob = (name: string, armId: string, status: SavedJob['status']): SavedJob => ({ key: `qobuz|album|${albumQueryId('Band', name)}`, status, armId, result: { ...album(name) } })

  it('a job main is still importing is followed, never downloaded again', async () => {
    resetQueueForTests({ restored: false })
    main.answers.set('Next Album', hang)
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [albumJob('Importing', 'arm-imp', 'downloading'), albumJob('Next Album', 'arm-next', 'queued')], live: ['arm-imp'] })
    const it = job('Importing')!
    assert.equal(it.status, 'downloading')
    assert.equal(it.armId, 'arm-imp', 'the same arm: main’s job')
    await sleep(10)
    assert.equal(main.calls.length, 0, 'not started again, and the album lane waits for it')
    assert.deepEqual(main.canceled, [], 'and not stopped')
    main.ended!({ jobId: 'arm-imp', result: { ok: true, imported: 12, dupes: 0 } })
    assert.equal(job('Importing')!.status, 'done')
    assert.equal(job('Importing')!.imported, 12)
    await waitFor(() => main.calls.length === 1, 'the next album, once the lane is free')
    assert.equal(main.calls[0].what, 'Next Album')
  })

  it('a job the saved list still called queued, already started by main, is followed too', async () => {
    resetQueueForTests({ restored: false })
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [albumJob('Just Sent', 'arm-sent', 'queued')], live: ['arm-sent'] })
    assert.equal(job('Just Sent')!.status, 'downloading')
    await sleep(10)
    assert.equal(main.calls.length, 0)
    main.ended!({ jobId: 'arm-sent', result: { ok: false, error: 'nope', primary: 'Not on Qobuz' } })
    assert.equal(job('Just Sent')!.status, 'failed')
    assert.equal(job('Just Sent')!.primary, 'Not on Qobuz')
  })

  it('an end heard before the list came back is used, not a second download', async () => {
    resetQueueForTests({ restored: false })
    main.ended!({ jobId: 'arm-gap', result: { ok: true, imported: 9 } })
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [albumJob('Gap', 'arm-gap', 'downloading')], live: [] })
    assert.equal(job('Gap')!.status, 'done')
    assert.equal(job('Gap')!.imported, 9)
    await sleep(10)
    assert.equal(main.calls.length, 0)
  })

  it('a followed job whose end was lost: main’s ledger says done, or it starts again', async () => {
    resetQueueForTests({ restored: false, followMs: 10 })
    main.answers.set('Lost B', hang)
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [albumJob('Lost A', 'arm-la', 'downloading'), { key: 'song-lost-b', status: 'downloading', armId: 'arm-lb', result: { ...song('Lost B') } }], live: ['arm-la', 'arm-lb'] })
    assert.equal(job('Lost A')!.status, 'downloading')
    main.load = async () => ({ ...emptyQueueDoc(), finished: { 'arm-la': { at: Date.now(), imported: 4 } }, live: [] })
    await waitFor(() => job('Lost A')!.status === 'done', 'the ledger to answer')
    assert.equal(job('Lost A')!.imported, 4)
    await waitFor(() => main.calls.some((c) => c.what === 'Lost B'), 'the unfinished one to start again')
    assert.notEqual(job('Lost B')!.armId, 'arm-lb', 'with a fresh arm')
  })

  it('a job main runs that the list no longer names is stopped; one not running starts again', async () => {
    resetQueueForTests({ restored: false })
    main.answers.set('Restart Me', hang)
    await restoreSavedQueue({ ...emptyQueueDoc(), jobs: [albumJob('Restart Me', 'arm-old', 'downloading')], live: ['arm-stray'] })
    assert.deepEqual(main.canceled, ['arm-stray'])
    await waitFor(() => main.calls.length === 1, 'the restart')
    assert.notEqual(job('Restart Me')!.armId, 'arm-old')
  })
})

describe('main: the count and the boot sweep', () => {
  it('two rips of one job: the count never goes back; Bandcamp clears it', async () => {
    const seen: Array<[number, number, boolean]> = []
    const s1 = join(dir, 'r1'), s2 = join(dir, 'r2')
    await mkdir(s1); await mkdir(s2)
    await runInJob('job-max', 4, (h, o, reset) => { seen.push([h, o, Boolean(reset)]) }, async () => {
      assert.ok(liveJobIds().includes('job-max'))
      let stop = watchLanding(s1, 10)
      await writeFile(join(s1, '01.flac'), 'x'.repeat(10))
      await sleep(5)
      await writeFile(join(s1, '02.flac'), 'x'.repeat(10))
      await waitFor(() => seen.some(([h]) => h === 1), 'one landed')
      stop(true)
      await waitFor(() => seen.some(([h]) => h === 2), 'the clean end counts the last file')
      // The retry: a fresh folder from nothing.
      stop = watchLanding(s2, 10)
      await writeFile(join(s2, '01.flac'), 'x'.repeat(10))
      await writeFile(join(s2, '02.flac'), 'y'.repeat(10))
      await sleep(40)
      stop()
      clearLanding()
    })
    const counts = seen.filter(([, , r]) => !r).map(([h]) => h)
    assert.deepEqual(counts, [...counts].sort((x, y) => x - y), 'never backwards')
    assert.deepEqual(seen[0], [0, 4, false], 'one 0 at the start, not one per rip')
    assert.equal(seen.filter(([h, , r]) => h === 0 && !r).length, 1)
    assert.deepEqual(seen[seen.length - 1], [0, 4, true], 'Bandcamp clears the count')
    assert.ok(!liveJobIds().includes('job-max'))
  })

  it('at boot every download folder goes, whatever its age; other temps keep the hour', async () => {
    const t = join(dir, 'tmp')
    await mkdir(t)
    for (const n of ['jaketunes-rip-fresh', 'jaketunes-bc-fresh', 'jaketunes-ripsearch-fresh', 'jaketunes-itunesdb-fresh', 'someone-else', 'jaketunes-rip-owned']) await mkdir(join(t, n))
    await mkdir(join(t, 'jaketunes-ripsearch-old'))
    const old = (Date.now() - 2 * 3600_000) / 1000
    await utimes(join(t, 'jaketunes-ripsearch-old'), old, old)
    await runInJob('job-owner', null, undefined, async () => {
      currentJob().stagingDirs.add(join(t, 'jaketunes-rip-owned'))
      assert.equal(await sweepOrphanedStaging({ atBoot: true, dir: t }), 3)
    })
    assert.deepEqual((await readdir(t)).sort(), ['jaketunes-itunesdb-fresh', 'jaketunes-rip-owned', 'jaketunes-ripsearch-fresh', 'someone-else'])
    // Later (not at boot): a fresh download folder may be live, and stays.
    await mkdir(join(t, 'jaketunes-rip-later'))
    assert.equal(await sweepOrphanedStaging({ atBoot: false, dir: t }), 0)
    assert.ok((await stat(join(t, 'jaketunes-rip-later'))).isDirectory())
  })
})
