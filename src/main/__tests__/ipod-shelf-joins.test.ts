// Brief 259: a song Jake saves from an iPod's shelf in the Record Shop joins
// that iPod's list. The import's ids are kept on this Mac's disk first, sent to
// homemini as POST /api/ipod-lists/:id/add { from: 'shelf' }, and asked again
// while homemini doesn't have the song yet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from './wait-for.ts'
import {
  createShelfJoins, createShelfJoinsRemote, isShelfListId, parseShelfJoins,
  SHELF_JOIN_GIVE_UP_MS, SHELF_JOINS_FILE, SHELF_WHY, type ShelfJoinAnswer,
} from '../ipod-shelf-joins.ts'
import { currentJob, markShelfSave, runInJob } from '../streamrip-store/rip-jobs.ts'
import { mergeOrigin, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'

const Y2K = 'b3c1f0aa-0000-4000-8000-000000001234'

async function harness(answers: Array<ShelfJoinAnswer | ((ids: number[]) => ShelfJoinAnswer)>) {
  const dir = await mkdtemp(join(tmpdir(), 'shelf-joins-'))
  let t = Date.parse('2026-11-20T12:00:00Z')
  const sent: Array<{ listId: string; ids: number[] }> = []
  const later: Array<() => void> = []
  const warned: string[] = []
  let n = 0
  const joins = createShelfJoins({
    stateDir: dir,
    remote: {
      add: async (listId, ids) => {
        sent.push({ listId, ids: [...ids] })
        const a = answers.shift() ?? { kind: 'done', skipped: [] }
        return typeof a === 'function' ? a(ids) : a
      },
    },
    now: () => new Date(t),
    newId: () => `op-${++n}`,
    warn: (m) => warned.push(m),
    later: (fn) => later.push(fn),
  })
  return {
    joins, sent, later, warned, dir,
    advance: (ms: number) => { t += ms },
    file: async () => JSON.parse(await readFile(join(dir, SHELF_JOINS_FILE), 'utf-8')),
    done: () => rm(dir, { recursive: true, force: true }),
  }
}

test('a list id the shelf may name: never the Original, never a path', () => {
  assert.equal(isShelfListId(Y2K), true)
  assert.equal(isShelfListId('top1000'), false)
  assert.equal(isShelfListId('../x'), false)
  assert.equal(isShelfListId(''), false)
  assert.equal(isShelfListId(undefined), false)
})

test('the import is on disk before homemini is asked, and homemini is asked a minute later', async () => {
  const h = await harness([])
  assert.equal(await h.joins.queue(Y2K, [101, 102, 101]), true)
  assert.equal(h.sent.length, 0)
  const doc = await h.file()
  assert.deepEqual(doc.joins.map((j: { listId: string; ids: number[] }) => [j.listId, j.ids]), [[Y2K, [101, 102]]])
  assert.equal(h.later.length, 1)
  h.later[0]!()
  // Wait for the send itself, not a guess at how fast the Mac is (wait-for.ts): 20 ms failed under load.
  await waitFor(() => h.sent.length > 0, 'the send to homemini')
  assert.deepEqual(h.sent, [{ listId: Y2K, ids: [101, 102] }])
  assert.equal(await h.joins.flush(), 0)
  await h.done()
})

test('nothing is kept for the Original, a bad id or no songs', async () => {
  const h = await harness([])
  assert.equal(await h.joins.queue('top1000', [1]), false)
  assert.equal(await h.joins.queue(Y2K, []), false)
  assert.equal(await h.joins.queue(Y2K, [0, -3, 1.5]), false)
  assert.equal((await h.joins.read()).joins.length, 0)
  await h.done()
})

test('homemini away: everything waits, in order, and goes when it answers', async () => {
  const h = await harness([{ kind: 'retry' }])
  await h.joins.queue(Y2K, [1])
  await h.joins.queue('punkpod', [2])
  assert.equal(await h.joins.flush(), 2)
  assert.deepEqual(h.sent, [{ listId: Y2K, ids: [1] }])   // the second waits behind the first
  assert.equal(await h.joins.flush(), 0)
  assert.deepEqual(h.sent.slice(1), [{ listId: Y2K, ids: [1] }, { listId: 'punkpod', ids: [2] }])
  await h.done()
})

test('a song homemini has not heard of yet waits; the rest of the answer is final', async () => {
  const h = await harness([
    { kind: 'done', skipped: [{ id: 2, reason: 'not-in-library' }, { id: 3, reason: 'skit' }] },
    { kind: 'done', skipped: [] },
  ])
  await h.joins.queue(Y2K, [1, 2, 3])
  assert.equal(await h.joins.flush(), 1)
  assert.deepEqual((await h.joins.read()).joins[0]!.ids, [2])
  assert.ok(h.warned.some((m) => m.includes('3 (skit)')))
  assert.equal(await h.joins.flush(), 0)
  assert.deepEqual(h.sent.at(-1), { listId: Y2K, ids: [2] })
  await h.done()
})

test('after 3 days a song homemini still lacks is given up', async () => {
  const notYet: ShelfJoinAnswer = { kind: 'done', skipped: [{ id: 7, reason: 'not-in-library' }] }
  const h = await harness([notYet, notYet])
  await h.joins.queue(Y2K, [7])
  assert.equal(await h.joins.flush(), 1)
  h.advance(SHELF_JOIN_GIVE_UP_MS + 1)
  assert.equal(await h.joins.flush(), 0)
  assert.ok(h.warned.some((m) => m.includes('given up')))
  await h.done()
})

test("homemini's refusal (no list, the Original) drops the entry and says why", async () => {
  const h = await harness([{ kind: 'refused', error: 'no list for this iPod: a save from a shelf never starts one' }])
  await h.joins.queue(Y2K, [5])
  assert.equal(await h.joins.flush(), 0)
  assert.ok(h.warned.some((m) => m.includes('refused')))
  await h.done()
})

test('a damaged waiting file reads as nothing, and bad rows are dropped', () => {
  assert.deepEqual(parseShelfJoins(null).joins, [])
  assert.deepEqual(parseShelfJoins({ version: 2, joins: [] }).joins, [])
  const doc = parseShelfJoins({ version: 1, joins: [
    { opId: 'a', listId: Y2K, ids: [1], at: '2026-11-20T00:00:00Z' },
    { opId: 'b', listId: 'top1000', ids: [1], at: '2026-11-20T00:00:00Z' },
    { opId: 'c', listId: Y2K, ids: [], at: '2026-11-20T00:00:00Z' },
    { opId: 'd', listId: Y2K, ids: [1], at: 'not a date' },
  ] })
  assert.deepEqual(doc.joins.map((j) => j.opId), ['a'])
})

test('the remote sends by claude, the shelf why and from shelf; reads homemini’s answers', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  let reply: { status: number; body: unknown } = { status: 200, body: { list: {}, added: [1], skipped: [{ id: 2, reason: 'excluded' }] } }
  const remote = createShelfJoinsRemote({
    baseUrl: 'http://homemini:3000/',
    warn: () => undefined,
    fetchImpl: (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { status: reply.status, json: async () => reply.body }
    }) as never,
  })
  assert.deepEqual(await remote.add(Y2K, [1, 2]), { kind: 'done', skipped: [{ id: 2, reason: 'excluded' }] })
  assert.equal(calls[0]!.url, `http://homemini:3000/api/ipod-lists/${Y2K}/add`)
  assert.deepEqual(calls[0]!.body, { ids: [1, 2], by: 'claude', why: SHELF_WHY, from: 'shelf' })
  assert.ok(SHELF_WHY.length <= 200)
  reply = { status: 400, body: { error: 'the Original takes no song by hand' } }
  assert.equal((await remote.add(Y2K, [1])).kind, 'refused')
  reply = { status: 502, body: '<html>' }
  assert.equal((await remote.add(Y2K, [1])).kind, 'retry')
  reply = { status: 503, body: { error: 'ipod-lists unreadable' } }
  assert.equal((await remote.add(Y2K, [1])).kind, 'retry')
})

test('a shelf save marks only its own job, never the shared outside slot', async () => {
  markShelfSave(Y2K)
  assert.equal(currentJob().forIpodList, undefined)
  await runInJob('arm-1', null, undefined, async () => {
    markShelfSave(Y2K)
    assert.equal(currentJob().forIpodList, Y2K)
  })
  await runInJob('arm-2', null, undefined, async () => {
    markShelfSave(null)
    assert.equal(currentJob().forIpodList, undefined)
  })
})

test('the list id rides along when a second save adopts an existing job', () => {
  const r: QResult = { source: 'qobuz', mediaType: 'track', id: 'q|track|a|b', desc: 'b — a', origin: { recommendationIds: ['r1'] } }
  mergeOrigin(r, { recommendationIds: ['r2'], forIpodList: Y2K })
  assert.equal(r.origin?.forIpodList, Y2K)
  mergeOrigin(r, { recommendationIds: ['r3'], forIpodList: 'punkpod' })
  assert.equal(r.origin?.forIpodList, Y2K)   // the first shelf's list stands
})
