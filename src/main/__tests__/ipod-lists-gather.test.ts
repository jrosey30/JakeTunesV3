/**
 * 'ipod-lists:get' on every Mac (2026-11-09, main/ipod-lists-gather.ts). Jake: "i dont see
 * punkpod on workmini for some reason" — the handler walked this Mac's ipod-devices.json, and
 * workmini never had punkPod plugged in. And: "they shouldnt have to be plugged into homemini
 * and workmini....macbook is the only one that actually syncs and works directly with each ipod".
 *
 *   • a replica: homemini's lists, no registry read, no pool refresh, nothing "registered"
 *   • homemini away: the copy kept from its last answer
 *   • the hub: registered iPods through their pool refresh, then every list homemini keeps for
 *     an iPod not registered here
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherIpodLists, ipodListsCachePath, readListsCache, type GatherIpodListsDeps } from '../ipod-lists-gather.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'
import type { IpodPoolRefresh } from '../ipod-list-pool.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ipod-lists-gather-')); dirs.push(d); return d }

const now = '2026-11-09T00:00:00.000Z'
const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now })!
const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', purpose: 'Punk', primary: false, now })!

const list = (id: string, name: string, ids: number[]): IpodList => ({
  id, name, purpose: null, cap: 1000, ids, adds: [], removed: [], updatedAt: now, brain: { enabled: true, perDay: 1 },
})
const HOMEMINI = [list(PUNK_ID, 'punkPod', [3, 2, 1]), list('y2k-revival-01', 'Y2K Revival', [8, 7]), list('best-of-bandcamp', 'Best of Bandcamp', [9])]

function deps(over: Partial<GatherIpodListsDeps> & { stateDir: string }): GatherIpodListsDeps & { calls: { registry: number; refresh: string[] } } {
  const calls = { registry: 0, refresh: [] as string[] }
  return {
    calls,
    isReplica: async () => true,
    registry: async () => { calls.registry++; return [original, punk] },
    refresh: async (d): Promise<IpodPoolRefresh> => {
      calls.refresh.push(d.id)
      return { poolIds: [1, 2, 3], listIds: [3, 2, 1], names: {}, source: 'homemini', note: null, updatedAt: now }
    },
    all: async () => HOMEMINI,
    cacheFile: ipodListsCachePath(over.stateDir),
    ...over,
  }
}

describe('ipod-lists:get on a replica (workmini, homemini\'s app)', () => {
  it('every list homemini keeps, punkPod included, with no registry and no pool refresh', async () => {
    const d = deps({ stateDir: tmp(), registry: async () => [] })
    const r = await gatherIpodLists(d)
    assert.equal(r.role, 'replica')
    assert.deepEqual(r.lists.map((l) => l.name), ['punkPod', 'Y2K Revival', 'Best of Bandcamp'])
    assert.deepEqual(r.lists[0].ids, [3, 2, 1])
    assert.equal(d.calls.registry, 0, 'a replica never reads ipod-devices.json')
    assert.deepEqual(d.calls.refresh, [], 'a replica never writes a pool file or feeds the sync-ready check')
    for (const l of r.lists) {
      assert.equal(l.registered, false)
      // The cover's colour is homemini's (none here: the default iPod's white), never a registry's (2026-11-09).
      assert.equal(l.color, 'white')
      assert.equal(l.model, 'default')
      assert.equal(l.source, 'homemini')
    }
  })
  it('homemini away: the lists from its last answer, marked as the kept copy', async () => {
    const stateDir = tmp()
    await gatherIpodLists(deps({ stateDir }))
    assert.ok(existsSync(ipodListsCachePath(stateDir)))
    const r = await gatherIpodLists(deps({ stateDir, all: async () => null }))
    assert.deepEqual(r.lists.map((l) => l.name), ['punkPod', 'Y2K Revival', 'Best of Bandcamp'])
    assert.ok(r.lists.every((l) => l.source === 'cache'))
  })
  it('homemini away and nothing kept: no lists, no throw', async () => {
    const r = await gatherIpodLists(deps({ stateDir: tmp(), all: async () => { throw new Error('ECONNREFUSED') } }))
    assert.deepEqual(r.lists, [])
  })
  it('a failed role check is a replica: it never writes a pool file', async () => {
    const d = deps({ stateDir: tmp(), isReplica: async () => { throw new Error('settings unreadable') } })
    const r = await gatherIpodLists(d)
    assert.equal(r.role, 'replica')
    assert.deepEqual(d.calls.refresh, [])
  })
  it('a cache entry that fails the parser is dropped, never guessed at', async () => {
    const stateDir = tmp()
    await gatherIpodLists(deps({ stateDir, all: async () => [...HOMEMINI, { ...list('bad-list-01', 'Bad', []), cap: 5001 } as IpodList] }))
    const kept = await readListsCache(ipodListsCachePath(stateDir))
    assert.deepEqual(kept?.map((l) => l.id), [PUNK_ID, 'y2k-revival-01', 'best-of-bandcamp'])
  })
})

describe('ipod-lists:get on the hub (the MacBook)', () => {
  it('registered iPods through their pool refresh, then the planned lists, each once', async () => {
    const d = deps({ stateDir: tmp(), isReplica: async () => false })
    const r = await gatherIpodLists(d)
    assert.equal(r.role, 'hub')
    assert.deepEqual(d.calls.refresh, [PUNK_ID], 'only the registered non-Original iPod')
    assert.deepEqual(r.lists.map((l) => [l.name, l.registered]), [['punkPod', true], ['Y2K Revival', false], ['Best of Bandcamp', false]])
    assert.equal(r.lists[0].color, 'red')
  })
  it('homemini away: registered lists from their pool files, planned ones from the kept copy', async () => {
    const stateDir = tmp()
    await gatherIpodLists(deps({ stateDir, isReplica: async () => false }))
    const r = await gatherIpodLists(deps({ stateDir, isReplica: async () => false, all: async () => null }))
    assert.deepEqual(r.lists.map((l) => [l.name, l.source]), [['punkPod', 'homemini'], ['Y2K Revival', 'cache'], ['Best of Bandcamp', 'cache']])
  })
})
