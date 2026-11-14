/**
 * Every iPod but the Original carries a list homemini writes (2026-11-07, Jake: "the evil ipod
 * gets a playlist like the top 1000 ipod does ... i cannot manually add songs in there").
 *
 *   • the parser (common/ipod-list-doc.ts) refuses junk
 *   • the pre-sync refresh (ipod-list-pool.ts): reachable / unreachable / 404 / garbage / over-cap,
 *     and nothing but a clean list ever rewrites the iPod's pool file
 *   • main's pool edits (ipc/activity-pool-ipc.ts) refuse a non-Original iPod
 *   • the sync builds a list-only iPod's set from the refreshed file (workout-sync-ipc.ts)
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  IPOD_LIST_MAX, ipodListPlaylistId, listOrderFromPool, parseIpodList, parseIpodListPlaylistId,
  poolEditRefusal, poolOrderFromList,
} from '../../common/ipod-list-doc.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { refreshIpodPool } from '../ipod-list-pool.ts'
import type { FetchLike } from '../top1000-client.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'
import { poolFileFor } from '../ipod-identity.ts'

const EVIL_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const now = '2026-11-07T00:00:00.000Z'
const evil = buildDeviceMarker({ id: EVIL_ID, name: 'iPod EVIL', color: 'red', purpose: 'Red Hot Rock', primary: false, now })!
const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now })!

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVIL_ID, name: 'iPod EVIL', purpose: 'Red Hot Rock', cap: 1000,
    ids: [30, 20, 10],
    adds: [{ id: 30, at: now, by: 'claude', why: 'asked for it' }, { id: 20, at: now, by: 'brain' }, { id: 10, at: now, by: 'seed' }],
    removed: [],
    updatedAt: now,
    brain: { enabled: true, perDay: 3 },
    ...over,
  }
}

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}
function writePool(path: string, ids: number[], updatedAt = '2026-11-06T15:04:00.000Z'): string {
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify({ ids, names: Object.fromEntries(ids.map((id) => [String(id), { t: `Song ${id}`, a: 'Band' }])), updatedAt }, null, 2)
  writeFileSync(path, body)
  return body
}

describe('the iPod list parser', () => {
  it('reads a clean list, newest first, and keeps the history', () => {
    const l = parseIpodList(doc(), EVIL_ID)
    assert.ok(l)
    assert.deepEqual(l.ids, [30, 20, 10])
    assert.equal(l.cap, 1000)
    assert.equal(l.adds.length, 3)
    assert.equal(l.adds[0]!.why, 'asked for it')
    assert.deepEqual(l.brain, { enabled: true, perDay: 3 })
  })
  it('reads the grow cadence when homemini sends one; an old list has none; a bad one is dropped, never the list', () => {
    assert.deepEqual(parseIpodList(doc({ brain: { enabled: true, perDay: 3, everyDays: 14, perRun: 10 } }))?.brain,
      { enabled: true, perDay: 3, everyDays: 14, perRun: 10 })
    assert.equal('everyDays' in parseIpodList(doc())!.brain, false)
    for (const bad of [{ everyDays: 0 }, { everyDays: 61 }, { everyDays: 1.5 }, { everyDays: '14' }, { perRun: -1 }, { perRun: 51 }]) {
      const l = parseIpodList(doc({ brain: { enabled: true, perDay: 3, ...bad } }))
      assert.ok(l, JSON.stringify(bad))
      assert.deepEqual(l.brain, { enabled: true, perDay: 3 }, JSON.stringify(bad))
    }
  })
  it('an empty list is a list (a slow build starts at nothing)', () => {
    assert.deepEqual(parseIpodList(doc({ ids: [], adds: [] }))?.ids, [])
  })
  it('refuses junk', () => {
    const junk: unknown[] = [
      null, 'list', [], 42,
      doc({ id: 'Not An Id!' }),
      doc({ name: '' }),
      doc({ cap: 0 }), doc({ cap: 5001 }), doc({ cap: 1.5 }), doc({ cap: '1000' }),
      // with no songs, only the cap's own bounds refuse these (review of PR 413)
      doc({ cap: 0, ids: [] }), doc({ cap: -1, ids: [] }), doc({ cap: -5000, ids: [] }), doc({ cap: 5001, ids: [] }),
      doc({ ids: 'x' }), doc({ ids: [1, 2, '3'] }), doc({ ids: [1, 2.5] }), doc({ ids: [0] }), doc({ ids: [-4] }),
      doc({ ids: [5, 6, 5] }),
      doc({ updatedAt: '' }), doc({ updatedAt: undefined }),
    ]
    for (const j of junk) assert.equal(parseIpodList(j), null, JSON.stringify(j))
  })
  it('refuses another iPod’s list', () => {
    assert.equal(parseIpodList(doc(), 'original-58ebb78e'), null)
  })
  it('refuses a list over its cap, and any cap over 5000', () => {
    assert.equal(IPOD_LIST_MAX, 5000)
    assert.equal(parseIpodList(doc({ cap: 2, ids: [3, 2, 1] })), null)
    const big = Array.from({ length: IPOD_LIST_MAX + 1 }, (_, i) => i + 1)
    assert.equal(parseIpodList(doc({ cap: IPOD_LIST_MAX + 1, ids: big })), null)
    assert.equal(parseIpodList(doc({ cap: IPOD_LIST_MAX, ids: big })), null)
    // a list still at homemini's first cap can't carry more than that
    assert.equal(parseIpodList(doc({ cap: 1000, ids: big.slice(0, 1001) })), null)
  })
  it('a list whose cap homemini raised carries every song, to 5000 (2026-11-13)', () => {
    const ids = Array.from({ length: IPOD_LIST_MAX }, (_, i) => i + 1)
    const l = parseIpodList(doc({ cap: IPOD_LIST_MAX, ids }))
    assert.equal(l?.cap, 5000)
    assert.equal(l?.ids.length, 5000)
    assert.deepEqual([l?.ids[0], l?.ids[4999]], [1, 5000])
    assert.equal(parseIpodList(doc({ cap: 1834, ids: ids.slice(0, 1834) }))?.ids.length, 1834)
  })
  it('drops a bad history entry without refusing the list', () => {
    const l = parseIpodList(doc({ adds: [{ id: 30, at: now, by: 'jake' }, { id: 'x', at: now, by: 'brain' }, { id: 20, at: now, by: 'brain' }], removed: 'nope', brain: null }))
    assert.deepEqual(l?.adds.map((a) => a.id), [20])
    assert.deepEqual(l?.removed, [])
    assert.deepEqual(l?.brain, { enabled: false, perDay: 0 })
  })
  it('list order and pool (drop) order are each other reversed', () => {
    assert.deepEqual(poolOrderFromList([30, 20, 10]), [10, 20, 30])
    assert.deepEqual(listOrderFromPool([10, 20, 30]), [30, 20, 10])
  })
  it('the sidebar id round-trips and refuses anything else', () => {
    assert.equal(parseIpodListPlaylistId(ipodListPlaylistId(EVIL_ID)), EVIL_ID)
    assert.equal(parseIpodListPlaylistId('top-1000'), null)
    assert.equal(parseIpodListPlaylistId('ipod-list-'), null)
    assert.equal(parseIpodListPlaylistId(null), null)
  })
  it('only the Original’s pool takes edits by hand', () => {
    assert.equal(poolEditRefusal(null), null)
    assert.equal(poolEditRefusal(original), null)
    assert.match(poolEditRefusal(evil) || '', /iPod EVIL’s list is kept on homemini.*asking Claude, or by the brain/)
  })
})

describe('the iPod list client', () => {
  const fake = (status: number | 'throw', body: unknown, seen: string[] = []): FetchLike => async (url) => {
    seen.push(url)
    if (status === 'throw') throw new Error('connect ECONNREFUSED')
    return { ok: status === 200, status, json: async () => body }
  }
  it('asks /api/ipod-lists/<id> on homemini', async () => {
    const seen: string[] = []
    const r = await createIpodListClient({ baseUrl: 'http://homemini:3000/', fetchImpl: fake(200, doc(), seen), warn: () => {} }).get(EVIL_ID)
    assert.equal(seen[0], `http://homemini:3000/api/ipod-lists/${EVIL_ID}`)
    assert.equal(r.kind, 'ok')
  })
  it('404 is "no list yet", a dead link is offline, anything else is bad', async () => {
    const c = (s: number | 'throw', b: unknown) => createIpodListClient({ baseUrl: 'http://h', fetchImpl: fake(s, b), warn: () => {} }).get(EVIL_ID)
    assert.equal((await c(404, { error: 'no list' })).kind, 'none')
    assert.equal((await c('throw', null)).kind, 'offline')
    assert.equal((await c(500, doc())).kind, 'bad')
    assert.equal((await c(401, null)).kind, 'bad')
    assert.equal((await c(200, { nope: true })).kind, 'bad')
    assert.equal((await c(200, doc({ id: 'original-58ebb78e' }))).kind, 'bad', 'another iPod’s list')
  })
})

describe('the pre-sync refresh of a list iPod’s pool file', () => {
  const fmt = (iso: string) => `T(${iso.slice(0, 10)})`
  const base = (poolFile: string, ask: Parameters<typeof refreshIpodPool>[0]['ask']) => ({
    poolFile, ipodName: 'iPod EVIL', ask, formatTime: fmt, now: () => new Date('2026-11-07T12:00:00.000Z'),
    nameOf: (id: number) => ({ t: `Library ${id}`, a: 'Lib' }),
  })

  it('reachable: the file becomes homemini’s list, in drop order, with names', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    writePool(pool, [1, 2, 10])
    const list = parseIpodList(doc({ ids: [40, 30, 10] }))!
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list })))
    assert.equal(r.source, 'homemini')
    assert.equal(r.note, null)
    assert.deepEqual(r.listIds, [40, 30, 10])
    assert.deepEqual(r.poolIds, [10, 30, 40])
    const file = JSON.parse(readFileSync(pool, 'utf-8'))
    assert.deepEqual(file.ids, [10, 30, 40])
    assert.deepEqual(file.names['10'], { t: 'Song 10', a: 'Band' }, 'a name the file already knew is kept')
    assert.deepEqual(file.names['40'], { t: 'Library 40', a: 'Lib' }, 'a new song is named from the library')
    assert.equal(file.names['1'], undefined)
    assert.equal(file.updatedAt, '2026-11-07T12:00:00.000Z')
  })

  it('reachable: homemini\'s grow cadence rides along for the sync-ready check', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const withCadence = parseIpodList(doc({ brain: { enabled: true, perDay: 3, everyDays: 14, perRun: 10 } }))!
    assert.equal((await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list: withCadence })))).everyDays, 14)
    const plain = parseIpodList(doc())!
    assert.equal('everyDays' in (await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list: plain })))), false)
  })

  it('reachable with no file yet: the file is made', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list: parseIpodList(doc())! })))
    assert.deepEqual(r.poolIds, [10, 20, 30])
    assert.deepEqual(JSON.parse(readFileSync(pool, 'utf-8')).ids, [10, 20, 30])
  })

  it('unreachable: the last good file, untouched, and the note says from when', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, [1, 2, 3])
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'offline', error: 'timeout' })))
    assert.equal(r.source, 'local')
    assert.deepEqual(r.poolIds, [1, 2, 3])
    assert.deepEqual(r.listIds, [3, 2, 1])
    assert.equal(r.note, 'homemini didn’t answer — using the list from T(2026-11-06).')
    assert.equal(readFileSync(pool, 'utf-8'), before)
  })

  it('unreachable because ask itself throws: same as offline', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    writePool(pool, [1, 2, 3])
    const r = await refreshIpodPool(base(pool, async () => { throw new Error('boom') }))
    assert.deepEqual(r.poolIds, [1, 2, 3])
    assert.match(r.note || '', /homemini didn’t answer/)
  })

  it('unreachable with no file: nothing, and it says so', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'offline', error: 'x' })))
    assert.deepEqual(r.poolIds, [])
    assert.match(r.note || '', /no copy of iPod EVIL’s list yet/)
    assert.equal(existsSync(pool), false)
  })

  it('404: the local pool stays as it is (the 500 start here and are seeded to homemini later)', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, Array.from({ length: 500 }, (_, i) => i + 1))
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'none' })))
    assert.equal(r.poolIds.length, 500)
    assert.equal(r.source, 'local')
    assert.match(r.note || '', /no list for iPod EVIL yet/)
    assert.equal(readFileSync(pool, 'utf-8'), before)
  })

  it('garbage: never empties the pool, through the real client', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, [7, 8, 9])
    for (const body of [null, 'oops', { ids: [] }, doc({ ids: [1, 1] }), doc({ ids: ['a'] })]) {
      const client = createIpodListClient({ baseUrl: 'http://h', fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }), warn: () => {} })
      const r = await refreshIpodPool(base(pool, () => client.get(EVIL_ID)))
      assert.deepEqual(r.poolIds, [7, 8, 9], JSON.stringify(body))
      assert.match(r.note || '', /came back unreadable/)
      assert.equal(readFileSync(pool, 'utf-8'), before)
    }
  })

  it('over the cap: refused as junk, the pool stays', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, [7, 8, 9])
    const over = Array.from({ length: 1001 }, (_, i) => i + 1)
    for (const body of [doc({ ids: over }), doc({ cap: 2, ids: [3, 2, 1] }), doc({ cap: 5001, ids: [1] })]) {
      const client = createIpodListClient({ baseUrl: 'http://h', fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }), warn: () => {} })
      const r = await refreshIpodPool(base(pool, () => client.get(EVIL_ID)))
      assert.deepEqual(r.poolIds, [7, 8, 9])
      assert.equal(readFileSync(pool, 'utf-8'), before)
    }
  })

  it('an empty list from homemini never wipes a pool that has songs', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, [7, 8, 9])
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list: parseIpodList(doc({ ids: [] }))! })))
    assert.deepEqual(r.poolIds, [7, 8, 9])
    assert.match(r.note || '', /is empty/)
    assert.equal(readFileSync(pool, 'utf-8'), before)
  })

  it('the same list again does not rewrite the file', async () => {
    const pool = poolFileFor(tmp('jt-ipl-'), evil)
    const before = writePool(pool, [10, 20, 30])
    const r = await refreshIpodPool(base(pool, async () => ({ kind: 'ok', list: parseIpodList(doc())! })))
    assert.equal(r.source, 'homemini')
    assert.equal(readFileSync(pool, 'utf-8'), before)
  })
})

describe('the sync builds a list iPod’s set from the refreshed file (source lock)', () => {
  const src = readFileSync(new URL('../workout-sync-ipc.ts', import.meta.url), 'utf-8')
  it('asks for the list before the split, and uses it over the renderer’s copy', () => {
    const ask = src.indexOf('host.listOnlyPool()')
    const split = src.indexOf('splitForIpod(')
    assert.ok(ask > 0 && split > ask, 'listOnlyPool is asked before the split')
    assert.match(src, /poolIn = \{ ids: fresh\.ids, fill: false \}/)
    assert.match(src, /listNote \? `\$\{listOnlyLine\(split, listOnlyName\)\} \$\{listNote\}`/, 'the note rides on the review line')
  })
  it('index.ts wires it, and the pool page’s refresh', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8')
    assert.match(index, /listOnlyPool: \(\) => ipodLists\.refreshPlugged\(detectedIpodMount\)/)
    assert.match(index, /listPool: \(device\) => ipodLists\.refresh\(device\)/)
  })
})

// ── main's pool edits refuse a non-Original iPod ─────────────────────────────
// activity-pool-ipc.ts asks electron for userData; the headless scripts' stub stands in.
const userData = tmp('jt-ipl-userdata-')
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerActivityPoolIpc } = await import('../ipc/activity-pool-ipc.ts')

type Handler = (e: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>
function harness(plugged: () => typeof evil | null) {
  const handlers = new Map<string, Handler>()
  registerActivityPoolIpc({ handle: (ch: string, fn: unknown) => { handlers.set(ch, fn as Handler) } } as never, {
    hubBase: async () => null,
    currentIpod: async () => plugged(),
  })
  return (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args)
}

describe('pool edits by hand: the Original only', () => {
  const evilPool = poolFileFor(userData, evil)
  const originalPool = poolFileFor(userData, null)
  const song = (id: number) => ({ id, title: `Song ${id}`, artist: 'Band', duration: 240_000 })

  it('with iPod EVIL plugged in, add / remove / swap / clear are refused and its file is untouched', async () => {
    const before = writePool(evilPool, [1, 2, 3])
    const call = harness(() => evil)
    for (const [ch, args] of [
      ['activity-pool-add', [[song(99)]]],
      ['activity-pool-remove', [[1]]],
      ['activity-pool-swap', [{ oldId: 1, newId: 99 }]],
      ['activity-pool-clear', []],
    ] as const) {
      const r = await call(ch, ...(args as unknown[]))
      assert.equal(r.ok, false, ch)
      assert.match(String(r.error), /iPod EVIL’s list is kept on homemini/, ch)
    }
    assert.equal(readFileSync(evilPool, 'utf-8'), before)
  })

  it('its page reads the list, marked managed (read-only)', async () => {
    writePool(evilPool, [1, 2, 3])
    const r = await harness(() => evil)('activity-pool-get')
    assert.equal(r.ok, true)
    assert.equal(r.managed, true)
    assert.deepEqual(r.ids, [1, 2, 3])
  })

  it('the Original (and no iPod) still takes drops, removals and a clear', async () => {
    for (const plugged of [() => original, () => null]) {
      writePool(originalPool, [5])
      const call = harness(plugged as () => typeof evil | null)
      const add = await call('activity-pool-add', [song(6)])
      assert.equal(add.ok, true)
      assert.deepEqual(JSON.parse(readFileSync(originalPool, 'utf-8')).ids, [5, 6])
      assert.equal((await call('activity-pool-remove', [5])).ok, true)
      assert.equal((await call('activity-pool-clear')).ok, true)
      assert.deepEqual(JSON.parse(readFileSync(originalPool, 'utf-8')).ids, [])
      const page = await call('activity-pool-get')
      assert.notEqual(page.managed, true)
    }
  })
})
