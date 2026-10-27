/** One Pool per iPod, step 2 (2026-10-27): where each iPod's pool lives, and the no-overlap wiring. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPOD_POOLS_DIR, buildDeviceMarker, ipodPoolRel, ipodWriteRefusal } from '../../common/ipod-identity.ts'
import { poolFileFor } from '../ipod-identity.ts'

const now = '2026-10-27T00:00:00.000Z'
const original = buildDeviceMarker({ id: 'original-1234', name: 'Original', primary: true, now })!
const red = buildDeviceMarker({ id: 'abc12345-red', name: 'Red', primary: false, now })!

describe('where an iPod’s Pool lives', () => {
  it('the Original keeps the legacy root file; no known iPod means the Original’s pool too', () => {
    assert.deepEqual(ipodPoolRel(original), ['activity-pool.json'])
    assert.deepEqual(ipodPoolRel(null), ['activity-pool.json'])
    assert.equal(poolFileFor('/state', original), join('/state', 'activity-pool.json'))
    assert.equal(poolFileFor('/state', null), join('/state', 'activity-pool.json'))
  })
  it('any other iPod has its own folder, keyed by its marker id', () => {
    assert.deepEqual(ipodPoolRel(red), [IPOD_POOLS_DIR, 'abc12345-red', 'activity-pool.json'])
    assert.equal(poolFileFor('/state', red), join('/state', IPOD_POOLS_DIR, 'abc12345-red', 'activity-pool.json'))
  })
  it('a second iPod now has a Pool; what it lacks is a sync (the refusal says so)', () => {
    assert.match(ipodWriteRefusal({ status: 'known', device: red }) || '', /Red has its own Pool, but JakeTunes can’t sync it yet/)
    assert.equal(ipodWriteRefusal({ status: 'known', device: original }), null)
  })
})

describe('pool IPC wiring (source locks)', () => {
  const ipc = readFileSync(new URL('../ipc/activity-pool-ipc.ts', import.meta.url), 'utf-8')
  it('every pool read and write names whose pool it is — no owner-less file access', () => {
    assert.doesNotMatch(ipc, /loadPoolFile\(\)/)
    assert.doesNotMatch(ipc, /saveActivityPool\(\s*(ids|next|r\.ids|\[\])/, 'a save without an owner')
    assert.doesNotMatch(ipc, /'activity-pool\.json'/, 'the ipc must resolve the file through poolFileFor')
  })
  it('adding and swapping both pass the no-overlap gate before the merge', () => {
    for (const ch of ['activity-pool-add', 'activity-pool-swap']) {
      const i = ipc.indexOf(`'${ch}'`)
      assert.ok(i > 0, ch)
      const body = ipc.slice(i, ipc.indexOf('{ refuse: REFUSED_SENDER })', i))
      assert.match(body, /blockedByOtherIpods\(/, `${ch} must check the other iPods' pools`)
      assert.ok(body.indexOf('blockedByOtherIpods(') < body.indexOf(ch === 'activity-pool-add' ? 'mergeIntoPool(' : 'swapInPool('), `${ch}: the gate must run before the merge`)
    }
  })
  it('the Original’s ledger only ever names the Original’s pool', () => {
    assert.match(ipc, /!owner && await backfillNamesFromLedger/)
  })
})
