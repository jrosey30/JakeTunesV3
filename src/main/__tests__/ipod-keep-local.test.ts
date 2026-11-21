/**
 * iPod songs stay on this Mac (2026-11-08): the keep set, the gate both
 * eviction routes ask, and pass-through eviction honouring it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildKeepDoc, createIpodKeepLocal, gateFor, keepsColon, keepsRel, relOfColon, KEEP_LOCAL_FILE,
  alwaysKeptIds, lastCleanAt, parseKeepDoc, prefetchFloorFor,
  IPOD_KEEP_ASKED_FLOOR_BYTES, IPOD_KEEP_FETCH_FLOOR_BYTES, KEEP_STALE_MS,
  type KeepLocalDoc,
} from '../ipod-keep-local.ts'
import { sweepOnce, EVICT_GRACE_MS, type EvictionDeps } from '../library-eviction.ts'
import { runConvertPass, type StreamConvertItem } from '../stream-convert-pass.ts'

const NOW = '2026-11-08T12:00:00.000Z'
const colon = (id: number) => `:iPod_Control:Music:F${String(id % 50).padStart(2, '0')}:imported_${id}.m4a`
const rel = (id: number) => relOfColon(colon(id))!

describe('the keep set', () => {
  it('is the Top 1000, then the registered iPods’ lists, then the planned ones — no repeats', () => {
    const doc = buildKeepDoc({
      top1000: [5, 3, 9],
      lists: [
        { id: 'planned-aaaa', name: 'Y2K Revival', ids: [40, 3] },
        { id: 'punkpod-bbbb', name: 'punkPod', ids: [20, 9, 21] },
      ],
      registered: new Set(['punkpod-bbbb']),
      previous: null,
      now: NOW,
    })!
    assert.deepEqual(doc.ids, [5, 3, 9, 20, 21, 40])
    assert.equal(doc.complete, true)
    assert.deepEqual(doc.sources.map((s) => [s.name, s.count, s.registered]), [
      ['Top 1000', 3, true], ['punkPod', 3, true], ['Y2K Revival', 2, false],
    ])
  })

  it('unknown until both sources answer once: nothing saved and one source down is null', () => {
    assert.equal(buildKeepDoc({ top1000: [1], lists: null, registered: new Set(), previous: null, now: NOW }), null)
    assert.equal(buildKeepDoc({ top1000: null, lists: [], registered: new Set(), previous: null, now: NOW }), null)
  })

  it('a source that fails never shrinks the set: its last songs stay kept', () => {
    const previous = buildKeepDoc({ top1000: [1, 2], lists: [{ id: 'evil-cccccc', name: 'Evil', ids: [7, 8] }], registered: new Set(), previous: null, now: NOW })!
    const listsDown = buildKeepDoc({ top1000: [1, 3], lists: null, registered: new Set(), previous, now: NOW })!
    assert.deepEqual([...listsDown.ids].sort((a, b) => a - b), [1, 2, 3, 7, 8])
    assert.equal(listsDown.complete, false)
    const topDown = buildKeepDoc({ top1000: null, lists: [{ id: 'evil-cccccc', name: 'Evil', ids: [8] }], registered: new Set(), previous, now: NOW })!
    assert.deepEqual([...topDown.ids].sort((a, b) => a - b), [1, 2, 7, 8])
  })

  it('a clean read may shrink it: a song off every list can be offloaded again', () => {
    const previous = buildKeepDoc({ top1000: [1, 2], lists: [], registered: new Set(), previous: null, now: NOW })!
    const next = buildKeepDoc({ top1000: [1], lists: [], registered: new Set(), previous, now: NOW })!
    assert.deepEqual(next.ids, [1])
  })
})

describe('the gate', () => {
  const doc: KeepLocalDoc = { version: 1, at: NOW, ids: [1, 2], sources: [], complete: true }
  const tracks = [1, 2, 3].map((id) => ({ id, path: colon(id) }))

  it('off on a replica: nothing is exempted', () => {
    const g = gateFor(false, doc, tracks)
    assert.equal(g.kind, 'off')
    assert.equal(keepsColon(g, colon(1)), false)
    assert.equal(keepsRel(g, rel(1)), false)
  })

  it('holds everything while the songs are unknown', () => {
    const g = gateFor(true, null, tracks)
    assert.equal(g.kind, 'hold')
    assert.equal(keepsColon(g, colon(3)), true)
    assert.equal(keepsRel(g, rel(3)), true)
  })

  it('keeps exactly the listed songs by both path shapes', () => {
    const g = gateFor(true, doc, tracks)
    assert.equal(keepsColon(g, colon(1)), true)
    assert.equal(keepsRel(g, rel(2)), true)
    assert.equal(keepsColon(g, colon(3)), false)
    assert.equal(keepsRel(g, rel(3)), false)
  })

  // 2026-11-20 (Brief 263): the 30 GB floor that let list songs be offloaded is gone.
  describe('no free-space floor: a song on any list is never offloaded', () => {
    const GIB = 1024 ** 3
    const all6000 = Array.from({ length: 6000 }, (_, i) => i + 1)
    const lib = all6000.map((id) => ({ id, path: colon(id) }))

    it('every one of 6,000 iPod songs is kept, whatever the disk says (the live gate)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jt-keep-nofloor-'))
      try {
        const keep = createIpodKeepLocal({
          userDataDir: dir, applies: async () => true,
          top1000: async () => all6000.slice(0, 1000), lists: async () => [{ id: 'punk-0d8fc490', name: 'punkPod', ids: all6000.slice(1000) }],
          registered: async () => new Set(['punk-0d8fc490']), libraryTracks: async () => lib,
        })
        await keep.refresh()
        const g = await keep.gate()
        assert.equal(g.kind === 'keep' && g.count, 6000)
        assert.equal(keepsColon(g, colon(6000)), true)
        assert.equal(keepsRel(g, rel(1001)), true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('the host can’t hand the gate a free-space number any more', async () => {
      const src = await readFile(new URL('../ipod-keep-local.ts', import.meta.url), 'utf-8')
      assert.doesNotMatch(src, /freeBytes|lapsed|IPOD_KEEP_FLOOR_BYTES/, 'a floor on the keep set offloaded 89 iPod songs on 2026-11-20')
      const start = await readFile(new URL('../ipod-local-start.ts', import.meta.url), 'utf-8')
      const keepCall = start.slice(start.indexOf('createIpodKeepLocal({'), start.indexOf('const kindOf'))
      assert.match(keepCall, /cachedListIds:/, 'the sidebar’s newer copy of homemini’s lists is part of the keep set')
      const passCall = start.slice(start.indexOf('await runPrefetchPass({'), start.indexOf('fetchOne: async'))
      assert.match(passCall, /floorBytes: prefetchFloorFor\(asked\),/, 'without it the download runs down to 10 GB free')
    })

    it('the download floors are where the recent-songs windows are', () => {
      assert.equal(IPOD_KEEP_FETCH_FLOOR_BYTES, 80 * GIB)
      assert.equal(IPOD_KEEP_ASKED_FLOOR_BYTES, 60 * GIB)
      assert.equal(prefetchFloorFor(false), 80 * GIB)
      assert.equal(prefetchFloorFor(true), 60 * GIB)
    })

    // The real case: Kraken (12558) on punkPod since 11-14, offloaded at 20:33Z with the disk 97% full.
    it('2026-11-20: a punkPod song on a 97%-full Mac stays local through the stream-convert pass', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jt-keep-kraken-'))
      try {
        const kraken = ':iPod_Control:Music:F08:imported_12558.m4a'
        const offList = ':iPod_Control:Music:F01:imported_7.m4a'
        const tracks = [{ id: 12558, path: kraken, audioFingerprint: 'sha1:d12082828727dbcd|55333' }, { id: 7, path: offList, audioFingerprint: 'sha1:aa|1' }, { id: 1, path: colon(1) }]
        const keep = createIpodKeepLocal({
          userDataDir: dir, applies: async () => true,
          top1000: async () => [1],
          lists: async () => [{ id: '0d8fc490-74d1-4232-9a35-1801a66f4fde', name: 'punkPod', ids: [12558] }],
          registered: async () => new Set(['0d8fc490-74d1-4232-9a35-1801a66f4fde']), libraryTracks: async () => tracks,
        })
        await keep.refresh()
        const gate = await keep.gate()
        const now = Date.parse('2026-11-20T20:33:00.000Z')
        const items: StreamConvertItem[] = [kraken, offList].map((ipodPath) => ({ ipodPath, fingerprint: 'x', enqueuedAt: now - 24 * 3_600_000 }))
        const converted: string[] = []
        await runConvertPass({
          now, items, maxAgeMs: 30 * 60_000, batch: null, tracks,
          kept: (it) => keepsColon(gate, it.ipodPath),
          away: async () => false,
          askIdentity: async (ids) => ({ kind: 'answers', byId: new Map(ids.map((id) => [String(id), { size: 8036287, sha1: '4a441abc4db4ec66069ede2056fb32a22b3bea54', etag: '"e"' }])) }),
          convert: async (row) => { converted.push(row.item.ipodPath); return { ok: true } },
          log: () => {},
        })
        assert.deepEqual(converted, [offList], 'only the song on no list is offloaded')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('a list in the sidebar’s newer copy of homemini’s answer is kept before the keep file hears of it', () => {
      const doc: KeepLocalDoc = { version: 1, at: NOW, ids: [1], sources: [], complete: true }
      const tracks = [1, 2, 3].map((id) => ({ id, path: colon(id) }))
      const g = gateFor(true, doc, tracks, { now: Date.parse(NOW), extraIds: [2] })
      assert.equal(keepsColon(g, colon(2)), true)
      assert.equal(keepsColon(g, colon(3)), false)
    })
  })

  // Review of PR 413: the Top 1000 is carried by identity across a read where homemini didn't answer for it.
  describe('the Top 1000 by identity', () => {
    const top = Array.from({ length: 1000 }, (_, i) => i + 1)
    const punk = Array.from({ length: 50 }, (_, i) => 10_000 + i)
    const lists = [{ id: 'punk-0d8fc490', name: 'punkPod', ids: punk }]
    const registered = new Set(['punk-0d8fc490'])
    const clean = buildKeepDoc({ top1000: top, lists, registered, previous: null, now: NOW })!

    it('a read where the Top 1000 didn’t answer still puts the last good Top 1000 first, across a restart', () => {
      const once = buildKeepDoc({ top1000: null, lists, registered, previous: clean, now: NOW })!
      assert.equal(once.complete, false)
      assert.deepEqual(once.ids.slice(0, 1000), top)
      const twice = buildKeepDoc({ top1000: null, lists: null, registered, previous: parseKeepDoc(JSON.parse(JSON.stringify(once))), now: NOW })!
      assert.deepEqual(alwaysKeptIds(twice), top)
      assert.equal(twice.sources.filter((s) => s.key === 'top1000').length, 1)
    })

    it('a doc saved before 2026-11-13, from a clean read: the head is the Top 1000', () => {
      const { top1000: _gone, ...old } = clean
      assert.deepEqual(alwaysKeptIds(old), top)
    })
  })

  describe('fresh or nothing', () => {
    const tracks = [1, 2, 3].map((id) => ({ id, path: colon(id) }))
    const t = Date.parse(NOW)

    it('a clean read older than 6 hours holds: nothing is offloaded until homemini answers again', () => {
      const doc: KeepLocalDoc = { version: 1, at: NOW, ids: [1], sources: [], complete: true }
      assert.equal(gateFor(true, doc, tracks, { now: t + KEEP_STALE_MS }).kind, 'keep')
      const g = gateFor(true, doc, tracks, { now: t + KEEP_STALE_MS + 1 })
      assert.equal(g.kind, 'hold')
      assert.equal(keepsColon(g, colon(3)), true)
    })

    it('a read where a source failed doesn’t make the set fresh: the last CLEAN read is the clock', () => {
      const clean = buildKeepDoc({ top1000: [1], lists: [], registered: new Set(), previous: null, now: NOW })!
      assert.equal(clean.cleanAt, NOW)
      const later = new Date(t + 7 * 3_600_000).toISOString()
      const partial = buildKeepDoc({ top1000: null, lists: [], registered: new Set(), previous: clean, now: later })!
      assert.equal(partial.complete, false)
      assert.equal(lastCleanAt(partial), NOW)
      assert.equal(gateFor(true, partial, tracks, { now: t + 7 * 3_600_000 }).kind, 'hold')
      assert.equal(lastCleanAt(parseKeepDoc(JSON.parse(JSON.stringify(partial)))), NOW, 'survives a restart')
    })

    it('an older saved doc: complete counts from `at`, incomplete has no clean read and holds', () => {
      assert.equal(gateFor(true, { version: 1, at: NOW, ids: [1], sources: [], complete: true }, tracks, { now: t }).kind, 'keep')
      assert.equal(gateFor(true, { version: 1, at: NOW, ids: [1], sources: [], complete: false }, tracks, { now: t }).kind, 'hold')
    })

    it('the live gate says why it holds in main.log, once per change', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jt-keep-stale-'))
      try {
        let clock = t
        const warns: string[] = []
        const keep = createIpodKeepLocal({
          userDataDir: dir, applies: async () => true, now: () => clock,
          top1000: async () => [1], lists: async () => [], registered: async () => new Set(),
          libraryTracks: async () => tracks, warn: (m) => warns.push(m),
        })
        await keep.refresh()
        assert.equal((await keep.gate()).kind, 'keep')
        clock = t + KEEP_STALE_MS + 1
        assert.equal((await keep.gate()).kind, 'hold')
        assert.equal((await keep.gate()).kind, 'hold')
        assert.equal(warns.length, 1)
        assert.match(warns[0], /offloading nothing: the iPod lists were last read/)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('pass-through eviction leaves iPod songs alone', () => {
  const old = Date.parse(NOW) - EVICT_GRACE_MS - 1000
  function deps(keep?: EvictionDeps['keepLocal']): { d: EvictionDeps; trashed: string[] } {
    const trashed: string[] = []
    const files = [1, 2, 3].map((id) => ({ abs: `/lib/${rel(id)}`, rel: rel(id), mtimeMs: old, sizeBytes: 10 }))
    return {
      trashed,
      d: {
        listLocalAudio: async () => files,
        libraryRelPaths: async () => new Set(files.map((f) => f.rel)),
        // every file "matches" homemini — md5 of an unreadable path never runs: no file is read here
        remoteMd5Batch: async (rels) => new Map(rels.map((r) => [r, 'x'])),
        trash: async (abs) => { trashed.push(abs) },
        journal: async () => {},
        now: () => Date.parse(NOW),
        ...(keep ? { keepLocal: keep } : {}),
      },
    }
  }

  it('a song on an iPod list is counted kept and never reaches the md5 or the trash', async () => {
    const asked: string[][] = []
    const { d, trashed } = deps(async () => (r) => r === rel(1))
    d.remoteMd5Batch = async (rels) => { asked.push(rels); return new Map() }
    const r = await sweepOnce(d)
    assert.equal(r.ipodKept, 1)
    assert.deepEqual(asked, [[rel(2), rel(3)]], 'the kept song is not even a candidate')
    assert.deepEqual(trashed, [])
  })

  it('hold (songs unknown) keeps every file', async () => {
    const { d, trashed } = deps(async () => keepsRel.bind(null, { kind: 'hold', why: 'test' }))
    const r = await sweepOnce(d)
    assert.equal(r.ipodKept, 3)
    assert.deepEqual(trashed, [])
  })

  it('a keep check that throws evicts nothing', async () => {
    const { d, trashed } = deps(async () => { throw new Error('boom') })
    const r = await sweepOnce(d)
    assert.equal(r.errors, 1)
    assert.deepEqual(trashed, [])
  })
})

describe('createIpodKeepLocal', () => {
  it('holds until homemini answers once, then keeps that set through an outage, and saves it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-keep-local-'))
    try {
      let up = false
      const host = {
        userDataDir: dir,
        applies: async () => true,
        top1000: async () => (up ? [1] : null),
        lists: async () => (up ? [{ id: 'punkpod-bbbb', name: 'punkPod', ids: [2] }] : null),
        registered: async () => new Set(['punkpod-bbbb']),
        libraryTracks: async () => [1, 2, 3].map((id) => ({ id, path: colon(id) })),
      }
      const k = createIpodKeepLocal(host)
      await k.refresh()
      assert.equal((await k.gate()).kind, 'hold')
      up = true
      const first = await k.refresh()
      assert.equal(first.changed, true)
      const g = await k.gate()
      assert.equal(keepsColon(g, colon(2)), true)
      assert.equal(keepsColon(g, colon(3)), false)
      up = false
      assert.equal((await k.refresh()).changed, false)
      assert.equal(keepsColon(await k.gate(), colon(1)), true)
      // A fresh start reads the saved set: no hold after a restart with homemini away.
      const again = createIpodKeepLocal(host)
      assert.equal(keepsRel(await again.gate(), rel(2)), true)
      assert.deepEqual(JSON.parse(await readFile(join(dir, KEEP_LOCAL_FILE), 'utf-8')).ids, [1, 2])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('on a replica the gate is off whatever is saved', async () => {
    const k = createIpodKeepLocal({
      userDataDir: '/nonexistent-jt', applies: async () => false,
      top1000: async () => [1], lists: async () => [], registered: async () => new Set(),
      libraryTracks: async () => [{ id: 1, path: colon(1) }],
    })
    assert.equal((await k.gate()).kind, 'off')
  })
})
