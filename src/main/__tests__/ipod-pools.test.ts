/** One Pool per iPod, step 2 (2026-10-27): where each iPod's pool lives, and the no-overlap wiring. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPOD_POOLS_DIR, buildDeviceMarker, ipodPoolRel, ipodStateRel, ipodWriteRefusal } from '../../common/ipod-identity.ts'
import { ipodStateDirFor, poolFileFor } from '../ipod-identity.ts'

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
  it('a second iPod has its own Pool AND its own sync (step 2b): only an unknown card is refused', () => {
    assert.equal(ipodWriteRefusal({ status: 'known', device: red }), null)
    assert.equal(ipodWriteRefusal({ status: 'known', device: original }), null)
    assert.match(ipodWriteRefusal({ status: 'unknown', canBeOriginal: false }) || '', /doesn’t know this iPod/)
  })
  it('every sync-side file of a second iPod lives in its folder; the Original keeps the root', () => {
    assert.deepEqual(ipodStateRel(original), [])
    assert.deepEqual(ipodStateRel(null), [])
    assert.deepEqual(ipodStateRel(red), [IPOD_POOLS_DIR, 'abc12345-red'])
    assert.equal(ipodStateDirFor('/state', original), '/state')
    assert.equal(ipodStateDirFor('/state', red), join('/state', IPOD_POOLS_DIR, 'abc12345-red'))
    assert.equal(join(ipodStateDirFor('/state', red), 'activity-pool.json'), poolFileFor('/state', red), 'the pool lives in the same folder')
  })
})

describe('sync wiring (source locks, step 2b)', () => {
  const sync = readFileSync(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
  const syncIpc = readFileSync(new URL('../ipc/sync-ipc.ts', import.meta.url), 'utf-8')
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8')
  const workout = readFileSync(new URL('../workout-sync-ipc.ts', import.meta.url), 'utf-8')
  it('the sync engine keeps every state file in the plugged-in iPod’s dir, resolved from its identity', () => {
    assert.match(sync, /syncStateDir = ipod\.stateDir/)
    assert.doesNotMatch(sync, /join\(STATE_DIR, 'last-sync-manifest\.json'\)/)
    assert.doesNotMatch(sync, /app\.getPath\('userData'\), '(last-sync-report|prev-sync-report|ipod-sync-journal|ipod-activity-tsa-seal)\.json'/)
    assert.match(sync, /stateDir: syncStateDir,/, 'the activity engine must get the per-iPod dir')
    // Importing songs off a card stays Original-only.
    assert.match(sync, /refuseUnlessOriginalIpod\(fromMount, STATE_DIR\)/)
  })
  it('the seal check, the journal, the round trip and the delete mirror all go through resolveIpodState', () => {
    assert.match(syncIpc, /resolveIpodState\(mount, STATE_DIR\)/)
    assert.doesNotMatch(syncIpc, /refuseUnlessOriginalIpod/)
    // 2026-10-28: the plug-in round trip resolves first (waiting out an in-flight ID adoption).
    assert.match(index, /onMountDetected: \(mount\) => void roundTripOnMount\(mount\)/)
    assert.match(index, /async function roundTripOnMount\(mount: string\)[\s\S]*?resolveIpodState\(mount, STATE_DIR\)[\s\S]*?roundTripHostFor\(ipod\.stateDir\)/)
    assert.match(index, /\[delete-sync\] skipped — \$\{ipod\.refusal\}/)
    assert.doesNotMatch(index, /refuseUnlessOriginalIpod/)
  })
  it('workout-sync state and history are per iPod, and only the Original’s history reaches the NAS', () => {
    assert.doesNotMatch(workout, /loadState\(\)|saveState\(state\)|loadSyncHistory\(\)|appendSyncHistory\(\{/)
    assert.match(workout, /if \(dir !== ROOT_STATE_DIR\(\)\) return/)
    assert.match(index, /ipodStateDir: async \(\) =>/)
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
