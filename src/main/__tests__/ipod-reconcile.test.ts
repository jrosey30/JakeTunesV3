import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planReconcile, partitionLanded, sizeVerified, type IntendedTrack, type DeviceCatalogEntry } from '../ipod-reconcile.ts'

describe('sizeVerified', () => {
  it('passes only on an exact positive match', () => {
    assert.equal(sizeVerified(1000, 1000), true)
    assert.equal(sizeVerified(999, 1000), false)   // truncated (bus drop)
    assert.equal(sizeVerified(0, 1000), false)     // zero-byte partial
    assert.equal(sizeVerified(null, 1000), false)  // missing file
    assert.equal(sizeVerified(undefined, 1000), false)
  })
})

describe('planReconcile — device truth, not cache', () => {
  const intended: IntendedTrack[] = [
    { id: 1, expectedSize: 100 },
    { id: 2, expectedSize: 200 },
    { id: 3, expectedSize: 300 },
  ]

  it('keeps only tracks the catalog claims AND whose file verifies at size', () => {
    const catalog: DeviceCatalogEntry[] = [
      { id: 1, recordedSize: 100 },
      { id: 2, recordedSize: 200 },
    ]
    // id1 file present + right size; id2 present but TRUNCATED; id3 not on device
    const verified = new Map<number, number>([[1, 100], [2, 199]])
    const plan = planReconcile(intended, catalog, verified)
    assert.deepEqual(plan.kept, [1])
    assert.deepEqual(plan.toCopy, [2, 3])   // 2 = wrong size, 3 = missing
    assert.deepEqual(plan.toRemove, [])
  })

  it('flags a catalog entry with no real file for re-copy (the 76/100 lie)', () => {
    const catalog: DeviceCatalogEntry[] = [{ id: 1, recordedSize: 100 }]
    const verified = new Map<number, number>()  // catalog claims id1 but no file lands
    const plan = planReconcile(intended, catalog, verified)
    assert.ok(plan.toCopy.includes(1), 'phantom catalog entry must be re-copied')
    assert.ok(!plan.kept.includes(1))
  })

  it('removes device tracks not in the intended set', () => {
    const catalog: DeviceCatalogEntry[] = [
      { id: 1, recordedSize: 100 },
      { id: 9, recordedSize: 900 },   // stale from a prior set
    ]
    const verified = new Map<number, number>([[1, 100], [9, 900]])
    const plan = planReconcile(intended, catalog, verified)
    assert.deepEqual(plan.toRemove, [9])
    assert.ok(plan.kept.includes(1))
  })

  it('a stray file with no catalog record is NOT counted as present', () => {
    const catalog: DeviceCatalogEntry[] = []          // catalog empty
    const verified = new Map<number, number>([[1, 100]]) // but a file exists
    const plan = planReconcile(intended, catalog, verified)
    assert.ok(plan.toCopy.includes(1), 'no catalog record → treat as not synced')
  })
})

describe('partitionLanded — honest post-copy split', () => {
  it('separates verified-landed from failed (dropped mid-copy)', () => {
    const intended: IntendedTrack[] = [
      { id: 1, expectedSize: 100 },
      { id: 2, expectedSize: 200 },
      { id: 3, expectedSize: 300 },
    ]
    const landed = new Map<number, number>([[1, 100], [2, 150], [3, 300]])  // id2 truncated
    const r = partitionLanded(intended, landed)
    assert.deepEqual(r.landed, [1, 3])
    assert.deepEqual(r.failed, [2])
  })

  it('a track missing from the card (no stat) is failed, not silently landed', () => {
    const intended: IntendedTrack[] = [{ id: 1, expectedSize: 100 }, { id: 2, expectedSize: 200 }]
    const landed = new Map<number, number>([[1, 100]])  // id2 never committed → absent
    const r = partitionLanded(intended, landed)
    assert.deepEqual(r.landed, [1])
    assert.deepEqual(r.failed, [2])
  })

  it('converges: a dropped track becomes landed once recopied at the right size (the retry loop)', () => {
    const intended: IntendedTrack[] = [{ id: 1, expectedSize: 100 }, { id: 2, expectedSize: 200 }]
    // Pass 1: id2 dropped (absent) → failed, gets recopied.
    const pass1 = partitionLanded(intended, new Map([[1, 100]]))
    assert.deepEqual(pass1.failed, [2])
    // Pass 2 (after recopy + remount): id2 now present at the right size → all landed.
    const pass2 = partitionLanded(intended, new Map([[1, 100], [2, 200]]))
    assert.deepEqual(pass2.landed, [1, 2])
    assert.deepEqual(pass2.failed, [])
  })
})
