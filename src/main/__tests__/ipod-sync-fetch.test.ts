/**
 * A list iPod's Sync fetches its own missing songs (Brief 263, 2026-11-20).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createKeyedLock, fetchForSync, landingRoomRefusal, syncFetchLogLine, type SyncFetchOne } from '../ipod-sync-fetch.ts'
import { NO_ROOM_FOR_SYNC_LINE } from '../../common/ipod-ready-on-mac.ts'
import { MATERIALIZE_FREE_FLOOR_BYTES } from '../ipod-sync-materialize.ts'
import { notHomeminisFile } from '../ipod-local-start.ts'
import type { IdentityAnswer, IdentityEntry } from '../audio-identity.ts'
import type { PrefetchItem } from '../ipod-prefetch.ts'

const item = (id: number): PrefetchItem => ({ id, colon: `:iPod_Control:Music:F08:imported_${id}.m4a`, bytes: 8_036_287 })
const has = (...ids: number[]): IdentityAnswer => ({ kind: 'answers', byId: new Map(ids.map((id) => [String(id), { size: 1, sha1: 'a'.repeat(40), etag: '"e"' }])) })
const noWait = async (): Promise<void> => {}

describe('fetchForSync', () => {
  it('2026-11-20: Kraken, on homemini, is fetched by the sync itself whatever the background download said', async () => {
    const fetched: number[] = []
    const r = await fetchForSync({
      items: [item(12558)], ask: async () => has(12558), wait: noWait,
      fetchOne: async (i) => { fetched.push(i.id); return { ok: true } },
    })
    assert.deepEqual(r, { landed: [12558], gone: [], failed: [], stopped: false, reason: null })
    assert.deepEqual(fetched, [12558])
  })

  it('a song homemini has no file for is "gone" at once, never retried, and the others still come', async () => {
    let asks = 0
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait,
      ask: async () => { asks++; return { kind: 'answers', byId: new Map<string, IdentityEntry>([['1', null], ['2', { size: 1, sha1: 'b'.repeat(40), etag: '"x"' }]]) } },
      fetchOne: async () => ({ ok: true }),
    })
    assert.deepEqual(r.landed, [2])
    assert.deepEqual(r.gone.map((g) => g.id), [1])
    assert.equal(asks, 1)
  })

  it('a 404 is gone; a passing failure is tried again with waits', async () => {
    const waits: number[] = []
    let tries = 0
    const r = await fetchForSync({
      items: [item(1), item(2), item(3)], ask: async () => has(1, 2, 3), wait: async (ms) => { waits.push(ms) },
      backoffMs: [5, 10],
      fetchOne: async (i): Promise<SyncFetchOne> => {
        if (i.id === 1) return { ok: false, gone: true, error: 'homemini doesn’t have the file' }
        if (i.id === 2) return { ok: false, gone: true, error: 'homemini doesn’t have the file' }
        tries++
        return tries < 3 ? { ok: false, error: 'homemini: fetch failed' } : { ok: true }
      },
    })
    assert.deepEqual(r.landed, [3])
    assert.deepEqual(r.gone.map((g) => g.id), [1, 2])
    assert.deepEqual(r.failed, [])
    assert.deepEqual(waits, [5, 10])
  })

  it('still not here after every try: failed, with the last reason', async () => {
    const r = await fetchForSync({
      items: [item(1)], ask: async () => has(1), wait: noWait, backoffMs: [1, 1, 1],
      fetchOne: async () => ({ ok: false, error: 'not enough room on this Mac' }),
    })
    assert.deepEqual(r.failed, [{ id: 1, error: 'not enough room on this Mac' }])
    assert.deepEqual(r.landed, [])
  })

  it('homemini not answering is asked again; answering on a later round is enough', async () => {
    let round = 0
    const r = await fetchForSync({
      items: [item(1)], wait: noWait, backoffMs: [1, 1],
      ask: async () => (++round < 3 ? { kind: 'unreachable' } : has(1)),
      fetchOne: async () => ({ ok: true }),
    })
    assert.deepEqual(r.landed, [1])
    const never = await fetchForSync({ items: [item(1)], wait: noWait, backoffMs: [1], ask: async () => ({ kind: 'unreachable' }), fetchOne: async () => ({ ok: true }) })
    assert.deepEqual(never.failed, [{ id: 1, error: 'homemini didn’t answer' }])
  })

  it('an older homemini that can’t say what it holds: the fetch decides (remote undefined)', async () => {
    const seen: Array<IdentityEntry | undefined> = []
    await fetchForSync({ items: [item(1)], wait: noWait, ask: async () => ({ kind: 'unsupported' }), fetchOne: async (_i, remote) => { seen.push(remote); return { ok: true } } })
    assert.deepEqual(seen, [undefined])
  })

  it('a song another fetch brought meanwhile is not fetched twice', async () => {
    const r = await fetchForSync({ items: [item(1)], wait: noWait, ask: async () => has(1), isHere: async () => true, fetchOne: async () => { throw new Error('must not fetch') } })
    assert.deepEqual(r.landed, [1])
  })

  it('Stop ends it: nothing is called failed', async () => {
    let stop = false
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait, ask: async () => has(1, 2), shouldStop: () => stop,
      fetchOne: async () => { stop = true; return { ok: false, error: 'x' } },
    })
    assert.equal(r.stopped, true)
    assert.deepEqual(r.failed, [])
  })

  it('the log line names what happened', () => {
    assert.equal(
      syncFetchLogLine('punkPod', { landed: [1], gone: [{ id: 2, why: 'homemini doesn’t have the file' }], failed: [], stopped: false, reason: null }),
      '[ipod-local] sync of punkPod: fetched 1 song(s) from homemini · 1 left off (first: id 2: homemini doesn’t have the file)',
    )
  })
})

describe('the fetched file against homemini’s audio-identity', () => {
  it('size and whole-file sha1 must both be what homemini said', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-sync-fetch-'))
    try {
      const part = join(dir, '1.part')
      const bytes = Buffer.from('the song')
      await writeFile(part, bytes)
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      assert.equal(await notHomeminisFile(part, { size: bytes.length, sha1 }), null)
      assert.match((await notHomeminisFile(part, { size: bytes.length + 1, sha1 }))!, /said 9 bytes and sent 8/)
      assert.match((await notHomeminisFile(part, { size: bytes.length, sha1: 'f'.repeat(40) }))!, /sha1/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the wiring: the sync’s fetch goes through the same land() as the background pass, with homemini’s answer', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../ipod-local-start.ts', import.meta.url), 'utf-8')
    const sync = src.slice(src.indexOf('async function fetchSongsForSync'), src.indexOf("host.ipc.handle('ipod-local:fetch-for-sync'"))
    assert.match(sync, /await land\(item, url, part, \(\) => syncFetchStop, tracks, remote\)/)
    assert.doesNotMatch(sync, /isPlaying|prefetchFloorFor/, 'Jake pressed Sync: music playing or under 60 GB free never stops it')
    assert.match(src, /note\(syncFetchLogLine\(ipodName, result\)\)/, 'what it did is in main.log')
  })
})

describe('review of #466', () => {
  const GB = 1024 ** 3
  it('no room: the fetch stops at once, nothing is tried again, and one plain line says so', async () => {
    let asks = 0
    let fetches = 0
    const waits: number[] = []
    const r = await fetchForSync({
      items: [item(1), item(2), item(3)], wait: async (ms) => { waits.push(ms) }, backoffMs: [1, 1, 1],
      ask: async () => { asks++; return has(1, 2, 3) },
      fetchOne: async () => { fetches++; return { ok: false, noRoom: true, error: 'not enough room on this Mac: free disk would drop below 10.0 GB (9.0 GB free)' } },
    })
    assert.equal(fetches, 1, 'the second and third songs are never downloaded')
    assert.equal(asks, 1)
    assert.deepEqual(waits, [], 'no retries')
    assert.deepEqual(r.failed.map((f) => f.id), [1, 2, 3])
    assert.equal(r.reason, NO_ROOM_FOR_SYNC_LINE)
  })

  it('homemini’s file isn’t this Mac’s record (a re-tag): stuck, not gone, not retried, said plainly', async () => {
    let fetches = 0
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait, backoffMs: [1, 1],
      ask: async () => has(1, 2),
      fetchOne: async (i) => { fetches++; return i.id === 1 ? { ok: false, stuck: true, error: 'homemini’s copy isn’t the file this Mac has on record' } : { ok: true } },
    })
    assert.equal(fetches, 2)
    assert.deepEqual(r.gone, [], 'a changed file is never "gone": the sync must not quietly leave it off')
    assert.deepEqual(r.failed.map((f) => f.id), [1])
    assert.deepEqual(r.landed, [2])
    assert.equal(r.reason, '1 song on homemini isn’t the same file this Mac had, so Sync can’t use it yet.')
  })

  it('room is checked before a download: both copies counted, the 10 GB floor kept, unknown free refuses', () => {
    const song = { bytes: 50e6 }
    assert.equal(landingRoomRefusal(MATERIALIZE_FREE_FLOOR_BYTES + 200e6, song), null)
    assert.match(String(landingRoomRefusal(MATERIALIZE_FREE_FLOOR_BYTES + 60e6, song)), /^not enough room on this Mac/, 'the part and the restore’s copy exist at once')
    assert.match(String(landingRoomRefusal(9 * GB, song)), /not enough room/)
    assert.match(String(landingRoomRefusal(Number.NaN, song)), /not enough room/)
    // homemini's size wins over a drifted library size.
    assert.match(String(landingRoomRefusal(MATERIALIZE_FREE_FLOOR_BYTES + 200e6, song, { size: 150e6, sha1: 'a'.repeat(40), etag: '"e"' })), /not enough room/)
  })

  it('one writer per song: a second land of the same song waits for the first; other songs don’t', async () => {
    const lock = createKeyedLock<number>()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const a = lock(1, async () => { order.push('a start'); await gate; order.push('a end') })
    const b = lock(1, async () => { order.push('b start') })
    const c = lock(2, async () => { order.push('c start') })
    await c
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(order, ['a start', 'c start'])
    release()
    await Promise.all([a, b])
    assert.deepEqual(order, ['a start', 'c start', 'a end', 'b start'])
    // A throw releases the lock.
    await assert.rejects(lock(3, async () => { throw new Error('x') }))
    assert.equal(await lock(3, async () => 'next'), 'next')
  })

  it('the wiring: land() holds the song’s lock, checks room before downloading, a refuse is stuck, a stop and a start clear the parts', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../ipod-local-start.ts', import.meta.url), 'utf-8')
    const land = src.slice(src.indexOf('function land('), src.indexOf('// A Sync’s own fetch'))
    assert.match(land, /return songLock\(item\.id, async/)
    assert.ok(land.indexOf('landingRoomRefusal(') > 0 && land.indexOf('landingRoomRefusal(') < land.indexOf('fetchResumable('), 'room is asked before anything is downloaded')
    assert.ok(land.indexOf("=== 'local'") < land.indexOf('fetchResumable('), 'a song the other writer brought is not downloaded again')
    const sync = src.slice(src.indexOf('async function fetchSongsForSync'), src.indexOf("host.ipc.handle('ipod-local:fetch-for-sync'"))
    assert.match(sync, /verdict === 'refuse'\) return \{ ok: false, stuck: true/)
    assert.doesNotMatch(sync, /verdict === 'refuse'\) return \{ ok: false, gone: true/)
    assert.match(sync, /if \(result\.stopped\) await rm\(syncPartDir, \{ recursive: true, force: true \}\)/)
    assert.match(src, /void rm\(syncPartDir, \{ recursive: true, force: true \}\)/)
  })

  it('at startup, part files a quit left in ipod-sync-fetch/ are removed', async () => {
    const { mkdir, readdir } = await import('node:fs/promises')
    const { startIpodLocal } = await import('../ipod-local-start.ts')
    const dir = await mkdtemp(join(tmpdir(), 'jt-sync-fetch-start-'))
    try {
      await mkdir(join(dir, 'ipod-sync-fetch'), { recursive: true })
      await writeFile(join(dir, 'ipod-sync-fetch', '12558.part'), 'half a song')
      await writeFile(join(dir, 'ipod-sync-fetch', '12558.part.json'), '{}')
      const handlers: string[] = []
      const ipc = { handle: (name: string) => { handlers.push(name) } }
      startIpodLocal({
        ipc: ipc as never, userDataDir: dir, stateDir: dir, baseUrl: 'http://127.0.0.1:1', audioBase: 'http://127.0.0.1:1/audio',
        isReplica: async () => true, libraryTracks: async () => [], localMount: () => dir, pathSep: '/', isPlaying: () => false, syncInFlight: () => false,
        freeBytes: async () => 100 * GB, libraryRefused: async () => null, materialize: async () => ({ ok: true }), mount: () => null, isAway: async () => false,
        fingerprintOf: async () => null, tellLibrary: () => {}, ineligible: async () => new Set(), log: () => {}, warn: () => {},
      })
      for (let i = 0; i < 50; i++) {
        const left = await readdir(join(dir, 'ipod-sync-fetch')).catch(() => [])
        if (left.length === 0) break
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.deepEqual(await readdir(join(dir, 'ipod-sync-fetch')).catch(() => []), [])
      assert.ok(handlers.includes('ipod-local:fetch-for-sync'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
