/**
 * Tag write-back can't run the app out of memory (2026-11-13).
 *
 * The crash: one Get Info over 41 songs sent 186 writable fields. Each started
 * its own read + parse of the 14 MB library.json at once; the main process hit
 * its 4 GB heap limit and V8 aborted the app. These tests hold the two things
 * that make that impossible: one edit at a time with no file read per edit
 * (the queue), and the handler going through the queue (the rail at the end,
 * which fails on the code that crashed).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTagWritebackQueue, TAG_WRITEBACK_HEAP_CEILING, type TagWritebackJob } from '../tag-writeback-queue.ts'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const job = (trackId: number, field = 'genre', value = 'Garage Punk'): TagWritebackJob => ({ trackId, field, value })

describe('tag write-back queue', () => {
  test('the crash, replayed: 186 edits at once are looked up and written one at a time, in order', async () => {
    let inFlight = 0
    let most = 0
    const lookups: number[] = []
    const written: string[] = []
    const q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => {
        inFlight++; most = Math.max(most, inFlight)
        lookups.push(id)
        await tick()
        inFlight--
        return { id }
      },
      write: async (j, t) => {
        inFlight++; most = Math.max(most, inFlight)
        await tick()
        written.push(`${t.id}:${j.field}`)
        inFlight--
      },
    })
    // The night's own shape: 41 songs × albumArtist, genre, discNumber, discCount; 11 × artist, trackCount.
    const sent: string[] = []
    for (let id = 15193; id <= 15233; id++) for (const f of ['albumArtist', 'genre', 'discNumber', 'discCount']) { q.enqueue(job(id, f)); sent.push(`${id}:${f}`) }
    for (let id = 15193; id <= 15203; id++) for (const f of ['artist', 'trackCount']) { q.enqueue(job(id, f)); sent.push(`${id}:${f}`) }
    assert.equal(sent.length, 186)
    await q.idle()
    assert.equal(most, 1, 'never two in flight: each used to hold its own copy of the library')
    assert.deepEqual(written, sent, 'every edit written, in the order it arrived')
    assert.equal(lookups.length, 186)
    assert.deepEqual(q.stats(), { waiting: 0, written: 186, skippedFull: 0, skippedHeap: 0, failed: 0 })
  })

  test('a write that fails, or a song that is gone, does not stop the ones behind it', async () => {
    const written: number[] = []
    const warned: string[] = []
    const q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => (id === 2 ? undefined : { id }),
      write: async (j) => { if (j.trackId === 1) throw new Error('tag writer exited 1'); written.push(j.trackId) },
      warn: (m) => warned.push(m),
    })
    for (const id of [1, 2, 3]) q.enqueue(job(id))
    await q.idle()
    assert.deepEqual(written, [3])
    assert.equal(q.stats().failed, 1)
    assert.equal(warned.length, 1)
    assert.match(warned[0], /trackId=1 field=genre: tag writer exited 1/)
  })

  test('with the heap nearly full nothing new starts: the tags are skipped, the app is not', async () => {
    let share = 0.95
    const written: number[] = []
    const warned: string[] = []
    const q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => ({ id }),
      write: async (j) => { written.push(j.trackId) },
      heapShare: () => share,
      warn: (m) => warned.push(m),
    })
    for (let id = 1; id <= 50; id++) q.enqueue(job(id))
    await q.idle()
    assert.deepEqual(written, [], 'no lookup and no write while the heap is over the ceiling')
    assert.equal(q.stats().skippedHeap, 50)
    assert.equal(warned.length, 1, 'one line for the burst, not fifty')
    assert.match(warned[0], /memory is nearly full/)
    // Room again: the next edit is written, and a later squeeze is reported again.
    share = TAG_WRITEBACK_HEAP_CEILING - 0.1
    q.enqueue(job(51))
    await q.idle()
    assert.deepEqual(written, [51])
    share = 0.99
    q.enqueue(job(52))
    await q.idle()
    assert.equal(warned.length, 2)
  })

  test('the line is capped: past it an edit is refused, said once, and the queue still drains', async () => {
    const release: Array<() => void> = []
    const written: number[] = []
    const warned: string[] = []
    const q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => ({ id }),
      write: (j) => new Promise<void>((r) => { release.push(() => { written.push(j.trackId); r() }) }),
      maxWaiting: 3,
      warn: (m) => warned.push(m),
    })
    assert.equal(q.enqueue(job(1)), true)   // taken off the line at once: it is the one running
    await tick()
    for (const id of [2, 3, 4]) assert.equal(q.enqueue(job(id)), true)
    assert.equal(q.enqueue(job(5)), false)
    assert.equal(q.enqueue(job(6)), false)
    assert.equal(warned.length, 1)
    assert.match(warned[0], /3 edits are already waiting/)
    assert.equal(q.stats().skippedFull, 2)
    const done = q.idle()
    for (let i = 0; i < 4; i++) { while (release.length === 0) await tick(); release.shift()!() }
    await done
    assert.deepEqual(written, [1, 2, 3, 4])
  })

  test('an edit that arrives as the last one finishes is still written', async () => {
    const written: number[] = []
    let q: ReturnType<typeof createTagWritebackQueue<{ id: number }>>
    q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => ({ id }),
      // The last write of a drain sends one more edit, the way a finished write can make the renderer save again.
      write: async (j) => { written.push(j.trackId); if (j.trackId === 2) q.enqueue(job(3)) },
    })
    q.enqueue(job(1)); q.enqueue(job(2))
    await q.idle()
    assert.deepEqual(written, [1, 2, 3])
    // And one sent in the same turn a drain that had nothing to wait for ended in (the heap path has no await).
    let share = 0.99
    const q2 = createTagWritebackQueue<{ id: number }>({ findTrack: async (id) => ({ id }), write: async (j) => { written.push(j.trackId) }, heapShare: () => share })
    q2.enqueue(job(10))
    await q2.idle()
    share = 0.1
    q2.enqueue(job(11)); q2.enqueue(job(12))
    await q2.idle()
    assert.deepEqual(written, [1, 2, 3, 11, 12])
    assert.equal(q2.stats().waiting, 0)
  })

  test('a heap reading that throws is treated as room, never as a reason to stop', async () => {
    const written: number[] = []
    const q = createTagWritebackQueue<{ id: number }>({
      findTrack: async (id) => ({ id }),
      write: async (j) => { written.push(j.trackId) },
      heapShare: () => { throw new Error('no v8') },
    })
    q.enqueue(job(1))
    await q.idle()
    assert.deepEqual(written, [1])
  })
})

describe('the handler goes through the queue', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  const start = src.indexOf("ipc.handle('save-metadata-override'")
  const end = src.indexOf('ipc.handle(', start + 10)
  const handler = src.slice(start, end)

  test('save-metadata-override never reads or parses library.json itself', () => {
    assert.ok(start > 0 && end > start, 'the handler is where this test looks for it')
    assert.doesNotMatch(handler, /readFile\(\s*LIBRARY_PATH/, 'one read of the whole library per edited field is the 2026-11-13 crash')
    assert.doesNotMatch(handler, /JSON\.parse\(/)
    assert.match(handler, /tagWriteback\.enqueue\(\{ trackId, field, value, fingerprint \}\)/)
    assert.doesNotMatch(handler, /writeTagsToFile\(/, 'the write itself belongs to the queue')
  })

  test('the queue finds its song in the library cache and watches the heap', () => {
    const at = src.indexOf('const tagWriteback = createTagWritebackQueue')
    assert.ok(at > 0)
    const wiring = src.slice(at, src.indexOf("ipc.handle('save-metadata-override'", at))
    assert.match(wiring, /findTrack: async \(trackId\) => \(\(\(await libraryCache\.get\(\)\)/)
    assert.doesNotMatch(wiring, /readFile\(/)
    assert.match(wiring, /heapShare: \(\) => \{ const h = getHeapStatistics\(\); return h\.used_heap_size \/ h\.heap_size_limit \}/)
  })
})
