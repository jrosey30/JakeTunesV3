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
  alwaysKeptIds, knownFreeBytes, parseKeepDoc, prefetchFloorFor,
  IPOD_KEEP_ALWAYS, IPOD_KEEP_ASKED_FLOOR_BYTES, IPOD_KEEP_FETCH_FLOOR_BYTES, IPOD_KEEP_FLOOR_BYTES,
  type KeepLocalDoc,
} from '../ipod-keep-local.ts'
import { sweepOnce, EVICT_GRACE_MS, type EvictionDeps } from '../library-eviction.ts'

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

  // 2026-11-13: a list can hold 5,000 songs; kept without a limit they'd stop this Mac freeing room.
  describe('the free-space floor', () => {
    const GIB = 1024 ** 3
    const all6000 = Array.from({ length: 6000 }, (_, i) => i + 1)
    const many: KeepLocalDoc = { version: 1, at: NOW, ids: all6000, sources: [], complete: true, top1000: all6000.slice(0, 1000) }
    const lib = many.ids.map((id) => ({ id, path: colon(id) }))

    it('with room, every one of 6,000 iPod songs is kept', () => {
      const g = gateFor(true, many, lib, 80 * GIB)
      assert.equal(g.kind === 'keep' && g.count, 6000)
      assert.equal(g.kind === 'keep' && g.lapsed, undefined)
      assert.equal(keepsColon(g, colon(6000)), true)
      assert.equal(keepsColon(gateFor(true, many, lib, IPOD_KEEP_FLOOR_BYTES), colon(6000)), true)   // exactly at the floor: kept
    })

    it('under 30 GB free only the first 1,000 (the Top 1000) stay kept; the rest may be offloaded', () => {
      const g = gateFor(true, many, lib, IPOD_KEEP_FLOOR_BYTES - 1)
      assert.equal(g.kind === 'keep' && g.count, IPOD_KEEP_ALWAYS)
      assert.equal(g.kind === 'keep' && g.lapsed, 5000)
      assert.equal(keepsColon(g, colon(1)), true)
      assert.equal(keepsRel(g, rel(1000)), true)
      assert.equal(keepsColon(g, colon(1001)), false)
      assert.equal(keepsRel(g, rel(6000)), false)
    })

    it('a free-space read that failed changes nothing: every song stays kept', () => {
      // 0 is what a failed statfs used to come back as (review of PR 413): never "no room".
      for (const free of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, -5 * GIB]) {
        const g = gateFor(true, many, lib, free)
        assert.equal(keepsColon(g, colon(6000)), true, String(free))
        assert.equal(g.kind === 'keep' && g.lapsed, undefined, String(free))
        assert.equal(g.kind === 'keep' && g.count, 6000, String(free))
      }
      assert.equal(knownFreeBytes(0), null)
      assert.equal(knownFreeBytes(Number.NaN), null)
      assert.equal(knownFreeBytes('5'), null)
      assert.equal(knownFreeBytes(1), 1)
    })

    it('unknown songs still hold everything, whatever the disk says', () => {
      assert.equal(keepsColon(gateFor(true, null, lib, 1), colon(6000)), true)
    })

    it('the download floors sit above the lapse floor, and at the edges the recent-songs windows use', () => {
      assert.equal(IPOD_KEEP_FLOOR_BYTES, 30 * GIB)
      assert.equal(IPOD_KEEP_FETCH_FLOOR_BYTES, 80 * GIB)   // ROOMY_ENTER_BYTES: the long windows hold while iPod songs arrive
      assert.equal(IPOD_KEEP_ASKED_FLOOR_BYTES, 60 * GIB)   // ROOMY_FREE_BYTES: Jake's Wait never pushes them out
      assert.equal(prefetchFloorFor(false), 80 * GIB)
      assert.equal(prefetchFloorFor(true), 60 * GIB)
      assert.ok(prefetchFloorFor(true) > IPOD_KEEP_FLOOR_BYTES)
    })

    it('a free-space read that throws keeps every song (the live gate)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jt-keep-throw-'))
      for (const freeBytes of [async () => { throw new Error('statfs') }, async () => 0, async () => Number.NaN]) {
        const keep = createIpodKeepLocal({
          userDataDir: dir, applies: async () => true,
          top1000: async () => all6000.slice(0, 1000), lists: async () => [{ id: 'punk-0d8fc490', name: 'punkPod', ids: all6000.slice(1000) }],
          registered: async () => new Set(['punk-0d8fc490']), libraryTracks: async () => lib, freeBytes,
        })
        await keep.refresh()
        const g = await keep.gate()
        assert.equal(keepsColon(g, colon(6000)), true)
        assert.equal(g.kind === 'keep' && g.count, 6000)
      }
      await rm(dir, { recursive: true, force: true })
    })

    it('main’s free-space read says "unknown" when it fails, never 0', async () => {
      const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
      const fn = src.slice(src.indexOf('async function laptopFreeBytes'), src.indexOf('function homeminiPullOpts'))
      assert.match(fn, /catch \(err\) \{[\s\S]*return Number\.NaN/)
      assert.doesNotMatch(fn, /return 0\b/)
    })

    it('the wiring: the gate is handed this Mac’s free disk, and each pass its floor', async () => {
      const src = await readFile(new URL('../ipod-local-start.ts', import.meta.url), 'utf-8')
      const keepCall = src.slice(src.indexOf('createIpodKeepLocal({'), src.indexOf('const kindOf'))
      assert.match(keepCall, /freeBytes: host\.freeBytes,/, 'without it the floor never applies')
      const passCall = src.slice(src.indexOf('await runPrefetchPass({'), src.indexOf('fetchOne: async'))
      assert.match(passCall, /floorBytes: prefetchFloorFor\(asked\),/, 'without it the download runs down to 10 GB free')
    })

    // Review of PR 413: on a read where homemini didn't answer for the Top 1000, the lists
    // went first and the previous Top 1000 last, so at 20 GB free none of it stayed kept.
    describe('the protected songs are the Top 1000 by identity', () => {
      const top = Array.from({ length: 1000 }, (_, i) => i + 1)             // 1..1000
      const punk = Array.from({ length: 5000 }, (_, i) => 10_000 + i)
      const lists = [{ id: 'punk-0d8fc490', name: 'punkPod', ids: punk }]
      const registered = new Set(['punk-0d8fc490'])
      const clean = buildKeepDoc({ top1000: top, lists, registered, previous: null, now: NOW })!
      const world = [...top, ...punk].map((id) => ({ id, path: colon(id) }))

      it('a read where the Top 1000 didn’t answer still puts the last good Top 1000 first', () => {
        const next = buildKeepDoc({ top1000: null, lists, registered, previous: clean, now: NOW })!
        assert.equal(next.complete, false)
        assert.deepEqual(next.ids.slice(0, 1000), top)
        assert.deepEqual(next.top1000, top)
        const g = gateFor(true, next, world, 20 * GIB)
        assert.equal(g.kind === 'keep' && g.count, 1000)
        assert.ok(top.every((id) => keepsColon(g, colon(id))), 'every Top 1000 song stays kept at 20 GB free')
        assert.equal(keepsColon(g, colon(10_000)), false)
      })

      it('and again on the read after that, and across a restart (the saved file)', () => {
        const once = buildKeepDoc({ top1000: null, lists, registered, previous: clean, now: NOW })!
        const twice = buildKeepDoc({ top1000: null, lists: null, registered, previous: parseKeepDoc(JSON.parse(JSON.stringify(once))), now: NOW })!
        assert.deepEqual(alwaysKeptIds(twice), top)
        assert.deepEqual(twice.ids.slice(0, 1000), top)
        assert.equal(twice.sources.filter((s) => s.key === 'top1000').length, 1)
      })

      it('a fresh Top 1000 replaces the old one as the protected set', () => {
        const fresh = top.map((id) => id + 500)                              // 501..1500
        const next = buildKeepDoc({ top1000: fresh, lists, registered, previous: clean, now: NOW })!
        assert.deepEqual(alwaysKeptIds(next), fresh)
        assert.equal(keepsColon(gateFor(true, next, [...world, ...fresh.map((id) => ({ id, path: colon(id) }))], 20 * GIB), colon(1)), false)
      })

      it('a doc saved before this, from a clean read: the head is the Top 1000', () => {
        const { top1000: _gone, ...old } = clean
        assert.deepEqual(alwaysKeptIds(old), top)
      })

      it('a doc that can’t say which songs are the Top 1000 lapses nothing', () => {
        const unknown: KeepLocalDoc = { version: 1, at: NOW, ids: [...punk, ...top], sources: [], complete: false }
        assert.equal(alwaysKeptIds(unknown), null)
        const g = gateFor(true, unknown, world, 20 * GIB)
        assert.equal(g.kind === 'keep' && g.count, 6000)
        assert.equal(keepsColon(g, colon(1)), true)
      })
    })

    it('the live gate asks the disk each time, and says so once', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jt-keep-floor-'))
      let free = 80 * GIB
      const lines: string[] = []
      const keep = createIpodKeepLocal({
        userDataDir: dir, applies: async () => true,
        top1000: async () => many.ids.slice(0, 1000), lists: async () => [{ id: 'punk-0d8fc490', name: 'punkPod', ids: many.ids.slice(1000) }],
        registered: async () => new Set(['punk-0d8fc490']), libraryTracks: async () => lib,
        freeBytes: async () => free, log: (m) => lines.push(m),
      })
      await keep.refresh()
      assert.equal(keepsColon(await keep.gate(), colon(6000)), true)
      free = 29 * GIB
      assert.equal(keepsColon(await keep.gate(), colon(6000)), false)
      assert.equal(keepsColon(await keep.gate(), colon(1000)), true)
      free = 31 * GIB
      assert.equal(keepsColon(await keep.gate(), colon(6000)), true)
      assert.deepEqual(lines, [
        '[ipod-local] keeping 6000 iPod song(s) on this Mac',
        '[ipod-local] keeping 1000 iPod song(s) on this Mac; 5000 more may be offloaded while it has under 30 GB free',
        '[ipod-local] keeping 6000 iPod song(s) on this Mac',
      ])
      await rm(dir, { recursive: true, force: true })
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
