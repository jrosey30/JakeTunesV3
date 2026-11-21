/**
 * A list iPod's Sync fetches its own missing songs (Brief 263, 2026-11-20).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  applySupersededReceipts, createKeyedLock, fetchForSync, landingRoomRefusal, parseSupersededReceipts, ROOM_UNKNOWN_ERROR, supersedeReceipt, syncFetchLogLine, type SyncFetchOne,
} from '../ipod-sync-fetch.ts'
import { NO_ROOM_FOR_SYNC_LINE, ROOM_UNKNOWN_LINE } from '../../common/ipod-ready-on-mac.ts'
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
    assert.deepEqual(r, { landed: [12558], gone: [], unclean: [], failed: [], stopped: false, reason: null })
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
      syncFetchLogLine('punkPod', { landed: [1], gone: [{ id: 2, why: 'homemini doesn’t have the file' }], unclean: [], failed: [], stopped: false, reason: null }),
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
    assert.match(sync, /await land\(item, url, part, \(\) => syncFetchStop, tracks, remote, true\)/)
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

  it('review of #469: a song nothing can prove (stuck) is left off as unclean, not retried, and never stops the sync', async () => {
    let fetches = 0
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait, backoffMs: [1, 1],
      ask: async () => has(1, 2),
      fetchOne: async (i) => { fetches++; return i.id === 1 ? { ok: false, stuck: true, error: 'homemini’s copy isn’t the file this Mac has on record' } : { ok: true } },
    })
    assert.equal(fetches, 2)
    assert.deepEqual(r.gone, [], 'not "gone": homemini has a file')
    assert.deepEqual(r.unclean.map((u) => u.id), [1])
    assert.deepEqual(r.failed, [], 'nothing failed: the sync goes ahead')
    assert.deepEqual(r.landed, [2])
    assert.equal(r.reason, null)
  })

  it('review of #469: a download that never matches homemini’s own identity is tried every round, then left off; one clean try lands it', async () => {
    const tries = new Map<number, number>()
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait, backoffMs: [1, 1, 1],
      ask: async () => has(1, 2),
      fetchOne: async (i) => {
        const n = (tries.get(i.id) ?? 0) + 1
        tries.set(i.id, n)
        if (i.id === 2 && n === 3) return { ok: true }
        return { ok: false, torn: true, error: 'its sha1 isn’t the one homemini gave for it' }
      },
    })
    assert.equal(tries.get(1), 4, 'every round')
    assert.deepEqual(r.landed, [2])
    assert.deepEqual(r.unclean, [{ id: 1, why: 'its sha1 isn’t the one homemini gave for it' }])
    assert.deepEqual(r.failed, [])
    assert.equal(r.reason, null)
    assert.match(syncFetchLogLine('punkPod', r), /1 couldn’t be fetched cleanly, left off \(first: id 1:/)
  })

  it('review of #469: a torn try followed by homemini not answering is a failure, not left off', async () => {
    let round = 0
    const r = await fetchForSync({
      items: [item(1)], wait: noWait, backoffMs: [1],
      ask: async () => (round++ === 0 ? has(1) : { kind: 'unreachable' }),
      fetchOne: async () => ({ ok: false, torn: true, error: 'torn' }),
    })
    assert.deepEqual(r.unclean, [])
    assert.deepEqual(r.failed.map((f) => f.id), [1])
  })

  it('review of #469: free space that can’t be read stops the fetch with its own line, not "not enough room"', async () => {
    const r = await fetchForSync({
      items: [item(1), item(2)], wait: noWait, backoffMs: [1],
      ask: async () => has(1, 2),
      fetchOne: async () => ({ ok: false, noRoom: true, error: String(landingRoomRefusal(Number.NaN, { bytes: 1 })) }),
    })
    assert.equal(r.reason, ROOM_UNKNOWN_LINE)
    assert.equal(ROOM_UNKNOWN_LINE, 'Couldn’t check free space on this Mac.')
    assert.deepEqual(r.failed.map((f) => f.id), [1, 2])
  })

  it('room is checked before a download: both copies counted, the 10 GB floor kept, unknown free refuses', () => {
    const song = { bytes: 50e6 }
    assert.equal(landingRoomRefusal(MATERIALIZE_FREE_FLOOR_BYTES + 200e6, song), null)
    assert.match(String(landingRoomRefusal(MATERIALIZE_FREE_FLOOR_BYTES + 60e6, song)), /^not enough room on this Mac/, 'the part and the restore’s copy exist at once')
    assert.match(String(landingRoomRefusal(9 * GB, song)), /not enough room/)
    assert.equal(landingRoomRefusal(Number.NaN, song), ROOM_UNKNOWN_ERROR, 'unknown free refuses, and says so')
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

  it('the wiring: land() holds the song’s lock, checks room before downloading, a refuse is settled by homemini’s identity, a stop and a start clear the parts', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../ipod-local-start.ts', import.meta.url), 'utf-8')
    const land = src.slice(src.indexOf('function land('), src.indexOf('// A Sync’s own fetch'))
    assert.match(land, /return songLock\(item\.id, async/)
    assert.ok(land.indexOf('landingRoomRefusal(') > 0 && land.indexOf('landingRoomRefusal(') < land.indexOf('fetchResumable('), 'room is asked before anything is downloaded')
    assert.ok(land.indexOf("=== 'local'") < land.indexOf('fetchResumable('), 'a song the other writer brought is not downloaded again')
    const sync = src.slice(src.indexOf('async function fetchSongsForSync'), src.indexOf("host.ipc.handle('ipod-local:fetch-for-sync'"))
    assert.match(sync, /if \(!proven\) return \{ ok: false, stuck: true/, 'only an unprovable refuse is left off')
    assert.match(sync, /verdict = 'fetch'/, 'a proven refuse is fetched and checked against homemini’s own identity')
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

describe('review of #469: a song re-tagged on homemini after it left this Mac', () => {
  const colon = ':iPod_Control:Music:F08:imported_7.m4a'
  const oldEv = { md5: '1'.repeat(32), bytes: 10 }
  const now = { sha1: 'c'.repeat(40), md5: '2'.repeat(32), bytes: 12 }

  it('the superseded receipt replaces the old one while the old one is still on file; a newer receipt wins', () => {
    const doc = supersedeReceipt({}, { id: 7, colon, evicted: oldEv, fullSha1: 'a'.repeat(40) }, now, 1)
    const round = parseSupersededReceipts(JSON.stringify(doc))
    assert.deepEqual(round, doc)
    const a = applySupersededReceipts(new Map([[colon, 'a'.repeat(40)]]), new Map([[colon, { ...oldEv, when: 'x' }]]), round)
    assert.equal(a.fullSha1ByPath.get(colon), now.sha1)
    assert.deepEqual({ md5: a.evictedByPath.get(colon)!.md5, bytes: a.evictedByPath.get(colon)!.bytes }, { md5: now.md5, bytes: now.bytes })
    // This Mac evicted the path again since: its own new receipt stands.
    const newer = { md5: '3'.repeat(32), bytes: 99 }
    const b = applySupersededReceipts(new Map([[colon, 'a'.repeat(40)]]), new Map([[colon, newer]]), round)
    assert.deepEqual(b.evictedByPath.get(colon), newer)
    assert.equal(b.fullSha1ByPath.get(colon), 'a'.repeat(40))
    // No receipt on the item: nothing to supersede.
    const none = {}
    assert.equal(supersedeReceipt(none, { id: 7, colon }, now, 1), none)
    assert.deepEqual(parseSupersededReceipts('not json'), {})
  })

  /**
   * The real path end to end: startIpodLocal's Sync fetch against a homemini on
   * 127.0.0.1 that serves a re-tagged file (12 bytes; this Mac evicted 10).
   */
  async function withHomemini(body: () => Buffer, fn: (o: { dir: string; base: string; notes: string[]; fetchForSync: (ids: number[]) => Promise<{ ok: boolean; landed?: number[]; gone?: number[]; unclean?: number[]; failed?: number[]; reason?: string | null }> }) => Promise<void>): Promise<void> {
    const http = await import('node:http')
    const { mkdir } = await import('node:fs/promises')
    const served = Buffer.from('retagged-new')   // what homemini says its file is
    const sha1 = createHash('sha1').update(served).digest('hex')
    const server = http.createServer((req, res) => {
      const url = req.url || ''
      if (url.startsWith('/api/audio-identity')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ files: { 7: { size: served.length, sha1, etag: '"e7"' } } }))
        return
      }
      if (url === '/audio/7') {
        const b = body()
        res.writeHead(200, { 'content-length': String(b.length), etag: '"e7"' })
        res.end(b)
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    const dir = await mkdtemp(join(tmpdir(), 'jt-sync-retag-'))
    try {
      await mkdir(join(dir, 'iPod_Control', 'Music', 'F08'), { recursive: true })
      await writeFile(join(dir, 'evictions.log'), JSON.stringify({ when: 'w', rel: 'F08/imported_7.m4a', md5: '1'.repeat(32), bytes: 10 }) + '\n')
      const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
      const notes: string[] = []
      const { startIpodLocal } = await import('../ipod-local-start.ts')
      startIpodLocal({
        ipc: { handle: (name: string, h: (...a: unknown[]) => Promise<unknown>) => { handlers.set(name, h) } } as never,
        userDataDir: dir, stateDir: dir, baseUrl: base, audioBase: `${base}/audio`,
        isReplica: async () => false, libraryTracks: async () => [{ id: 7, path: colon, fileSize: 10 }], localMount: () => dir, pathSep: '/',
        isPlaying: () => false, syncInFlight: () => false, freeBytes: async () => 100 * 1024 ** 3, libraryRefused: async () => null,
        materialize: async (c, _id, fetchAudio) => {
          const got = await fetchAudio('x')
          await writeFile(join(dir, ...c.split(':').filter(Boolean)), got.buffer)
          return { ok: true }
        },
        mount: () => null, isAway: async () => false, fingerprintOf: async () => null, tellLibrary: () => {}, ineligible: async () => new Set(),
        log: () => {}, warn: (m) => notes.push(m), note: (m) => notes.push(m), syncFetchBackoffMs: [1, 1],
      })
      const fetchForSync = async (ids: number[]) => (await handlers.get('ipod-local:fetch-for-sync')!({}, ids, 'punkPod')) as never
      await fn({ dir, base, notes, fetchForSync })
    } finally {
      server.close()
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('homemini’s own size and sha1 match: it lands, the receipt is superseded, one line names the id, and the sync goes ahead', async () => {
    const { readFile } = await import('node:fs/promises')
    await withHomemini(() => Buffer.from('retagged-new'), async ({ dir, notes, fetchForSync }) => {
      const r = await fetchForSync([7])
      assert.equal(r.ok, true)
      assert.deepEqual(r.landed, [7])
      assert.deepEqual(r.failed, [])
      assert.deepEqual(r.unclean, [])
      assert.equal(r.reason, null)
      assert.equal(await readFile(join(dir, 'iPod_Control', 'Music', 'F08', 'imported_7.m4a'), 'utf-8'), 'retagged-new')
      const doc = parseSupersededReceipts(await readFile(join(dir, 'ipod-receipts-superseded.json'), 'utf-8'))
      assert.equal(doc[colon]?.now.bytes, 12)
      assert.equal(doc[colon]?.now.md5, createHash('md5').update('retagged-new').digest('hex'))
      const line = notes.filter((n) => /homemini’s own size and sha1 match/.test(n))
      assert.equal(line.length, 1)
      assert.match(line[0], /id 7\b/)
    })
  })

  it('homemini’s download never matches its own identity: tried again, then left off, and the sync still goes ahead', async () => {
    const { readFile } = await import('node:fs/promises')
    let served = 0
    await withHomemini(() => { served++; return Buffer.from('torn-bytes!!') }, async ({ dir, fetchForSync }) => {
      const r = await fetchForSync([7])
      assert.equal(r.ok, true)
      assert.equal(served, 3, 'every round')
      assert.deepEqual(r.landed, [])
      assert.deepEqual(r.unclean, [7])
      assert.deepEqual(r.failed, [])
      assert.equal(r.reason, null)
      await assert.rejects(readFile(join(dir, 'iPod_Control', 'Music', 'F08', 'imported_7.m4a')), 'nothing unproven lands')
      await assert.rejects(readFile(join(dir, 'ipod-receipts-superseded.json')), 'the receipt is untouched')
    })
  })
})
