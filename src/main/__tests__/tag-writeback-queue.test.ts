/**
 * Tag write-back can't run the app out of memory, and doesn't lose a tag
 * doing so (2026-11-13, reviewed 2026-11-14).
 *
 * The crash: one Get Info over 41 songs sent 186 writable fields. Each started
 * its own read + parse of the 14 MB library.json at once; the main process hit
 * its 4 GB heap limit and V8 aborted the app. The first fix ran them one at a
 * time and looked each song up when its turn came, by which time the renderer
 * had saved the new artist and the edit's own before-edit fingerprint no longer
 * matched: 59 of the 186 were skipped. These tests hold both.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createTagWritebackQueue, jobFromDisk, overrideNamesTrack, resolveTagEdit, trackFingerprint,
  TAG_WRITEBACK_HEAP_CEILING, TAG_WRITEBACK_MAX_TRIES,
  type TagEdit, type TagWritebackDeps, type TagWritebackJob, type TagWriteOutcome,
} from '../tag-writeback-queue.ts'
import { augmentPairFields, writeTagsToFile } from '../tag-writer.ts'

type Row = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const song = (id: number, over: Row = {}): Row => ({ id, path: `:iPod_Control:Music:F00:S${id}.m4a`, title: `Song ${id}`, artist: 'twisted teens', album: 'twisted teens', duration: 180000 + id, trackNumber: 3, trackCount: 11, ...over })

/** A library in memory, and a queue wired the way index.ts wires it. */
function rig(rows: Row[], over: Partial<TagWritebackDeps> = {}): {
  q: ReturnType<typeof createTagWritebackQueue>
  written: TagWritebackJob[]
  warned: string[]
  saved: TagWritebackJob[][]
} {
  const written: TagWritebackJob[] = []
  const warned: string[] = []
  const saved: TagWritebackJob[][] = []
  const q = createTagWritebackQueue({
    findTrack: async (id) => rows.find((r) => r.id === id),
    augment: augmentPairFields,
    write: async (job) => { written.push({ ...job }); return { ok: true } },
    warn: (m) => warned.push(m),
    save: async (jobs) => { saved.push(jobs.map((j) => ({ ...j }))) },
    ...over,
  })
  return { q, written, warned, saved }
}
const edit = (row: Row, field: string, value: string): TagEdit => ({ trackId: row.id as number, field, value, fingerprint: trackFingerprint(row) })

describe('the crash night, replayed', () => {
  // 41 songs × albumArtist, genre, discNumber, discCount; the first 11 × artist, trackCount.
  const nightEdits = (rows: Row[]): TagEdit[] => {
    const out: TagEdit[] = []
    for (const r of rows.slice(0, 11)) { out.push(edit(r, 'artist', 'Twisted Teens')); out.push(edit(r, 'trackCount', '11')) }
    for (const r of rows) for (const [f, v] of [['albumArtist', 'Twisted Teens'], ['genre', 'Garage Punk'], ['discNumber', '1'], ['discCount', '1']]) out.push(edit(r, f, v))
    return out
  }

  test('186 edits are written one at a time, in the order they arrived', async () => {
    const rows = Array.from({ length: 41 }, (_, i) => song(15193 + i))
    let inFlight = 0, most = 0
    const { q, written } = rig(rows, {
      write: async (job) => { inFlight++; most = Math.max(most, inFlight); await tick(); written.push({ ...job }); inFlight--; return { ok: true } },
    })
    const sent = nightEdits(rows)
    assert.equal(sent.length, 186)
    for (const e of sent) await q.edit(e)
    await q.idle()
    assert.equal(most, 1, 'never two writes in flight: each used to hold its own copy of the library')
    assert.deepEqual(written.map((j) => `${j.trackId}:${j.field}`), sent.map((e) => `${e.trackId}:${e.field}`))
    assert.deepEqual(q.stats(), { waiting: 0, later: 0, written: 186, failed: 0, gone: 0, refused: 0, heapWaits: 0 })
  })

  test('186 of 186 are written although the renderer saves the new artist while most still wait', async () => {
    // The real timing, scaled: a write takes ~145 ms, and the renderer saves the
    // library (new artist on 11 songs) 1 s after the last edit, so about 7 writes
    // are done and 179 are waiting when the library in memory changes under them.
    const rows = Array.from({ length: 41 }, (_, i) => song(15193 + i))
    const { q, written, warned } = rig(rows, { write: async (job) => { await sleep(3); written.push({ ...job }); return { ok: true } } })
    const sent = nightEdits(rows)
    for (const e of sent) await q.edit(e)                // every edit has arrived; fingerprints are the BEFORE-edit songs
    await sleep(20)
    assert.ok(written.length > 0 && written.length < 40, `the save lands mid-line (${written.length} written so far)`)
    for (const r of rows.slice(0, 11)) r.artist = 'Twisted Teens'   // the renderer's save: the library now holds the edited artist
    for (const r of rows) r.albumArtist = 'Twisted Teens'
    await q.idle()
    assert.equal(written.length, 186, `skipped: ${warned.join(' / ')}`)
    assert.deepEqual(warned, [])
    for (const r of rows.slice(0, 11)) {
      const mine = written.filter((j) => j.trackId === r.id)
      assert.equal(mine.length, 6, `all six edits of ${r.id}, the artist change included`)
      assert.ok(mine.every((j) => j.path === r.path))
    }
  })
})

describe('what a job carries', () => {
  test('the value, the pair, and the path of the song with that id: not its neighbour', async () => {
    const rows = [song(1, { artist: 'A' }), song(2, { artist: 'B', trackNumber: 7, trackCount: 12 }), song(3, { artist: 'C' })]
    const { q, written } = rig(rows)
    const r = await q.edit(edit(rows[1], 'trackNumber', '8'))
    await q.idle()
    assert.deepEqual(written, [{ trackId: 2, path: ':iPod_Control:Music:F00:S2.m4a', field: 'trackNumber', value: '8', overrides: { trackNumber: '8', trackCount: '12' }, duration: 180002, tries: 0 }])
    assert.deepEqual(r, { job: written[0] })
  })

  test('resolveTagEdit: no row, no path, another song at that id, and the plain case', () => {
    const row = song(9)
    const aug = (f: string, v: string): Record<string, string> => ({ [f]: v, seen: 'yes' })
    assert.deepEqual(resolveTagEdit({ trackId: 9, field: 'genre', value: 'Rock' }, undefined, aug), { skip: 'no-track' })
    assert.deepEqual(resolveTagEdit({ trackId: 9, field: 'genre', value: 'Rock' }, { ...row, path: '' }, aug), { skip: 'no-path' })
    assert.deepEqual(resolveTagEdit({ trackId: 9, field: 'genre', value: 'Rock', fingerprint: 'someone else|entirely|1' }, row, aug), { skip: 'fingerprint' })
    // No fingerprint sent (stars, bulk rename): the id alone names the song, as before.
    assert.deepEqual(resolveTagEdit({ trackId: 9, field: 'genre', value: 'Rock' }, row, aug),
      { job: { trackId: 9, path: row.path, field: 'genre', value: 'Rock', overrides: { genre: 'Rock', seen: 'yes' }, duration: 180009, tries: 0 } })
    assert.equal('job' in resolveTagEdit({ trackId: 9, field: 'genre', value: 'Rock', fingerprint: 'song 9|twisted teens|180009' }, row, aug), true)
    assert.equal(trackFingerprint({ title: '  Blue Flower ', artist: 'Twisted TEENS', duration: 5 }), 'blue flower|twisted teens|5')
    assert.equal(trackFingerprint({}), '||0')
  })

  test('an edit whose fingerprint names another song is never written, and says so', async () => {
    const rows = [song(1)]
    const { q, written, warned } = rig(rows)
    const r = await q.edit({ trackId: 1, field: 'genre', value: 'Rock', fingerprint: 'a different song|someone|1' })
    await q.idle()
    assert.deepEqual(r, { skip: 'fingerprint' })
    assert.deepEqual(written, [])
    assert.match(warned[0], /skipped trackId=1 field=genre — fingerprint mismatch/)
  })

  test('a song that has moved or gone by its turn is not written to', async () => {
    const rows = [song(1), song(2), song(3)]
    const gate: Array<() => void> = []
    const { q, written, warned } = rig(rows, { write: (job) => new Promise<TagWriteOutcome>((r) => { gate.push(() => { written.push({ ...job }); r({ ok: true }) }) }) })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    while (gate.length === 0) await tick()
    rows[1].path = ':iPod_Control:Music:F09:ELSE.m4a'    // re-pathed while it waited: the job's file is not this song's any more
    rows.splice(2, 1)                                     // deleted while it waited
    gate.shift()!()
    await q.idle()
    assert.deepEqual(written.map((j) => j.trackId), [1])
    assert.equal(q.stats().gone, 2)
    assert.equal(warned.length, 2)
    assert.match(warned[0], /^\[tag-writeback\] 2 genre: the song is no longer at :iPod_Control:Music:F00:S2\.m4a; nothing written$/)
  })
})

describe('nothing waiting is lost', () => {
  test('the line is on disk while it waits and empty once written', async () => {
    const rows = [song(1), song(2), song(3)]
    const gate: Array<() => void> = []
    const { q, saved } = rig(rows, { write: () => new Promise<TagWriteOutcome>((r) => { gate.push(() => r({ ok: true })) }) })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    while (gate.length === 0) await tick()
    await tick()
    assert.deepEqual(saved[saved.length - 1].map((j) => j.trackId), [1, 2, 3], 'the one being written is still owed')
    for (let i = 0; i < 3; i++) { while (gate.length === 0) await tick(); gate.shift()!() }
    await q.idle()
    assert.deepEqual(saved[saved.length - 1], [])
  })

  test('a quit writes what fits its budget, leaves the rest on disk, and the next launch finishes them', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => song(i + 1))
    const disk: { jobs: TagWritebackJob[] } = { jobs: [] }
    const first = rig(rows, {
      write: async (job) => { await sleep(10); first.written.push({ ...job }); return { ok: true } },
      saveNow: (jobs) => { disk.jobs = jobs.map((j) => ({ ...j })) },
    })
    for (const r of rows) await first.q.edit(edit(r, 'genre', 'Rock'))
    const out = await first.q.stop(45)
    assert.ok(out.written >= 1 && out.written < 30, `some, not all, in 45 ms (${out.written})`)
    assert.equal(out.left, disk.jobs.length)
    assert.equal(first.written.length + disk.jobs.length >= 30, true, 'written + left covers every edit (one in flight at the bound may be both)')
    assert.match(first.warned[first.warned.length - 1], new RegExp(`^\\[tag-writeback\\] quit: ${out.written} tag edit\\(s\\) written into files, ${out.left} left for the next launch$`))
    await sleep(40)
    assert.ok(first.written.length <= out.written + 1, 'nothing starts after the bound')

    // Next launch: the file is read back (through JSON, as on disk) and finished.
    const next = rig(rows, { load: async () => JSON.parse(JSON.stringify(disk.jobs)) })
    assert.equal(await next.q.resume(), disk.jobs.length)
    await next.q.idle()
    const all = new Set([...first.written, ...next.written].map((j) => j.trackId))
    assert.equal(all.size, 30, 'every edit reached its file across the two runs')
    assert.match(next.warned[0], /tag edit\(s\) from the last run are still owed/)
  })

  test('what comes back from disk goes ahead of what arrived since, and junk is not a job', async () => {
    const rows = [song(1), song(2), song(3)]
    const old = [{ trackId: 2, path: rows[1].path, field: 'genre', value: 'Punk', overrides: { genre: 'Punk' }, duration: 1, tries: 1 }, { trackId: 'x' }, null, 7, { trackId: 3, path: rows[2].path, field: 'genre', value: 'Ska', overrides: { genre: 'Ska' }, duration: 1, tries: 0 }, { trackId: 3, path: '', field: 'genre', value: 'x' }]
    const gate: Array<() => void> = []
    const { q, written } = rig(rows, { load: async () => old, write: (job) => new Promise<TagWriteOutcome>((r) => { gate.push(() => { written.push({ ...job }); r({ ok: true }) }) }) })
    await q.edit(edit(rows[0], 'genre', 'Rock'))
    while (gate.length === 0) await tick()
    await q.edit(edit(rows[2], 'genre', 'Rock'))
    assert.equal(await q.resume(), 2)
    for (let i = 0; i < 4; i++) { while (gate.length === 0) await tick(); gate.shift()!() }
    await q.idle()
    assert.deepEqual(written.map((j) => `${j.trackId}:${j.value}`), ['1:Rock', '2:Punk', '3:Ska', '3:Rock'], 'the last run\'s edits first, in their own order')
    assert.equal(written[1].tries, 1)
    assert.equal(jobFromDisk({ trackId: 5, path: ':p', field: 'year', value: '1999' })?.overrides.year, '1999', 'a job saved without its payload still writes its own field')
    assert.equal(jobFromDisk({ trackId: 5, path: ':p', field: 'year', value: 1999 }), null)
    assert.equal(jobFromDisk({ trackId: NaN, path: ':p', field: 'year', value: '1' }), null)
    assert.equal(await rig(rows, { load: async () => { throw new Error('ENOENT') } }).q.resume(), 0)
    assert.equal(await rig(rows, { load: async () => ({ not: 'a list' }) }).q.resume(), 0)
  })

  test('with the heap nearly full the line waits; nothing is dropped; it goes on when there is room', async () => {
    let share = 0.95
    const rows = Array.from({ length: 50 }, (_, i) => song(i + 1))
    const { q, written, warned, saved } = rig(rows, { heapShare: () => share, heapWaitMs: 15 })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    await q.idle()
    assert.deepEqual(written, [], 'no lookup and no write while the heap is over the ceiling')
    assert.equal(q.stats().waiting, 50, 'all fifty are still owed')
    assert.equal(saved[saved.length - 1].length, 50, 'and on disk')
    assert.equal(warned.length, 1, 'one line while it waits, not fifty')
    assert.match(warned[0], /memory is nearly full: \d+ tag edit\(s\) wait to be written into files \(next: 1 genre\)\. They are kept and tried again\./)
    share = TAG_WRITEBACK_HEAP_CEILING - 0.1
    await sleep(40)
    await q.idle()
    assert.equal(written.length, 50)
    assert.equal(q.stats().waiting, 0)
    assert.ok(q.stats().heapWaits >= 1)
  })

  test('at the ceiling exactly there is still room; a heap reading that throws is room too', async () => {
    const rows = [song(1)]
    const a = rig(rows, { heapShare: () => TAG_WRITEBACK_HEAP_CEILING })
    await a.q.edit(edit(rows[0], 'genre', 'Rock')); await a.q.idle()
    assert.equal(a.written.length, 1)
    const b = rig(rows, { heapShare: () => { throw new Error('no v8') } })
    await b.q.edit(edit(rows[0], 'genre', 'Rock')); await b.q.idle()
    assert.equal(b.written.length, 1)
  })

  test('a quit with the heap full starts nothing and leaves the whole line on disk', async () => {
    const rows = [song(1), song(2)]
    let left: TagWritebackJob[] = []
    const { q, written } = rig(rows, { heapShare: () => 0.99, saveNow: (jobs) => { left = jobs } })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    await q.idle()
    assert.deepEqual(await q.stop(50), { written: 0, left: 2 })
    assert.deepEqual(left.map((j) => j.trackId), [1, 2])
    assert.deepEqual(written, [])
  })
})

describe('one bad write does not hold the line', () => {
  test('a tag writer that timed out: that edit is tried again later, the ones behind it go on', async () => {
    const rows = [song(1), song(2), song(3)]
    let hung = 1
    const { q, written, warned } = rig(rows, {
      retryAfterMs: 20,
      write: async (job) => {
        if (job.trackId === 2 && hung-- > 0) return { ok: false, timedOut: true, error: 'no answer' }
        written.push({ ...job }); return { ok: true }
      },
    })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    await q.idle()
    assert.deepEqual(written.map((j) => j.trackId), [1, 3], 'the line went on past the hung one')
    assert.deepEqual({ later: q.stats().later, failed: q.stats().failed }, { later: 1, failed: 0 })
    assert.match(warned[0], /^\[tag-writeback\] 2 genre: the tag writer timed out and was stopped; the file is untouched, tried again later$/)
    await sleep(50)
    await q.idle()
    assert.deepEqual(written.map((j) => j.trackId), [1, 3, 2])
    assert.equal(written[2].tries, 1)
    assert.equal(q.stats().later, 0)
  })

  test('a writer that times out every time is given up after its tries, and said', async () => {
    const rows = [song(1)]
    let calls = 0
    const { q, warned } = rig(rows, { retryAfterMs: 5, write: async () => { calls++; return { ok: false, timedOut: true } } })
    await q.edit(edit(rows[0], 'genre', 'Rock'))
    for (let i = 0; i < 20 && q.stats().failed === 0; i++) { await sleep(10); await q.idle() }
    assert.equal(calls, TAG_WRITEBACK_MAX_TRIES)
    assert.deepEqual({ failed: q.stats().failed, later: q.stats().later, waiting: q.stats().waiting }, { failed: 1, later: 0, waiting: 0 })
    assert.match(warned[warned.length - 1], /1 genre failed: the tag writer timed out 3 times; given up/)
  })

  test('a write that fails or throws is said once and does not stop the ones behind it', async () => {
    const rows = [song(1), song(2), song(3)]
    const { q, written, warned } = rig(rows, {
      write: async (job) => {
        if (job.trackId === 1) throw new Error('tag writer exited 1')
        if (job.trackId === 2) return { ok: false, error: 'not a regular file (streamed placeholder); left as-is' }
        written.push({ ...job }); return { ok: true }
      },
    })
    for (const r of rows) await q.edit(edit(r, 'genre', 'Rock'))
    await q.idle()
    assert.deepEqual(written.map((j) => j.trackId), [3])
    assert.deepEqual({ failed: q.stats().failed, later: q.stats().later }, { failed: 2, later: 0 }, 'a plain failure is not retried')
    assert.deepEqual(warned, [
      '[tag-writeback] hook error for trackId=1 field=genre: tag writer exited 1',
      '[tag-writeback] 2 genre failed: not a regular file (streamed placeholder); left as-is',
    ])
  })

  test('the line is capped: past it an edit is refused, said once, and the queue still drains', async () => {
    const rows = [1, 2, 3, 4, 5, 6].map((id) => song(id))
    const gate: Array<() => void> = []
    const { q, written, warned } = rig(rows, { maxWaiting: 3, write: (job) => new Promise<TagWriteOutcome>((r) => { gate.push(() => { written.push({ ...job }); r({ ok: true }) }) }) })
    assert.equal('job' in await q.edit(edit(rows[0], 'genre', 'Rock')), true)   // taken off the line at once: it is the one running
    while (gate.length === 0) await tick()
    for (const r of rows.slice(1, 4)) assert.equal('job' in await q.edit(edit(r, 'genre', 'Rock')), true)
    assert.deepEqual(await q.edit(edit(rows[4], 'genre', 'Rock')), { skip: 'full' })
    assert.deepEqual(await q.edit(edit(rows[5], 'genre', 'Rock')), { skip: 'full' })
    assert.equal(warned.length, 1)
    assert.match(warned[0], /3 edits are already waiting/)
    assert.equal(q.stats().refused, 2)
    for (let i = 0; i < 4; i++) { while (gate.length === 0) await tick(); gate.shift()!() }
    await q.idle()
    assert.deepEqual(written.map((j) => j.trackId), [1, 2, 3, 4])
  })

  test('an edit that arrives as the last one finishes is still written', async () => {
    const rows = [song(1), song(2), song(3)]
    const r = rig(rows)
    const again = rig(rows, { write: async (job) => { again.written.push({ ...job }); if (job.trackId === 2) await again.q.edit(edit(rows[2], 'genre', 'Rock')); return { ok: true } } })
    await again.q.edit(edit(rows[0], 'genre', 'Rock')); await again.q.edit(edit(rows[1], 'genre', 'Rock'))
    await again.q.idle()
    assert.deepEqual(again.written.map((j) => j.trackId), [1, 2, 3])
    await r.q.edit(edit(rows[0], 'genre', 'Rock')); await r.q.idle()
    await r.q.edit(edit(rows[1], 'genre', 'Rock')); await r.q.edit(edit(rows[2], 'genre', 'Rock')); await r.q.idle()
    assert.deepEqual(r.written.map((j) => j.trackId), [1, 2, 3])
    assert.equal(r.q.stats().waiting, 0)
  })
})

describe('"Apply Overrides to Files…": an entry still names its song after the song was corrected', () => {
  const row = { id: 1, title: 'Marionette', artist: 'Twisted Teens', duration: 181919 }
  const cases: Array<[string, { fp?: string; fields?: Record<string, unknown> } | undefined, boolean]> = [
    ['no fingerprint recorded', { fields: { genre: 'Rock' } }, true],
    ['no entry', undefined, true],
    ['untouched title and artist', { fp: 'marionette|twisted teens|181919', fields: { genre: 'Rock' } }, true],
    ['the artist was corrected (the crash night)', { fp: 'marionette|twisted teens (band)|181919', fields: { artist: 'Twisted Teens' } }, true],
    ['the artist was corrected, case and spaces aside', { fp: 'marionette|tt|181919', fields: { artist: '  twisted TEENS ' } }, true],
    ['the title was corrected', { fp: 'marionete|twisted teens|181919', fields: { title: 'Marionette' } }, true],
    ['both were corrected', { fp: 'track 02|unknown artist|181919', fields: { title: 'Marionette', artist: 'Twisted Teens' } }, true],
    ['another length: another recording', { fp: 'marionette|twisted teens|200000', fields: { artist: 'Twisted Teens' } }, false],
    ['both corrected, another length', { fp: 'x|y|1', fields: { title: 'Marionette', artist: 'Twisted Teens' } }, false],
    ['the artist differs and the entry never set it', { fp: 'marionette|someone else|181919', fields: { genre: 'Rock' } }, false],
    ['the entry set another artist than the row has', { fp: 'marionette|someone else|181919', fields: { artist: 'A Third Band' } }, false],
    ['artist corrected, but the title is not the one it had', { fp: 'another song|old name|181919', fields: { artist: 'Twisted Teens' } }, false],
    ['title corrected, but the artist is not the one it had', { fp: 'old title|another band|181919', fields: { title: 'Marionette' } }, false],
    ['an empty artist in the entry sets nothing', { fp: 'marionette|x|181919', fields: { artist: '' } }, false],
  ]
  for (const [name, entry, want] of cases) test(name, () => assert.equal(overrideNamesTrack(entry, row), want))
})

describe('a tag writer that hangs is stopped by its own clock', () => {
  const root = mkdtempSync(join(tmpdir(), 'jt-tagclock-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  // Stand-ins for core/tag_writer.py. .mp3 is not decode-checked, so this needs no ffmpeg.
  const hangs = join(root, 'writer_hangs.py')
  writeFileSync(hangs, 'import sys, time\nsys.stdin.read()\nopen(sys.argv[1], "ab").write(b"half")\ntime.sleep(60)\n')
  const fine = join(root, 'writer_ok.py')
  writeFileSync(fine, 'import sys\nsys.stdin.read()\n')

  test('killed at the limit, the song file untouched, no copy left behind, and the result says it timed out', async () => {
    const dir = mkdtempSync(join(root, 'song-'))
    const file = join(dir, 'a.mp3')
    writeFileSync(file, 'audio')
    const noted: string[] = []
    const t0 = Date.now()
    const r = await writeTagsToFile({ audioFilePath: file, overrides: { genre: 'Rock' } }, { script: hangs, timeoutMs: 700, noteEdit: async (p) => { noted.push(p) } })
    assert.ok(Date.now() - t0 < 20_000, 'it came back; the script sleeps for a minute')
    assert.equal(r.ok, false)
    assert.equal(r.timedOut, true)
    assert.match(String(r.error), /gave no answer in 1 s and was stopped; the file is untouched/)
    assert.equal(readFileSync(file, 'utf8'), 'audio')
    assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith('.original-tags.json')), ['a.mp3'])
    assert.deepEqual(noted, [])
  })

  test('a writer that answers is not timed out, and an ordinary failure is not called one', async () => {
    const dir = mkdtempSync(join(root, 'ok-'))
    const file = join(dir, 'a.mp3')
    writeFileSync(file, 'audio')
    const ok = await writeTagsToFile({ audioFilePath: file, overrides: { genre: 'Rock' } }, { script: fine, timeoutMs: 20_000, noteEdit: async () => {} })
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.timedOut, undefined)
    const bad = join(root, 'writer_bad.py')
    writeFileSync(bad, 'import sys\nsys.stdin.read()\nsys.exit(3)\n')
    const no = await writeTagsToFile({ audioFilePath: file, overrides: { genre: 'Rock' } }, { script: bad, timeoutMs: 20_000, noteEdit: async () => {} })
    assert.equal(no.ok, false)
    assert.equal(no.timedOut, undefined)
  })
})

describe('index.ts goes through the queue', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  const start = src.indexOf("ipc.handle('save-metadata-override'")
  const end = src.indexOf('ipc.handle(', start + 10)
  const handler = src.slice(start, end)
  const at = src.indexOf('const tagWritebackPendingPath = ')
  const wiring = src.slice(at, start)

  test('save-metadata-override never reads or parses library.json itself, and never writes tags itself', () => {
    assert.ok(start > 0 && end > start, 'the handler is where this test looks for it')
    assert.doesNotMatch(handler, /readFile\(\s*LIBRARY_PATH/, 'one read of the whole library per edited field is the 2026-11-13 crash')
    assert.doesNotMatch(handler, /JSON\.parse\(/)
    assert.doesNotMatch(handler, /writeTagsToFile\(/, 'the write itself belongs to the queue')
  })

  test('the song is settled as the edit arrives: before the background work, not inside it', () => {
    const arrives = handler.indexOf('if (WRITABLE_FIELDS.has(field)) await tagWriteback.edit({ trackId, field, value, fingerprint })')
    const background = handler.indexOf('void (async () => {')
    assert.ok(arrives > 0, 'the handler hands the edit, its own fingerprint included, to the queue')
    assert.ok(background > arrives, 'before the fire-and-forget block: after it, the renderer may already have saved the new title/artist')
    assert.equal((handler.match(/tagWriteback\./g) || []).length, 1)
  })

  test('the queue finds its song in the library cache, watches the heap, and keeps its line on disk', () => {
    assert.ok(at > 0 && at < start)
    assert.match(wiring, /findTrack: async \(trackId\) => \(\(\(await libraryCache\.get\(\)\) as \{ tracks\?: Array<Record<string, unknown>> \}\)\.tracks \|\| \[\]\)\.find\(\(t\) => t\.id === trackId\)/)
    assert.doesNotMatch(wiring, /LIBRARY_PATH/)
    assert.match(wiring, /augment: augmentPairFields,/)
    assert.match(wiring, /heapShare: \(\) => \{ const h = getHeapStatistics\(\); return h\.used_heap_size \/ h\.heap_size_limit \}/)
    assert.match(wiring, /join\(app\.getPath\('userData'\), TAG_WRITEBACK_PENDING_FILE\)/)
    assert.match(wiring, /load: async \(\) => JSON\.parse\(await readFile\(tagWritebackPendingPath\(\), 'utf-8'\)\)/)
    assert.match(wiring, /save: async \(jobs\) => \{[\s\S]*?await writeFile\(tmp, JSON\.stringify\(jobs\)\)\s*await rename\(tmp, file\)/)
    assert.match(wiring, /saveNow: \(jobs\) => \{[\s\S]*?writeFileSync\(tmp, JSON\.stringify\(jobs\)\)\s*renameSync\(tmp, file\)/)
    assert.match(wiring, /void tagWriteback\.resume\(\)/)
  })

  test('the write uses the job: its path, its payload, and says when the writer timed out', () => {
    assert.match(wiring, /const \{ trackId, field, value, overrides \} = job/)
    assert.match(wiring, /const track = \{ id: job\.trackId, path: job\.path, duration: job\.duration \}/)
    assert.match(wiring, /const absPath = colonPathToAbsolute\(job\.path, MUSIC_DIR\)/)
    assert.match(wiring, /const result = await writeTagsToFile\(\{ audioFilePath: absPath, overrides \}\)/)
    assert.match(wiring, /return \{ ok: false, timedOut: result\.timedOut === true, error: result\.error \}/)
  })

  test('a quit gives the line the same two seconds as the other files', () => {
    const quit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('will-quit'"))
    assert.match(quit, /flush,\s*\/\/[^\n]*\n\s*tagWriteback\.stop\(2000\)\.catch\(\(\) => undefined\),/)
  })

  test('"Apply Overrides to Files…" asks whether the entry names the song, not whether the song is unedited', () => {
    const batch = src.slice(src.indexOf("ipc.handle('apply-overrides-batch'"), src.indexOf('const result = await writeTagsBatch('))
    assert.match(batch, /if \(!overrideNamesTrack\(entry, track\)\) \{\s*skippedFpMismatch\+\+\s*continue/)
    assert.doesNotMatch(batch, /entry\.fp !== trackFp/)
  })
})
