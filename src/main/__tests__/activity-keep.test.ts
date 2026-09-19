import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sealedManifestRows, keepVerdict, activityKeepPlan, wipeListingMatchesKeep, keepStreak,
} from '../activity-keep.ts'

const sealed = {
  sealed: true, status: 'sealed', count: 3,
  tracks: [
    { id: 1, destPath: ':iPod_Control:Music:F01:1.m4a', identity: 'fp:sha1:aaa|100' },
    { id: 2, destPath: ':iPod_Control:Music:F02:2.m4a', identity: 'fp:sha1:bbb|200' },
    { id: 3, destPath: ':iPod_Control:Music:F03:3.m4a', identity: 'path::iPod_Control:Music:F03:3.m4a' },
  ],
}
const cand = (over: Partial<Parameters<typeof keepVerdict>[0]>) => ({
  id: 1, destPath: ':iPod_Control:Music:F01:1.m4a', identity: 'fp:sha1:aaa|100', sourceSize: 100, onCardSize: 100, ...over,
})

describe('sealedManifestRows', () => {
  it('reads only a sealed manifest, only fingerprint identities', () => {
    const rows = sealedManifestRows(sealed)
    assert.deepEqual([...rows.keys()], [1, 2])          // id 3 has a path identity — vouches for nothing
    assert.equal(sealedManifestRows({ ...sealed, sealed: false }).size, 0)
    assert.equal(sealedManifestRows({ ...sealed, status: 'in-flight' }).size, 0)
    assert.equal(sealedManifestRows(null).size, 0)
  })
})

describe('keepVerdict — identity-gated, never text', () => {
  const rows = sealedManifestRows(sealed)
  it('keeps the same id at the same path with the same fingerprint and the same bytes on the card', () => {
    assert.deepEqual(keepVerdict(cand({}), rows), { keep: true })
  })
  it('copies when anything about the song changed', () => {
    assert.equal(keepVerdict(cand({ identity: 'fp:sha1:zzz|100' }), rows).keep, false)
    assert.equal(keepVerdict(cand({ destPath: ':iPod_Control:Music:F09:1.m4a' }), rows).keep, false)
    assert.equal(keepVerdict(cand({ id: 7 }), rows).keep, false)
  })
  it('copies when the card file is absent or a different size (a convert setting changed, or bytes did)', () => {
    assert.deepEqual(keepVerdict(cand({ onCardSize: undefined }), rows), { keep: false, why: 'not-on-card' })
    assert.deepEqual(keepVerdict(cand({ onCardSize: 99 }), rows), { keep: false, why: 'size-differs' })
    assert.deepEqual(keepVerdict(cand({ sourceSize: 0 }), rows), { keep: false, why: 'bad-size' })
  })
  it('never keeps on a weak identity, even if the manifest matches it', () => {
    const weak = cand({ id: 3, destPath: ':iPod_Control:Music:F03:3.m4a', identity: 'path::iPod_Control:Music:F03:3.m4a' })
    assert.deepEqual(keepVerdict(weak, rows), { keep: false, why: 'weak-identity' })
  })
})

describe('activityKeepPlan', () => {
  it('splits keep from copy and counts the reasons', () => {
    const plan = activityKeepPlan([
      cand({}),
      cand({ id: 2, destPath: ':iPod_Control:Music:F02:2.m4a', identity: 'fp:sha1:bbb|200', sourceSize: 200, onCardSize: 200 }),
      cand({ id: 4, identity: 'fp:sha1:ddd|5', sourceSize: 5, onCardSize: undefined }),
    ], sealed)
    assert.deepEqual([...plan.keepIds], [1, 2])
    assert.deepEqual(plan.copyIds, [4])
    assert.deepEqual(plan.reasons, { 'no-manifest-row': 1 })
  })
  it('with no sealed manifest, everything is copied — the old rebuild', () => {
    const plan = activityKeepPlan([cand({}), cand({ id: 2 })], null)
    assert.equal(plan.keepIds.size, 0)
    assert.deepEqual(plan.copyIds, [1, 2])
  })
})

describe('targeted wipe proof', () => {
  it('is proven only when the listing IS the keep set', () => {
    const keep = new Set(['/V/a.m4a', '/V/b.m4a'])
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a', '/V/b.m4a'], keep), true)
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a'], keep), false)                 // one missing
    assert.equal(wipeListingMatchesKeep(['/V/a.m4a', '/V/b.m4a', '/V/x.m4a'], keep), false) // one extra
    assert.equal(wipeListingMatchesKeep([], new Set()), true)                        // the old proven-empty
  })
  it('streaks like the empty-wipe proof', () => {
    assert.equal(keepStreak(true, 0), 1)
    assert.equal(keepStreak(true, 1), 2)
    assert.equal(keepStreak(false, 5), 0)
  })
})
