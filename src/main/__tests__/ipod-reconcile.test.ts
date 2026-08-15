import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  planReconcile,
  partitionLanded,
  sizeVerified,
  activitySetProven,
  fileSizeForItunesDb,
  estimateIpodBytes,
  looksLossless,
  packTracksToCapacity,
  type IntendedTrack,
  type DeviceCatalogEntry,
} from '../ipod-reconcile.ts'

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

  it('the convert bug: AAC-on-card must be checked against AAC size, not the ALAC master', () => {
    // 500-song activity sync on a Mini: convert wrote ~3MB AAC, verify used to
    // expect the ~30MB ALAC master → every track "failed" → recopy filled the
    // card with ALACs → only ~100 songs stuck. Correct expected size lands.
    const alacMaster = 30_000_000
    const aacOnCard = 3_000_000
    const wrong = partitionLanded(
      [{ id: 1, expectedSize: alacMaster }],
      new Map([[1, aacOnCard]]),
    )
    assert.deepEqual(wrong.failed, [1], 'ALAC expected vs AAC on card = false failure')
    const right = partitionLanded(
      [{ id: 1, expectedSize: aacOnCard }],
      new Map([[1, aacOnCard]]),
    )
    assert.deepEqual(right.landed, [1])
  })
})

describe('activitySetProven — 500 means 500, never a lucky remount', () => {
  it('refuses success on a single remount even when the count looks full', () => {
    assert.equal(activitySetProven(1, 500, 500), false)
    assert.equal(activitySetProven(0, 500, 500), false)
  })

  it('passes only after two consecutive full proofs at the target', () => {
    assert.equal(activitySetProven(2, 500, 500), true)
    assert.equal(activitySetProven(3, 250, 250), true)
  })

  it('a shortfall is never proven, no matter how many remounts agreed', () => {
    assert.equal(activitySetProven(4, 33, 500), false)
    assert.equal(activitySetProven(2, 499, 500), false)
    assert.equal(activitySetProven(2, 0, 500), false)
  })
})

describe('fileSizeForItunesDb — catalog size is the card, never library.json', () => {
  it('uses the on-card byte size (Beyond Me: 7.5MB on card, not 31MB ALAC in library.json)', () => {
    assert.equal(fileSizeForItunesDb(7_549_180), 7_549_180)
    assert.notEqual(fileSizeForItunesDb(7_549_180), 31_481_234)
  })

  it('refuses a missing or zero file — do not pack a stale library size into the mhit', () => {
    assert.equal(fileSizeForItunesDb(0), 0)
    assert.equal(fileSizeForItunesDb(null), 0)
    assert.equal(fileSizeForItunesDb(undefined), 0)
    assert.equal(fileSizeForItunesDb(-1), 0)
  })
})

describe('estimateIpodBytes / looksLossless / packTracksToCapacity', () => {
  it('estimates AAC size from duration when converting lossless', () => {
    // 4 minutes at 128 kbps ≈ 3_840_000 bytes
    const n = estimateIpodBytes({
      fileSize: 30_000_000,
      durationMs: 240_000,
      convertEnabled: true,
      targetKbps: 128,
      isLossless: true,
    })
    assert.equal(n, Math.ceil(240 * 128 * 1000 / 8))
  })

  it('uses the master size when convert is off', () => {
    assert.equal(estimateIpodBytes({ fileSize: 30_000_000, convertEnabled: false, isLossless: true }), 30_000_000)
  })

  it('recognizes ALAC / FLAC codecs and extensions', () => {
    assert.equal(looksLossless('alac', ':F00:x.m4a'), true)
    assert.equal(looksLossless('aac', ':F00:x.m4a'), false)
    assert.equal(looksLossless('', ':F00:x.flac'), true)
  })

  it('packs until the budget is full — the Mini capacity gate', () => {
    const tracks = [
      { id: 1, bytes: 100 },
      { id: 2, bytes: 100 },
      { id: 3, bytes: 100 },
      { id: 4, bytes: 100 },
    ]
    // 250 free, 50 reserve → budget 200 → first two fit
    const r = packTracksToCapacity(tracks, 250, 50)
    assert.deepEqual(r.packed.map((t) => t.id), [1, 2])
    assert.deepEqual(r.dropped.map((t) => t.id), [3, 4])
    assert.equal(r.usedBytes, 200)
    assert.equal(r.budgetBytes, 200)
  })
})
