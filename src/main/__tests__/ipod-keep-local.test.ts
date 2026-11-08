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
